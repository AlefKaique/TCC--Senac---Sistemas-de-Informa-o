<?php

namespace Hydra\Repositories;

/**
 * Histórico de entradas/saídas de estoque — RF03, RF10, RF12, RN11.
 * Por filial, como o catálogo de produtos.
 */
final class MovimentacaoEstoqueRepository
{
    /** Usado pelo Dashboard (gráfico de movimentações dos últimos 30 dias). */
    /** @return array<int,array<string,mixed>> */
    public function listByFilial(int $idFilial, int $dias = 30): array
    {
        $stmt = db()->prepare(
            'SELECT me.*, p.nome AS nome_produto
             FROM movimentacoes_estoque me
             JOIN produtos p ON p.id_produto = me.id_produto
             WHERE me.id_filial = :id_filial
               AND me.data_movimentacao >= DATE_SUB(NOW(), INTERVAL :dias DAY)
             ORDER BY me.data_movimentacao DESC'
        );
        $stmt->bindValue('id_filial', $idFilial, \PDO::PARAM_INT);
        $stmt->bindValue('dias', $dias, \PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll();
    }

    /** @return array<int,array<string,mixed>> */
    public function listByProduto(int $idProduto, int $idFilial): array
    {
        $stmt = db()->prepare(
            'SELECT me.*, u.nome AS nome_usuario
             FROM movimentacoes_estoque me
             LEFT JOIN usuarios u ON u.id_usuario = me.id_usuario
             WHERE me.id_produto = :id_produto AND me.id_filial = :id_filial
             ORDER BY me.data_movimentacao DESC'
        );
        $stmt->execute(['id_produto' => $idProduto, 'id_filial' => $idFilial]);
        return $stmt->fetchAll();
    }

    /**
     * Uma movimentação por produto, todas num único INSERT (mesma origem,
     * tipo, usuário e venda). Usado pela venda, que antes inseria uma a uma.
     *
     * @param array<int,string> $quantidadePorProduto id_produto => quantidade
     */
    public function createMany(
        int $idLoja,
        int $idFilial,
        ?int $idUsuario,
        ?int $idVenda,
        string $tipo,
        array $quantidadePorProduto,
        string $origem
    ): void {
        if ($quantidadePorProduto === []) {
            return;
        }
        $linhas = [];
        $params = [];
        foreach ($quantidadePorProduto as $idProduto => $quantidade) {
            $linhas[] = '(?, ?, ?, ?, ?, ?, ?, ?)';
            array_push($params, $idLoja, $idFilial, (int) $idProduto, $idUsuario, $idVenda, $tipo, (string) $quantidade, $origem);
        }
        db()->prepare(
            'INSERT INTO movimentacoes_estoque
                (id_loja, id_filial, id_produto, id_usuario, id_venda, tipo, quantidade, origem)
             VALUES ' . implode(', ', $linhas)
        )->execute($params);
    }

    public function create(
        int $idLoja,
        int $idFilial,
        int $idProduto,
        ?int $idUsuario,
        ?int $idVenda,
        string $tipo,
        string $quantidade,
        string $origem
    ): int {
        $stmt = db()->prepare(
            'INSERT INTO movimentacoes_estoque
                (id_loja, id_filial, id_produto, id_usuario, id_venda, tipo, quantidade, origem)
             VALUES
                (:id_loja, :id_filial, :id_produto, :id_usuario, :id_venda, :tipo, :quantidade, :origem)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
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
