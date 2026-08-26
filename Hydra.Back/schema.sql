-- ============================================================
-- SISTEMA HYDRA - Schema do módulo de Cadastro de Usuário
-- e Permissões (Usuários + Loja)
-- Banco: MySQL 8
--
-- Telas cobertas por este schema:
--   - Cadastro (Fig. 13)        -> INSERT em lojas + INSERT em usuarios (perfil = administrador)
--   - Login (Fig. 14)           -> SELECT em usuarios (email, senha) + UPDATE ultimo_acesso
--   - Recuperar senha (Fig. 15) -> UPDATE reset_token / reset_token_expira_em
--   - Gerenciar Usuários        -> CRUD em usuarios (perfil = operador_caixa/estoquista)
--   - Configurações da Loja     -> UPDATE em lojas
--
-- Este arquivo é idempotente (CREATE TABLE IF NOT EXISTS) e reflete
-- exatamente o que já está aplicado no banco "hydra_db" local.
-- ============================================================

CREATE TABLE IF NOT EXISTS lojas (
    id_loja         INT AUTO_INCREMENT PRIMARY KEY,
    nome_loja       VARCHAR(120) NOT NULL,
    cnpj            VARCHAR(18)  NULL UNIQUE,
    telefone        VARCHAR(15)  NULL,
    endereco        VARCHAR(150) NULL,
    cidade          VARCHAR(60)  NULL,
    estado          VARCHAR(2)   NULL,
    cep             VARCHAR(10)  NULL,
    status          ENUM('ativa', 'inativa') NOT NULL DEFAULT 'ativa',
    data_criacao    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS usuarios (
    id_usuario              INT AUTO_INCREMENT PRIMARY KEY,
    id_loja                 INT NOT NULL,
    nome                    VARCHAR(100)  NOT NULL,
    email                   VARCHAR(100)  NOT NULL UNIQUE,
    senha                   VARCHAR(255)  NOT NULL,          -- hash (bcrypt), nunca texto puro
    perfil                  ENUM('administrador', 'operador_caixa', 'estoquista') NOT NULL,
    status                  ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    data_criacao            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ultimo_acesso           DATETIME NULL,

    -- suporte à tela de Recuperação de Senha (RN05)
    reset_token             VARCHAR(255) NULL,
    reset_token_expira_em   DATETIME NULL,

    -- suporte ao "Lembrar de mim" da tela de Login
    remember_token          VARCHAR(255) NULL,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Índices de apoio às consultas mais frequentes do módulo
CREATE INDEX idx_usuarios_id_loja ON usuarios (id_loja);
CREATE INDEX idx_usuarios_perfil  ON usuarios (perfil);


-- ============================================================
-- Regras de negócio aplicadas neste modelo (referência ao TCC)
--   RN04 - Restrição de Acesso: apenas perfil 'administrador'
--          altera preços/descontos/relatórios financeiros e acessa
--          Gerenciar Usuários / Configurações da Loja
--   RN05 - Recuperação de Senha Segura: token com validade
--          (reset_token_expira_em)
--   RN06 - Acesso ao sistema: apenas usuários autenticados,
--          conforme perfil (enum fechado)
--   RN07 - Permissão de venda: 'operador_caixa' ou 'administrador'
--   RN21 - Confirmação prévia antes de excluir usuário/produto/cliente
-- ============================================================
