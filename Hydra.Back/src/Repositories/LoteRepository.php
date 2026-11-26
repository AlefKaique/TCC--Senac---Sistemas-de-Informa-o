<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/**
 * Lotes do produto: cada lote tem saldo e validade próprios.
 *
 * O saldo do produto (produtos.quantidade) é a SOMA dos lotes. Venda,
 * cancelamento de venda e edição do produto continuam mexendo só em
 * produtos.quantidade; sincronizar() reconcilia os lotes com esse saldo
 * antes de qualquer operação de lote:
 *   - saldo do produto maior que a soma dos lotes (produto antigo, sem
 *     lote ainda, ou venda cancelada) → a diferença entra num lote com o
 *     código e a validade que o produto já tinha ("SEM-LOTE" se não tinha);
 *   - saldo menor (venda) → a diferença sai dos lotes por FEFO: o que
 *     vence primeiro sai primeiro.
 *
 * Os campos produtos.lote/validade passam a espelhar o PRIMEIRO lote a
 * vencer com saldo, para o Estoque, os alertas e o Relatório continuarem
 * mostrando a validade que importa.
 *
 * Todos os métodos que alteram dados esperam uma transação aberta por
 * quem chama (FOR UPDATE nas linhas do produto e dos lotes).
 */
final class LoteRepository
{
    /** Ordem FEFO: vence primeiro, sai primeiro; sem validade por último. */
    private const ORDEM_FEFO = 'validade IS NULL, validade ASC, id_lote ASC';
    private const EPSILON = 0.0005;

    public function __construct()
    {
        // DDL faz commit implícito: este construtor roda fora de transação.
        Migracoes::garantir('estoque_lotes_documentos_v1', [self::class, 'migrar']);
    }

    public static function migrar(): void
    {
        $pdo = db();
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS lotes (
                id_lote         INT AUTO_INCREMENT PRIMARY KEY,
                id_loja         INT NOT NULL,
                id_filial       INT NOT NULL,
                id_produto      INT NOT NULL,
                codigo          VARCHAR(50) NOT NULL,
                validade        DATE NULL,
                quantidade      DECIMAL(10,3) NOT NULL DEFAULT 0,
                custo_unitario  DECIMAL(10,2) NULL,
                data_criacao    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE INDEX uq_lotes_produto_codigo (id_produto, codigo),
                INDEX idx_lotes_fefo (id_produto, validade),
                INDEX idx_lotes_filial (id_filial),
                FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE,
                FOREIGN KEY (id_produto) REFERENCES produtos(id_produto) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS documentos_estoque (
                id_documento            INT AUTO_INCREMENT PRIMARY KEY,
                id_loja                 INT NOT NULL,
                id_filial               INT NOT NULL,
                numero                  VARCHAR(20) NOT NULL,
                tipo                    ENUM(\'entrada\', \'saida\') NOT NULL,
                subtipo                 VARCHAR(30) NOT NULL,
                motivo                  VARCHAR(40) NULL,
                justificativa           VARCHAR(500) NULL,
                fornecedor              VARCHAR(150) NULL,
                nota_fiscal             VARCHAR(30) NULL,
                data_documento          DATE NOT NULL,
                id_usuario              INT NULL,
                status                  ENUM(\'confirmado\', \'estornado\') NOT NULL DEFAULT \'confirmado\',
                id_documento_estornado  INT NULL,
                custo_total             DECIMAL(12,2) NOT NULL DEFAULT 0,
                data_criacao            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE INDEX uq_documentos_estoque_numero (id_loja, numero),
                INDEX idx_documentos_estoque_filial (id_filial, data_criacao),
                FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE,
                FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS documento_estoque_itens (
                id_item         INT AUTO_INCREMENT PRIMARY KEY,
                id_documento    INT NOT NULL,
                id_produto      INT NOT NULL,
                id_lote         INT NULL,
                quantidade      DECIMAL(10,3) NOT NULL,
                custo_unitario  DECIMAL(10,2) NULL,
                observacao      VARCHAR(255) NULL,
                lote_novo       TINYINT(1) NOT NULL DEFAULT 0,
                FOREIGN KEY (id_documento) REFERENCES documentos_estoque(id_documento) ON DELETE CASCADE,
                FOREIGN KEY (id_produto) REFERENCES produtos(id_produto) ON DELETE CASCADE,
                FOREIGN KEY (id_lote) REFERENCES lotes(id_lote) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );

        $coluna = static function (string $nome): bool {
            $stmt = db()->prepare(
                'SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'movimentacoes_estoque\' AND COLUMN_NAME = :c'
            );
            $stmt->execute(['c' => $nome]);
            return (bool) $stmt->fetchColumn();
        };
        if (!$coluna('id_documento')) {
            $pdo->exec('ALTER TABLE movimentacoes_estoque ADD COLUMN id_documento INT NULL, ADD INDEX idx_mov_documento (id_documento)');
        }
        if (!$coluna('id_lote')) {
            $pdo->exec('ALTER TABLE movimentacoes_estoque ADD COLUMN id_lote INT NULL');
        }
        $pdo->exec(
            "ALTER TABLE movimentacoes_estoque
                MODIFY origem ENUM('cadastro', 'ajuste_manual', 'venda', 'cancelamento_venda', 'documento', 'estorno') NOT NULL"
        );
    }

    /**
     * Reconcilia os lotes com produtos.quantidade (ver o comentário da classe)
     * e devolve os lotes do produto em ordem FEFO, travados até o commit.
     *
     * @param array<string,mixed> $produto linha de "produtos" (id_loja, id_filial, id_produto)
     * @return array<int,array<string,mixed>>
     */
    public function sincronizar(array $produto): array
    {
        $idProduto = (int) $produto['id_produto'];
        $stmt = db()->prepare('SELECT quantidade, lote, validade FROM produtos WHERE id_produto = :id FOR UPDATE');
        $stmt->execute(['id' => $idProduto]);
        $atual = $stmt->fetch();
        if (!$atual) {
            return [];
        }
        $lotes = $this->lotesDoProduto($idProduto, true);
        $soma = array_sum(array_map(static fn ($l) => (float) $l['quantidade'], $lotes));
        $diferenca = round((float) $atual['quantidade'] - $soma, 3);

        if ($diferenca > self::EPSILON) {
            $codigo = trim((string) ($atual['lote'] ?? '')) !== '' ? trim((string) $atual['lote']) : 'SEM-LOTE';
            $existente = null;
            foreach ($lotes as $lote) {
                if (strcasecmp($lote['codigo'], $codigo) === 0) {
                    $existente = $lote;
                    break;
                }
            }
            if ($existente !== null) {
                $this->somar((int) $existente['id_lote'], $diferenca);
            } else {
                $this->criar($produto, $codigo, $atual['validade'] ?: null, $diferenca, null);
            }
            $lotes = $this->lotesDoProduto($idProduto, true);
        } elseif ($diferenca < -self::EPSILON) {
            $falta = -$diferenca;
            foreach ($lotes as $lote) {
                if ($falta <= self::EPSILON) {
                    break;
                }
                $tira = min($falta, (float) $lote['quantidade']);
                if ($tira > 0) {
                    $this->somar((int) $lote['id_lote'], -$tira);
                    $falta = round($falta - $tira, 3);
                }
            }
            $lotes = $this->lotesDoProduto($idProduto, true);
        }
        return $lotes;
    }

    /** @return array<int,array<string,mixed>> lotes do produto em ordem FEFO */
    public function lotesDoProduto(int $idProduto, bool $travar = false): array
    {
        $sql = 'SELECT id_lote, id_produto, codigo, validade, quantidade, custo_unitario
                  FROM lotes WHERE id_produto = :id ORDER BY ' . self::ORDEM_FEFO;
        if ($travar) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = db()->prepare($sql);
        $stmt->execute(['id' => $idProduto]);
        return $stmt->fetchAll();
    }

    /** @param array<string,mixed> $produto */
    public function criar(array $produto, string $codigo, ?string $validade, float $quantidade, ?float $custo): int
    {
        db()->prepare(
            'INSERT INTO lotes (id_loja, id_filial, id_produto, codigo, validade, quantidade, custo_unitario)
             VALUES (:id_loja, :id_filial, :id_produto, :codigo, :validade, :quantidade, :custo)'
        )->execute([
            'id_loja' => (int) $produto['id_loja'],
            'id_filial' => (int) $produto['id_filial'],
            'id_produto' => (int) $produto['id_produto'],
            'codigo' => $codigo,
            'validade' => $validade,
            'quantidade' => $quantidade,
            'custo' => $custo,
        ]);
        return (int) db()->lastInsertId();
    }

    public function somar(int $idLote, float $delta): void
    {
        db()->prepare('UPDATE lotes SET quantidade = quantidade + :delta WHERE id_lote = :id')
            ->execute(['delta' => $delta, 'id' => $idLote]);
    }

    public function atualizarCusto(int $idLote, float $custo): void
    {
        db()->prepare('UPDATE lotes SET custo_unitario = :custo WHERE id_lote = :id')
            ->execute(['custo' => $custo, 'id' => $idLote]);
    }

    /**
     * Soma $delta ao saldo do produto e atualiza produtos.lote/validade com
     * o primeiro lote a vencer que ainda tem saldo.
     */
    public function aplicarNoProduto(int $idProduto, float $delta): void
    {
        db()->prepare('UPDATE produtos SET quantidade = quantidade + :delta WHERE id_produto = :id')
            ->execute(['delta' => $delta, 'id' => $idProduto]);

        $stmt = db()->prepare(
            'SELECT codigo, validade FROM lotes WHERE id_produto = :id AND quantidade > 0
              ORDER BY ' . self::ORDEM_FEFO . ' LIMIT 1'
        );
        $stmt->execute(['id' => $idProduto]);
        $primeiro = $stmt->fetch();
        if ($primeiro) {
            db()->prepare('UPDATE produtos SET lote = :lote, validade = :validade WHERE id_produto = :id')
                ->execute(['lote' => mb_substr((string) $primeiro['codigo'], 0, 50), 'validade' => $primeiro['validade'], 'id' => $idProduto]);
        }
    }

    /**
     * Sugestão FEFO para baixar $quantidade: [[id_lote, quantidade], ...].
     * Devolve null se a soma dos lotes não cobre a quantidade.
     *
     * @param array<int,array<string,mixed>> $lotes em ordem FEFO
     * @return array<int,array{id_lote:int,quantidade:float}>|null
     */
    public static function alocarFefo(array $lotes, float $quantidade): ?array
    {
        $alocacoes = [];
        $falta = $quantidade;
        foreach ($lotes as $lote) {
            if ($falta <= self::EPSILON) {
                break;
            }
            $tira = min($falta, (float) $lote['quantidade']);
            if ($tira > self::EPSILON) {
                $alocacoes[] = ['id_lote' => (int) $lote['id_lote'], 'quantidade' => round($tira, 3)];
                $falta = round($falta - $tira, 3);
            }
        }
        return $falta > self::EPSILON ? null : $alocacoes;
    }
}
