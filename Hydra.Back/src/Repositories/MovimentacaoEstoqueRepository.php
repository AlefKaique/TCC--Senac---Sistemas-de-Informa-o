<?php

namespace Hydra\Repositories;

/**
 * Histórico de entradas/saídas de estoque — RF03, RF10, RF12, RN11.
 */
final class MovimentacaoEstoqueRepository
{
    /** Usado pelo Dashboard (gráfico de movimentações dos últimos 30 dias). */
    /** @return array<int,array<string,mixed>> */
    public function listByLoja(int $idLoja, int $dias = 30): array
    {
        $stmt = db()->prepare(
            'SELECT me.*, p.nome AS nome_produto
             FROM movimentacoes_estoque me
             JOIN produtos p ON p.id_produto = me.id_produto
             WHERE me.id_loja = :id_loja
               AND me.data_movimentacao >= DATE_SUB(NOW(), INTERVAL :dias DAY)
             ORDER BY me.data_movimentacao DESC'
        );
        $stmt->bindValue('id_loja', $idLoja, \PDO::PARAM_INT);
        $stmt->bindValue('dias', $dias, \PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll();
    }

    /** @return array<int,array<string,mixed>> */
    public function listByProduto(int $idProduto, int $idLoja): array
    {
        $stmt = db()->prepare(
            'SELECT * FROM movimentacoes_estoque
             WHERE id_produto = :id_produto AND id_loja = :id_loja
             ORDER BY data_movimentacao DESC'
        );
        $stmt->execute(['id_produto' => $idProduto, 'id_loja' => $idLoja]);
        return $stmt->fetchAll();
    }

    public function create(
        int $idLoja,
        int $idProduto,
        ?int $idUsuario,
        ?int $idVenda,
        string $tipo,
        string $quantidade,
        string $origem
    ): int {
        $stmt = db()->prepare(
            'INSERT INTO movimentacoes_estoque
                (id_loja, id_produto, id_usuario, id_venda, tipo, quantidade, origem)
             VALUES
                (:id_loja, :id_produto, :id_usuario, :id_venda, :tipo, :quantidade, :origem)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_produto' => $idProduto,
            'id_usuario' => $idUsuario,
            'id_venda' => $idVenda,
            'tipo' => $tipo,
            'quantidade' => $quantidade,
            'origem' => $origem,
        ]);
        return (int) db()->lastInsertId();
    }
}
