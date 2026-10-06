<?php

namespace Hydra\Repositories;

/**
 * Tela "Produtos" / "Controle de Estoque" — RF02, RF03, RF05, RF19.
 *
 * O catálogo é por filial: toda leitura filtra pela filial ativa da sessão
 * (Auth::requirePermissionNaFilial). Os métodos que recebem só id_produto
 * (update, baixa de estoque...) são chamados depois de findInFilial() ter
 * confirmado que o produto é da filial.
 */
final class ProdutoRepository
{
    /** @return array<int,array<string,mixed>> */
    public function listByFilial(int $idFilial): array
    {
        $stmt = db()->prepare(
            'SELECT * FROM produtos WHERE id_filial = :id_filial ORDER BY nome ASC'
        );
        $stmt->execute(['id_filial' => $idFilial]);
        return $stmt->fetchAll();
    }

    public function findInFilial(int $idProduto, int $idFilial): ?array
    {
        $stmt = db()->prepare('SELECT * FROM produtos WHERE id_produto = :id AND id_filial = :id_filial');
        $stmt->execute(['id' => $idProduto, 'id_filial' => $idFilial]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @param array<string,mixed> $dados */
    public function create(int $idLoja, int $idFilial, array $dados): int
    {
        $stmt = db()->prepare(
            'INSERT INTO produtos
                (id_loja, id_filial, nome, descricao, categoria, preco_custo, preco_venda,
                 quantidade, estoque_minimo, unidade, lote, validade)
             VALUES
                (:id_loja, :id_filial, :nome, :descricao, :categoria, :preco_custo, :preco_venda,
                 :quantidade, :estoque_minimo, :unidade, :lote, :validade)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
            'nome' => $dados['nome'],
            'descricao' => $dados['descricao'],
            'categoria' => $dados['categoria'],
            'preco_custo' => $dados['preco_custo'],
            'preco_venda' => $dados['preco_venda'],
            'quantidade' => $dados['quantidade'],
            'estoque_minimo' => $dados['estoque_minimo'],
            'unidade' => $dados['unidade'],
            'lote' => $dados['lote'],
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
                categoria = :categoria,
                preco_custo = :preco_custo,
                preco_venda = :preco_venda,
                estoque_minimo = :estoque_minimo,
                unidade = :unidade,
                lote = :lote,
                validade = :validade,
                status = :status
             WHERE id_produto = :id'
        );
        $stmt->execute([
            'nome' => $dados['nome'],
            'descricao' => $dados['descricao'],
            'categoria' => $dados['categoria'],
            'preco_custo' => $dados['preco_custo'],
            'preco_venda' => $dados['preco_venda'],
            'estoque_minimo' => $dados['estoque_minimo'],
            'unidade' => $dados['unidade'],
            'lote' => $dados['lote'],
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

    /**
     * Baixa do estoque que so acontece se houver saldo, verificado pelo
     * proprio UPDATE. Retorna false quando nao havia saldo suficiente.
     *
     * Conferir o saldo antes e abater depois (duas instrucoes separadas)
     * abre uma janela entre a leitura e a escrita: duas vendas
     * simultaneas do mesmo produto passavam ambas pela verificacao e o
     * estoque terminava negativo. Aqui a condicao viaja junto do UPDATE,
     * que o InnoDB executa travando a linha.
     */
    public function baixarQuantidadeSeHouver(int $idProduto, float $quantidade): bool
    {
        $stmt = db()->prepare(
            'UPDATE produtos
                SET quantidade = quantidade - :quantidade
              WHERE id_produto = :id AND quantidade >= :minimo'
        );
        $stmt->execute([
            'quantidade' => $quantidade,
            'id' => $idProduto,
            'minimo' => $quantidade,
        ]);
        return $stmt->rowCount() === 1;
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
