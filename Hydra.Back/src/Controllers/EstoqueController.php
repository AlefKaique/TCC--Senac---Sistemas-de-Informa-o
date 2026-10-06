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

    /** GET /api/estoque/movimentacoes — usado pelo Dashboard (RF06). Leitura. */
    public function index(): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.consultar');
        Response::json(['movimentacoes' => $this->movimentacoes->listByFilial($user['id_filial'])]);
    }

    /** POST /api/estoque/movimentacoes — é aqui que o saldo muda, daí "estoque.lancar". */
    public function store(): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.lancar');
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

        $produto = $this->produtos->findInFilial($idProduto, $user['id_filial']);
        if ($produto === null) {
            Response::json(['erro' => 'Produto não encontrado'], 404);
            return;
        }

        $quantidade = (float) $quantidade;
        // Pré-checagem apenas para devolver um erro claro; quem realmente
        // garante o saldo é o UPDATE condicional dentro da transação.
        if ($tipo === 'saida' && $quantidade > (float) $produto['quantidade']) {
            Response::json(['erro' => 'Quantidade maior que o estoque disponível'], 422);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            if ($tipo === 'saida') {
                if (!$this->produtos->baixarQuantidadeSeHouver($idProduto, $quantidade)) {
                    $pdo->rollBack();
                    Response::json(['erro' => 'Quantidade maior que o estoque disponível'], 422);
                    return;
                }
            } else {
                $this->produtos->ajustarQuantidade($idProduto, $quantidade);
            }
            $this->movimentacoes->create(
                $user['id_loja'],
                $user['id_filial'],
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

        Response::json(['produto' => $this->produtos->findInFilial($idProduto, $user['id_filial'])], 201);
    }
}
