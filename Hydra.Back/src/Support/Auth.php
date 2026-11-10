<?php

namespace Hydra\Support;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\AdminPlataformaRepository;
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
    /** @var array{id_filial:int,ativa:bool,vinculada:bool}|null acesso à filial lido por requireLogin() */
    private static ?array $acessoFilial = null;

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

    /**
     * Grava e solta o lock do arquivo de sessão.
     *
     * O PHP mantém a sessão travada do session_start() até o fim do script.
     * Como toda tela dispara várias chamadas ao mesmo tempo (/auth/me,
     * /filiais/minhas, /produtos, /vendas...), o lock fazia o servidor
     * atendê-las UMA DE CADA VEZ — a principal causa da lentidão. Depois
     * daqui $_SESSION continua legível; para gravar de novo, chame
     * reabrirSessao() antes.
     */
    public static function liberarSessao(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
    }

    /** Reabre a sessão liberada por liberarSessao(), para poder gravar nela. */
    public static function reabrirSessao(): void
    {
        self::start();
    }

    /** @param array<string,mixed> $usuario */
    public static function login(array $usuario): void
    {
        self::reabrirSessao();
        // Troca o identificador de sessão ao autenticar. Sem isso, um
        // PHPSESSID que o atacante tenha conseguido fixar no navegador da
        // vítima continuaria valendo depois do login dela (session fixation).
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }

        unset($_SESSION['admin_plataforma'], $_SESSION['login_pendente_plataforma']);
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

    /** Inicia uma sessão exclusiva da plataforma, sem contexto de loja ou filial. */
    public static function loginPlataforma(array $admin): void
    {
        self::reabrirSessao();
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
            $_SESSION['login_pendente_plataforma']
        );
        $_SESSION['admin_plataforma'] = [
            'id_admin' => (int) $admin['id_admin'],
            'nome' => (string) $admin['nome'],
            'email' => (string) $admin['email'],
            'ultima_atividade' => time(),
        ];
    }

    /** Encerra somente o contexto da plataforma e da verificação pendente. */
    public static function logoutPlataforma(): void
    {
        self::reabrirSessao();
        unset($_SESSION['admin_plataforma'], $_SESSION['login_pendente_plataforma']);
        self::liberarSessao();
    }

    /**
     * Revalida o administrador da plataforma e encerra sessões inativas após
     * 30 minutos, sem aceitar uma sessão de usuário de loja como equivalente.
     *
     * @return array{id:int,nome:string,email:string,nivel:string}
     */
    public static function requirePlataforma(): array
    {
        // Só lê aqui; a consulta ao banco roda com a sessão já liberada, e a
        // sessão só é reaberta se houver o que gravar (ver o fim do método).
        self::liberarSessao();
        if (isset($_SESSION['id_usuario']) || isset($_SESSION['id_loja'])) {
            self::logout();
            Response::json([
                'erro' => 'Sessão da plataforma expirada',
                'codigo' => 'plataforma_nao_autenticado',
            ], 401);
            exit;
        }
        $sessao = $_SESSION['admin_plataforma'] ?? null;
        if (!is_array($sessao) || empty($sessao['id_admin'])) {
            self::liberarSessao();
            Response::json([
                'erro' => 'Sessão da plataforma expirada',
                'codigo' => 'plataforma_nao_autenticado',
            ], 401);
            exit;
        }

        $ultimaAtividade = (int) ($sessao['ultima_atividade'] ?? 0);
        if ($ultimaAtividade <= 0 || time() - $ultimaAtividade > 30 * 60) {
            self::reabrirSessao();
            unset($_SESSION['admin_plataforma']);
            self::liberarSessao();
            Response::json([
                'erro' => 'Sessão da plataforma expirada',
                'codigo' => 'plataforma_nao_autenticado',
            ], 401);
            exit;
        }

        $admin = (new AdminPlataformaRepository())->findAtivoById((int) $sessao['id_admin']);
        if ($admin === null) {
            self::reabrirSessao();
            unset($_SESSION['admin_plataforma']);
            self::liberarSessao();
            Response::json([
                'erro' => 'Sessão da plataforma expirada',
                'codigo' => 'plataforma_nao_autenticado',
            ], 401);
            exit;
        }

        $novoEstado = [
            'id_admin' => (int) $admin['id_admin'],
            'nome' => (string) $admin['nome'],
            'email' => (string) $admin['email'],
            'nivel' => (string) $admin['nivel'],
        ];
        $dadosMudaram = false;
        foreach ($novoEstado as $chave => $valor) {
            if (($sessao[$chave] ?? null) !== $valor) {
                $dadosMudaram = true;
                break;
            }
        }
        // ultima_atividade conta o tempo de inatividade (30 min). Regravá-la a
        // cada chamada reabria a sessão (e o lock) em todas as requisições;
        // com folga de 60 s, a precisão do timeout continua mais que suficiente.
        if ($dadosMudaram || time() - $ultimaAtividade >= 60) {
            self::reabrirSessao();
            $_SESSION['admin_plataforma'] = $novoEstado + ['ultima_atividade' => time()];
            self::liberarSessao();
        }

        return [
            'id' => (int) $admin['id_admin'],
            'nome' => (string) $admin['nome'],
            'email' => (string) $admin['email'],
            'nivel' => (string) $admin['nivel'],
        ];
    }

    /**
     * Confere o papel em cada requisição protegida, nunca apenas no menu.
     *
     * @param string[] $niveisPermitidos
     * @return array{id:int,nome:string,email:string,nivel:string}
     */
    public static function requirePlataformaNivel(array $niveisPermitidos): array
    {
        $admin = self::requirePlataforma();
        if (!in_array($admin['nivel'], $niveisPermitidos, true)) {
            Response::json(['erro' => 'Seu nível de acesso não permite esta ação.'], 403);
            exit;
        }
        return $admin;
    }

    public static function logout(): void
    {
        self::reabrirSessao();
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
        self::reabrirSessao();
        $_SESSION['id_filial'] = $idFilial;
        self::liberarSessao();
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

        // requireLogin() já trouxe o acesso à filial junto com o usuário;
        // a consulta própria fica só para quando a filial mudou no meio.
        $acesso = self::$acessoFilial;
        if ($acesso !== null && $acesso['id_filial'] === (int) $idFilial) {
            $temAcesso = $acesso['ativa'] && (self::ehAdministrador() || $acesso['vinculada']);
        } else {
            $temAcesso = (new FilialRepository())->podeAcessar(
                (int) $user['id_usuario'],
                (int) $user['id_loja'],
                self::ehAdministrador(),
                (int) $idFilial
            );
        }
        if (!$temAcesso) {
            self::reabrirSessao();
            unset($_SESSION['id_filial']);
            self::liberarSessao();
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
        if (isset($_SESSION['admin_plataforma'])) {
            self::logout();
            Response::json(['erro' => 'Não autenticado'], 401);
            exit;
        }
        $user = self::user();
        if ($user === null) {
            Response::json(['erro' => 'Não autenticado'], 401);
            exit;
        }

        // Solta o lock ANTES de ir ao banco. Antes ele só era solto depois
        // da consulta abaixo, e as 5 a 10 chamadas que cada tela dispara ao
        // mesmo tempo esperavam, uma a uma, a conexão com o MySQL remoto
        // mais essa consulta. $_SESSION continua legível; se algo precisar
        // ser gravado, a sessão é reaberta só para isso.
        self::liberarSessao();

        // Usuário, permissões e acesso à filial da sessão numa consulta só
        // (ver UsuarioRepository::estadoDaSessao()).
        $idFilial = (int) ($_SESSION['id_filial'] ?? 0);
        $atual = (new UsuarioRepository())->estadoDaSessao($user['id_usuario'], $idFilial);
        if ($atual === null || $atual['status'] !== 'ativo') {
            self::logout();
            Response::json(['erro' => 'Sua conta foi desativada ou removida. Faça login novamente.'], 401);
            exit;
        }
        if ($atual['status_loja'] === 'suspensa') {
            self::logout();
            Response::json([
                'erro' => 'O acesso deste mercado está suspenso. Entre em contato com o suporte Hydra.',
                'codigo' => 'loja_suspensa',
            ], 403);
            exit;
        }

        // Reespelha cargo e permissões, para que mudanças feitas na tela
        // de Cargos valham na próxima requisição, sem precisar relogar.
        $idCargo = $atual['id_cargo'] !== null ? (int) $atual['id_cargo'] : null;
        $estado = [
            'perfil' => $atual['perfil'],
            'nome' => $atual['nome'],
            'email' => $atual['email'],
            'id_cargo' => $idCargo,
            'permissoes' => $idCargo !== null && $atual['permissoes'] !== null
                ? explode(',', (string) $atual['permissoes'])
                : [],
        ];
        $mudou = false;
        foreach ($estado as $chave => $valor) {
            if (($_SESSION[$chave] ?? null) !== $valor) {
                $mudou = true;
                break;
            }
        }
        // Só reabre a sessão (e retoma o lock) quando algo mudou de fato,
        // o que é raro: no caso comum a requisição nem toca no arquivo.
        if ($mudou) {
            self::reabrirSessao();
            foreach ($estado as $chave => $valor) {
                $_SESSION[$chave] = $valor;
            }
            self::liberarSessao();
        }
        // Guardado para requireFilial() não repetir a consulta.
        self::$acessoFilial = $idFilial > 0
            ? [
                'id_filial' => $idFilial,
                'ativa' => (int) $atual['filial_ativa'] === 1,
                'vinculada' => (int) $atual['filial_vinculada'] === 1,
            ]
            : null;

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
