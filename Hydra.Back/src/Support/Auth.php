<?php

namespace Hydra\Support;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\UsuarioRepository;

/**
 * Sessão de autenticação (PHP session) + suporte ao "lembrar de mim"
 * via cookie de longa duração (remember_token, armazenado nas colunas
 * de usuarios previstas no modelo de dados).
 *
 * O controle de acesso é baseado em permissões do Cargo do usuário (ver
 * módulo de Cargos no schema.sql e Hydra\Repositories\CargoRepository):
 * no login, as permissões do cargo são carregadas na sessão e cada
 * endpoint restrito chama requirePermission() com o código exigido.
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
        $_SESSION['id_cargo'] = isset($usuario['id_cargo']) ? (int) $usuario['id_cargo'] : null;
        $_SESSION['permissoes'] = $_SESSION['id_cargo'] !== null
            ? (new CargoRepository())->permissoesDoCargo($_SESSION['id_cargo'])
            : [];
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

    /** @return array{id_usuario:int,id_loja:int,perfil:string,nome:string,email:string,id_cargo:?int,permissoes:string[]}|null */
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
            'id_cargo' => $_SESSION['id_cargo'] ?? null,
            'permissoes' => $_SESSION['permissoes'] ?? [],
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

    /** Permissões do cargo do usuário logado — ver módulo de Cargos (schema.sql). */
    public static function can(string $codigo): bool
    {
        return in_array($codigo, $_SESSION['permissoes'] ?? [], true);
    }

    /**
     * Encerra a requisição com 403 se o usuário autenticado estiver sem
     * sessão ou se o cargo dele não tiver a permissão exigida. Substitui
     * as antigas verificações fixas por perfil (requireAdmin/
     * requireEstoqueAccess/requireVendaAccess): agora cada cargo decide,
     * por permissão marcada na tela "Cargos", o que seus usuários podem
     * fazer.
     */
    public static function requirePermission(string $codigo): array
    {
        $user = self::requireLogin();
        if (!self::can($codigo)) {
            Response::json(['erro' => 'Seu cargo não tem permissão para acessar este recurso'], 403);
            exit;
        }
        return $user;
    }
}
