-- ============================================================
-- SISTEMA HYDRA - Migração: Filiais
--
-- Para bancos JÁ EM USO, criados a partir do schema.sql anterior ao
-- módulo de Filiais. Um banco novo não precisa deste arquivo: o
-- schema.sql já descreve o estado final.
--
-- ANTES DE RODAR, FAÇA BACKUP DO BANCO:
--
--     mysqldump -u root -p --routines --triggers hydra_db > backup_hydra_antes_filiais.sql
--
-- (para restaurar: mysql -u root -p hydra_db < backup_hydra_antes_filiais.sql)
--
-- Como executar:
--     mysql -u root -p hydra_db < Hydra.Back/sql/migracao_filiais.sql
-- ou na aba "SQL" do phpMyAdmin, com o banco hydra_db selecionado.
--
-- O que faz:
--   1. Cria "filiais" e "usuario_filiais" e a coluna
--      usuarios.id_ultima_filial.
--   2. Acrescenta id_filial (ainda opcional) em produtos, vendas,
--      movimentacoes_estoque, movimentacoes_financeiras e promocoes.
--   3. EM TRANSAÇÃO: cria a filial "Matriz" de cada loja que ainda não
--      tem filial, move todos os registros existentes para ela e vincula
--      a ela todos os usuários dessas lojas (inclusive o Administrador,
--      que não precisa do vínculo, mas o mantém caso deixe de ser
--      Administrador um dia). A Matriz vira também a "última filial" de
--      cada um, para o primeiro login depois da migração entrar direto.
--   4. Torna id_filial obrigatório, cria as chaves estrangeiras e troca a
--      numeração do pedido (vendas.numero_venda) de "única por loja" para
--      "única por filial".
--
-- Sobre a transação: no MySQL/MariaDB, todo CREATE/ALTER TABLE faz
-- COMMIT implícito, então só a etapa 3 (os dados) pode ficar dentro de
-- uma transação de verdade. As etapas de estrutura são IDEMPOTENTES:
-- cada uma confere no information_schema se já foi feita. Se o script
-- parar no meio (ex.: queda de conexão), basta rodá-lo de novo.
--
-- Rodar de novo depois de o sistema já estar em uso também é seguro: a
-- etapa 3 só cria Matriz e vínculos para lojas que ainda não têm
-- nenhuma filial, então não devolve a ninguém um acesso que o
-- Administrador tenha retirado.
--
-- Compatível com MySQL 8 e MariaDB 10.x (XAMPP). Não usa
-- "ADD COLUMN IF NOT EXISTS", que só existe no MariaDB.
-- ============================================================


-- ------------------------------------------------------------
-- Procedimentos auxiliares (removidos no fim do arquivo)
-- ------------------------------------------------------------
DELIMITER $$

DROP PROCEDURE IF EXISTS hydra_mig_add_coluna $$
CREATE PROCEDURE hydra_mig_add_coluna(IN p_tabela VARCHAR(64), IN p_coluna VARCHAR(64), IN p_definicao VARCHAR(255))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela AND COLUMN_NAME = p_coluna) THEN
        SET @hydra_sql = CONCAT('ALTER TABLE `', p_tabela, '` ADD COLUMN `', p_coluna, '` ', p_definicao);
        PREPARE stmt FROM @hydra_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END $$

DROP PROCEDURE IF EXISTS hydra_mig_add_indice $$
CREATE PROCEDURE hydra_mig_add_indice(IN p_tabela VARCHAR(64), IN p_indice VARCHAR(64), IN p_definicao VARCHAR(255))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela AND INDEX_NAME = p_indice) THEN
        SET @hydra_sql = CONCAT('ALTER TABLE `', p_tabela, '` ADD ', p_definicao);
        PREPARE stmt FROM @hydra_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END $$

DROP PROCEDURE IF EXISTS hydra_mig_drop_indice $$
CREATE PROCEDURE hydra_mig_drop_indice(IN p_tabela VARCHAR(64), IN p_indice VARCHAR(64))
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela AND INDEX_NAME = p_indice) THEN
        SET @hydra_sql = CONCAT('ALTER TABLE `', p_tabela, '` DROP INDEX `', p_indice, '`');
        PREPARE stmt FROM @hydra_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END $$

DROP PROCEDURE IF EXISTS hydra_mig_add_fk $$
CREATE PROCEDURE hydra_mig_add_fk(IN p_tabela VARCHAR(64), IN p_fk VARCHAR(64), IN p_definicao VARCHAR(255))
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela
                      AND CONSTRAINT_NAME = p_fk AND CONSTRAINT_TYPE = 'FOREIGN KEY') THEN
        SET @hydra_sql = CONCAT('ALTER TABLE `', p_tabela, '` ADD CONSTRAINT `', p_fk, '` ', p_definicao);
        PREPARE stmt FROM @hydra_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END $$

-- Torna id_filial obrigatório. Recusa (com erro explícito) se ainda
-- houver linha sem filial, em vez de deixar o ALTER falhar com uma
-- mensagem genérica ou, sem modo estrito, gravar 0 nessas linhas.
DROP PROCEDURE IF EXISTS hydra_mig_filial_obrigatoria $$
CREATE PROCEDURE hydra_mig_filial_obrigatoria(IN p_tabela VARCHAR(64))
BEGIN
    SET @hydra_sql = CONCAT('SELECT COUNT(*) INTO @hydra_sem_filial FROM `', p_tabela, '` WHERE id_filial IS NULL');
    PREPARE stmt FROM @hydra_sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;

    IF @hydra_sem_filial > 0 THEN
        SET @hydra_msg = CONCAT('Migracao interrompida: ', @hydra_sem_filial, ' linha(s) de ', p_tabela, ' sem id_filial');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = @hydra_msg;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela
                  AND COLUMN_NAME = 'id_filial' AND IS_NULLABLE = 'YES') THEN
        SET @hydra_sql = CONCAT('ALTER TABLE `', p_tabela, '` MODIFY COLUMN id_filial INT NOT NULL');
        PREPARE stmt FROM @hydra_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END $$

DELIMITER ;


-- ------------------------------------------------------------
-- Etapa 1: tabelas novas
-- ------------------------------------------------------------

-- Uma loja (a rede, criada no Cadastro) tem uma ou mais filiais. Usuários,
-- cargos e Configurações da Loja continuam valendo para a rede inteira;
-- produtos, estoque, vendas e promoções pertencem a uma filial.
--
-- Filial não é excluída, só inativada (status): ela tem vendas e
-- movimentações que precisam continuar consultáveis.
--
-- uq_filiais_loja_id (id_loja, id_filial) parece redundante, já que
-- id_filial sozinho é a chave primária, mas é ela que permite às tabelas
-- de dados referenciarem (id_loja, id_filial) juntos — o banco passa a
-- garantir que um produto nunca aponte para a filial de OUTRA loja.
CREATE TABLE IF NOT EXISTS filiais (
    id_filial       INT AUTO_INCREMENT PRIMARY KEY,
    id_loja         INT NOT NULL,
    nome            VARCHAR(120) NOT NULL,
    cnpj            VARCHAR(18)  NULL,
    telefone        VARCHAR(15)  NULL,
    endereco        VARCHAR(150) NULL,
    cidade          VARCHAR(60)  NULL,
    estado          VARCHAR(2)   NULL,
    cep             VARCHAR(10)  NULL,
    status          ENUM('ativa', 'inativa') NOT NULL DEFAULT 'ativa',
    data_criacao    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE,

    UNIQUE KEY uq_filiais_loja_id (id_loja, id_filial),
    UNIQUE KEY uq_filiais_loja_nome (id_loja, nome),
    -- NULL não conta para UNIQUE: várias filiais sem CNPJ são permitidas.
    UNIQUE KEY uq_filiais_cnpj (cnpj)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Filiais que cada usuário NÃO administrador pode acessar. O Administrador
-- (cargo de nível "administrador", ver CargoRepository::nivelEquivalente)
-- acessa todas as filiais ativas da loja sem precisar de linha aqui.
CREATE TABLE IF NOT EXISTS usuario_filiais (
    id_usuario      INT NOT NULL,
    id_filial       INT NOT NULL,

    PRIMARY KEY (id_usuario, id_filial),
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        ON DELETE CASCADE,
    FOREIGN KEY (id_filial) REFERENCES filiais(id_filial)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- "promocoes" pode ainda não existir: em bancos antigos ela é criada na
-- primeira requisição por PromocaoRepository::garantirTabela(). Cria aqui
-- com a estrutura anterior para que as etapas abaixo a tratem como as
-- demais tabelas.
CREATE TABLE IF NOT EXISTS promocoes (
    id_promocao       INT AUTO_INCREMENT PRIMARY KEY,
    id_loja           INT NOT NULL,
    id_produto        INT NOT NULL,
    id_usuario        INT NULL,
    preco_promocional DECIMAL(10,2) NOT NULL,
    data_inicio       DATE NOT NULL,
    data_fim          DATE NOT NULL,
    status            ENUM('ativa', 'encerrada') NOT NULL DEFAULT 'ativa',
    data_criacao      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE,
    FOREIGN KEY (id_produto) REFERENCES produtos(id_produto) ON DELETE CASCADE,
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    INDEX idx_promocoes_loja_produto (id_loja, id_produto),
    INDEX idx_promocoes_periodo (data_inicio, data_fim)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ------------------------------------------------------------
-- Etapa 2: colunas novas (opcionais por enquanto)
-- ------------------------------------------------------------
-- Dados cadastrais da filial (os mesmos de Configurações da Loja). Para
-- quem já rodou uma versão anterior deste arquivo, em que "filiais" tinha
-- só nome, CNPJ e endereço: rodar de novo acrescenta estas colunas.
CALL hydra_mig_add_coluna('filiais', 'telefone', 'VARCHAR(15) NULL AFTER cnpj');
CALL hydra_mig_add_coluna('filiais', 'cidade',   'VARCHAR(60) NULL AFTER endereco');
CALL hydra_mig_add_coluna('filiais', 'estado',   'VARCHAR(2)  NULL AFTER cidade');
CALL hydra_mig_add_coluna('filiais', 'cep',      'VARCHAR(10) NULL AFTER estado');

CALL hydra_mig_add_coluna('usuarios',                  'id_ultima_filial', 'INT NULL AFTER id_cargo');
CALL hydra_mig_add_coluna('produtos',                  'id_filial',        'INT NULL AFTER id_loja');
CALL hydra_mig_add_coluna('vendas',                    'id_filial',        'INT NULL AFTER id_loja');
CALL hydra_mig_add_coluna('movimentacoes_estoque',     'id_filial',        'INT NULL AFTER id_loja');
CALL hydra_mig_add_coluna('movimentacoes_financeiras', 'id_filial',        'INT NULL AFTER id_loja');
CALL hydra_mig_add_coluna('promocoes',                 'id_filial',        'INT NULL AFTER id_loja');


-- ------------------------------------------------------------
-- Etapa 3: dados (em transação)
-- ------------------------------------------------------------

-- Lojas que ainda não têm nenhuma filial: só estas ganham Matriz e
-- vínculos. Tabela temporária não faz COMMIT implícito.
DROP TEMPORARY TABLE IF EXISTS hydra_mig_lojas_novas;
CREATE TEMPORARY TABLE hydra_mig_lojas_novas AS
    SELECT l.id_loja
      FROM lojas l
     WHERE NOT EXISTS (SELECT 1 FROM filiais f WHERE f.id_loja = l.id_loja);

START TRANSACTION;

-- A Matriz herda os dados cadastrais da loja (os de Configurações da
-- Loja). Dá para editar depois, em Configuração Loja > Filiais.
INSERT INTO filiais (id_loja, nome, cnpj, telefone, endereco, cidade, estado, cep)
SELECT l.id_loja, 'Matriz', l.cnpj, l.telefone, l.endereco, l.cidade, l.estado, l.cep
  FROM lojas l
  JOIN hydra_mig_lojas_novas n ON n.id_loja = l.id_loja;

-- Todo registro sem filial vai para a primeira filial da sua loja (a
-- Matriz, nas lojas que acabaram de ganhar uma).
UPDATE produtos t
  JOIN (SELECT id_loja, MIN(id_filial) AS id_filial FROM filiais GROUP BY id_loja) m ON m.id_loja = t.id_loja
   SET t.id_filial = m.id_filial
 WHERE t.id_filial IS NULL;

UPDATE vendas t
  JOIN (SELECT id_loja, MIN(id_filial) AS id_filial FROM filiais GROUP BY id_loja) m ON m.id_loja = t.id_loja
   SET t.id_filial = m.id_filial
 WHERE t.id_filial IS NULL;

UPDATE movimentacoes_estoque t
  JOIN (SELECT id_loja, MIN(id_filial) AS id_filial FROM filiais GROUP BY id_loja) m ON m.id_loja = t.id_loja
   SET t.id_filial = m.id_filial
 WHERE t.id_filial IS NULL;

UPDATE movimentacoes_financeiras t
  JOIN (SELECT id_loja, MIN(id_filial) AS id_filial FROM filiais GROUP BY id_loja) m ON m.id_loja = t.id_loja
   SET t.id_filial = m.id_filial
 WHERE t.id_filial IS NULL;

UPDATE promocoes t
  JOIN (SELECT id_loja, MIN(id_filial) AS id_filial FROM filiais GROUP BY id_loja) m ON m.id_loja = t.id_loja
   SET t.id_filial = m.id_filial
 WHERE t.id_filial IS NULL;

-- Vincula à Matriz todos os usuários das lojas novas, para ninguém ficar
-- trancado do lado de fora no primeiro login depois da migração.
INSERT IGNORE INTO usuario_filiais (id_usuario, id_filial)
SELECT u.id_usuario, f.id_filial
  FROM usuarios u
  JOIN hydra_mig_lojas_novas n ON n.id_loja = u.id_loja
  JOIN filiais f ON f.id_loja = u.id_loja;

UPDATE usuarios u
  JOIN hydra_mig_lojas_novas n ON n.id_loja = u.id_loja
  JOIN filiais f ON f.id_loja = u.id_loja
   SET u.id_ultima_filial = f.id_filial
 WHERE u.id_ultima_filial IS NULL;

COMMIT;

DROP TEMPORARY TABLE IF EXISTS hydra_mig_lojas_novas;


-- ------------------------------------------------------------
-- Etapa 4: restrições
-- ------------------------------------------------------------
CALL hydra_mig_filial_obrigatoria('produtos');
CALL hydra_mig_filial_obrigatoria('vendas');
CALL hydra_mig_filial_obrigatoria('movimentacoes_estoque');
CALL hydra_mig_filial_obrigatoria('movimentacoes_financeiras');
CALL hydra_mig_filial_obrigatoria('promocoes');

-- Índice (id_loja, id_filial): serve às consultas do sistema, que filtram
-- pelos dois, e à chave estrangeira composta logo abaixo.
CALL hydra_mig_add_indice('produtos',                  'idx_produtos_loja_filial',                  'INDEX idx_produtos_loja_filial (id_loja, id_filial)');
CALL hydra_mig_add_indice('vendas',                    'idx_vendas_loja_filial',                    'INDEX idx_vendas_loja_filial (id_loja, id_filial)');
CALL hydra_mig_add_indice('movimentacoes_estoque',     'idx_movimentacoes_estoque_loja_filial',     'INDEX idx_movimentacoes_estoque_loja_filial (id_loja, id_filial)');
CALL hydra_mig_add_indice('movimentacoes_financeiras', 'idx_movimentacoes_financeiras_loja_filial', 'INDEX idx_movimentacoes_financeiras_loja_filial (id_loja, id_filial)');
CALL hydra_mig_add_indice('promocoes',                 'idx_promocoes_loja_filial',                 'INDEX idx_promocoes_loja_filial (id_loja, id_filial)');

CALL hydra_mig_add_fk('produtos',                  'fk_produtos_filial',                  'FOREIGN KEY (id_loja, id_filial) REFERENCES filiais(id_loja, id_filial) ON DELETE CASCADE');
CALL hydra_mig_add_fk('vendas',                    'fk_vendas_filial',                    'FOREIGN KEY (id_loja, id_filial) REFERENCES filiais(id_loja, id_filial) ON DELETE CASCADE');
CALL hydra_mig_add_fk('movimentacoes_estoque',     'fk_movimentacoes_estoque_filial',     'FOREIGN KEY (id_loja, id_filial) REFERENCES filiais(id_loja, id_filial) ON DELETE CASCADE');
CALL hydra_mig_add_fk('movimentacoes_financeiras', 'fk_movimentacoes_financeiras_filial', 'FOREIGN KEY (id_loja, id_filial) REFERENCES filiais(id_loja, id_filial) ON DELETE CASCADE');
CALL hydra_mig_add_fk('promocoes',                 'fk_promocoes_filial',                 'FOREIGN KEY (id_loja, id_filial) REFERENCES filiais(id_loja, id_filial) ON DELETE CASCADE');

CALL hydra_mig_add_fk('usuarios', 'fk_usuarios_ultima_filial', 'FOREIGN KEY (id_ultima_filial) REFERENCES filiais(id_filial) ON DELETE SET NULL');

-- Numeração do pedido: passa de "única por loja" para "única por filial"
-- (cada filial começa no pedido 1). Os números atuais continuam únicos,
-- porque todas as vendas de cada loja foram para a mesma Matriz.
-- idx_vendas_id_loja é garantido antes do DROP porque a chave estrangeira
-- de vendas.id_loja precisa de um índice começando por id_loja; sem ele o
-- MySQL recusaria apagar uq_vendas_loja_numero.
CALL hydra_mig_add_indice('vendas', 'idx_vendas_id_loja', 'INDEX idx_vendas_id_loja (id_loja)');
CALL hydra_mig_drop_indice('vendas', 'uq_vendas_loja_numero');
CALL hydra_mig_add_indice('vendas', 'uq_vendas_filial_numero', 'UNIQUE KEY uq_vendas_filial_numero (id_filial, numero_venda)');


-- ------------------------------------------------------------
-- Limpeza
-- ------------------------------------------------------------
DROP PROCEDURE IF EXISTS hydra_mig_add_coluna;
DROP PROCEDURE IF EXISTS hydra_mig_add_indice;
DROP PROCEDURE IF EXISTS hydra_mig_drop_indice;
DROP PROCEDURE IF EXISTS hydra_mig_add_fk;
DROP PROCEDURE IF EXISTS hydra_mig_filial_obrigatoria;


-- ------------------------------------------------------------
-- Conferência (só leitura): rode depois e confira os números
-- ------------------------------------------------------------
SELECT l.id_loja, l.nome_loja,
       (SELECT COUNT(*) FROM filiais f         WHERE f.id_loja = l.id_loja)                 AS filiais,
       (SELECT COUNT(*) FROM usuarios u        WHERE u.id_loja = l.id_loja)                 AS usuarios,
       (SELECT COUNT(DISTINCT uf.id_usuario)
          FROM usuario_filiais uf JOIN usuarios u ON u.id_usuario = uf.id_usuario
         WHERE u.id_loja = l.id_loja)                                                       AS usuarios_vinculados,
       (SELECT COUNT(*) FROM produtos p        WHERE p.id_loja = l.id_loja)                 AS produtos,
       (SELECT COUNT(*) FROM vendas v          WHERE v.id_loja = l.id_loja)                 AS vendas
  FROM lojas l
 ORDER BY l.id_loja;
