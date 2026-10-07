<?php

namespace Hydra\Support;

/**
 * Migrações preguiçosas de colunas — a mesma estratégia de
 * PromocaoRepository::garantirTabela(): o schema.sql só roda quando
 * reaplicado à mão, então um banco já em uso ganha as colunas novas na
 * primeira requisição que precisa delas.
 *
 * DDL no MySQL faz commit implícito: quem chama isto precisa chamar ANTES
 * de abrir qualquer transação (os construtores dos controllers/repositórios
 * servem para isso).
 */
final class Migracoes
{
    private static bool $cancelamentoGarantido = false;

    /**
     * Cancelamento de venda com senha de autorização (tela Vendas, aba
     * "Cancelar Venda"; senha cadastrada na tela Equipe). Mesma estrutura
     * descrita no schema.sql e em sql/migracao_cancelamento_vendas.sql.
     */
    public static function garantirCancelamentoDeVendas(): void
    {
        if (self::$cancelamentoGarantido) {
            return;
        }
        self::$cancelamentoGarantido = true;

        if (!self::colunaExiste('usuarios', 'senha_autorizacao')) {
            db()->exec('ALTER TABLE usuarios ADD COLUMN senha_autorizacao VARCHAR(255) NULL');
        }

        if (!self::colunaExiste('vendas', 'status')) {
            db()->exec(
                "ALTER TABLE vendas
                    ADD COLUMN status ENUM('concluida', 'cancelada') NOT NULL DEFAULT 'concluida',
                    ADD COLUMN data_cancelamento DATETIME NULL,
                    ADD COLUMN motivo_cancelamento VARCHAR(255) NULL,
                    ADD COLUMN id_operador_cancelamento INT NULL,
                    ADD COLUMN id_autorizador_cancelamento INT NULL,
                    ADD CONSTRAINT fk_vendas_operador_cancelamento
                        FOREIGN KEY (id_operador_cancelamento) REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
                    ADD CONSTRAINT fk_vendas_autorizador_cancelamento
                        FOREIGN KEY (id_autorizador_cancelamento) REFERENCES usuarios(id_usuario) ON DELETE SET NULL"
            );
        }

        $stmt = db()->prepare(
            "SELECT COLUMN_TYPE FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'movimentacoes_estoque' AND COLUMN_NAME = 'origem'"
        );
        $stmt->execute();
        $tipo = (string) $stmt->fetchColumn();
        if ($tipo !== '' && !str_contains($tipo, 'cancelamento_venda')) {
            db()->exec(
                "ALTER TABLE movimentacoes_estoque
                    MODIFY origem ENUM('cadastro', 'ajuste_manual', 'venda', 'cancelamento_venda') NOT NULL"
            );
        }
    }

    private static function colunaExiste(string $tabela, string $coluna): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND COLUMN_NAME = :coluna'
        );
        $stmt->execute(['tabela' => $tabela, 'coluna' => $coluna]);
        return (bool) $stmt->fetchColumn();
    }
}
