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
     * Um advisory lock do MySQL serializa a primeira execução em instâncias
     * PHP concorrentes. Mudou o que a migração faz? Troque o $nome (sufixo
     * _v2, _v3...).
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

        $chaveBanco = Env::get('DB_HOST', '127.0.0.1') . ':' . Env::get('DB_PORT', '3306') . '/' . Env::get('DB_NAME', 'hydra_db');
        $nomeLock = 'hydra_migracoes_' . md5($chaveBanco);
        $lock = db()->prepare('SELECT GET_LOCK(:nome, 30)');
        $lock->execute(['nome' => $nomeLock]);
        if ((int) $lock->fetchColumn() !== 1) {
            throw new \RuntimeException('Não foi possível obter o bloqueio para executar uma migração do banco.');
        }

        try {
            if (is_file($marcador)) {
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
        } finally {
            $release = db()->prepare('SELECT RELEASE_LOCK(:nome)');
            $release->execute(['nome' => $nomeLock]);
        }
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

    /** Registra o custo na época da venda e cria índices para os relatórios. */
    public static function garantirRelatoriosReais(): void
    {
        self::garantirCancelamentoDeVendas();
        self::garantir('relatorios_reais_v1', static function (): void {
            $custoExistia = self::colunaExiste('itens_venda', 'custo_unitario');
            if (!$custoExistia) {
                db()->exec('ALTER TABLE itens_venda ADD COLUMN custo_unitario DECIMAL(10,2) NULL AFTER preco_unitario');
            }
            if (!self::colunaExiste('itens_venda', 'custo_estimado')) {
                db()->exec('ALTER TABLE itens_venda ADD COLUMN custo_estimado TINYINT(1) NOT NULL DEFAULT 0 AFTER custo_unitario');
            }
            db()->exec(
                'UPDATE itens_venda iv
                 JOIN produtos p ON p.id_produto = iv.id_produto
                    SET iv.custo_unitario = p.preco_custo,
                        iv.custo_estimado = 1
                  WHERE iv.custo_unitario IS NULL AND iv.custo_estimado = 0'
            );

            if (!self::indiceExiste('vendas', 'idx_vendas_relatorio_filial_status_data')) {
                db()->exec(
                    'CREATE INDEX idx_vendas_relatorio_filial_status_data
                        ON vendas (id_filial, status, data_venda)'
                );
            }
            if (!self::indiceExiste('itens_venda', 'idx_itens_venda_relatorio')) {
                db()->exec('CREATE INDEX idx_itens_venda_relatorio ON itens_venda (id_venda, id_produto)');
            }
            if (!self::indiceExiste('pagamentos', 'idx_pagamentos_id_venda')) {
                db()->exec('CREATE INDEX idx_pagamentos_id_venda ON pagamentos (id_venda)');
            }
        });
    }

    /** Cria as preferências, o histórico diário e o limite dos testes de alertas. */
    public static function garantirAlertasWhatsApp(): void
    {
        self::garantir('alertas_whatsapp_v2', static function (): void {
            db()->exec(
                "CREATE TABLE IF NOT EXISTS preferencias_alerta (
                    id_usuario INT PRIMARY KEY,
                    telefone_whatsapp VARCHAR(15) NULL,
                    canal ENUM('whatsapp','email','ambos') NOT NULL DEFAULT 'whatsapp',
                    consentimento TINYINT(1) NOT NULL DEFAULT 0,
                    consentimento_em DATETIME NULL,
                    alerta_estoque TINYINT(1) NOT NULL DEFAULT 1,
                    alerta_validade TINYINT(1) NOT NULL DEFAULT 1,
                    dias_validade TINYINT NOT NULL DEFAULT 7,
                    atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    CONSTRAINT fk_preferencias_alerta_usuario
                        FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
                    INDEX idx_pref_telefone (telefone_whatsapp)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            );
            db()->exec(
                "CREATE TABLE IF NOT EXISTS destinatarios_alerta (
                    id_destinatario INT AUTO_INCREMENT PRIMARY KEY,
                    id_usuario INT NOT NULL,
                    id_loja INT NOT NULL,
                    telefone_whatsapp VARCHAR(15) NOT NULL,
                    consentimento TINYINT(1) NOT NULL DEFAULT 0,
                    consentimento_em DATETIME NULL,
                    ativo TINYINT(1) NOT NULL DEFAULT 1,
                    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uq_destinatario_usuario_telefone (id_usuario, telefone_whatsapp),
                    INDEX idx_destinatario_loja_ativo (id_loja, ativo, consentimento),
                    CONSTRAINT fk_destinatario_alerta_usuario
                        FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
                    CONSTRAINT fk_destinatario_alerta_loja
                        FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            );
            db()->exec(
                "INSERT IGNORE INTO destinatarios_alerta
                    (id_usuario, id_loja, telefone_whatsapp, consentimento, consentimento_em)
                 SELECT p.id_usuario, u.id_loja, p.telefone_whatsapp, p.consentimento, p.consentimento_em
                   FROM preferencias_alerta p
                   JOIN usuarios u ON u.id_usuario = p.id_usuario
                  WHERE p.telefone_whatsapp IS NOT NULL AND p.consentimento = 1"
            );
            db()->exec(
                "CREATE TABLE IF NOT EXISTS alertas_enviados (
                    id_alerta INT AUTO_INCREMENT PRIMARY KEY,
                    id_usuario INT NOT NULL,
                    id_loja INT NOT NULL,
                    id_filial INT NOT NULL,
                    data_referencia DATE NOT NULL,
                    canal ENUM('whatsapp','email') NOT NULL,
                    id_destinatario_alerta INT NOT NULL DEFAULT 0,
                    qtd_estoque INT NOT NULL DEFAULT 0,
                    qtd_validade INT NOT NULL DEFAULT 0,
                    status ENUM('enviado','entregue','lido','falhou') NOT NULL DEFAULT 'enviado',
                    id_mensagem_meta VARCHAR(100) NULL,
                    erro VARCHAR(255) NULL,
                    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_alerta_mensagem (id_mensagem_meta),
                    CONSTRAINT fk_alertas_enviados_usuario
                        FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
                    CONSTRAINT fk_alertas_enviados_loja
                        FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE,
                    CONSTRAINT fk_alertas_enviados_filial
                        FOREIGN KEY (id_loja, id_filial) REFERENCES filiais(id_loja, id_filial) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            );
            $indiceAntigo = db()->prepare(
                "SELECT 1 FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alertas_enviados'
                    AND INDEX_NAME = 'uq_alerta_dia'"
            );
            $indiceAntigo->execute();
            if ($indiceAntigo->fetchColumn()) {
                db()->exec('ALTER TABLE alertas_enviados DROP INDEX uq_alerta_dia');
            }
            $colunaDestinatario = db()->prepare(
                "SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alertas_enviados'
                    AND COLUMN_NAME = 'id_destinatario_alerta'"
            );
            $colunaDestinatario->execute();
            if (!$colunaDestinatario->fetchColumn()) {
                db()->exec(
                    'ALTER TABLE alertas_enviados
                        ADD COLUMN id_destinatario_alerta INT NOT NULL DEFAULT 0 AFTER canal'
                );
            }
            $indiceDestinatario = db()->prepare(
                "SELECT 1 FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alertas_enviados'
                    AND INDEX_NAME = 'uq_alerta_dia_destinatario'"
            );
            $indiceDestinatario->execute();
            if (!$indiceDestinatario->fetchColumn()) {
                db()->exec(
                    'CREATE UNIQUE INDEX uq_alerta_dia_destinatario
                        ON alertas_enviados (id_usuario, id_filial, data_referencia, canal, id_destinatario_alerta)'
                );
            }
            db()->exec(
                'CREATE TABLE IF NOT EXISTS limites_testes_alertas (
                    id_usuario INT PRIMARY KEY,
                    inicio DATETIME NOT NULL,
                    quantidade TINYINT UNSIGNED NOT NULL DEFAULT 0,
                    CONSTRAINT fk_limites_testes_alertas_usuario
                        FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
        });
    }

    /** Cria as tabelas próprias da autenticação da plataforma em bancos existentes. */
    public static function garantirAdminsPlataforma(): void
    {
        self::garantir('admins_plataforma_v1', static function (): void {
            db()->exec(
                "CREATE TABLE IF NOT EXISTS admins_plataforma (
                    id_admin                INT AUTO_INCREMENT PRIMARY KEY,
                    nome                    VARCHAR(100) NOT NULL,
                    email                   VARCHAR(100) NOT NULL UNIQUE,
                    senha                   VARCHAR(255) NOT NULL,
                    codigo_acesso_hash      CHAR(64) NULL,
                    codigo_acesso_expira_em DATETIME NULL,
                    status                  ENUM('ativo','inativo') NOT NULL DEFAULT 'ativo',
                    nivel                   ENUM('proprietario','gestor','analista') NOT NULL DEFAULT 'analista',
                    senha_definida          TINYINT(1) NOT NULL DEFAULT 1,
                    criado_por              INT NULL,
                    ultimo_acesso           DATETIME NULL,
                    data_criacao            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT fk_admins_plataforma_criado_por
                        FOREIGN KEY (criado_por) REFERENCES admins_plataforma(id_admin)
                        ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            );
            db()->exec(
                'CREATE TABLE IF NOT EXISTS auditoria_plataforma (
                    id_auditoria INT AUTO_INCREMENT PRIMARY KEY,
                    id_admin     INT NULL,
                    acao         VARCHAR(50) NOT NULL,
                    id_loja      INT NULL,
                    detalhe      VARCHAR(255) NULL,
                    ip           VARCHAR(45) NULL,
                    data         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (id_admin) REFERENCES admins_plataforma(id_admin),
                    INDEX idx_auditoria_data (data)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
        });

        self::garantir('plataforma_equipe_lojas_v1', static function (): void {
            $adminsExistiam = self::tabelaExiste('admins_plataforma');
            foreach ([
                'nivel' => "ENUM('proprietario','gestor','analista') NOT NULL DEFAULT 'analista'",
                'senha_definida' => 'TINYINT(1) NOT NULL DEFAULT 1',
                'criado_por' => 'INT NULL',
            ] as $coluna => $definicao) {
                if (!self::colunaExiste('admins_plataforma', $coluna)) {
                    db()->exec("ALTER TABLE admins_plataforma ADD COLUMN {$coluna} {$definicao}");
                }
            }

            if ($adminsExistiam) {
                db()->exec("UPDATE admins_plataforma SET nivel = 'proprietario' WHERE nivel = 'analista'");
            }
            if (!self::constraintExiste('admins_plataforma', 'fk_admins_plataforma_criado_por')) {
                db()->exec(
                    'ALTER TABLE admins_plataforma
                        ADD CONSTRAINT fk_admins_plataforma_criado_por
                        FOREIGN KEY (criado_por) REFERENCES admins_plataforma(id_admin)
                        ON DELETE SET NULL'
                );
            }

            db()->exec("ALTER TABLE lojas MODIFY status ENUM('ativa','inativa','suspensa') NOT NULL DEFAULT 'ativa'");
            if (!self::colunaExiste('lojas', 'motivo_status')) {
                db()->exec('ALTER TABLE lojas ADD COLUMN motivo_status VARCHAR(255) NULL');
            }
            if (!self::colunaExiste('lojas', 'status_alterado_em')) {
                db()->exec('ALTER TABLE lojas ADD COLUMN status_alterado_em DATETIME NULL');
            }
            if (!self::indiceExiste('usuarios', 'idx_usuarios_loja_ultimo_acesso')) {
                db()->exec('CREATE INDEX idx_usuarios_loja_ultimo_acesso ON usuarios (id_loja, ultimo_acesso)');
            }
            if (!self::indiceExiste('vendas', 'idx_vendas_loja_data')) {
                db()->exec('CREATE INDEX idx_vendas_loja_data ON vendas (id_loja, data_venda)');
            }
        });
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

    private static function tabelaExiste(string $tabela): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela'
        );
        $stmt->execute(['tabela' => $tabela]);
        return (bool) $stmt->fetchColumn();
    }

    private static function indiceExiste(string $tabela, string $indice): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND INDEX_NAME = :indice'
        );
        $stmt->execute(['tabela' => $tabela, 'indice' => $indice]);
        return (bool) $stmt->fetchColumn();
    }

    private static function constraintExiste(string $tabela, string $constraint): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND CONSTRAINT_NAME = :constraint'
        );
        $stmt->execute(['tabela' => $tabela, 'constraint' => $constraint]);
        return (bool) $stmt->fetchColumn();
    }
}
