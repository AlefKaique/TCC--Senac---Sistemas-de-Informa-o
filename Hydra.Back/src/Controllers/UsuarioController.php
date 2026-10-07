<?php

namespace Hydra\Controllers;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Support\Auth;
use Hydra\Support\Migracoes;
use Hydra\Support\PasswordPolicy;
use Hydra\Support\SenhaAutorizacao;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Tela "Gerenciar Usuários" (Equipe) — restrita a quem tem a permissão
 * de Usuários (usuarios.*), concedidas ao cargo Administrador por padrão.
 * Cada usuário é associado a um Cargo (ver tela "Cargos" e
 * CargoRepository) em vez de um "perfil" de texto livre; o "perfil"
 * legado continua sendo gravado, mas é apenas um reflexo automático das
 * permissões do cargo escolhido (ver CargoRepository::nivelEquivalente()).
 */
final class UsuarioController
{
    private UsuarioRepository $usuarios;
    private CargoRepository $cargos;
    private FilialRepository $filiais;

    public function __construct()
    {
        // Coluna senha_autorizacao em bancos já em uso. No construtor, antes
        // das transações de store()/update(): DDL faz commit implícito.
        Migracoes::garantirCancelamentoDeVendas();
        $this->usuarios = new UsuarioRepository();
        $this->cargos = new CargoRepository();
        $this->filiais = new FilialRepository();
    }

    /**
     * Confere a senha de autorização vinda da tela. Devolve o erro (já
     * enviado como resposta) ou null se ela pode ser gravada.
     *
     * O PIN precisa ser único na loja: a tela de cancelamento pede só o
     * PIN, e é ele que identifica quem autorizou.
     */
    private function senhaAutorizacaoInvalida(string $senha, int $idLoja, ?int $idUsuario): bool
    {
        $erro = SenhaAutorizacao::validarFormato($senha);
        if ($erro !== null) {
            Response::json(['erro' => $erro], 422);
            return true;
        }
        $dono = SenhaAutorizacao::encontrarAutorizador($idLoja, $senha);
        if ($dono !== null && (int) $dono['id_usuario'] !== $idUsuario) {
            Response::json(['erro' => 'Esta senha de autorização já é usada por outra pessoa da equipe. Escolha outra.'], 409);
            return true;
        }
        return false;
    }

    /**
     * GET /api/usuarios
     * Devolve também os cargos da loja (id, nome, cor) para preencher o
     * seletor de cargo da tela, e as filiais da loja para as caixas de
     * "Filiais que pode acessar" — poupando chamadas a GET /api/cargos e
     * GET /api/filiais. Cada usuário vem com "filiais" (ids vinculados) e
     * cada cargo com "administrador", calculado por
     * CargoRepository::nivelEquivalente: é o que a tela usa para travar as
     * caixas de filial, com o mesmo critério do back-end.
     */
    public function index(): void
    {
        $admin = Auth::requirePermission('equipe.gerenciar');
        $this->cargos->ensureDefaults($admin['id_loja']);

        $vinculos = $this->filiais->idsPorUsuarioDaLoja($admin['id_loja']);
        $usuarios = $this->usuarios->listByLoja($admin['id_loja']);
        foreach ($usuarios as &$usuario) {
            $usuario['filiais'] = $vinculos[(int) $usuario['id_usuario']] ?? [];
        }
        unset($usuario);

        $cargos = $this->cargos->listByLoja($admin['id_loja']);
        foreach ($cargos as &$cargo) {
            $cargo['administrador'] = CargoRepository::nivelEquivalente($cargo['permissoes'] ?? []) === 'administrador';
        }
        unset($cargo);

        Response::json([
            'usuarios' => $usuarios,
            'cargos' => $cargos,
            'filiais' => array_map(
                fn ($f) => ['id_filial' => (int) $f['id_filial'], 'nome' => $f['nome'], 'status' => $f['status']],
                $this->filiais->listByLoja($admin['id_loja'])
            ),
        ]);
    }

    /**
     * POST /api/usuarios
     * Novo usuário — vinculado automaticamente à loja do administrador
     * logado (id_loja), sem pedir "Nome da loja" novamente, e associado
     * a um Cargo da tela "Cargos" — qualquer um dos cargos da loja, de
     * sistema ou personalizado. O "perfil" legado é derivado das
     * permissões desse cargo (CargoRepository::nivelEquivalente()).
     */
    public function store(): void
    {
        $admin = Auth::requirePermission('equipe.gerenciar');
        $dados = Request::json();

        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');
        $idCargo = (int) ($dados['id_cargo'] ?? 0);

        if ($nome === '' || $email === '') {
            Response::json(['erro' => 'Preencha nome e e-mail'], 422);
            return;
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            Response::json(['erro' => 'E-mail inválido'], 422);
            return;
        }
        $erroSenha = PasswordPolicy::validar($senha);
        if ($erroSenha !== null) {
            Response::json(['erro' => $erroSenha], 422);
            return;
        }

        $cargo = $this->cargos->find($idCargo, $admin['id_loja']);
        if ($cargo === null) {
            Response::json(['erro' => 'Selecione um cargo válido'], 422);
            return;
        }
        // Qualquer cargo da loja pode ser atribuído aqui, inclusive os
        // administrativos: a recusa que existia antes só criava um desvio
        // (cadastrar com outro cargo e editar em seguida), porque PUT
        // /api/usuarios/{id} sempre aceitou o mesmo cargo. Quem chega até
        // aqui já tem "equipe.gerenciar".
        $perfil = CargoRepository::nivelEquivalente($cargo['permissoes']);
        if ($this->usuarios->emailExists($email)) {
            Response::json(['erro' => 'Já existe uma conta com este e-mail'], 409);
            return;
        }
        $idsFiliais = $this->filiaisInformadas($dados, $admin['id_loja']);
        if ($idsFiliais === false) {
            Response::json(['erro' => 'Uma das filiais selecionadas não existe'], 422);
            return;
        }
        // Opcional: só gerente/administrador recebe (libera o cancelamento
        // de venda na tela Vendas).
        $senhaAutorizacao = trim((string) ($dados['senha_autorizacao'] ?? ''));
        if ($senhaAutorizacao !== '' && $this->senhaAutorizacaoInvalida($senhaAutorizacao, $admin['id_loja'], null)) {
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $id = $this->usuarios->create(
                $admin['id_loja'],
                $nome,
                $email,
                password_hash($senha, PASSWORD_BCRYPT),
                $perfil,
                $idCargo
            );
            // Administrador acessa todas as filiais pelo cargo: as caixas de
            // filial chegam desabilitadas da tela e não são gravadas.
            if ($perfil !== 'administrador' && $idsFiliais !== null) {
                $this->filiais->definirVinculos($id, $idsFiliais);
            }
            if ($senhaAutorizacao !== '') {
                $this->usuarios->setSenhaAutorizacao($id, password_hash($senhaAutorizacao, PASSWORD_BCRYPT));
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível cadastrar o usuário'], 500);
            return;
        }

        Response::json(['usuario' => $this->usuarioComFiliais($id)], 201);
    }

    /** PUT /api/usuarios/{id} */
    public function update(int $id): void
    {
        $admin = Auth::requirePermission('equipe.gerenciar');
        $usuario = $this->usuarios->findInLoja($id, $admin['id_loja']);
        if ($usuario === null) {
            Response::json(['erro' => 'Usuário não encontrado'], 404);
            return;
        }

        $dados = Request::json();
        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $idCargo = (int) ($dados['id_cargo'] ?? 0);
        $status = (string) ($dados['status'] ?? '');

        if ($nome === '' || $email === '') {
            Response::json(['erro' => 'Preencha nome e e-mail'], 422);
            return;
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            Response::json(['erro' => 'E-mail inválido'], 422);
            return;
        }
        // "email" é UNIQUE no banco: sem esta checagem, informar um e-mail
        // já usado estourava a constraint e virava um 500 genérico, em vez
        // de dizer ao administrador o que estava errado.
        if ($email !== $usuario['email'] && $this->usuarios->emailExists($email)) {
            Response::json(['erro' => 'Já existe uma conta com este e-mail'], 409);
            return;
        }
        $cargo = $this->cargos->find($idCargo, $admin['id_loja']);
        if ($cargo === null) {
            Response::json(['erro' => 'Selecione um cargo válido'], 422);
            return;
        }
        if (!in_array($status, ['ativo', 'inativo'], true)) {
            Response::json(['erro' => 'Status inválido'], 422);
            return;
        }
        $perfil = CargoRepository::nivelEquivalente($cargo['permissoes']);

        // Mesma proteção que o antigo DELETE /api/usuarios/{id} tinha, agora
        // no caminho do status: desativar a própria conta mata a própria
        // sessão na requisição seguinte (Auth::requireLogin()), e o admin
        // descobre isso sendo expulso para o login. A trava de administrador
        // ativo abaixo não cobre este caso quando existe um segundo admin.
        if ($id === $admin['id_usuario'] && $status !== 'ativo') {
            Response::json(['erro' => 'Você não pode desativar sua própria conta'], 422);
            return;
        }

        // Evita que a loja fique sem nenhum administrador ativo.
        $perdendoAdmin = $usuario['perfil'] === 'administrador'
            && ($perfil !== 'administrador' || $status !== 'ativo');
        if ($perdendoAdmin && $this->usuarios->countAdminsAtivos($admin['id_loja']) <= 1) {
            Response::json(['erro' => 'A loja precisa ter pelo menos um administrador ativo'], 422);
            return;
        }

        $idsFiliais = $this->filiaisInformadas($dados, $admin['id_loja']);
        if ($idsFiliais === false) {
            Response::json(['erro' => 'Uma das filiais selecionadas não existe'], 422);
            return;
        }
        // Senha de autorização: em branco mantém a atual; "remover" apaga.
        $removerSenhaAutorizacao = !empty($dados['remover_senha_autorizacao']);
        $senhaAutorizacao = $removerSenhaAutorizacao ? '' : trim((string) ($dados['senha_autorizacao'] ?? ''));
        if ($senhaAutorizacao !== '' && $this->senhaAutorizacaoInvalida($senhaAutorizacao, $admin['id_loja'], $id)) {
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $this->usuarios->update($id, [
                'nome' => $nome,
                'email' => $email,
                'perfil' => $perfil,
                'status' => $status,
                'id_cargo' => $idCargo,
            ]);
            // Para o Administrador os vínculos ficam como estão: ele não
            // precisa deles, e eles voltam a valer se um dia deixar de ser.
            if ($perfil !== 'administrador' && $idsFiliais !== null) {
                $this->filiais->definirVinculos($id, $idsFiliais);
            }
            if ($removerSenhaAutorizacao) {
                $this->usuarios->setSenhaAutorizacao($id, null);
            } elseif ($senhaAutorizacao !== '') {
                $this->usuarios->setSenhaAutorizacao($id, password_hash($senhaAutorizacao, PASSWORD_BCRYPT));
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível salvar o usuário'], 500);
            return;
        }

        Response::json(['usuario' => $this->usuarioComFiliais($id)]);
    }

    /**
     * Lista "filiais" (ids) enviada pela tela, já validada: null quando a
     * chave não veio (os vínculos ficam como estão), false quando algum id
     * não é filial desta loja.
     *
     * @param array<string,mixed> $dados
     * @return int[]|null|false
     */
    private function filiaisInformadas(array $dados, int $idLoja): array|null|false
    {
        if (!array_key_exists('filiais', $dados)) {
            return null;
        }
        if (!is_array($dados['filiais'])) {
            return false;
        }
        $pedidos = array_values(array_unique(array_map('intval', $dados['filiais'])));
        $validos = $this->filiais->filtrarDaLoja($idLoja, $pedidos);
        return count($validos) === count($pedidos) ? $validos : false;
    }

    private function usuarioComFiliais(int $id): ?array
    {
        $usuario = $this->usuarios->findPublic($id);
        if ($usuario !== null) {
            $usuario['filiais'] = $this->filiais->idsDoUsuario($id);
        }
        return $usuario;
    }

    /*
     * Não existe exclusão de usuário. As vendas (vendas.id_usuario) e as
     * movimentações de estoque (movimentacoes_estoque.id_usuario) gravam
     * quem fez cada lançamento: apagar o funcionário apagaria a autoria do
     * histórico da loja. Para revogar o acesso de quem saiu, basta mudar o
     * status dele para "inativo" pela tela de Equipe — o login passa a ser
     * recusado (AuthController) e a sessão aberta cai na requisição
     * seguinte (Auth::requireLogin).
     */
}
