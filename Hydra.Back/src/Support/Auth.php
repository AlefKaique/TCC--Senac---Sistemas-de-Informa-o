<?php

namespace Hydra\Support;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\FilialRepository;
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
 *
 * Filial ativa: os dados de produtos, estoque, vendas e promoções são por
 * filial. A filial em que o usuário está trabalhando fica SÓ na sessão
 * ($_SESSION['id_filial']), definida no login ou em POST /api/filiais/trocar
 * — o back-end nunca lê um id de filial enviado pelo navegador nas demais
 * requisições. Os endpoints desses dados usam requirePermissionNaFilial(),
 * que revalida o acesso à filial a cada requisição.
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
        // Sem isto, logar com outra conta no mesmo navegador (sem passar
        // pelo "Sair") herdaria a filial escolhida pela conta anterior.
        unset($_SESSION['id_filial']);
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

    /** @return array{id_usuario:int,id_loja:int,id_filial:?int,perfil:string,nome:string,email:string,id_cargo:?int,permissoes:string[]}|null */
    public static function user(): ?array
    {
        if (!self::check()) {
            return null;
        }
        return [
            'id_usuario' => $_SESSION['id_usuario'],
            'id_loja' => $_SESSION['id_loja'],
            'id_filial' => $_SESSION['id_filial'] ?? null,
            'perfil' => $_SESSION['perfil'],
            'nome' => $_SESSION['nome'],
            'email' => $_SESSION['email'],
            'id_cargo' => $_SESSION['id_cargo'] ?? null,
            'permissoes' => $_SESSION['permissoes'] ?? [],
        ];
    }

    /**
     * O usuário logado é Administrador? Mesmo critério do cargo
     * (CargoRepository::nivelEquivalente), calculado sobre as permissões
     * reespelhadas por requireLogin() — e não sobre usuarios.perfil, para
     * valer na hora em que o cargo muda na tela Cargos.
     */
    public static function ehAdministrador(): bool
    {
        return CargoRepository::nivelEquivalente($_SESSION['permissoes'] ?? []) === 'administrador';
    }

    /** Grava a filial ativa na sessão. Quem chama já validou o acesso. */
    public static function definirFilial(int $idFilial): void
    {
        $_SESSION['id_filial'] = $idFilial;
    }

    /**
     * Encerra a requisição com 409 se não houver filial ativa na sessão ou
     * se o usuário tiver perdido o acesso a ela (filial inativada, vínculo
     * removido na tela Equipe). O front-end reconhece o código
     * "filial_nao_selecionada" e abre a janela de escolha de filial.
     *
     * @param array<string,mixed> $user retorno de requireLogin()
     * @return array<string,mixed> o mesmo usuário, com id_filial garantido
     */
    public static function requireFilial(array $user): array
    {
        $idFilial = $_SESSION['id_filial'] ?? null;
        if ($idFilial === null) {
            Response::json([
                'erro' => 'Escolha a filial em que você vai trabalhar.',
                'codigo' => 'filial_nao_selecionada',
            ], 409);
            exit;
        }

        $temAcesso = (new FilialRepository())->podeAcessar(
            (int) $user['id_usuario'],
            (int) $user['id_loja'],
            self::ehAdministrador(),
            (int) $idFilial
        );
        if (!$temAcesso) {
            unset($_SESSION['id_filial']);
            Response::json([
                'erro' => 'Você não tem mais acesso a esta filial, ou ela foi desativada. Escolha outra filial.',
                'codigo' => 'filial_nao_selecionada',
            ], 409);
            exit;
        }

        $user['id_filial'] = (int) $idFilial;
        return $user;
    }

    /** requirePermission() + requireFilial(): para os endpoints de dados por filial. */
    public static function requirePermissionNaFilial(string $codigo): array
    {
        return self::requireFilial(self::requirePermission($codigo));
    }

    /**
     * requireAnyPermission() + requireFilial().
     *
     * @param string[] $codigos
     */
    public static function requireAnyPermissionNaFilial(array $codigos): array
    {
        return self::requireFilial(self::requireAnyPermission($codigos));
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
     * uma área do sistema. O caso atual é GET /api/vendas: ele alimenta o
     * Histórico de Vendas ("vendas.historico") e também o cálculo do
     * faturamento no Dashboard ("relatorios.visualizar"). Exigir só o
     * primeiro obrigaria a dar acesso ao histórico item a item a quem
     * deveria enxergar apenas os totais.
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
