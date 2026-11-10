<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

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
    public function __construct()
    {
        Migracoes::garantir('produtos_codigo_hortifruti_v1', static function (): void {
            foreach ([
                'codigo' => 'SMALLINT UNSIGNED NULL',
                'plu' => 'CHAR(4) NULL',
            ] as $coluna => $definicao) {
                $stmt = db()->prepare(
                    'SELECT 1 FROM information_schema.COLUMNS
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND COLUMN_NAME = :coluna'
                );
                $stmt->execute(['tabela' => 'produtos', 'coluna' => $coluna]);
                if (!$stmt->fetchColumn()) {
                    db()->exec("ALTER TABLE produtos ADD COLUMN {$coluna} {$definicao}");
                }
            }

            $stmt = db()->prepare(
                'SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND COLUMN_NAME = :coluna'
            );
            $stmt->execute(['tabela' => 'produtos', 'coluna' => 'preco_venda']);
            if ($stmt->fetchColumn()) {
                db()->exec('ALTER TABLE produtos MODIFY preco_venda DECIMAL(10,2) NULL');
            }

            $stmt = db()->prepare(
                'SELECT 1 FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND INDEX_NAME = :indice'
            );
            $stmt->execute(['tabela' => 'produtos', 'indice' => 'uq_produtos_filial_codigo']);
            if (!$stmt->fetchColumn()) {
                db()->exec('CREATE UNIQUE INDEX uq_produtos_filial_codigo ON produtos (id_filial, codigo)');
            }
        });

        Migracoes::garantir('produtos_codigo_barras_v1', static function (): void {
            $stmt = db()->prepare(
                'SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND COLUMN_NAME = :coluna'
            );
            $stmt->execute(['tabela' => 'produtos', 'coluna' => 'codigo_barras']);
            if (!$stmt->fetchColumn()) {
                db()->exec('ALTER TABLE produtos ADD COLUMN codigo_barras VARCHAR(14) NULL');
            }

            $stmt = db()->prepare(
                'SELECT 1 FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND INDEX_NAME = :indice'
            );
            $stmt->execute(['tabela' => 'produtos', 'indice' => 'uq_produtos_filial_codigo_barras']);
            if (!$stmt->fetchColumn()) {
                db()->exec("UPDATE produtos SET codigo_barras = NULL WHERE codigo_barras = ''");
                $duplicados = (int) db()->query(
                    'SELECT COUNT(*) FROM (
                        SELECT id_filial, codigo_barras
                          FROM produtos
                         WHERE codigo_barras IS NOT NULL AND codigo_barras <> \'\'
                         GROUP BY id_filial, codigo_barras
                        HAVING COUNT(*) > 1
                    ) duplicados'
                )->fetchColumn();
                if ($duplicados > 0) {
                    throw new \RuntimeException(
                        'Há códigos de barras duplicados na mesma filial. Corrija-os antes de habilitar a busca por código de barras.'
                    );
                }
                db()->exec('CREATE UNIQUE INDEX uq_produtos_filial_codigo_barras ON produtos (id_filial, codigo_barras)');
            }

            $stmt->execute(['tabela' => 'produtos', 'indice' => 'uq_produtos_loja_codigo_barras']);
            if ($stmt->fetchColumn()) {
                db()->exec('DROP INDEX uq_produtos_loja_codigo_barras ON produtos');
            }
        });
    }

    /** @return array<int,array<string,mixed>> */
    public function listByFilial(int $idFilial): array
    {
        $stmt = db()->prepare(
            'SELECT * FROM produtos WHERE id_filial = :id_filial ORDER BY nome ASC'
        );
        $stmt->execute(['id_filial' => $idFilial]);
        return $stmt->fetchAll();
    }

    /** @return array{quantidade:int,nomes:array<int,string>} */
    public function resumoAbaixoDoMinimo(int $idFilial): array
    {
        $filtro = "id_filial = :id_filial AND status = 'ativo'
                   AND estoque_minimo > 0 AND quantidade <= estoque_minimo";
        $stmt = db()->prepare("SELECT COUNT(*) FROM produtos WHERE {$filtro}");
        $stmt->execute(['id_filial' => $idFilial]);
        $quantidade = (int) $stmt->fetchColumn();

        $stmt = db()->prepare(
            "SELECT nome FROM produtos WHERE {$filtro} ORDER BY nome ASC LIMIT 5"
        );
        $stmt->execute(['id_filial' => $idFilial]);
        return ['quantidade' => $quantidade, 'nomes' => array_column($stmt->fetchAll(), 'nome')];
    }

    /** @return array{quantidade:int,nomes:array<int,string>} */
    public function resumoValidades(int $idFilial, string $data, int $dias): array
    {
        $filtro = "id_filial = :id_filial AND status = 'ativo'
                   AND validade IS NOT NULL AND validade <= DATE_ADD(:data, INTERVAL {$dias} DAY)";
        $stmt = db()->prepare("SELECT COUNT(*) FROM produtos WHERE {$filtro}");
        $stmt->execute(['id_filial' => $idFilial, 'data' => $data]);
        $quantidade = (int) $stmt->fetchColumn();

        $stmt = db()->prepare(
            "SELECT nome FROM produtos WHERE {$filtro} ORDER BY validade ASC, nome ASC LIMIT 5"
        );
        $stmt->execute(['id_filial' => $idFilial, 'data' => $data]);
        return ['quantidade' => $quantidade, 'nomes' => array_column($stmt->fetchAll(), 'nome')];
    }

    public function findInFilial(int $idProduto, int $idFilial): ?array
    {
        $stmt = db()->prepare('SELECT * FROM produtos WHERE id_produto = :id AND id_filial = :id_filial');
        $stmt->execute(['id' => $idProduto, 'id_filial' => $idFilial]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /**
     * Vários produtos da filial numa consulta só, indexados por id_produto
     * (ids de outra filial simplesmente não voltam). Usado pela venda, que
     * antes buscava produto por produto.
     *
     * @param int[] $ids
     * @return array<int,array<string,mixed>>
     */
    public function findManyInFilial(array $ids, int $idFilial): array
    {
        $ids = array_values(array_unique(array_map('intval', $ids)));
        if ($ids === []) {
            return [];
        }
        $marcadores = implode(',', array_fill(0, count($ids), '?'));
        $stmt = db()->prepare("SELECT * FROM produtos WHERE id_filial = ? AND id_produto IN ($marcadores)");
        $stmt->execute([$idFilial, ...$ids]);
        $porId = [];
        foreach ($stmt->fetchAll() as $row) {
            $porId[(int) $row['id_produto']] = $row;
        }
        return $porId;
    }

    public function findByBarcodeInFilial(string $codigoBarras, int $idFilial): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM produtos
              WHERE id_filial = :id_filial AND codigo_barras = :codigo_barras
              LIMIT 1'
        );
        $stmt->execute(['id_filial' => $idFilial, 'codigo_barras' => $codigoBarras]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @param array<string,mixed> $dados */
    public function create(int $idLoja, int $idFilial, array $dados): int
    {
        $stmt = db()->prepare(
            'INSERT INTO produtos
                (id_loja, id_filial, nome, descricao, categoria, preco_custo, preco_venda,
                 codigo, codigo_barras, plu, quantidade, estoque_minimo, unidade, lote, validade)
             VALUES
                (:id_loja, :id_filial, :nome, :descricao, :categoria, :preco_custo, :preco_venda,
                 :codigo, :codigo_barras, :plu, :quantidade, :estoque_minimo, :unidade, :lote, :validade)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
            'nome' => $dados['nome'],
            'descricao' => $dados['descricao'],
            'categoria' => $dados['categoria'],
            'preco_custo' => $dados['preco_custo'],
            'preco_venda' => $dados['preco_venda'],
            'codigo' => $dados['codigo'],
            'codigo_barras' => $dados['codigo_barras'],
            'plu' => $dados['plu'],
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
                codigo = :codigo,
                codigo_barras = :codigo_barras,
                plu = :plu,
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
            'codigo' => $dados['codigo'],
            'codigo_barras' => $dados['codigo_barras'],
            'plu' => $dados['plu'],
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
