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
    /**
     * Roda $aplicar UMA vez por banco, e não uma vez por requisição.
     *
     * Antes cada migração preguiçosa se protegia com uma flag `static`, que
     * no PHP só dura a requisição: toda chamada a /vendas, /usuarios,
     * /produtos e /promocoes refazia consultas ao information_schema (lentas
     * no MySQL) e um CREATE TABLE IF NOT EXISTS. Agora:
     *   1. um arquivo-marcador no diretório temporário do servidor responde
     *      sem tocar no banco (caso normal, custo de um file_exists);
     *   2. sem o marcador (servidor novo, deploy), consulta a tabela
     *      schema_migracoes por chave primária;
     *   3. só se a migração não estiver registrada ela roda e é gravada.
     *
     * $aplicar precisa continuar idempotente: duas requisições simultâneas
     * num servidor recém-iniciado podem executá-la ao mesmo tempo. Mudou o
     * que a migração faz? Troque o $nome (sufixo _v2, _v3...).
     *
     * DDL faz commit implícito: chame ANTES de abrir transação.
     */
    public static function garantir(string $nome, callable $aplicar): void
    {
        $marcador = self::arquivoMarcador($nome);
        if (is_file($marcador)) {
            return;
        }

        // Dentro de uma transação (caso do registro de conta, que chama
        // CargoRepository::ensureDefaults() no meio da sua) não dá para
        // tocar em schema_migracoes: o CREATE TABLE abaixo faria commit
        // implícito e quebraria a transação de quem chamou. Roda a migração
        // como antes (ela é idempotente) e deixa o registro para a próxima
        // requisição fora de transação.
        if (db()->inTransaction()) {
            $aplicar();
            return;
        }

        db()->exec(
            'CREATE TABLE IF NOT EXISTS schema_migracoes (
                nome        VARCHAR(100) PRIMARY KEY,
                aplicada_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
        $stmt = db()->prepare('SELECT 1 FROM schema_migracoes WHERE nome = :nome');
        $stmt->execute(['nome' => $nome]);

        if (!$stmt->fetchColumn()) {
            $aplicar();
            db()->prepare('INSERT IGNORE INTO schema_migracoes (nome) VALUES (:nome)')
                ->execute(['nome' => $nome]);
        }

        @file_put_contents($marcador, date('c'));
    }

    /**
     * Um marcador por banco (host + nome) e por migração, para dois
     * ambientes no mesmo servidor não compartilharem o mesmo arquivo.
     */
    private static function arquivoMarcador(string $nome): string
    {
        $banco = Env::get('DB_HOST', '127.0.0.1') . ':' . Env::get('DB_PORT', '3306') . '/' . Env::get('DB_NAME', 'hydra_db');
        return rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR
            . 'hydra_mig_' . md5($banco) . '_' . preg_replace('/[^a-z0-9_]/i', '_', $nome);
    }

    /**
     * Cancelamento de venda com senha de autorização (tela Vendas, aba
     * "Cancelar Venda"; senha cadastrada na tela Equipe). Mesma estrutura
     * descrita no schema.sql e em sql/migracao_cancelamento_vendas.sql.
     */
    public static function garantirCancelamentoDeVendas(): void
    {
        self::garantir('cancelamento_vendas_v1', [self::class, 'aplicarCancelamentoDeVendas']);
    }

    /** @internal usado por garantirCancelamentoDeVendas() */
    public static function aplicarCancelamentoDeVendas(): void
    {
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
