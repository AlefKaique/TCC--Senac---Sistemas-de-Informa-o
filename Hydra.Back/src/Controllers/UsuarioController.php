<?php

namespace Hydra\Controllers;

use Hydra\Repositories\UsuarioRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Tela "Gerenciar Usuários" (Equipe) — RN04: somente Administrador.
 */
final class UsuarioController
{
    private UsuarioRepository $usuarios;

    public function __construct()
    {
        $this->usuarios = new UsuarioRepository();
    }

    /** GET /api/usuarios */
    public function index(): void
    {
        $admin = Auth::requireAdmin();
        Response::json(['usuarios' => $this->usuarios->listByLoja($admin['id_loja'])]);
    }

    /**
     * POST /api/usuarios
     * Novo usuário — vinculado automaticamente à loja do administrador
     * logado (id_loja), sem pedir "Nome da loja" novamente. Perfil
     * restrito a operador_caixa/estoquista: o único administrador
     * criado diretamente é o do onboarding (Fig. 13).
     */
    public function store(): void
    {
        $admin = Auth::requireAdmin();
        $dados = Request::json();

        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');
        $perfil = (string) ($dados['perfil'] ?? '');

        if ($nome === '' || $email === '') {
            Response::json(['erro' => 'Preencha nome e e-mail'], 422);
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
        if (!in_array($perfil, ['operador_caixa', 'estoquista'], true)) {
            Response::json(['erro' => 'Perfil inválido — escolha Operador de Caixa ou Estoquista'], 422);
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
            $perfil
        );

        Response::json(['usuario' => $this->usuarios->findPublic($id)], 201);
    }

    /** PUT /api/usuarios/{id} */
    public function update(int $id): void
    {
        $admin = Auth::requireAdmin();
        $usuario = $this->usuarios->findInLoja($id, $admin['id_loja']);
        if ($usuario === null) {
            Response::json(['erro' => 'Usuário não encontrado'], 404);
            return;
        }

        $dados = Request::json();
        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $perfil = (string) ($dados['perfil'] ?? '');
        $status = (string) ($dados['status'] ?? '');

        if ($nome === '' || $email === '') {
            Response::json(['erro' => 'Preencha nome e e-mail'], 422);
            return;
        }
        if (!in_array($perfil, ['administrador', 'operador_caixa', 'estoquista'], true)) {
            Response::json(['erro' => 'Perfil inválido'], 422);
            return;
        }
        if (!in_array($status, ['ativo', 'inativo'], true)) {
            Response::json(['erro' => 'Status inválido'], 422);
            return;
        }

        // Evita que a loja fique sem nenhum administrador ativo.
        $perdendoAdmin = $usuario['perfil'] === 'administrador'
            && ($perfil !== 'administrador' || $status !== 'ativo');
        if ($perdendoAdmin && $this->usuarios->countAdminsAtivos($admin['id_loja']) <= 1) {
            Response::json(['erro' => 'A loja precisa ter pelo menos um administrador ativo'], 422);
            return;
        }

        $this->usuarios->update($id, compact('nome', 'email', 'perfil', 'status'));
        Response::json(['usuario' => $this->usuarios->findPublic($id)]);
    }

    /** DELETE /api/usuarios/{id} — RN21: a confirmação prévia é feita no front-end. */
    public function destroy(int $id): void
    {
        $admin = Auth::requireAdmin();
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
