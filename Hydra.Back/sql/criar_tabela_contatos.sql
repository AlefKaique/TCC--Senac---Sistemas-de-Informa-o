-- ============================================================
-- SISTEMA HYDRA - Tabela de contatos (formulário "Entre em Contato")
--
-- Guarda o que é enviado pelo formulário da página inicial
-- (POST /api/contato, ContatoController). Cada envio vira uma linha, e a
-- equipe Hydra consulta a tabela para retornar o contato.
--
-- Este arquivo NÃO roda sozinho: o back-end não cria esta tabela
-- automaticamente. Revise e execute uma vez:
--
--     mysql -u root -p hydra_db < Hydra.Back/sql/criar_tabela_contatos.sql
--
-- ou cole na aba "SQL" do phpMyAdmin, com o banco hydra_db selecionado.
--
-- Rodar de novo é seguro: "IF NOT EXISTS" ignora a tabela se ela já
-- existir. Enquanto ela não existir, o formulário responde com uma
-- mensagem amigável que indica o WhatsApp e o e-mail da equipe.
--
-- Colunas:
--   telefone         só os dígitos, com DDD (ex.: 11958206969); opcional.
--   tipo_comercio    opcional; os valores são os do campo "Tipo de comércio".
--   plano_interesse  "nao_sei" = "Ainda não sei" (valor padrão do campo).
--   aceite_lgpd      a pessoa marcou "Concordo com a Política de
--                    Privacidade..."; o envio é recusado sem o aceite.
--                    criado_em é o momento do aceite.
-- ============================================================

CREATE TABLE IF NOT EXISTS contatos (
    id_contato       INT AUTO_INCREMENT PRIMARY KEY,
    nome             VARCHAR(100)  NOT NULL,
    email            VARCHAR(100)  NOT NULL,
    telefone         VARCHAR(11)   NULL,
    estabelecimento  VARCHAR(120)  NULL,
    tipo_comercio    ENUM('mercado', 'padaria', 'hortifruti', 'outro') NULL,
    plano_interesse  ENUM('nao_sei', 'start', 'flex', 'premium') NOT NULL DEFAULT 'nao_sei',
    mensagem         VARCHAR(1000) NULL,
    aceite_lgpd      TINYINT(1)    NOT NULL DEFAULT 0,
    criado_em        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_contatos_criado (criado_em),
    INDEX idx_contatos_email_criado (email, criado_em)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Para ver os contatos recebidos, do mais recente para o mais antigo:
--
--     SELECT * FROM contatos ORDER BY criado_em DESC;
