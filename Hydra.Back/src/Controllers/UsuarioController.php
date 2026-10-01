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
 * "usuarios.gerenciar" (concedida ao cargo Administrador por padrão).
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
     * seletor de cargo da tela — sem exigir a permissão "cargos.gerenciar"
     * (que é só para a tela de administração de Cargos em si).
     */
    public function index(): void
    {
        $admin = Auth::requirePermission('usuarios.gerenciar');
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
     * a um Cargo da tela "Cargos". O nível equivalente do cargo escolhido
     * não pode ser "administrador": o único administrador criado
     * diretamente é o do onboarding (Fig. 13) — promover alguém a um
     * cargo administrativo é feito depois, editando o usuário.
     */
    public function store(): void
    {
        $admin = Auth::requirePermission('usuarios.gerenciar');
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
        $perfil = CargoRepository::nivelEquivalente($cargo['permissoes']);
        if ($perfil === 'administrador') {
            Response::json(['erro' => 'Não é possível criar um usuário com cargo administrativo por aqui — cadastre com outro cargo e promova depois, editando o usuário'], 422);
            return;
        }
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
        $admin = Auth::requirePermission('usuarios.gerenciar');
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

    /** DELETE /api/usuarios/{id} — RN21: a confirmação prévia é feita no front-end. */
    public function destroy(int $id): void
    {
        $admin = Auth::requirePermission('usuarios.gerenciar');
        $usuario = $this->usuarios->findInLoja($id, $admin['id_loja']);
        if ($usuario === null) {
            Response::json(['erro' => 'Usuário não encontrado'], 404);
            return;
        }
        if ($id === $admin['id_usuario']) {
            Response::json(['erro' => 'Você não pode excluir sua própria conta'], 422);
            return;
        }
        if ($usuario['perfil'] === 'administrador' && $this->usuarios->countAdminsAtivos($admin['id_loja']) <= 1) {
            Response::json(['erro' => 'A loja precisa ter pelo menos um administrador ativo'], 422);
            return;
        }

        $this->usuarios->delete($id);
        Response::json(['ok' => true]);
    }
}
