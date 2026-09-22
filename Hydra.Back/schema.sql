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
-- Módulo de Clientes (PDV)
--   RF07 - Edição e Exclusão de Clientes
--   RF08 - Busca e Filtragem de Clientes (nome, CPF)
--   RF14 - Consentimento para inclusão de CPF
--   RN14 - Validação de cliente: sem cadastro duplicado com o mesmo CPF
--   RN15 - Associação de cliente à venda é opcional
--   RN19 - Coleta mínima de dados para identificação do cliente
--
-- CPF é opcional e só pode ser preenchido com o consentimento explícito
-- do cliente (consentimento_cpf = TRUE). O e-mail é o identificador
-- alternativo quando não há CPF, permitindo rastrear o histórico do
-- cliente (via id_cliente nas vendas) mesmo sem dado documental.
-- ============================================================

CREATE TABLE IF NOT EXISTS clientes (
    id_cliente          INT AUTO_INCREMENT PRIMARY KEY,
    id_loja             INT NOT NULL,
    nome                VARCHAR(120) NOT NULL,
    cpf                 VARCHAR(14)  NULL,
    email               VARCHAR(100) NULL,
    telefone            VARCHAR(15)  NULL,
    consentimento_cpf   BOOLEAN NOT NULL DEFAULT FALSE,
    data_criacao        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE,

    -- NULL não conta para UNIQUE em MySQL, então múltiplos clientes sem
    -- CPF na mesma loja são permitidos; só bloqueia CPF repetido.
    UNIQUE KEY uq_clientes_loja_cpf (id_loja, cpf)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_clientes_id_loja ON clientes (id_loja);
CREATE INDEX idx_clientes_email   ON clientes (email);


-- ============================================================
-- Módulo de Produtos e Estoque
--   RF02 - Gestão de Produtos (Estoquista/Admin)
--   RF03 - Controle de Estoque (Estoquista/Admin)
--   RF05 - Alertas de Estoque (estoque_minimo)
--   RF19 - Alertas de Validade de Produtos (campo "validade")
--   RN02 - Nível Mínimo de Estoque
--   RN03 - Exclusão de Produtos: não pode ser excluído se já
--          vinculado a uma venda, apenas inativado (status)
--
-- Corresponde à entidade PRODUTO do DER (Figura 9) e ao atributo de
-- status + método inativar() do Diagrama de Classes (Figura 6).
-- ============================================================

CREATE TABLE IF NOT EXISTS produtos (
    id_produto      INT AUTO_INCREMENT PRIMARY KEY,
    id_loja         INT NOT NULL,
    nome            VARCHAR(150) NOT NULL,
    descricao       VARCHAR(255) NULL,
    codigo_barras   VARCHAR(50)  NULL,
    categoria       VARCHAR(60)  NOT NULL,
    preco_custo     DECIMAL(10,2) NULL,
    preco_venda     DECIMAL(10,2) NOT NULL,
    quantidade      DECIMAL(10,3) NOT NULL DEFAULT 0,
    estoque_minimo  DECIMAL(10,3) NOT NULL DEFAULT 0,
    unidade         VARCHAR(10)  NOT NULL DEFAULT 'un',
    validade        DATE NULL,
    status          ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    data_criacao    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE,

    -- NULL não conta para UNIQUE em MySQL: vários produtos sem código
    -- de barras na mesma loja são permitidos; só bloqueia duplicidade
    -- de um código já usado.
    UNIQUE KEY uq_produtos_loja_codigo_barras (id_loja, codigo_barras)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_produtos_id_loja  ON produtos (id_loja);
CREATE INDEX idx_produtos_categoria ON produtos (categoria);
CREATE INDEX idx_produtos_validade  ON produtos (validade);


-- ============================================================
-- Módulo de Vendas (PDV)
--   RF04  - Registro de Vendas (Operador de Caixa)
--   RF09  - Cancelamento de Venda (RN01: só antes da finalização,
--           portanto uma venda cancelada nunca chega a ser gravada)
--   RF12  - Atualização Automática de Estoque
--   RF13  - Seleção de Forma de Pagamento
--   RN01  - Venda com Estoque Insuficiente
--   RN07  - Permissão de venda: 'operador_caixa' ou 'administrador'
--   RN08  - Disponibilidade de produto
--   RN09  - Finalização da venda exige forma de pagamento válida
--   RN10  - Formas de pagamento aceitas (PIX, crédito, débito, VR,
--           dinheiro)
--   RN15  - Associação de cliente à venda é opcional
--
-- Corresponde às entidades VENDA e ITEM_VENDA do DER (Figura 9). A
-- classe Pagamento se relaciona com Venda em multiplicidade 1..*
-- (Diagrama de Classes, Figura 6), contemplando pagamento fracionado
-- em mais de uma forma — daí "pagamentos" ser uma tabela à parte.
-- ============================================================

CREATE TABLE IF NOT EXISTS vendas (
    id_venda        INT AUTO_INCREMENT PRIMARY KEY,
    id_loja         INT NOT NULL,
    id_usuario      INT NOT NULL,
    id_cliente      INT NULL,
    subtotal        DECIMAL(10,2) NOT NULL,
    desconto        DECIMAL(10,2) NOT NULL DEFAULT 0,
    valor_total     DECIMAL(10,2) NOT NULL,
    data_venda      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE,
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        ON DELETE RESTRICT,
    FOREIGN KEY (id_cliente) REFERENCES clientes(id_cliente)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_vendas_id_loja    ON vendas (id_loja);
CREATE INDEX idx_vendas_id_usuario ON vendas (id_usuario);
CREATE INDEX idx_vendas_id_cliente ON vendas (id_cliente);
CREATE INDEX idx_vendas_data_venda ON vendas (data_venda);


CREATE TABLE IF NOT EXISTS itens_venda (
    id_item_venda   INT AUTO_INCREMENT PRIMARY KEY,
    id_venda        INT NOT NULL,
    id_produto      INT NOT NULL,
    quantidade      DECIMAL(10,3) NOT NULL,
    preco_unitario  DECIMAL(10,2) NOT NULL,

    FOREIGN KEY (id_venda) REFERENCES vendas(id_venda)
        ON DELETE CASCADE,
    -- RN03: um produto já vendido não pode ser excluído (apenas inativado).
    FOREIGN KEY (id_produto) REFERENCES produtos(id_produto)
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_itens_venda_id_venda   ON itens_venda (id_venda);
CREATE INDEX idx_itens_venda_id_produto ON itens_venda (id_produto);


CREATE TABLE IF NOT EXISTS pagamentos (
    id_pagamento    INT AUTO_INCREMENT PRIMARY KEY,
    id_venda        INT NOT NULL,
    forma_pagamento ENUM('pix', 'cartao_credito', 'cartao_debito', 'vale_refeicao', 'dinheiro') NOT NULL,
    valor           DECIMAL(10,2) NOT NULL,

    FOREIGN KEY (id_venda) REFERENCES vendas(id_venda)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_pagamentos_id_venda ON pagamentos (id_venda);


-- ============================================================
-- Movimentações de estoque
--   RF03, RF10 - Controle de Estoque / Visualização do histórico de
--                movimentações de cada produto
--   RF12       - Atualização Automática de Estoque após uma venda
--   RN11       - Atualização de estoque após finalização da venda
--
-- Corresponde à entidade MOVIMENTACAO_ESTOQUE do DER (Figura 9).
-- Toda alteração de quantidade em "produtos" (cadastro com estoque
-- inicial, entrada/saída manual ou baixa por venda) gera um registro
-- aqui, preservando o histórico consolidado por produto.
-- ============================================================

CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
    id_movimentacao   INT AUTO_INCREMENT PRIMARY KEY,
    id_loja           INT NOT NULL,
    id_produto        INT NOT NULL,
    id_usuario        INT NULL,
    id_venda          INT NULL,
    tipo              ENUM('entrada', 'saida') NOT NULL,
    quantidade        DECIMAL(10,3) NOT NULL,
    origem            ENUM('cadastro', 'ajuste_manual', 'venda') NOT NULL,
    data_movimentacao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE,
    FOREIGN KEY (id_produto) REFERENCES produtos(id_produto)
        ON DELETE CASCADE,
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        ON DELETE SET NULL,
    FOREIGN KEY (id_venda) REFERENCES vendas(id_venda)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_movimentacoes_estoque_id_loja    ON movimentacoes_estoque (id_loja);
CREATE INDEX idx_movimentacoes_estoque_id_produto ON movimentacoes_estoque (id_produto);
CREATE INDEX idx_movimentacoes_estoque_data        ON movimentacoes_estoque (data_movimentacao);


-- ============================================================
-- Movimentações financeiras
--   RN16, RN17 - Acesso e visualização de entradas, saídas e saldo
--                financeiro (restrito ao Administrador)
--
-- Corresponde à classe MovimentacaoFinanceira do Diagrama de Classes
-- (Figura 6), desacoplada de Venda com multiplicidade opcional (0..1
-- em ambos os sentidos): permite tanto o registro automático de uma
-- venda quanto lançamentos financeiros manuais (ex.: retirada de
-- caixa), sem vínculo obrigatório com uma venda específica.
-- Reservada para uma futura tela de lançamentos manuais — os
-- indicadores financeiros já disponíveis no Dashboard (RF06) são
-- calculados diretamente a partir de "vendas", sem depender desta
-- tabela.
-- ============================================================

CREATE TABLE IF NOT EXISTS movimentacoes_financeiras (
    id_movimentacao_financeira INT AUTO_INCREMENT PRIMARY KEY,
    id_loja           INT NOT NULL,
    id_venda          INT NULL,
    id_usuario        INT NULL,
    tipo              ENUM('entrada', 'saida') NOT NULL,
    valor             DECIMAL(10,2) NOT NULL,
    descricao         VARCHAR(255) NULL,
    data_movimentacao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE,
    FOREIGN KEY (id_venda) REFERENCES vendas(id_venda)
        ON DELETE SET NULL,
    FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_movimentacoes_financeiras_id_loja ON movimentacoes_financeiras (id_loja);
CREATE INDEX idx_movimentacoes_financeiras_data     ON movimentacoes_financeiras (data_movimentacao);


-- ============================================================
-- Regras de negócio aplicadas neste modelo (referência ao TCC)
--   RN01 - Venda com Estoque Insuficiente: validada antes de gravar
--          os itens da venda
--   RN02 - Nível Mínimo de Estoque (produtos.estoque_minimo)
--   RN03 - Exclusão de Produtos: inativação em vez de DELETE quando
--          já vinculado a uma venda (produtos.status)
--   RN04 - Restrição de Acesso: apenas perfil 'administrador'
--          altera preços/descontos/relatórios financeiros e acessa
--          Gerenciar Usuários / Configurações da Loja
--   RN05 - Recuperação de Senha Segura: token com validade
--          (reset_token_expira_em)
--   RN06 - Acesso ao sistema: apenas usuários autenticados,
--          conforme perfil (enum fechado)
--   RN07 - Permissão de venda: 'operador_caixa' ou 'administrador'
--   RN08 - Disponibilidade de produto: só entra na venda se houver
--          quantidade em estoque
--   RN09 - Finalização da venda exige forma de pagamento válida
--   RN10 - Formas de pagamento aceitas (pagamentos.forma_pagamento)
--   RN11 - Atualização automática do estoque após a venda
--          (movimentacoes_estoque, origem = 'venda')
--   RN15 - Associação de cliente à venda é opcional (vendas.id_cliente)
--   RN20 - Confirmação prévia antes de excluir usuário/produto/cliente
--
-- (RF19 - Alertas de Validade de Produtos - é requisito funcional, não
--  regra de negócio; ver produtos.validade e o comentário da tabela.)
-- ============================================================
