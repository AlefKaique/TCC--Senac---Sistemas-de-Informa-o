<?php

namespace Hydra\Controllers;

use Hydra\Repositories\MovimentacaoEstoqueRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Telas "Cadastro de Produto" e "Controle de Estoque" — RF02, RF03,
 * RF05, RF10, RF19. Acessível a Estoquista e Administrador.
 */
final class ProdutoController
{
    private ProdutoRepository $produtos;
    private MovimentacaoEstoqueRepository $movimentacoes;

    public function __construct()
    {
        $this->produtos = new ProdutoRepository();
        $this->movimentacoes = new MovimentacaoEstoqueRepository();
    }

    /** GET /api/produtos */
    public function index(): void
    {
        $user = Auth::requireEstoqueAccess();
        Response::json(['produtos' => $this->produtos->listByLoja($user['id_loja'])]);
    }

    /**
     * POST /api/produtos
     * Corresponde à tela "Cadastro de Produto" (Figura 25): registra o
     * produto e, se a quantidade inicial informada for maior que zero,
     * gera automaticamente um movimento de entrada (RF12).
     */
    public function store(): void
    {
        $user = Auth::requireEstoqueAccess();
        $dados = Request::json();

        $validado = $this->validar($dados);
        if ($validado['erro'] !== null) {
            Response::json(['erro' => $validado['erro']], 422);
            return;
        }
        $campos = $validado['campos'];

        if (
            $campos['codigo_barras'] !== null
            && $this->produtos->codigoBarrasExists($user['id_loja'], $campos['codigo_barras'])
        ) {
            Response::json(['erro' => 'Já existe um produto cadastrado com este código de barras'], 409);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $id = $this->produtos->create($user['id_loja'], $campos);
            if ($campos['quantidade'] > 0) {
                $this->movimentacoes->create(
                    $user['id_loja'],
                    $id,
                    $user['id_usuario'],
                    null,
                    'entrada',
                    (string) $campos['quantidade'],
                    'cadastro'
                );
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível cadastrar o produto'], 500);
            return;
        }

        Response::json(['produto' => $this->produtos->findInLoja($id, $user['id_loja'])], 201);
    }

    /**
     * PUT /api/produtos/{id}
     * A quantidade em estoque não é alterada por aqui — mudanças de
     * saldo passam pelo endpoint de movimentações (RF03/RF12), para
     * que toda variação fique registrada no histórico (RF10).
     */
    public function update(int $id): void
    {
        $user = Auth::requireEstoqueAccess();
        $produto = $this->produtos->findInLoja($id, $user['id_loja']);
        if ($produto === null) {
            Response::json(['erro' => 'Produto não encontrado'], 404);
            return;
        }

        $dados = Request::json();
        $validado = $this->validar($dados);
        if ($validado['erro'] !== null) {
            Response::json(['erro' => $validado['erro']], 422);
            return;
        }
        $campos = $validado['campos'];

        $status = (string) ($dados['status'] ?? 'ativo');
        if (!in_array($status, ['ativo', 'inativo'], true)) {
            Response::json(['erro' => 'Status inválido'], 422);
            return;
        }
        $campos['status'] = $status;

        // RN04 — só o Administrador pode alterar preços de produtos.
        // Estoquista pode editar os demais campos normalmente, desde que
        // reenvie os preços atuais sem modificá-los.
        $precoCustoAtual = $produto['preco_custo'] !== null ? (float) $produto['preco_custo'] : null;
        $precoVendaMudou = abs($campos['preco_venda'] - (float) $produto['preco_venda']) > 0.001;
        $precoCustoMudou = $campos['preco_custo'] !== $precoCustoAtual
            && abs(($campos['preco_custo'] ?? 0) - ($precoCustoAtual ?? 0)) > 0.001;
        if ($user['perfil'] !== 'administrador' && ($precoVendaMudou || $precoCustoMudou)) {
            Response::json(['erro' => 'Apenas o Administrador pode alterar preços de produtos (RN04)'], 403);
            return;
        }

        if (
            $campos['codigo_barras'] !== null
            && $this->produtos->codigoBarrasExists($user['id_loja'], $campos['codigo_barras'], $id)
        ) {
            Response::json(['erro' => 'Já existe um produto cadastrado com este código de barras'], 409);
            return;
        }

        $this->produtos->update($id, $campos);
        Response::json(['produto' => $this->produtos->findInLoja($id, $user['id_loja'])]);
    }

    /**
     * DELETE /api/produtos/{id}
     * RN03 — se o produto já estiver vinculado a alguma venda, ele é
     * apenas inativado (preserva o histórico financeiro); caso
     * contrário, é removido definitivamente. RN20: a confirmação
     * prévia é feita no front-end.
     */
    public function destroy(int $id): void
    {
        $user = Auth::requireEstoqueAccess();
        $produto = $this->produtos->findInLoja($id, $user['id_loja']);
        if ($produto === null) {
            Response::json(['erro' => 'Produto não encontrado'], 404);
            return;
        }

        if ($this->produtos->possuiVendas($id)) {
            $this->produtos->inativar($id);
            Response::json(['ok' => true, 'inativado' => true]);
            return;
        }

        $this->produtos->delete($id);
        Response::json(['ok' => true, 'inativado' => false]);
    }

    /** GET /api/produtos/{id}/movimentacoes — RF10 */
    public function movimentacoes(int $id): void
    {
        $user = Auth::requireEstoqueAccess();
        $produto = $this->produtos->findInLoja($id, $user['id_loja']);
        if ($produto === null) {
            Response::json(['erro' => 'Produto não encontrado'], 404);
            return;
        }

        Response::json(['movimentacoes' => $this->movimentacoes->listByProduto($id, $user['id_loja'])]);
    }

    /**
     * @param array<string,mixed> $dados
     * @return array{erro:?string,campos:array<string,mixed>}
     */
    private function validar(array $dados): array
    {
        $nome = trim((string) ($dados['nome'] ?? ''));
        $categoria = trim((string) ($dados['categoria'] ?? ''));
        $codigoBarras = trim((string) ($dados['codigo_barras'] ?? ''));
        $unidade = trim((string) ($dados['unidade'] ?? 'un')) ?: 'un';
        $validade = trim((string) ($dados['validade'] ?? ''));
        $descricao = trim((string) ($dados['descricao'] ?? ''));

        $precoCusto = $dados['preco_custo'] ?? null;
        $precoVenda = $dados['preco_venda'] ?? null;
        $quantidade = $dados['quantidade'] ?? null;
        $estoqueMinimo = $dados['estoque_minimo'] ?? 0;

        if ($nome === '' || $categoria === '') {
            return ['erro' => 'Preencha o nome e a categoria do produto', 'campos' => []];
        }
        if (!is_numeric($precoVenda) || (float) $precoVenda <= 0) {
            return ['erro' => 'Informe um preço de venda válido', 'campos' => []];
        }
        if (!is_numeric($quantidade) || (float) $quantidade < 0) {
            return ['erro' => 'Informe uma quantidade em estoque válida', 'campos' => []];
        }
        if ($estoqueMinimo !== null && $estoqueMinimo !== '' && (!is_numeric($estoqueMinimo) || (float) $estoqueMinimo < 0)) {
            return ['erro' => 'Estoque mínimo inválido', 'campos' => []];
        }
        if ($validade !== '' && \DateTime::createFromFormat('Y-m-d', $validade) === false) {
            return ['erro' => 'Data de validade inválida', 'campos' => []];
        }

        return [
            'erro' => null,
            'campos' => [
                'nome' => $nome,
                'descricao' => $descricao !== '' ? $descricao : null,
                'codigo_barras' => $codigoBarras !== '' ? $codigoBarras : null,
                'categoria' => $categoria,
                'preco_custo' => ($precoCusto !== null && $precoCusto !== '' && is_numeric($precoCusto)) ? (float) $precoCusto : null,
                'preco_venda' => (float) $precoVenda,
                'quantidade' => (float) $quantidade,
                'estoque_minimo' => ($estoqueMinimo !== null && $estoqueMinimo !== '') ? (float) $estoqueMinimo : 0,
                'unidade' => $unidade,
                'validade' => $validade !== '' ? $validade : null,
            ],
        ];
    }
}
