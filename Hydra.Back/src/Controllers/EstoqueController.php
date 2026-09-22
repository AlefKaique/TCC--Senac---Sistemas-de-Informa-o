<?php

namespace Hydra\Controllers;

use Hydra\Repositories\MovimentacaoEstoqueRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Botões globais "Entrada de Estoque" / "Saída de Estoque" da tela de
 * Controle de Estoque — RF03, RF12. Também é o endpoint usado para
 * ajustar a quantidade de um produto ao salvar a tela de edição.
 */
final class EstoqueController
{
    private ProdutoRepository $produtos;
    private MovimentacaoEstoqueRepository $movimentacoes;

    public function __construct()
    {
        $this->produtos = new ProdutoRepository();
        $this->movimentacoes = new MovimentacaoEstoqueRepository();
    }

    /** GET /api/estoque/movimentacoes — usado pelo Dashboard (RF06). */
    public function index(): void
    {
        $user = Auth::requireEstoqueAccess();
        Response::json(['movimentacoes' => $this->movimentacoes->listByLoja($user['id_loja'])]);
    }

    /** POST /api/estoque/movimentacoes */
    public function store(): void
    {
        $user = Auth::requireEstoqueAccess();
        $dados = Request::json();

        $idProduto = (int) ($dados['id_produto'] ?? 0);
        $tipo = (string) ($dados['tipo'] ?? '');
        $quantidade = $dados['quantidade'] ?? null;
        $origem = (string) ($dados['origem'] ?? 'ajuste_manual');

        if (!in_array($tipo, ['entrada', 'saida'], true)) {
            Response::json(['erro' => 'Tipo de movimentação inválido'], 422);
            return;
        }
        if (!is_numeric($quantidade) || (float) $quantidade <= 0) {
            Response::json(['erro' => 'Informe uma quantidade válida'], 422);
            return;
        }
        if (!in_array($origem, ['ajuste_manual', 'cadastro'], true)) {
            Response::json(['erro' => 'Origem de movimentação inválida'], 422);
            return;
        }

        $produto = $this->produtos->findInLoja($idProduto, $user['id_loja']);
        if ($produto === null) {
            Response::json(['erro' => 'Produto não encontrado'], 404);
            return;
        }

        $quantidade = (float) $quantidade;
        if ($tipo === 'saida' && $quantidade > (float) $produto['quantidade']) {
            Response::json(['erro' => 'Quantidade maior que o estoque disponível'], 422);
            return;
        }

        $delta = $tipo === 'entrada' ? $quantidade : -$quantidade;

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $this->produtos->ajustarQuantidade($idProduto, $delta);
            $this->movimentacoes->create(
                $user['id_loja'],
                $idProduto,
                $user['id_usuario'],
                null,
                $tipo,
                (string) $quantidade,
                $origem
            );
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível registrar a movimentação'], 500);
            return;
        }

        Response::json(['produto' => $this->produtos->findInLoja($idProduto, $user['id_loja'])], 201);
    }
}
