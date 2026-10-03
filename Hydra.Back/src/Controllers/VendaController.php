<?php

namespace Hydra\Controllers;

use Hydra\Repositories\MovimentacaoEstoqueRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Repositories\VendaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Tela "Caixa" (PDV) — RF04, RF09, RF12, RF13, RN01, RN07-RN11, RN15.
 */
final class VendaController
{
    private const FORMAS_PAGAMENTO = ['pix', 'cartao_credito', 'cartao_debito', 'vale_refeicao', 'dinheiro'];

    private VendaRepository $vendas;
    private ProdutoRepository $produtos;
    private MovimentacaoEstoqueRepository $movimentacoes;

    public function __construct()
    {
        $this->vendas = new VendaRepository();
        $this->produtos = new ProdutoRepository();
        $this->movimentacoes = new MovimentacaoEstoqueRepository();
    }

    /**
     * GET /api/vendas — histórico de vendas (RF10), com itens e pagamentos
     * embutidos.
     *
     * Aceita também "relatorios.visualizar" porque o Dashboard calcula o
     * faturamento a partir desta lista: um cargo criado só para acompanhar
     * os números da loja não deve levar 403 aqui, nem precisar da permissão
     * de abrir o histórico item a item.
     */
    public function index(): void
    {
        $user = Auth::requireAnyPermission(['vendas.historico', 'relatorios.visualizar']);
        $vendas = $this->vendas->listByLoja($user['id_loja']);
        foreach ($vendas as &$venda) {
            $venda['itens'] = $this->vendas->listItensByVenda((int) $venda['id_venda']);
            $venda['pagamentos'] = $this->vendas->listPagamentosByVenda((int) $venda['id_venda']);
        }
        unset($venda);

        // O Caixa precisa saber qual número a próxima venda vai receber
        // para montar o cabeçalho "Pedido #N" antes de a venda existir.
        Response::json([
            'vendas' => $vendas,
            'proximo_numero' => $this->vendas->proximoNumero($user['id_loja']),
        ]);
    }

    /**
     * POST /api/vendas
     * Finaliza uma venda (RF04): valida disponibilidade de estoque
     * (RN01/RN08) e forma(s) de pagamento (RN09/RN10), grava a venda
     * com seus itens e pagamentos, baixa o estoque de cada produto e
     * registra o movimento de saída correspondente (RF12/RN11) — tudo
     * em uma única transação.
     */
    public function store(): void
    {
        $user = Auth::requirePermission('vendas.operar');
        $dados = Request::json();

        $itensEntrada = $dados['itens'] ?? [];
        $pagamentosEntrada = $dados['pagamentos'] ?? [];
        $idCliente = isset($dados['id_cliente']) && $dados['id_cliente'] !== null ? (int) $dados['id_cliente'] : null;
        $descontoInformado = $dados['desconto'] ?? 0;

        if (!is_array($itensEntrada) || count($itensEntrada) === 0) {
            Response::json(['erro' => 'Adicione ao menos um item à venda'], 422);
            return;
        }
        if (!is_array($pagamentosEntrada) || count($pagamentosEntrada) === 0) {
            Response::json(['erro' => 'Selecione a forma de pagamento'], 422);
            return;
        }
        if (!is_numeric($descontoInformado) || (float) $descontoInformado < 0) {
            Response::json(['erro' => 'Desconto inválido'], 422);
            return;
        }
        // O desconto não tem permissão própria: "vendas.aplicar_desconto"
        // foi retirada do catálogo porque a tela do Caixa não oferece
        // campo de desconto. Quem pode registrar a venda informa o
        // desconto junto com ela, e o valor continua sendo validado acima.

        foreach ($pagamentosEntrada as $pagamento) {
            $forma = (string) ($pagamento['forma_pagamento'] ?? '');
            $valor = $pagamento['valor'] ?? null;
            if (!in_array($forma, self::FORMAS_PAGAMENTO, true)) {
                Response::json(['erro' => 'Forma de pagamento inválida'], 422);
                return;
            }
            if (!is_numeric($valor) || (float) $valor <= 0) {
                Response::json(['erro' => 'Valor de pagamento inválido'], 422);
                return;
            }
        }

        // Soma as linhas que repetem o mesmo produto ANTES de validar o
        // estoque. Sem isso, cada linha era conferida contra o saldo
        // inteiro: com 10 em estoque, duas linhas de 8 passavam as duas e
        // a venda baixava 16.
        $quantidadePorProduto = [];
        foreach ($itensEntrada as $item) {
            $idProduto = (int) ($item['id_produto'] ?? 0);
            $quantidade = $item['quantidade'] ?? null;
            if (!is_numeric($quantidade) || (float) $quantidade <= 0) {
                Response::json(['erro' => 'Quantidade inválida em um dos itens'], 422);
                return;
            }
            $quantidadePorProduto[$idProduto] = ($quantidadePorProduto[$idProduto] ?? 0.0) + (float) $quantidade;
        }

        // Recalcula os preços a partir do produto no banco — nunca confia no
        // preço enviado pelo cliente.
        $itensValidados = [];
        $subtotal = 0.0;
        foreach ($quantidadePorProduto as $idProduto => $quantidade) {
            $produto = $this->produtos->findInLoja($idProduto, $user['id_loja']);
            if ($produto === null || $produto['status'] !== 'ativo') {
                Response::json(['erro' => 'Produto indisponível para venda'], 422);
                return;
            }
            // RN01/RN08 — disponibilidade de estoque.
            if ($quantidade > (float) $produto['quantidade']) {
                Response::json(['erro' => "Quantidade em estoque insuficiente para \"{$produto['nome']}\""], 422);
                return;
            }

            $precoUnitario = (float) $produto['preco_venda'];
            $subtotal += $precoUnitario * $quantidade;
            $itensValidados[] = [
                'id_produto' => $idProduto,
                'quantidade' => $quantidade,
                'preco_unitario' => $precoUnitario,
            ];
        }

        $desconto = min((float) $descontoInformado, $subtotal);
        $valorTotal = round($subtotal - $desconto, 2);

        $somaPagamentos = array_reduce($pagamentosEntrada, fn ($soma, $p) => $soma + (float) $p['valor'], 0.0);
        // RN09 — a venda só é finalizada com pagamento(s) cuja soma cubra o total.
        if (abs($somaPagamentos - $valorTotal) > 0.01) {
            Response::json(['erro' => 'A soma dos pagamentos deve ser igual ao total da venda'], 422);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $idVenda = $this->vendas->create(
                $user['id_loja'],
                $user['id_usuario'],
                $idCliente,
                round($subtotal, 2),
                round($desconto, 2),
                $valorTotal
            );

            foreach ($itensValidados as $item) {
                // A verificação acima serve para a mensagem de erro; a
                // garantia real vem deste UPDATE condicional, que impede
                // duas vendas simultâneas de zerarem o mesmo saldo.
                if (!$this->produtos->baixarQuantidadeSeHouver($item['id_produto'], $item['quantidade'])) {
                    throw new \RuntimeException('Estoque insuficiente para o produto ' . $item['id_produto']);
                }
                $this->vendas->addItem($idVenda, $item['id_produto'], $item['quantidade'], $item['preco_unitario']);
                $this->movimentacoes->create(
                    $user['id_loja'],
                    $item['id_produto'],
                    $user['id_usuario'],
                    $idVenda,
                    'saida',
                    (string) $item['quantidade'],
                    'venda'
                );
            }

            foreach ($pagamentosEntrada as $pagamento) {
                $this->vendas->addPagamento($idVenda, (string) $pagamento['forma_pagamento'], (float) $pagamento['valor']);
            }

            $pdo->commit();
        } catch (\RuntimeException $e) {
            // Estoque esgotado entre a validação e a baixa (outra venda
            // simultânea levou as últimas unidades).
            $pdo->rollBack();
            Response::json(['erro' => 'O estoque de um dos produtos acabou durante a finalização. Confira as quantidades e tente de novo.'], 409);
            return;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível registrar a venda'], 500);
            return;
        }

        $venda = $this->vendas->findInLoja($idVenda, $user['id_loja']);
        $venda['itens'] = $this->vendas->listItensByVenda($idVenda);
        $venda['pagamentos'] = $this->vendas->listPagamentosByVenda($idVenda);

        Response::json(['venda' => $venda], 201);
    }
}
