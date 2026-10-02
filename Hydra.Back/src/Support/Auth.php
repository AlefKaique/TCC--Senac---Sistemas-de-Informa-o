<?php

namespace Hydra\Support;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\UsuarioRepository;

/**
 * Sessão de autenticação (PHP session).
 *
 * Não existe login persistente ("lembrar de mim"): a sessão morre ao
 * fechar o navegador. O sistema roda em terminais de loja compartilhados,
 * onde manter alguém logado por dias entregaria a conta do operador
 * anterior a quem sentasse depois - e falsearia a autoria registrada em
 * movimentacoes_estoque.id_usuario.
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
                // lifetime 0 = o cookie morre junto com o navegador.
                'lifetime' => 0,
                'path' => '/',
                // Fora do alcance de JavaScript, para que um XSS não consiga
                // ler o identificador de sessão.
                'httponly' => true,
                // Só exige HTTPS quando a requisição já chegou por HTTPS, para
                // não quebrar o desenvolvimento local em http://localhost.
                'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
                'samesite' => 'Lax',
            ]);
            session_start();
        }
    }

    /** @param array<string,mixed> $usuario */
    public static function login(array $usuario): void
    {
        // Troca o identificador de sessão ao autenticar. Sem isso, um
        // PHPSESSID que o atacante tenha conseguido fixar no navegador da
        // vítima continuaria valendo depois do login dela (session fixation).
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }

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

    /**
     * Encerra a requisição com 401 se não houver sessão válida.
     *
     * Revalida o usuário no banco a cada requisição. Antes, status,
     * cargo e permissões eram lidos uma única vez no login e congelavam
     * na sessão: inativar um funcionário, movê-lo de cargo ou remover
     * uma permissão não tinha efeito nenhum enquanto a sessão dele
     * existisse. O custo é uma consulta por requisição.
     */
    public static function requireLogin(): array
    {
        $user = self::user();
        if ($user === null) {
            Response::json(['erro' => 'Não autenticado'], 401);
            exit;
        }

        $atual = (new UsuarioRepository())->find($user['id_usuario']);
        if ($atual === null || $atual['status'] !== 'ativo') {
            self::logout();
            Response::json(['erro' => 'Sua conta foi desativada ou removida. Faça login novamente.'], 401);
            exit;
        }

        // Reespelha cargo e permissões, para que mudanças feitas na tela
        // de Cargos valham na próxima requisição, sem precisar relogar.
        $_SESSION['perfil'] = $atual['perfil'];
        $_SESSION['nome'] = $atual['nome'];
        $_SESSION['email'] = $atual['email'];
        $_SESSION['id_cargo'] = $atual['id_cargo'] !== null ? (int) $atual['id_cargo'] : null;
        $_SESSION['permissoes'] = $_SESSION['id_cargo'] !== null
            ? (new CargoRepository())->permissoesDoCargo($_SESSION['id_cargo'])
            : [];

        return self::user();
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

    /**
     * Variante de requirePermission() para o endpoint que serve a mais de
     * uma área do sistema. O caso que a motivou é GET /api/produtos: o
     * catálogo é a tela de Estoque, mas é também o que o Caixa lê para
     * montar a venda. Exigir "estoque.gerenciar" ali obrigaria a dar poder
     * de escrita no estoque a um operador de caixa só para ele enxergar os
     * preços — o oposto do que as permissões grossas tentam fazer.
     *
     * @param string[] $codigos basta ter UM deles
     */
    public static function requireAnyPermission(array $codigos): array
    {
        $user = self::requireLogin();
        foreach ($codigos as $codigo) {
            if (self::can($codigo)) {
                return $user;
            }
        }
        Response::json(['erro' => 'Seu cargo não tem permissão para acessar este recurso'], 403);
        exit;
    }
}
