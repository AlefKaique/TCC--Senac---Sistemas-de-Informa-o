<?php

namespace Hydra\Support;

use Hydra\Repositories\UsuarioRepository;

/**
 * Sessão de autenticação (PHP session) + suporte ao "lembrar de mim"
 * via cookie de longa duração (remember_token, armazenado nas colunas
 * de usuarios previstas no modelo de dados).
 */
final class Auth
{
    public static function start(): void
    {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            session_set_cookie_params([
                'lifetime' => 0,
                'path' => '/',
                'samesite' => 'Lax',
            ]);
            session_start();
        }

        // Sessão expirada mas existe cookie "lembrar de mim" -> restaura login.
        if (!isset($_SESSION['id_usuario']) && !empty($_COOKIE['hydra_remember'])) {
            self::resumeFromRememberCookie($_COOKIE['hydra_remember']);
        }
    }

    private static function resumeFromRememberCookie(string $token): void
    {
        $usuario = (new UsuarioRepository())->findByRememberToken($token);
        if ($usuario !== null) {
            self::login($usuario);
        }
    }

    /** @param array<string,mixed> $usuario */
    public static function login(array $usuario): void
    {
        $_SESSION['id_usuario'] = (int) $usuario['id_usuario'];
        $_SESSION['id_loja'] = (int) $usuario['id_loja'];
        $_SESSION['perfil'] = $usuario['perfil'];
        $_SESSION['nome'] = $usuario['nome'];
        $_SESSION['email'] = $usuario['email'];
    }

    public static function logout(): void
    {
        $_SESSION = [];
        session_destroy();
        setcookie('hydra_remember', '', time() - 3600, '/');
    }

    public static function check(): bool
    {
        return isset($_SESSION['id_usuario']);
    }

    /** @return array{id_usuario:int,id_loja:int,perfil:string,nome:string,email:string}|null */
    public static function user(): ?array
    {
        if (!self::check()) {
            return null;
        }
        return [
            'id_usuario' => $_SESSION['id_usuario'],
            'id_loja' => $_SESSION['id_loja'],
            'perfil' => $_SESSION['perfil'],
            'nome' => $_SESSION['nome'],
            'email' => $_SESSION['email'],
        ];
    }

    /** Encerra a requisição com 401 se não houver sessão válida. */
    public static function requireLogin(): array
    {
        $user = self::user();
        if ($user === null) {
            Response::json(['erro' => 'Não autenticado'], 401);
            exit;
        }
        return $user;
    }

    /**
     * RN04 — restringe o acesso às funcionalidades gerenciais ao perfil Administrador.
     * Encerra a requisição com 403 se o usuário autenticado não for administrador.
     */
    public static function requireAdmin(): array
    {
        $user = self::requireLogin();
        if ($user['perfil'] !== 'administrador') {
            Response::json(['erro' => 'Apenas o Administrador pode acessar este recurso (RN04)'], 403);
            exit;
        }
        return $user;
    }
}
