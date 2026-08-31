<?php

namespace Hydra\Controllers;

use Hydra\Repositories\LojaRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\Mailer;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Cadastro (Fig. 13), Login (Fig. 14) e Recuperação de senha (Fig. 15).
 */
final class AuthController
{
    private UsuarioRepository $usuarios;
    private LojaRepository $lojas;

    public function __construct()
    {
        $this->usuarios = new UsuarioRepository();
        $this->lojas = new LojaRepository();
    }

    /**
     * POST /api/auth/registro
     * Onboarding: cria a loja + o primeiro usuário (perfil administrador),
     * em uma única transação. Corresponde à Figura 13 — só nome, e-mail,
     * senha e nome da loja; nada de dados que crescem com o tempo (RN22 —
     * esses ficam na tela de Configurações da Loja).
     */
    public function registro(): void
    {
        $dados = Request::json();
        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');
        $nomeLoja = trim((string) ($dados['nome_loja'] ?? ''));

        if ($nome === '' || $email === '' || $nomeLoja === '') {
            Response::json(['erro' => 'Preencha nome, e-mail e nome da loja'], 422);
            return;
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            Response::json(['erro' => 'E-mail inválido'], 422);
            return;
        }
        if (strlen($senha) < 6) {
            Response::json(['erro' => 'A senha deve ter pelo menos 6 caracteres'], 422);
            return;
        }
        if ($this->usuarios->emailExists($email)) {
            Response::json(['erro' => 'Já existe uma conta com este e-mail'], 409);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $idLoja = $this->lojas->create($nomeLoja);
            $idUsuario = $this->usuarios->create(
                $idLoja,
                $nome,
                $email,
                password_hash($senha, PASSWORD_BCRYPT),
                'administrador'
            );
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível concluir o cadastro'], 500);
            return;
        }

        $usuario = $this->usuarios->find($idUsuario);
        Auth::login($usuario);

        Response::json(['usuario' => $this->publicUser($usuario)], 201);
    }

    /**
     * POST /api/auth/login
     * SELECT em usuarios por e-mail + verificação de senha + UPDATE ultimo_acesso.
     */
    public function login(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');
        $lembrar = (bool) ($dados['lembrar'] ?? false);

        $usuario = $email !== '' ? $this->usuarios->findByEmail($email) : null;

        if ($usuario === null || !password_verify($senha, $usuario['senha'])) {
            Response::json(['erro' => 'E-mail ou senha inválidos'], 401);
            return;
        }
        if ($usuario['status'] !== 'ativo') {
            Response::json(['erro' => 'Este usuário está inativo. Fale com o administrador da loja.'], 403);
            return;
        }

        $this->usuarios->updateUltimoAcesso((int) $usuario['id_usuario']);
        Auth::login($usuario);

        if ($lembrar) {
            $token = bin2hex(random_bytes(32));
            $this->usuarios->setRememberToken((int) $usuario['id_usuario'], $token);
            $dias = (int) Env::get('REMEMBER_ME_DAYS', '30');
            setcookie('hydra_remember', $token, [
                'expires' => time() + $dias * 86400,
                'path' => '/',
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
        }

        Response::json(['usuario' => $this->publicUser($usuario)]);
    }

    /** POST /api/auth/logout */
    public function logout(): void
    {
        $user = Auth::user();
        if ($user !== null) {
            $this->usuarios->setRememberToken($user['id_usuario'], null);
        }
        Auth::logout();
        Response::json(['ok' => true]);
    }

    /** GET /api/auth/me — retorna o usuário autenticado (ou 401). */
    public function me(): void
    {
        $user = Auth::requireLogin();
        Response::json(['usuario' => $user]);
    }

    /**
     * POST /api/auth/esqueci-senha
     * Gera um código numérico de 6 dígitos com validade de 15 minutos
     * (RN05) e envia por e-mail (Mailer). Se o SMTP não estiver
     * configurado no ambiente (MAIL_HOST vazio), o código volta na
     * própria resposta para viabilizar o fluxo de teste/demonstração
     * local, já que não há como entregá-lo por e-mail nesse caso.
     */
    public function esqueciSenha(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $usuario = $email !== '' ? $this->usuarios->findByEmail($email) : null;

        // Resposta genérica mesmo se o e-mail não existir, para não vazar
        // quais e-mails estão cadastrados na base.
        if ($usuario === null) {
            Response::json(['ok' => true]);
            return;
        }

        $codigo = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $expiraEm = (new \DateTimeImmutable('+15 minutes'))->format('Y-m-d H:i:s');
        $this->usuarios->setResetToken((int) $usuario['id_usuario'], $codigo, $expiraEm);

        $enviado = Mailer::send(
            $email,
            'Código de recuperação de senha — Hydra PDV',
            $this->emailCodigoHtml((string) $usuario['nome'], $codigo)
        );

        $resposta = ['ok' => true];
        if (!$enviado) {
            $resposta['codigo_dev'] = $codigo;
        }

        Response::json($resposta);
    }

    /** POST /api/auth/redefinir-senha */
    public function redefinirSenha(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $codigo = trim((string) ($dados['codigo'] ?? ''));
        $senha = (string) ($dados['senha'] ?? '');

        if ($email === '' || $codigo === '' || strlen($senha) < 6) {
            Response::json(['erro' => 'Preencha o código recebido e uma senha com pelo menos 6 caracteres'], 422);
            return;
        }

        $usuario = $this->usuarios->findByValidResetCode($email, $codigo);
        if ($usuario === null) {
            Response::json(['erro' => 'Código inválido ou expirado'], 400);
            return;
        }

        $this->usuarios->updatePasswordAndClearResetToken(
            (int) $usuario['id_usuario'],
            password_hash($senha, PASSWORD_BCRYPT)
        );

        Response::json(['ok' => true]);
    }

    private function emailCodigoHtml(string $nome, string $codigo): string
    {
        $primeiroNome = htmlspecialchars(explode(' ', trim($nome))[0] ?? '', ENT_QUOTES, 'UTF-8');
        return <<<HTML
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1B2A63;">
                <h2 style="margin-bottom: 8px;">Recuperação de senha</h2>
                <p>Olá, {$primeiroNome}!</p>
                <p>Use o código abaixo para redefinir sua senha no Hydra PDV. Ele expira em 15 minutos.</p>
                <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; background: #F4F5F9; padding: 16px 24px; border-radius: 8px; text-align: center;">{$codigo}</p>
                <p>Se você não solicitou essa recuperação, pode ignorar este e-mail.</p>
            </div>
            HTML;
    }

    /** @param array<string,mixed> $usuario */
    private function publicUser(array $usuario): array
    {
        return [
            'id_usuario' => (int) $usuario['id_usuario'],
            'id_loja' => (int) $usuario['id_loja'],
            'nome' => $usuario['nome'],
            'email' => $usuario['email'],
            'perfil' => $usuario['perfil'],
        ];
    }
}
