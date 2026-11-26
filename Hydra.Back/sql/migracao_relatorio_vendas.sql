-- ============================================================
-- Migração: tela Relatório de Vendas
--
-- Para bancos criados ANTES desta tela. O back-end aplica estas mesmas
-- alterações sozinho na primeira vez que alguém abre o Relatório
-- (Hydra\Support\Migracoes::garantirRelatorioVendas), então rodar este
-- arquivo é opcional.
--
-- Pode ser executado mais de uma vez: a tabela usa IF NOT EXISTS e cada
-- índice só é criado se ainda não existir (o MySQL não tem
-- "CREATE INDEX IF NOT EXISTS", daí a consulta ao information_schema).
-- ============================================================

-- 1. Blocos que cada usuário deixou marcados no Passo 2 da tela.
--    Exemplo do conteúdo de "blocos": ["mais_vendidos", "dia_a_dia"]
CREATE TABLE IF NOT EXISTS relatorio_preferencia (
    id_usuario     INT PRIMARY KEY,
    blocos         JSON NOT NULL,
    atualizado_em  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- 2. Índices de data e filial usados pelas consultas do relatório.
--    Os bancos criados pelo schema.sql atual já têm todos; bancos antigos
--    podem não ter.

-- Vendas concluídas de uma filial num intervalo de datas (todos os blocos).
SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendas'
                  AND INDEX_NAME = 'idx_vendas_relatorio_filial_status_data');
SET @sql := IF(@falta, 'CREATE INDEX idx_vendas_relatorio_filial_status_data ON vendas (id_filial, status, data_venda)', 'DO 0');
PREPARE passo FROM @sql; EXECUTE passo; DEALLOCATE PREPARE passo;

-- Cancelamentos de uma filial num intervalo de datas.
SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vendas'
                  AND INDEX_NAME = 'idx_vendas_filial_status_cancelamento');
SET @sql := IF(@falta, 'CREATE INDEX idx_vendas_filial_status_cancelamento ON vendas (id_filial, status, data_cancelamento)', 'DO 0');
PREPARE passo FROM @sql; EXECUTE passo; DEALLOCATE PREPARE passo;

-- Itens de cada venda (produtos mais vendidos, dia a dia, lucro).
SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'itens_venda'
                  AND INDEX_NAME = 'idx_itens_venda_relatorio');
SET @sql := IF(@falta, 'CREATE INDEX idx_itens_venda_relatorio ON itens_venda (id_venda, id_produto)', 'DO 0');
PREPARE passo FROM @sql; EXECUTE passo; DEALLOCATE PREPARE passo;

-- Pagamentos de cada venda (como o cliente pagou).
SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pagamentos'
                  AND INDEX_NAME = 'idx_pagamentos_id_venda');
SET @sql := IF(@falta, 'CREATE INDEX idx_pagamentos_id_venda ON pagamentos (id_venda)', 'DO 0');
PREPARE passo FROM @sql; EXECUTE passo; DEALLOCATE PREPARE passo;

-- Produtos ativos de uma filial (parados, vai acabar logo, impressões).
SET @falta := (SELECT COUNT(*) = 0 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'produtos'
                  AND INDEX_NAME = 'idx_produtos_filial_status');
SET @sql := IF(@falta, 'CREATE INDEX idx_produtos_filial_status ON produtos (id_filial, status)', 'DO 0');
PREPARE passo FROM @sql; EXECUTE passo; DEALLOCATE PREPARE passo;


-- 3. Permissão "Relatório Completo" (vendas por operador, cancelamentos e
--    lucro). Quem tem esta permissão é tratado como Gerente no relatório.
INSERT INTO permissoes (codigo, nome, descricao, categoria, ordem) VALUES
    ('relatorios.completo', 'Relatório Completo',
     'Ver no Relatório as vendas por operador, os cancelamentos e o lucro estimado — marque também "Relatórios"',
     'Operação', 23)
ON DUPLICATE KEY UPDATE
    nome = VALUES(nome), descricao = VALUES(descricao),
    categoria = VALUES(categoria), ordem = VALUES(ordem);

-- O cargo de sistema "Administrador" de cada loja já recebe a permissão.
INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao)
SELECT c.id_cargo, p.id_permissao
  FROM cargos c
  JOIN permissoes p ON p.codigo = 'relatorios.completo'
 WHERE c.cargo_sistema = 1 AND c.nome = 'Administrador';
