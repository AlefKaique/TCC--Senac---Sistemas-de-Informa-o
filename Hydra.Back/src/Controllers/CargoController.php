<?php

namespace Hydra\Controllers;

use Hydra\Repositories\CargoRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Tela "Cargos" (estilo Discord: cria o cargo, marca as permissões por
 * checkbox). Restrita a quem tem "equipe.gerenciar" — a mesma permissão da
 * tela de Equipe, porque são duas vistas da mesma autoridade: quem define
 * os cargos decide, na prática, o que cada funcionário pode fazer. Por
 * padrão só o cargo "Administrador" a possui.
 */
final class CargoController
{
    private CargoRepository $cargos;

    public function __construct()
    {
        $this->cargos = new CargoRepository();
    }

    /** GET /api/cargos — lista os cargos da loja + o catálogo de permissões disponíveis. */
    public function index(): void
    {
        $user = Auth::requirePermission('equipe.gerenciar');
        $this->cargos->ensureDefaults($user['id_loja']);

        Response::json([
            'cargos' => $this->cargos->listByLoja($user['id_loja']),
            'permissoes' => $this->cargos->permissoesCatalogo(),
        ]);
    }

    /** POST /api/cargos */
    public function store(): void
    {
        $user = Auth::requirePermission('equipe.gerenciar');
        $dados = Request::json();

        $validado = $this->validar($dados, $user['id_loja']);
        if ($validado['erro'] !== null) {
            Response::json(['erro' => $validado['erro']], 422);
            return;
        }

        $id = $this->cargos->create(
            $user['id_loja'],
            $validado['nome'],
            $validado['descricao'],
            $validado['cor'],
            $validado['codigos']
        );

        Response::json(['cargo' => $this->cargos->find($id, $user['id_loja'])], 201);
    }

    /** PUT /api/cargos/{id} */
    public function update(int $id): void
    {
        $user = Auth::requirePermission('equipe.gerenciar');
        $cargo = $this->cargos->find($id, $user['id_loja']);
        if ($cargo === null) {
            Response::json(['erro' => 'Cargo não encontrado'], 404);
            return;
        }

        $dados = Request::json();
        $validado = $this->validar($dados, $user['id_loja'], $id);
        if ($validado['erro'] !== null) {
            Response::json(['erro' => $validado['erro']], 422);
            return;
        }

        // Evita que a edição das permissões deixe a loja sem ninguém capaz
        // de administrar (ex.: tirar "Equipe e Cargos" do único cargo ativo
        // que concedia essa permissão — ninguém mais abriria estas telas
        // para desfazer a mudança).
        if (
            !in_array('equipe.gerenciar', $validado['codigos'], true)
            && $this->cargos->countUsuariosAtivos($id) > 0
            && $this->cargos->countUsuariosAtivosComPermissaoExcetoCargo($user['id_loja'], 'equipe.gerenciar', $id) === 0
        ) {
            Response::json(['erro' => 'A loja precisa manter pelo menos um cargo ativo com a permissão "Equipe e Cargos"'], 422);
            return;
        }

        // Cargos de sistema (Administrador, Operador de Caixa, Estoquista)
        // mantêm o nome fixo — mas o admin pode ajustar cor, descrição e
        // as permissões concedidas a eles.
        $nome = $cargo['cargo_sistema'] ? $cargo['nome'] : $validado['nome'];

        $this->cargos->update($id, $nome, $validado['descricao'], $validado['cor'], $validado['codigos']);
        Response::json(['cargo' => $this->cargos->find($id, $user['id_loja'])]);
    }

    /** DELETE /api/cargos/{id} */
    public function destroy(int $id): void
    {
        $user = Auth::requirePermission('equipe.gerenciar');
        $cargo = $this->cargos->find($id, $user['id_loja']);
        if ($cargo === null) {
            Response::json(['erro' => 'Cargo não encontrado'], 404);
            return;
        }
        if ($cargo['cargo_sistema']) {
            Response::json(['erro' => 'Cargos de sistema não podem ser excluídos'], 422);
            return;
        }
        if ($cargo['qtd_usuarios'] > 0) {
            Response::json(['erro' => 'Reatribua os usuários deste cargo antes de excluí-lo'], 422);
            return;
        }

        $this->cargos->delete($id);
        Response::json(['ok' => true]);
    }

    /**
     * @param array<string,mixed> $dados
     * @return array{erro:?string,nome:string,descricao:?string,cor:string,codigos:string[]}
     */
    private function validar(array $dados, int $idLoja, ?int $ignorarId = null): array
    {
        $nome = trim((string) ($dados['nome'] ?? ''));
        $descricao = trim((string) ($dados['descricao'] ?? ''));
        $cor = trim((string) ($dados['cor'] ?? '#5865F2'));
        $codigos = $dados['permissoes'] ?? [];

        if ($nome === '') {
            return ['erro' => 'Informe o nome do cargo', 'nome' => '', 'descricao' => null, 'cor' => '', 'codigos' => []];
        }
        if (mb_strlen($nome) > 60) {
            return ['erro' => 'O nome do cargo deve ter no máximo 60 caracteres', 'nome' => '', 'descricao' => null, 'cor' => '', 'codigos' => []];
        }
        if (!preg_match('/^#[0-9a-fA-F]{6}$/', $cor)) {
            return ['erro' => 'Cor inválida — use um código hexadecimal (#RRGGBB)', 'nome' => '', 'descricao' => null, 'cor' => '', 'codigos' => []];
        }
        if (!is_array($codigos)) {
            return ['erro' => 'Lista de permissões inválida', 'nome' => '', 'descricao' => null, 'cor' => '', 'codigos' => []];
        }
        if ($this->cargos->nomeExists($idLoja, $nome, $ignorarId)) {
            return ['erro' => 'Já existe um cargo com esse nome', 'nome' => '', 'descricao' => null, 'cor' => '', 'codigos' => []];
        }

        return [
            'erro' => null,
            'nome' => $nome,
            'descricao' => $descricao !== '' ? $descricao : null,
            'cor' => strtoupper($cor),
            'codigos' => array_values(array_unique(array_map('strval', $codigos))),
        ];
    }
}
