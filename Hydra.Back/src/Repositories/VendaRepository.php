<?php

namespace Hydra\Repositories;

/**
 * Tela "Caixa" (PDV) — RF04, RF09, RF12, RF13.
 */
final class VendaRepository
{
    public function create(int $idLoja, int $idUsuario, ?int $idCliente, float $subtotal, float $desconto, float $valorTotal): int
    {
        $stmt = db()->prepare(
            'INSERT INTO vendas (id_loja, id_usuario, id_cliente, subtotal, desconto, valor_total)
             VALUES (:id_loja, :id_usuario, :id_cliente, :subtotal, :desconto, :valor_total)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_usuario' => $idUsuario,
            'id_cliente' => $idCliente,
            'subtotal' => $subtotal,
            'desconto' => $desconto,
            'valor_total' => $valorTotal,
        ]);
        return (int) db()->lastInsertId();
    }

    public function addItem(int $idVenda, int $idProduto, float $quantidade, float $precoUnitario): void
    {
        $stmt = db()->prepare(
            'INSERT INTO itens_venda (id_venda, id_produto, quantidade, preco_unitario)
             VALUES (:id_venda, :id_produto, :quantidade, :preco_unitario)'
        );
        $stmt->execute([
            'id_venda' => $idVenda,
            'id_produto' => $idProduto,
            'quantidade' => $quantidade,
            'preco_unitario' => $precoUnitario,
        ]);
    }

    public function addPagamento(int $idVenda, string $formaPagamento, float $valor): void
    {
        $stmt = db()->prepare(
            'INSERT INTO pagamentos (id_venda, forma_pagamento, valor) VALUES (:id_venda, :forma_pagamento, :valor)'
        );
        $stmt->execute([
            'id_venda' => $idVenda,
            'forma_pagamento' => $formaPagamento,
            'valor' => $valor,
        ]);
    }

    public function findInLoja(int $idVenda, int $idLoja): ?array
    {
        $stmt = db()->prepare('SELECT * FROM vendas WHERE id_venda = :id AND id_loja = :id_loja');
        $stmt->execute(['id' => $idVenda, 'id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<int,array<string,mixed>> */
    public function listByLoja(int $idLoja): array
    {
        $stmt = db()->prepare('SELECT * FROM vendas WHERE id_loja = :id_loja ORDER BY data_venda DESC');
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->fetchAll();
    }

    /** @return array<int,array<string,mixed>> */
    public function listItensByVenda(int $idVenda): array
    {
        $stmt = db()->prepare(
            'SELECT iv.*, p.nome AS nome_produto
             FROM itens_venda iv
             JOIN produtos p ON p.id_produto = iv.id_produto
             WHERE iv.id_venda = :id_venda'
        );
        $stmt->execute(['id_venda' => $idVenda]);
        return $stmt->fetchAll();
    }

    /** @return array<int,array<string,mixed>> */
    public function listPagamentosByVenda(int $idVenda): array
    {
        $stmt = db()->prepare('SELECT * FROM pagamentos WHERE id_venda = :id_venda');
        $stmt->execute(['id_venda' => $idVenda]);
        return $stmt->fetchAll();
    }
}
