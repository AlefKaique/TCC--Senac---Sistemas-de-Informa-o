<?php

namespace Hydra\Controllers;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Support\Auth;
use Hydra\Support\PasswordPolicy;
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

    public function __construct()
    {
        $this->usuarios = new UsuarioRepository();
        $this->cargos = new CargoRepository();
    }

    /**
     * GET /api/usuarios
     * Devolve também os cargos da loja (id, nome, cor) para preencher o
     * seletor de cargo da tela, poupando uma segunda chamada a
     * GET /api/cargos.
     */
    public function index(): void
    {
        $admin = Auth::requirePermission('equipe.gerenciar');
        $this->cargos->ensureDefaults($admin['id_loja']);
        Response::json([
            'usuarios' => $this->usuarios->listByLoja($admin['id_loja']),
            'cargos' => $this->cargos->listByLoja($admin['id_loja']),
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

        $id = $this->usuarios->create(
            $admin['id_loja'],
            $nome,
            $email,
            password_hash($senha, PASSWORD_BCRYPT),
            $perfil,
            $idCargo
        );

        Response::json(['usuario' => $this->usuarios->findPublic($id)], 201);
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

        $this->usuarios->update($id, [
            'nome' => $nome,
            'email' => $email,
            'perfil' => $perfil,
            'status' => $status,
            'id_cargo' => $idCargo,
        ]);
        Response::json(['usuario' => $this->usuarios->findPublic($id)]);
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
