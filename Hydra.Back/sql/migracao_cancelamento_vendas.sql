-- ============================================================
-- Migração: cancelamento de venda com senha de autorização
--
-- Para bancos criados ANTES deste módulo. O back-end também aplica estas
-- mesmas alterações sozinho na primeira requisição às telas de Vendas ou
-- Equipe (Hydra\Support\Migracoes), então rodar este arquivo é opcional.
-- Faça backup antes e rode UMA vez: o MySQL não tem "ADD COLUMN IF NOT
-- EXISTS", e a segunda execução falharia com "Duplicate column".
-- ============================================================

-- Senha de autorização (PIN) do gerente/administrador, cadastrada na tela Equipe.
ALTER TABLE usuarios
    ADD COLUMN senha_autorizacao VARCHAR(255) NULL;

-- Venda cancelada muda de status em vez de ser apagada.
ALTER TABLE vendas
    ADD COLUMN status ENUM('concluida', 'cancelada') NOT NULL DEFAULT 'concluida',
    ADD COLUMN data_cancelamento DATETIME NULL,
    ADD COLUMN motivo_cancelamento VARCHAR(255) NULL,
    ADD COLUMN id_operador_cancelamento INT NULL,
    ADD COLUMN id_autorizador_cancelamento INT NULL,
    ADD CONSTRAINT fk_vendas_operador_cancelamento
        FOREIGN KEY (id_operador_cancelamento) REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
    ADD CONSTRAINT fk_vendas_autorizador_cancelamento
        FOREIGN KEY (id_autorizador_cancelamento) REFERENCES usuarios(id_usuario) ON DELETE SET NULL;

-- Devolução ao estoque dos itens da venda cancelada.
ALTER TABLE movimentacoes_estoque
    MODIFY origem ENUM('cadastro', 'ajuste_manual', 'venda', 'cancelamento_venda') NOT NULL;
