-- ============================================================
-- SISTEMA HYDRA - Schema completo do banco
-- Banco: MySQL 8
--
-- Módulos: Loja e Usuários, Cargos e Permissões, Clientes, Produtos,
-- Controle de Estoque, Vendas (PDV) e Movimentações Financeiras.
--
-- Telas cobertas por este schema:
--   - Cadastro (Fig. 13)        -> INSERT em lojas + INSERT em usuarios (perfil = administrador)
--   - Login (Fig. 14)           -> SELECT em usuarios (email, senha) + UPDATE ultimo_acesso
--   - Recuperar senha (Fig. 15) -> UPDATE reset_token / reset_token_expira_em
--   - Gerenciar Usuários        -> CRUD em usuarios (perfil = operador_caixa/estoquista)
--   - Configurações da Loja     -> UPDATE em lojas
--
-- Este arquivo é a VERSÃO DEFINITIVA do modelo: descreve o estado final
-- do banco, sem blocos de migração incremental. Ele pressupõe um banco
-- limpo — em um banco que já tenha as tabelas, "CREATE TABLE IF NOT
-- EXISTS" apenas ignora as existentes (sem acrescentar colunas novas) e
-- os "CREATE INDEX" falham por índice duplicado.
--
-- Para reaplicar do zero, recrie o banco antes de executar este arquivo:
--
--     DROP DATABASE IF EXISTS hydra_db;
--     CREATE DATABASE hydra_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--     USE hydra_db;
--
-- (as três linhas acima apagam todos os dados — por isso ficam como
--  comentário, para serem executadas conscientemente)
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

    -- Cargo do usuário: é ele que define as permissões efetivas (ver o
    -- módulo de Cargos mais abaixo). "perfil" permanece como nível
    -- equivalente derivado das permissões, usado pelas telas legadas.
    -- A chave estrangeira é criada logo após a tabela "cargos", que é
    -- declarada depois desta.
    id_cargo                INT NULL,

    status                  ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    data_criacao            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ultimo_acesso           DATETIME NULL,

    -- suporte à tela de Recuperação de Senha (RN05)
    reset_token             VARCHAR(255) NULL,
    reset_token_expira_em   DATETIME NULL,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- Índices de apoio às consultas mais frequentes do módulo
CREATE INDEX idx_usuarios_id_loja  ON usuarios (id_loja);
CREATE INDEX idx_usuarios_perfil   ON usuarios (perfil);
CREATE INDEX idx_usuarios_id_cargo ON usuarios (id_cargo);


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
--
-- O código de barras foi removido do sistema: o mercadinho de bairro
-- não tem leitor nem etiqueta padronizada, e o produto passou a ser
-- identificado pelo nome. Em um banco JÁ EM USO (criado antes dessa
-- remoção), execute os dois comandos abaixo NESTA ORDEM:
--
--     ALTER TABLE produtos DROP INDEX uq_produtos_loja_codigo_barras;
--     ALTER TABLE produtos DROP COLUMN codigo_barras;
--
-- A ordem importa: o índice era composto (id_loja, codigo_barras).
-- Soltar a coluna primeiro faria o MySQL reduzir o índice a
-- UNIQUE (id_loja), o que passaria a permitir só UM produto por loja.
-- ============================================================

CREATE TABLE IF NOT EXISTS produtos (
    id_produto      INT AUTO_INCREMENT PRIMARY KEY,
    id_loja         INT NOT NULL,
    nome            VARCHAR(150) NOT NULL,
    descricao       VARCHAR(255) NULL,
    -- Digitada livremente pelo usuário no cadastro, com as categorias já
    -- usadas na loja oferecidas como sugestão (não há lista fixa).
    categoria       VARCHAR(60)  NOT NULL,
    preco_custo     DECIMAL(10,2) NULL,
    preco_venda     DECIMAL(10,2) NOT NULL,
    quantidade      DECIMAL(10,3) NOT NULL DEFAULT 0,
    estoque_minimo  DECIMAL(10,3) NOT NULL DEFAULT 0,
    unidade         VARCHAR(10)  NOT NULL DEFAULT 'un',
    lote            VARCHAR(50)  NULL,
    validade        DATE NULL,
    status          ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    data_criacao    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE
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
-- Módulo de Cargos e Permissões (estilo Discord)
--   RF01/RN04/RN06/RN07 - substitui o antigo ENUM fixo "perfil" por um
--   modelo de cargos configuráveis por loja: cada cargo tem um nome,
--   uma cor (identidade visual, igual aos cargos do Discord) e um
--   conjunto de permissões marcadas por checkbox na tela "Cargos".
--
--   "permissoes" é um catálogo GLOBAL (igual para todas as lojas) das
--   ações que podem ser concedidas. "cargos" pertence a uma loja — cada
--   loja nova ganha automaticamente 3 cargos de sistema (Administrador,
--   Operador de Caixa e Estoquista) com as mesmas permissões que o
--   ENUM "perfil" já garantia, então nenhuma loja existente perde
--   acesso quando este módulo é instalado (ver CargoRepository::
--   ensureDefaults(), chamado de forma preguiçosa no login). Cargos de
--   sistema (cargo_sistema = 1) não podem ser excluídos; cargos
--   personalizados podem ser livremente criados, editados e excluídos
--   pelo Administrador (tela exclusiva, permissão "cargos.gerenciar").
--
--   usuarios.perfil é mantido (não removido) por compatibilidade: ele é
--   recalculado automaticamente a partir das permissões do cargo
--   atribuído (ver CargoRepository::nivelEquivalente()) e continua
--   sustentando a regra "a loja precisa ter ao menos um administrador
--   ativo" (UsuarioRepository::countAdminsAtivos).
-- ============================================================

-- ============================================================
-- Controle de tentativas de acesso
--   Limita forca bruta no login e na redefinicao de senha. Sem isto,
--   o codigo de 6 digitos da recuperacao (1 milhao de combinacoes)
--   seria quebravel em minutos, porque nada impedia tentativas
--   ilimitadas dentro da janela de validade.
--
-- "chave" identifica o alvo da contagem, no formato "<acao>:<alvo>"
-- (ex.: "login:fulano@loja.com"). Nao ha FK para usuarios de
-- proposito: tentativas contra e-mails inexistentes tambem contam,
-- senao bastaria variar o e-mail para escapar do bloqueio.
-- ============================================================
CREATE TABLE IF NOT EXISTS tentativas_acesso (
    chave           VARCHAR(190) NOT NULL PRIMARY KEY,
    tentativas      INT NOT NULL DEFAULT 0,
    bloqueado_ate   DATETIME NULL,
    atualizado_em   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_tentativas_acesso_atualizado ON tentativas_acesso (atualizado_em);


CREATE TABLE IF NOT EXISTS permissoes (
    id_permissao    INT AUTO_INCREMENT PRIMARY KEY,
    codigo          VARCHAR(60)  NOT NULL UNIQUE,
    nome            VARCHAR(100) NOT NULL,
    descricao       VARCHAR(255) NULL,
    categoria       VARCHAR(60)  NOT NULL,
    ordem           INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cargos (
    id_cargo        INT AUTO_INCREMENT PRIMARY KEY,
    id_loja         INT NOT NULL,
    nome            VARCHAR(60)  NOT NULL,
    descricao       VARCHAR(255) NULL,
    cor             VARCHAR(7)   NOT NULL DEFAULT '#5865F2',
    cargo_sistema   TINYINT(1)   NOT NULL DEFAULT 0,
    data_criacao    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja)
        ON DELETE CASCADE,

    UNIQUE KEY uq_cargos_loja_nome (id_loja, nome)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_cargos_id_loja ON cargos (id_loja);

CREATE TABLE IF NOT EXISTS cargo_permissoes (
    id_cargo        INT NOT NULL,
    id_permissao    INT NOT NULL,

    PRIMARY KEY (id_cargo, id_permissao),
    FOREIGN KEY (id_cargo) REFERENCES cargos(id_cargo)
        ON DELETE CASCADE,
    FOREIGN KEY (id_permissao) REFERENCES permissoes(id_permissao)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Catálogo fixo de permissões — cada uma corresponde a uma verificação
-- real no back-end (Hydra\Support\Auth::requirePermission ou
-- ::requireAnyPermission), não é só texto decorativo na tela de Cargos.
--
-- São 5, uma por área do sistema. A granularidade anterior (19 códigos,
-- ver/criar/editar/excluir por módulo) não correspondia a nenhuma decisão
-- real de um mercadinho: configura-se "quem cuida do estoque", não "quem
-- pode editar mas não excluir produto".
--
-- "produtos.editar_preco" fica separada porque a RN04 exige que só o
-- Administrador altere preços — é a única granularidade fina que o negócio
-- pede. Ela só tem efeito somada a "estoque.gerenciar", que é o que libera
-- o PUT /api/produtos/{id}.
--
-- ON DUPLICATE KEY UPDATE em vez de INSERT IGNORE: "produtos.editar_preco"
-- e "loja.configurar" já existem em bancos da versão anterior (os códigos
-- foram reaproveitados). O IGNORE pularia as duas e deixaria o nome antigo
-- ("Alterar Dados da Loja") na tela; o UPDATE atualiza o texto SEM trocar o
-- id_permissao, então as linhas de cargo_permissoes continuam valendo.
INSERT INTO permissoes (codigo, nome, descricao, categoria, ordem) VALUES
    ('estoque.gerenciar',     'Estoque e Produtos',   'Cadastrar, editar e excluir produtos e lançar entradas e saídas de estoque',              'Operação',      10),
    ('produtos.editar_preco', 'Alterar Preços',       'Alterar preço de custo e de venda (RN04) — só tem efeito junto com "Estoque e Produtos"', 'Operação',      11),
    ('vendas.operar',         'Vendas no Caixa',      'Operar o Caixa (PDV), finalizar vendas e consultar o histórico',                          'Operação',      12),
    ('equipe.gerenciar',      'Equipe e Cargos',      'Gerenciar os usuários da loja e os cargos e suas permissões',                             'Administração', 20),
    ('loja.configurar',       'Configuração da Loja', 'Ver e alterar os dados cadastrais da loja',                                               'Administração', 21)
ON DUPLICATE KEY UPDATE
    nome = VALUES(nome), descricao = VALUES(descricao),
    categoria = VALUES(categoria), ordem = VALUES(ordem);

-- Migração do acesso antigo para os códigos novos. Roda ANTES do DELETE
-- mais abaixo, e é a mesma regra de
-- CargoRepository::remapearPermissoesDosCargos() — que faz isto
-- automaticamente a cada login, para não exigir reaplicar este arquivo em
-- um banco já em uso.
--
-- A regra SUB-concede de propósito: só quem tinha algum código de ESCRITA
-- na área ganha a permissão grossa, que também concede escrita. Um cargo
-- que só tinha "produtos.visualizar"/"estoque.visualizar" termina sem
-- permissão alguma — "só olhar o estoque" deixou de existir, e o
-- administrador remarca esse cargo na tela de Cargos.
INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao)
SELECT DISTINCT cp.id_cargo, novo.id_permissao
  FROM cargo_permissoes cp
  JOIN permissoes antiga ON antiga.id_permissao = cp.id_permissao
  JOIN permissoes novo   ON novo.codigo = 'estoque.gerenciar'
 WHERE antiga.codigo IN ('produtos.criar', 'produtos.editar', 'produtos.excluir', 'estoque.movimentar');

INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao)
SELECT DISTINCT cp.id_cargo, novo.id_permissao
  FROM cargo_permissoes cp
  JOIN permissoes antiga ON antiga.id_permissao = cp.id_permissao
  JOIN permissoes novo   ON novo.codigo = 'vendas.operar'
 WHERE antiga.codigo IN ('vendas.visualizar', 'vendas.registrar');

INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao)
SELECT DISTINCT cp.id_cargo, novo.id_permissao
  FROM cargo_permissoes cp
  JOIN permissoes antiga ON antiga.id_permissao = cp.id_permissao
  JOIN permissoes novo   ON novo.codigo = 'equipe.gerenciar'
 WHERE antiga.codigo IN ('usuarios.visualizar', 'usuarios.criar', 'usuarios.editar', 'usuarios.excluir',
                         'cargos.visualizar', 'cargos.criar', 'cargos.editar', 'cargos.excluir');

INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao)
SELECT DISTINCT cp.id_cargo, novo.id_permissao
  FROM cargo_permissoes cp
  JOIN permissoes antiga ON antiga.id_permissao = cp.id_permissao
  JOIN permissoes novo   ON novo.codigo = 'loja.configurar'
 WHERE antiga.codigo = 'loja.visualizar';

-- Permissões retiradas do catálogo depois de já terem sido gravadas em
-- algum banco. As linhas correspondentes em cargo_permissoes caem junto,
-- por ON DELETE CASCADE. O mesmo é feito automaticamente em
-- CargoRepository::ensureDefaults(), que também roda o remap acima antes
-- de apagar.
--
--   - "vendas.aplicar_desconto": o PDV nunca teve campo de desconto.
--   - os 17 códigos granulares da versão anterior. Dos 19, sobrevivem só
--     "produtos.editar_preco" e "loja.configurar", reaproveitados acima.
--
-- A ORDEM IMPORTA: este DELETE depois do remap. Invertido, o acesso antigo
-- é apagado antes de haver de onde copiá-lo e todo cargo de toda loja fica
-- sem permissão alguma. Se isso acontecer, o SQL de diagnóstico e de
-- recuperação do acesso administrativo está em Hydra.Back/README.md,
-- seção "Cargos e permissões".
DELETE FROM permissoes WHERE codigo IN (
    'vendas.aplicar_desconto',
    'produtos.visualizar', 'produtos.criar', 'produtos.editar', 'produtos.excluir',
    'estoque.visualizar', 'estoque.movimentar',
    'vendas.visualizar', 'vendas.registrar',
    'usuarios.visualizar', 'usuarios.criar', 'usuarios.editar', 'usuarios.excluir',
    'cargos.visualizar', 'cargos.criar', 'cargos.editar', 'cargos.excluir',
    'loja.visualizar'
);

-- A chave estrangeira de usuarios.id_cargo é criada aqui, e não na
-- declaração da tabela, porque "usuarios" vem antes de "cargos" neste
-- arquivo (a ordem acompanha a narrativa dos módulos do TCC).
ALTER TABLE usuarios
    ADD CONSTRAINT fk_usuarios_cargo
    FOREIGN KEY (id_cargo) REFERENCES cargos(id_cargo)
    ON DELETE SET NULL;


-- ============================================================
-- Regras de negócio aplicadas neste modelo (referência ao TCC)
--   RN01 - Venda com Estoque Insuficiente: validada antes de gravar
--          os itens da venda
--   RN02 - Nível Mínimo de Estoque (produtos.estoque_minimo)
--   RN03 - Exclusão de Produtos: inativação em vez de DELETE quando
--          já vinculado a uma venda (produtos.status)
--   RN04 - Restrição de Acesso: apenas perfil 'administrador'
--          altera preços/descontos/relatórios financeiros e acessa
--          Gerenciar Usuários / Configurações da Loja (a partir do
--          módulo de Cargos, o que decide isso são as permissões do
--          cargo do usuário — ver comentário acima de "permissoes")
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
