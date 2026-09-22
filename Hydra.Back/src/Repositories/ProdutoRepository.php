<?php

namespace Hydra\Repositories;

/**
 * Tela "Produtos" / "Controle de Estoque" — RF02, RF03, RF05, RF19.
 */
final class ProdutoRepository
{
    /** @return array<int,array<string,mixed>> */
    public function listByLoja(int $idLoja): array
    {
        $stmt = db()->prepare(
            'SELECT * FROM produtos WHERE id_loja = :id_loja ORDER BY nome ASC'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->fetchAll();
    }

    public function findInLoja(int $idProduto, int $idLoja): ?array
    {
        $stmt = db()->prepare('SELECT * FROM produtos WHERE id_produto = :id AND id_loja = :id_loja');
        $stmt->execute(['id' => $idProduto, 'id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function codigoBarrasExists(int $idLoja, string $codigoBarras, ?int $ignorarId = null): bool
    {
        $sql = 'SELECT 1 FROM produtos WHERE id_loja = :id_loja AND codigo_barras = :codigo_barras';
        $params = ['id_loja' => $idLoja, 'codigo_barras' => $codigoBarras];
        if ($ignorarId !== null) {
            $sql .= ' AND id_produto != :ignorar_id';
            $params['ignorar_id'] = $ignorarId;
        }
        $stmt = db()->prepare($sql);
        $stmt->execute($params);
        return (bool) $stmt->fetchColumn();
    }

    /** @param array<string,mixed> $dados */
    public function create(int $idLoja, array $dados): int
    {
        $stmt = db()->prepare(
            'INSERT INTO produtos
                (id_loja, nome, descricao, codigo_barras, categoria, preco_custo, preco_venda,
                 quantidade, estoque_minimo, unidade, validade)
             VALUES
                (:id_loja, :nome, :descricao, :codigo_barras, :categoria, :preco_custo, :preco_venda,
                 :quantidade, :estoque_minimo, :unidade, :validade)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'nome' => $dados['nome'],
            'descricao' => $dados['descricao'],
            'codigo_barras' => $dados['codigo_barras'],
            'categoria' => $dados['categoria'],
            'preco_custo' => $dados['preco_custo'],
            'preco_venda' => $dados['preco_venda'],
            'quantidade' => $dados['quantidade'],
            'estoque_minimo' => $dados['estoque_minimo'],
            'unidade' => $dados['unidade'],
            'validade' => $dados['validade'],
        ]);
        return (int) db()->lastInsertId();
    }

    /** @param array<string,mixed> $dados */
    public function update(int $idProduto, array $dados): void
    {
        $stmt = db()->prepare(
            'UPDATE produtos SET
                nome = :nome,
                descricao = :descricao,
                codigo_barras = :codigo_barras,
                categoria = :categoria,
                preco_custo = :preco_custo,
                preco_venda = :preco_venda,
                estoque_minimo = :estoque_minimo,
                unidade = :unidade,
                validade = :validade,
                status = :status
             WHERE id_produto = :id'
        );
        $stmt->execute([
            'nome' => $dados['nome'],
            'descricao' => $dados['descricao'],
            'codigo_barras' => $dados['codigo_barras'],
            'categoria' => $dados['categoria'],
            'preco_custo' => $dados['preco_custo'],
            'preco_venda' => $dados['preco_venda'],
            'estoque_minimo' => $dados['estoque_minimo'],
            'unidade' => $dados['unidade'],
            'validade' => $dados['validade'],
            'status' => $dados['status'],
            'id' => $idProduto,
        ]);
    }

    public function updateQuantidade(int $idProduto, string $quantidade): void
    {
        $stmt = db()->prepare('UPDATE produtos SET quantidade = :quantidade WHERE id_produto = :id');
        $stmt->execute(['quantidade' => $quantidade, 'id' => $idProduto]);
    }

    public function ajustarQuantidade(int $idProduto, float $delta): void
    {
        $stmt = db()->prepare('UPDATE produtos SET quantidade = quantidade + :delta WHERE id_produto = :id');
        $stmt->execute(['delta' => $delta, 'id' => $idProduto]);
    }

    public function inativar(int $idProduto): void
    {
        $stmt = db()->prepare("UPDATE produtos SET status = 'inativo' WHERE id_produto = :id");
        $stmt->execute(['id' => $idProduto]);
    }

    public function delete(int $idProduto): void
    {
        $stmt = db()->prepare('DELETE FROM produtos WHERE id_produto = :id');
        $stmt->execute(['id' => $idProduto]);
    }

    /** RN03 — um produto vinculado a uma venda não pode ser excluído, apenas inativado. */
    public function possuiVendas(int $idProduto): bool
    {
        $stmt = db()->prepare('SELECT 1 FROM itens_venda WHERE id_produto = :id LIMIT 1');
        $stmt->execute(['id' => $idProduto]);
        return (bool) $stmt->fetchColumn();
    }
}
