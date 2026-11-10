<?php

namespace Hydra\Controllers;

use Hydra\Repositories\AdminPlataformaRepository;
use Hydra\Repositories\AuditoriaPlataformaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\Mailer;
use Hydra\Support\PasswordPolicy;
use Hydra\Support\RateLimit;
use Hydra\Support\Request;
use Hydra\Support\Response;

/** Gestão de membros Hydra e definição de senha no primeiro acesso. */
final class PlataformaEquipeController
{
    private AdminPlataformaRepository $admins;
    private AuditoriaPlataformaRepository $auditoria;

    public function __construct()
    {
        $this->admins = new AdminPlataformaRepository();
        $this->auditoria = new AuditoriaPlataformaRepository();
    }

    public function index(): void
    {
        Auth::requirePlataformaNivel(['proprietario']);
        Response::json(['membros' => $this->admins->listarEquipe()]);
    }

    public function criar(): void
    {
        $ator = Auth::requirePlataformaNivel(['proprietario']);
        $dados = Request::json();
        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $nivel = trim((string) ($dados['nivel'] ?? 'analista'));
        if ($nome === '' || mb_strlen($nome, 'UTF-8') > 100) {
            Response::json(['erro' => 'Informe o nome do membro.'], 422);
            return;
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 100) {
            Response::json(['erro' => 'Informe um e-mail válido.'], 422);
            return;
        }
        if (!in_array($nivel, ['proprietario', 'gestor', 'analista'], true)) {
            Response::json(['erro' => 'Selecione um nível de acesso válido.'], 422);
            return;
        }
        if ($this->admins->findByEmail($email) !== null) {
            Response::json(['erro' => 'Já existe um membro da plataforma com esse e-mail.'], 409);
            return;
        }

        $codigo = $this->novoCodigo();
        $expiraEm = date('Y-m-d H:i:s', time() + 24 * 60 * 60);
        db()->beginTransaction();
        try {
            $idAdmin = $this->admins->criarMembro(
                $nome,
                $email,
                $nivel,
                $ator['id'],
                hash('sha256', $codigo),
                $expiraEm
            );
            $this->auditoria->registrar($ator['id'], 'equipe_convidada', null, $email . ' (' . $nivel . ')');
            db()->commit();
        } catch (\Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            throw $e;
        }

        if (!$this->enviarConvite($email, $nome, $codigo)) {
            Response::json([
                'erro' => 'O membro foi cadastrado, mas não foi possível enviar o convite. Use “Reenviar convite”.',
                'id_admin' => $idAdmin,
            ], 502);
            return;
        }
        Response::json(['ok' => true, 'id_admin' => $idAdmin], 201);
    }

    public function atualizar(int $idAdmin): void
    {
        $ator = Auth::requirePlataformaNivel(['proprietario']);
        if ($idAdmin === $ator['id']) {
            Response::json(['erro' => 'Você não pode alterar seu próprio nível ou status.'], 403);
            return;
        }
        $dados = Request::json();
        $nivel = isset($dados['nivel']) ? trim((string) $dados['nivel']) : null;
        $status = isset($dados['status']) ? trim((string) $dados['status']) : null;
        if ($nivel === null && $status === null) {
            Response::json(['erro' => 'Informe o novo nível ou status do membro.'], 422);
            return;
        }
        if ($nivel !== null && !in_array($nivel, ['proprietario', 'gestor', 'analista'], true)) {
            Response::json(['erro' => 'Nível de acesso inválido.'], 422);
            return;
        }
        if ($status !== null && !in_array($status, ['ativo', 'inativo'], true)) {
            Response::json(['erro' => 'Status inválido.'], 422);
            return;
        }

        $resultado = $this->admins->atualizarMembro($idAdmin, $nivel, $status, $ator['id']);
        if (isset($resultado['erro'])) {
            $http = $resultado['erro'] === 'Membro não encontrado.' ? 404 : 409;
            Response::json(['erro' => $resultado['erro']], $http);
            return;
        }
        Response::json(['membro' => $resultado['membro']]);
    }

    public function reenviarConvite(int $idAdmin): void
    {
        $ator = Auth::requirePlataformaNivel(['proprietario']);
        $membro = $this->admins->buscarMembro($idAdmin);
        if ($membro === null) {
            Response::json(['erro' => 'Membro não encontrado.'], 404);
            return;
        }
        if ((int) $membro['senha_definida'] === 1) {
            Response::json(['erro' => 'Esse membro já definiu a própria senha.'], 409);
            return;
        }
        if ($membro['status'] !== 'ativo') {
            Response::json(['erro' => 'Reative o membro antes de reenviar o convite.'], 409);
            return;
        }

        $codigo = $this->novoCodigo();
        $this->admins->atualizarCodigoHash(
            $idAdmin,
            hash('sha256', $codigo),
            date('Y-m-d H:i:s', time() + 24 * 60 * 60)
        );
        $this->auditoria->registrar($ator['id'], 'equipe_convite_reenviado', null, (string) $membro['email']);
        if (!$this->enviarConvite((string) $membro['email'], (string) $membro['nome'], $codigo)) {
            Response::json(['erro' => 'Não foi possível enviar o convite. Tente novamente mais tarde.'], 502);
            return;
        }
        Response::json(['ok' => true]);
    }

    public function primeiroAcesso(): void
    {
        // Rota de autenticação que não usa a sessão: solta o lock já no início.
        Auth::liberarSessao();
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $codigo = trim((string) ($dados['codigo'] ?? ''));
        $senha = (string) ($dados['senha'] ?? '');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 100) {
            Response::json(['erro' => 'Convite inválido ou expirado. Confira o e-mail e o código.'], 400);
            return;
        }
        $chave = 'plataforma:primeiro_acesso:' . $email;
        RateLimit::requireNaoBloqueado($chave);

        $admin = $email !== '' && preg_match('/^\d{6}$/', $codigo) === 1
            ? $this->admins->findByEmailAndValidCode($email, $codigo)
            : null;
        if ($admin === null || (int) $admin['senha_definida'] !== 0) {
            RateLimit::registrarFalha($chave);
            $this->auditoria->registrar(null, 'login_falha_codigo', null, 'Código de primeiro acesso inválido');
            Response::json(['erro' => 'Convite inválido ou expirado. Confira o e-mail e o código.'], 400);
            return;
        }

        $erroSenha = PasswordPolicy::validar($senha);
        if ($erroSenha !== null) {
            Response::json(['erro' => $erroSenha, 'campo' => 'senha'], 422);
            return;
        }
        $senhaHash = password_hash($senha, PASSWORD_BCRYPT);
        if ($senhaHash === false || !$this->admins->atualizarSenhaPrimeiroAcesso(
            (int) $admin['id_admin'],
            $senhaHash,
            hash('sha256', $codigo)
        )) {
            RateLimit::registrarFalha($chave);
            Response::json(['erro' => 'Convite inválido ou expirado. Confira o e-mail e o código.'], 400);
            return;
        }

        RateLimit::limpar($chave);
        $this->auditoria->registrar((int) $admin['id_admin'], 'equipe_primeiro_acesso');
        Response::json(['ok' => true]);
    }

    private function novoCodigo(): string
    {
        return str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    }

    private function enviarConvite(string $email, string $nome, string $codigo): bool
    {
        $base = rtrim((string) Env::get('FRONTEND_URL', ''), '/');
        if ($base === '') {
            $origem = rtrim((string) ($_SERVER['HTTP_ORIGIN'] ?? 'http://localhost:5500'), '/');
            $referencia = parse_url((string) ($_SERVER['HTTP_REFERER'] ?? ''), PHP_URL_PATH) ?: '';
            $prefixo = '';
            if (preg_match('#^(.*?)/pages/plataforma/#', $referencia, $encontrado)) {
                $prefixo = rtrim($encontrado[1], '/');
            }
            $base = $origem . $prefixo;
        }
        $link = $base . '/pages/plataforma/primeiro-acesso.html?email=' . rawurlencode($email);
        $nomeSeguro = htmlspecialchars($nome, ENT_QUOTES, 'UTF-8');
        $html = '<p>Olá, ' . $nomeSeguro . '.</p>'
            . '<p>Você foi convidado para fazer parte da equipe Hydra.</p>'
            . '<p>Acesse <a href="' . htmlspecialchars($link, ENT_QUOTES, 'UTF-8') . '">esta página</a>, informe o código abaixo e crie sua senha.</p>'
            . '<p style="font-size:32px;font-weight:700;letter-spacing:6px">' . $codigo . '</p>'
            . '<p>O convite é válido por 24 horas.</p>';
        return Mailer::send($email, 'Convite para a equipe Hydra', $html);
    }
}
