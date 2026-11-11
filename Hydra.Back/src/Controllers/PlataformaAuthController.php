<?php

namespace Hydra\Controllers;

use Hydra\Repositories\AdminPlataformaRepository;
use Hydra\Repositories\AuditoriaPlataformaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Mailer;
use Hydra\Support\RateLimit;
use Hydra\Support\Request;
use Hydra\Support\Response;

/** Login em duas etapas dos administradores da plataforma Hydra. */
final class PlataformaAuthController
{
    private const MINUTOS_CODIGO = 10;

    private AdminPlataformaRepository $admins;
    private AuditoriaPlataformaRepository $auditoria;

    public function __construct()
    {
        $this->admins = new AdminPlataformaRepository();
        $this->auditoria = new AuditoriaPlataformaRepository();
    }

    /** POST /api/plataforma/auth/login */
    public function login(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');
        $chaveLogin = 'plataforma:login:' . $email;
        RateLimit::requireNaoBloqueado($chaveLogin);

        $admin = $email !== '' ? $this->admins->findByEmail($email) : null;
        if (
            $admin === null
            || $admin['status'] !== 'ativo'
            || (int) ($admin['senha_definida'] ?? 1) !== 1
            || !password_verify($senha, $admin['senha'])
        ) {
            RateLimit::registrarFalha($chaveLogin);
            $this->auditoria->registrar(
                $admin !== null ? (int) $admin['id_admin'] : null,
                'login_falha_senha'
            );
            Response::json(['erro' => 'E-mail ou senha inválidos'], 401);
            return;
        }

        RateLimit::limpar($chaveLogin);

        // Conta marcada pelo script bin/criar-admin-plataforma.php --sem-codigo:
        // entra só com e-mail e senha, sem a etapa do código por e-mail.
        if ((int) ($admin['login_sem_codigo'] ?? 0) === 1) {
            $idAdmin = (int) $admin['id_admin'];
            $this->admins->registrarAcesso($idAdmin);
            $this->auditoria->registrar($idAdmin, 'login_ok_sem_codigo');
            Auth::loginPlataforma($admin);
            Response::json($this->respostaDeLogin($admin));
            return;
        }

        $emailChave = $admin['email'];
        $chaveEnvio = 'plataforma:envio:' . $emailChave;
        RateLimit::requireNaoBloqueado($chaveEnvio);
        RateLimit::registrarFalha($chaveEnvio);

        Auth::reabrirSessao();
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }
        unset(
            $_SESSION['id_usuario'],
            $_SESSION['id_loja'],
            $_SESSION['id_filial'],
            $_SESSION['perfil'],
            $_SESSION['nome'],
            $_SESSION['email'],
            $_SESSION['id_cargo'],
            $_SESSION['permissoes'],
            $_SESSION['login_pendente'],
            $_SESSION['admin_plataforma']
        );
        $_SESSION['login_pendente_plataforma'] = [
            'id_admin' => (int) $admin['id_admin'],
            'email' => $emailChave,
            'expira' => time() + self::MINUTOS_CODIGO * 60,
        ];
        // Grava a sessão e solta o lock ANTES de chamar o Brevo (até 10 s):
        // antes as outras requisições do navegador ficavam esperando o envio.
        Auth::liberarSessao();

        if (!$this->enviarCodigo($admin)) {
            Auth::reabrirSessao();
            unset($_SESSION['login_pendente_plataforma']);
            Auth::liberarSessao();
            Response::json(['erro' => 'Não foi possível enviar o código. Tente novamente mais tarde.'], 502);
            return;
        }

        Response::json(['requer_codigo' => true, 'email' => $emailChave]);
    }

    /** POST /api/plataforma/auth/codigo */
    public function codigo(): void
    {
        $dados = Request::json();
        $sessaoPendente = $_SESSION['login_pendente_plataforma'] ?? null;
        if (
            !is_array($sessaoPendente)
            || empty($sessaoPendente['id_admin'])
            || empty($sessaoPendente['email'])
            || (int) ($sessaoPendente['expira'] ?? 0) < time()
        ) {
            unset($_SESSION['login_pendente_plataforma']);
            Response::json(['erro' => 'Sua verificação expirou. Faça login novamente.'], 401);
            return;
        }

        // Daqui em diante só lê a sessão até Auth::loginPlataforma(), que a
        // reabre para gravar; o lock não fica preso durante as consultas.
        Auth::liberarSessao();

        $idAdmin = (int) $sessaoPendente['id_admin'];
        $email = (string) $sessaoPendente['email'];
        $codigo = trim((string) ($dados['codigo'] ?? ''));
        $emailInformado = trim(strtolower((string) ($dados['email'] ?? '')));
        $chaveCodigo = 'plataforma:codigo:' . $email;
        RateLimit::requireNaoBloqueado($chaveCodigo);

        $admin = $this->admins->findAtivoById($idAdmin);
        $codigoValido = $admin !== null
            && hash_equals($email, $emailInformado)
            && preg_match('/^\d{6}$/', $codigo) === 1
            && $this->admins->consumirCodigo($idAdmin, $codigo);

        if (!$codigoValido) {
            RateLimit::registrarFalha($chaveCodigo);
            $this->auditoria->registrar(
                $admin !== null ? $idAdmin : null,
                'login_falha_codigo'
            );
            Response::json(['erro' => 'Código inválido ou expirado'], 400);
            return;
        }

        $this->admins->registrarAcesso($idAdmin);
        $this->auditoria->registrar($idAdmin, 'login_ok');
        RateLimit::limpar(
            'plataforma:login:' . $email,
            $chaveCodigo,
            'plataforma:envio:' . $email
        );
        Auth::loginPlataforma($admin);

        Response::json($this->respostaDeLogin($admin));
    }

    /** POST /api/plataforma/auth/reenviar */
    public function reenviar(): void
    {
        $sessaoPendente = $_SESSION['login_pendente_plataforma'] ?? null;
        if (
            !is_array($sessaoPendente)
            || empty($sessaoPendente['id_admin'])
            || empty($sessaoPendente['email'])
            || (int) ($sessaoPendente['expira'] ?? 0) < time()
        ) {
            unset($_SESSION['login_pendente_plataforma']);
            Response::json(['erro' => 'Sua verificação expirou. Faça login novamente.'], 401);
            return;
        }

        // Solta o lock antes das consultas e do envio ao Brevo; a sessão é
        // reaberta só nos pontos que gravam nela.
        Auth::liberarSessao();

        $email = (string) $sessaoPendente['email'];
        $chaveEnvio = 'plataforma:envio:' . $email;
        RateLimit::requireNaoBloqueado($chaveEnvio);
        RateLimit::registrarFalha($chaveEnvio);
        $admin = $this->admins->findAtivoById((int) $sessaoPendente['id_admin']);
        if ($admin === null) {
            Auth::reabrirSessao();
            unset($_SESSION['login_pendente_plataforma']);
            Auth::liberarSessao();
            Response::json(['erro' => 'Sua verificação expirou. Faça login novamente.'], 401);
            return;
        }

        if (!$this->enviarCodigo($admin)) {
            Response::json(['erro' => 'Não foi possível enviar o código. Tente novamente mais tarde.'], 502);
            return;
        }
        Auth::reabrirSessao();
        if (is_array($_SESSION['login_pendente_plataforma'] ?? null)) {
            $_SESSION['login_pendente_plataforma']['expira'] = time() + self::MINUTOS_CODIGO * 60;
        }
        Auth::liberarSessao();
        Response::json(['ok' => true]);
    }

    /** GET /api/plataforma/auth/me */
    public function me(): void
    {
        Response::json(['admin' => Auth::requirePlataforma()]);
    }

    /** POST /api/plataforma/auth/logout */
    public function logout(): void
    {
        $admin = Auth::requirePlataforma();
        $this->auditoria->registrar($admin['id'], 'logout');
        Auth::logoutPlataforma();
        Response::json(['ok' => true]);
    }

    /** @return array{admin:array{id:int,nome:string,email:string,nivel:string}} */
    private function respostaDeLogin(array $admin): array
    {
        return [
            'admin' => [
                'id' => (int) $admin['id_admin'],
                'nome' => (string) $admin['nome'],
                'email' => (string) $admin['email'],
                'nivel' => (string) $admin['nivel'],
            ],
        ];
    }

    /** Salva somente o hash do código e envia o valor temporário por e-mail. */
    private function enviarCodigo(array $admin): bool
    {
        $codigo = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $expiraEm = date('Y-m-d H:i:s', time() + self::MINUTOS_CODIGO * 60);
        $idAdmin = (int) $admin['id_admin'];
        $this->admins->salvarCodigo($idAdmin, $codigo, $expiraEm);

        $nome = htmlspecialchars((string) $admin['nome'], ENT_QUOTES, 'UTF-8');
        $html = '<p>Olá, ' . $nome . '.</p>'
            . '<p>Use este código para concluir o acesso à plataforma Hydra:</p>'
            . '<p style="font-size:32px;font-weight:700;letter-spacing:6px">'
            . $codigo . '</p><p>O código expira em 10 minutos.</p>';

        if (!Mailer::send((string) $admin['email'], 'Código de acesso — Hydra Plataforma', $html)) {
            $this->admins->limparCodigo($idAdmin);
            return false;
        }
        return true;
    }
}
