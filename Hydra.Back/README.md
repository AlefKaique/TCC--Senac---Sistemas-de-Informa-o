# Hydra.Back

API REST em PHP (PDO + MySQL) do Sistema Hydra. Sem framework — um front
controller único (`public/index.php`) roteia as requisições para os
`Controllers`, que usam `Repositories` (prepared statements) para acessar
o banco `hydra_db`.

Cobre os módulos de **Loja e Usuários** (Cadastro — Fig. 13, Login —
Fig. 14, Recuperar senha — Fig. 15, Gerenciar Usuários, Configurações da
Loja), **Cargos e Permissões**, **Produtos**, **Controle de Estoque** e
**Vendas (PDV)**.

## Configuração

1. Copie `.env.example` para `.env` e ajuste as credenciais do MySQL local.
2. O banco `hydra_db` e suas tabelas já devem existir — execute
   `schema.sql` para criá-las. O arquivo descreve o estado final do
   modelo e espera um banco limpo: para reaplicá-lo, recrie o banco
   antes (as linhas de `DROP DATABASE` / `CREATE DATABASE` estão
   comentadas no cabeçalho dele). Depois, execute
   `sql/seed_catalogo_hortifruti.sql` para carregar os 120 itens padrão;
   esse seed pode ser executado novamente sem duplicar códigos.
3. Preencha `BREVO_API_KEY` e `MAIL_*` no `.env` para enviar os códigos
   de acesso da Plataforma Hydra, convites e e-mails de recuperação. O
   envio usa a **API HTTP do Brevo**, não SMTP — provedores como o Render
   bloqueiam as portas 25, 465 e 587. Sem a chave, os fluxos da plataforma
   informam que o envio falhou; os códigos de desenvolvimento da
   recuperação de senha continuam disponíveis apenas com `APP_ENV=local`.
4. Defina `APP_ENV=local` na sua máquina e `production` no servidor. Esse
   valor controla o `codigo_dev` acima e o curinga de CORS.

## Rodando localmente

Com o PHP embutido (sem precisar do Apache do XAMPP):

```bash
php -S localhost:8080 -t public public/index.php
```

A API fica disponível em `http://localhost:8080/api/...`.

Alternativamente, aponte um VirtualHost do Apache (XAMPP) para a pasta
`public/` deste projeto — o `.htaccess` já cuida do roteamento.

## Endpoints

| Método | Rota | Permissão exigida | Descrição |
|--------|------|-------------------|-----------|
| GET    | `/api/health`                        | pública | Verificação de saúde (usada pelo Render) |
| POST   | `/api/auth/registro`                 | pública | Onboarding: cria loja + usuário administrador (Fig. 13) e envia o código de confirmação do e-mail; não abre sessão |
| POST   | `/api/auth/verificar-email`          | pública (via código) | Confirma o e-mail da conta recém-criada; depois o front redireciona para o Login |
| POST   | `/api/auth/reenviar-verificacao`     | pública | Reenvia o código de confirmação do e-mail |
| POST   | `/api/auth/login`                    | pública | Login (Fig. 14). Para Administrador ou e-mail não confirmado responde `requer_codigo` e envia um código por e-mail |
| POST   | `/api/auth/login/codigo`             | login pendente | Segunda etapa: valida o código e abre a sessão |
| POST   | `/api/auth/login/reenviar`           | login pendente | Reenvia o código da segunda etapa |
| POST   | `/api/auth/logout`                   | logado | Encerra a sessão |
| GET    | `/api/auth/me`                       | logado | Usuário autenticado atual, com suas permissões |
| POST   | `/api/auth/esqueci-senha`            | pública | Envia código de verificação por e-mail (Fig. 15) |
| POST   | `/api/auth/verificar-codigo-recuperacao` | pública (via código) | Confere o código antes de a tela pedir a nova senha (não o consome) |
| POST   | `/api/auth/redefinir-senha`          | pública (via código) | Valida o código de novo e define nova senha |
| GET    | `/api/usuarios`                      | `equipe.gerenciar` | Lista usuários e cargos da loja |
| POST   | `/api/usuarios`                      | `equipe.gerenciar` | Cria usuário não administrativo |
| PUT    | `/api/usuarios/{id}`                 | `equipe.gerenciar` | Edita nome, e-mail, cargo e situação (ativo/inativo) |
| GET    | `/api/cargos`                        | `equipe.gerenciar` | Lista cargos da loja + catálogo de permissões |
| POST   | `/api/cargos`                        | `equipe.gerenciar` | Cria cargo |
| PUT    | `/api/cargos/{id}`                   | `equipe.gerenciar` | Altera nome, cor, descrição e permissões |
| DELETE | `/api/cargos/{id}`                   | `equipe.gerenciar` | Exclui cargo que não seja de sistema |
| GET    | `/api/produtos`                      | `estoque.consultar` | Catálogo da loja (Controle de Estoque e Caixa) |
| GET    | `/api/produtos/codigo-barras/{codigo}` | `estoque.consultar` | Busca produto da filial ativa por código de barras (8–14 dígitos) |
| POST   | `/api/produtos`                      | `produtos.gerenciar` | Cadastra produto (Fig. 25) |
| PUT    | `/api/produtos/{id}`                 | `produtos.gerenciar` | Edita produto (preços exigem `produtos.editar_preco`, RN04) |
| DELETE | `/api/produtos/{id}`                 | `produtos.gerenciar` | Exclui ou inativa o produto (RN03) |
| GET    | `/api/produtos/{id}/movimentacoes`   | `estoque.consultar` | Histórico de entradas/saídas do produto (RF10) |
| GET    | `/api/estoque/movimentacoes`         | `estoque.consultar` | Movimentações da loja (Dashboard, RF06) |
| POST   | `/api/estoque/movimentacoes`         | `estoque.lancar` | Lança entrada ou saída manual (RF03/RF12) |
| GET    | `/api/vendas`                        | `vendas.historico` **ou** `relatorios.visualizar` | Histórico de vendas com itens, pagamentos, o nome de quem registrou e o próximo número de pedido da loja |
| GET    | `/api/relatorios/resumo`              | `relatorios.visualizar` | Indicadores financeiros, comparativo com período anterior e visão de hoje |
| GET    | `/api/relatorios/vendas-por-dia`      | `relatorios.visualizar` | Série diária de vendas e período anterior |
| GET    | `/api/relatorios/pagamentos`          | `relatorios.visualizar` | Vendas agrupadas por forma de pagamento |
| GET    | `/api/relatorios/horarios`            | `relatorios.visualizar` | Média de vendas por dia da semana e hora |
| GET    | `/api/relatorios/produtos`            | `relatorios.visualizar` | Produtos mais vendidos, mais lucrativos, menor margem e curva ABC |
| GET    | `/api/relatorios/estoque`             | `relatorios.visualizar` | Valoração atual, risco de ruptura, estoque sem giro e alertas de validade/mínimo |
| GET    | `/api/relatorios/cancelamentos`       | `relatorios.visualizar` | Cancelamentos do período, responsáveis e motivos |
| GET    | `/api/relatorios/operadores`          | `relatorios.visualizar` | Vendas, faturamento, ticket médio e cancelamentos por operador |
| GET    | `/api/alertas/preferencias`           | `loja.configurar` | Preferências de alertas e os últimos 10 envios do administrador |
| PUT    | `/api/alertas/preferencias`           | `loja.configurar` | Salva canais e tipos de alerta |
| POST   | `/api/alertas/destinatarios`          | `loja.configurar` | Adiciona o celular pessoal do administrador, com consentimento explícito |
| DELETE | `/api/alertas/destinatarios/{id}`     | `loja.configurar` | Revoga e remove um telefone da lista do administrador |
| POST   | `/api/alertas/teste`                  | `loja.configurar` | Envia um resumo de teste da filial ativa (até 3 por hora) |
| POST   | `/api/interno/alertas/disparar`       | `X-Cron-Token` | Executa o envio diário sem sessão de usuário |
| GET    | `/api/whatsapp/webhook`                | verificação Meta | Confirma o webhook com `WHATSAPP_VERIFY_TOKEN` |
| POST   | `/api/whatsapp/webhook`                | assinatura Meta | Atualiza entrega/leitura e processa pedidos de cancelamento `SAIR` |
| POST   | `/api/vendas`                        | `vendas.operar` | Finaliza venda (itens, pagamentos e desconto) |
| GET    | `/api/pix/mercadopago/conta`          | `loja.configurar` | Consulta se a integração Mercado Pago está configurada/conectada, sem retornar tokens |
| POST   | `/api/pix/mercadopago/conectar`       | `loja.configurar` | Inicia OAuth para conectar a conta Mercado Pago da loja |
| GET    | `/api/pix/mercadopago/callback`       | sessão OAuth válida | Recebe o retorno OAuth e grava os tokens criptografados |
| DELETE | `/api/pix/mercadopago/conta`          | `loja.configurar` | Desconecta a conta Mercado Pago da loja |
| POST   | `/api/pix/pagamentos`                 | `vendas.operar` | Cria cobrança Pix dinâmica e retorna QR Code/código copia e cola |
| GET    | `/api/pix/pagamentos/pendente`         | `vendas.operar` | Retoma a cobrança pendente do operador atual |
| GET    | `/api/pix/pagamentos/{id}`             | `vendas.operar` | Consulta pagamento; ao confirmar, grava venda e baixa estoque atomicamente |
| POST   | `/api/vendas/autorizar-cancelamento` | `vendas.operar` **ou** `vendas.historico` | Confere a senha de autorização (PIN) de um gerente/administrador e libera cancelamentos por 5 minutos, nesta filial (fica na sessão) |
| POST   | `/api/vendas/autorizar-cancelamento/encerrar` | logado | Encerra a autorização antes do prazo (a tela saiu da aba Cancelar Venda) |
| POST   | `/api/vendas/{id}/cancelar`          | `vendas.operar` **ou** `vendas.historico` + autorização acima | Cancela a venda (`{ "motivo": "..." }`), devolve os itens ao estoque e grava quem autorizou |
| GET    | `/api/loja`                          | `loja.configurar` | Dados da loja (Configurações da Loja) |
| PUT    | `/api/loja`                          | `loja.configurar` | Atualiza dados da loja |
| GET    | `/api/filiais/minhas`                | logado | Filiais ativas que o usuário pode acessar e a filial ativa da sessão |
| POST   | `/api/filiais/trocar`                | logado | Troca a filial ativa (`{ "id_filial": N }`): 403 sem acesso, 404 inexistente, 422 inativa |
| GET    | `/api/filiais`                       | `loja.configurar` **ou** `equipe.gerenciar` | Todas as filiais da loja (seção Filiais e tela Equipe) |
| POST   | `/api/filiais`                       | `loja.configurar` | Cria filial; `importar_hortifruti: true` solicita também a importação (exige `produtos.importar_catalogo`) |
| PUT    | `/api/filiais/{id}`                  | `loja.configurar` | Edita filial; recusa inativar a única ativa ou a da própria sessão |
| GET    | `/api/catalogo-hortifruti`           | pública | Lista o catálogo padrão de códigos hortifrúti |
| POST   | `/api/catalogo-hortifruti/importar`  | `produtos.importar_catalogo` | Importa para a filial ativa sem sobrescrever códigos existentes |

As rotas `/api/relatorios/*` aceitam `?de=AAAA-MM-DD&ate=AAAA-MM-DD`; sem
datas, usam os últimos 30 dias. O limite é 366 dias e todas as consultas usam
a filial ativa da sessão. O validador local das agregações pode ser executado
somente com `APP_ENV=local` e banco em `localhost`/loopback; ele exige
confirmação explícita, usa uma filial com usuário e produto ativos e reverte
os registros de teste:

```bash
APP_ENV=local php bin/seed-relatorios.php --id-filial=1 --confirm-test-data
```

O custo histórico é gravado em cada item da venda; vendas anteriores à
migração recebem o custo atual do cadastro marcado como estimado. O percentual
de cancelamentos considera o valor cancelado dividido pelo total concluído
mais cancelado no período.

### Catálogo hortifrúti e balança

O cadastro inicial permite escolher a importação para a primeira filial; a
mesma opção fica no fim do formulário de criação de cada filial. Sem marcar
essa opção, o fluxo continua permitindo cadastrar produtos manualmente. Os
itens importados entram com estoque zero, preço e PLU nulos. O Administrador
define o preço em Estoque antes de o item poder ser vendido. Códigos próprios
podem ser cadastrados manualmente na faixa 500–599.

No caixa, a busca aceita o código curto ou a etiqueta EAN-13. Para manter
13 dígitos, a etiqueta de balança reconhecida usa um prefixo de dois dígitos
da faixa interna `20`–`29` (configure `20`), código interno preenchido com
zeros à esquerda até cinco dígitos, peso em gramas com cinco dígitos e o
dígito verificador EAN-13. Exemplo: código `101` e peso `350 g` formam
`20` + `00101` + `00350` + verificador = `2000101003502`. Configure a
balança para emitir exatamente esse formato; a configuração do equipamento
varia por fabricante e não é alterada pelo Hydra.

O código de barras de produtos comuns é opcional e, quando informado, deve
conter de 8 a 14 dígitos. Pode ser lido pela câmera na busca do Caixa e nos
formulários de cadastro/edição. A câmera requer permissão do usuário, HTTPS
(ou `localhost`) e navegador com suporte à API `BarcodeDetector`; sem esse
suporte, o código pode ser digitado ou lido com um leitor USB. A leitura é
processada no próprio navegador.

### Pix dinâmico no Caixa (Mercado Pago)

O botão **Pix com QR Code** gera uma cobrança dinâmica na conta do mercado
conectada por OAuth. O Caixa consulta o status a cada 2,5 segundos e só grava
a venda/baixa o estoque após confirmar o pagamento aprovado no Mercado Pago.
O QR e o código Pix copia e cola ficam disponíveis enquanto a cobrança está
pendente; a tela pode ser recarregada e retoma a consulta. Este fluxo usa
polling, não webhook; a API Hydra precisa apenas de acesso HTTPS de saída ao
Mercado Pago.

**RN10 — formas de pagamento:** dinheiro, cartão de crédito, cartão de débito,
vale-refeição e Pix. No Pix dinâmico, informar o e-mail do cliente gera uma
cobrança única; status pendente/rejeitado não registra a venda e somente o
status aprovado permite a finalização automática.

Para habilitar:

1. Crie uma aplicação no painel de desenvolvedores do Mercado Pago e configure
   o URI de redirecionamento OAuth como
   `https://SEU-DOMINIO/api/pix/mercadopago/callback` (tem que corresponder
   exatamente a `MERCADOPAGO_REDIRECT_URI`).
2. Configure `MERCADOPAGO_CLIENT_ID`, `MERCADOPAGO_CLIENT_SECRET`,
   `MERCADOPAGO_REDIRECT_URI` e `HYDRA_FRONTEND_URL` no ambiente do Hydra.Back.
   Gere `HYDRA_ENCRYPTION_KEY` com
   `php -r "echo base64_encode(random_bytes(32)), PHP_EOL;"`.
   Mantenha essa chave privada e persistente: sem ela os tokens já conectados
   não poderão ser descriptografados.
3. Execute o schema atualizado ou deixe a migração automática criar as tabelas.
   Um Administrador conecta a conta da loja em **Configurações da Loja**.
4. No Caixa, escolha **Pix com QR Code**. O operador deve manter a sessão
   aberta até o status aprovado para concluir a venda automaticamente.

Não configure um Access Token único compartilhado: cada loja conecta a própria
conta e os tokens OAuth são criptografados em repouso. Em desenvolvimento, o
retorno OAuth precisa chegar ao navegador e à API usando um endereço permitido
no painel do Mercado Pago; se o celular não alcançar o servidor local, use um
túnel HTTPS como ngrok. Não há webhook para apontar ao `localhost`.

### Plataforma Hydra

As telas administrativas ficam em `Hydra.Front/pages/plataforma/`. A
autenticação da plataforma é separada das sessões de mercado: o login exige
senha e código por e-mail, e os endpoints validam o nível do membro no
servidor. Os níveis são **Analista** (consulta), **Gestor** (consulta,
auditoria e suspensão/reativação) e **Proprietário** (acesso total e gestão
da equipe).

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| POST | `/api/plataforma/auth/login` | pública | Confere e-mail/senha e envia código de acesso |
| POST | `/api/plataforma/auth/codigo` | login pendente | Confere o código e abre a sessão da plataforma |
| POST | `/api/plataforma/auth/reenviar` | login pendente | Reenvia o código da segunda etapa |
| POST | `/api/plataforma/auth/primeiro-acesso` | convite válido | Define a senha inicial de um membro convidado |
| GET | `/api/plataforma/auth/me` | plataforma autenticada | Revalida a sessão e retorna o nível atual |
| POST | `/api/plataforma/auth/logout` | plataforma autenticada | Registra a saída e encerra a sessão |
| GET | `/api/plataforma/resumo` | plataforma autenticada | Indicadores agregados da visão geral |
| GET | `/api/plataforma/rendimento?dias=30` | plataforma autenticada | Faturamento agregado, evolução e ranking dos mercados (7, 30, 90 ou 365 dias) |
| GET | `/api/plataforma/lojas` | plataforma autenticada | Lista paginada de mercados com busca e filtros |
| GET | `/api/plataforma/lojas/{id}` | plataforma autenticada | Detalhes agregados de um mercado |
| POST | `/api/plataforma/lojas/{id}/suspender` | Proprietário ou Gestor | Suspende o mercado com motivo obrigatório |
| POST | `/api/plataforma/lojas/{id}/reativar` | Proprietário ou Gestor | Reativa o mercado com motivo obrigatório |
| GET | `/api/plataforma/cadastros-pendentes` | plataforma autenticada | Lista cadastros que ainda aguardam confirmação |
| GET | `/api/plataforma/auditoria` | Proprietário ou Gestor | Consulta o histórico de ações administrativas |
| GET/POST | `/api/plataforma/equipe` | Proprietário | Lista membros ou envia um convite |
| PUT | `/api/plataforma/equipe/{id}` | Proprietário | Altera nível ou situação de um membro |
| POST | `/api/plataforma/equipe/{id}/reenviar-convite` | Proprietário | Emite um novo convite válido por 24 horas |

Não há conta padrão. Para criar o primeiro Proprietário, na pasta
`Hydra.Back`, execute `php bin/criar-admin-plataforma.php "Nome" email@dominio.com`
e informe a senha quando solicitado. O script valida a política de senha e
não exibe a senha enquanto ela é digitada. Em bancos existentes, as colunas
da equipe, o status de suspensão e os índices necessários são aplicados
automaticamente na primeira requisição da plataforma; não é necessário
recriar o banco nem reaplicar `schema.sql`.

### Cancelamento de venda

A tela Vendas tem a aba **Cancelar Venda**, ao lado do Histórico. Ela só
abre depois que um gerente ou administrador digita a **senha de
autorização** dele: um PIN de 4 a 8 números, separado da senha de login,
que o administrador cadastra na tela Equipe (ao criar ou editar o
usuário). Quem não tem PIN não autoriza nada; o PIN é único dentro da
loja, porque é ele que identifica quem autorizou.

A autorização vale 5 minutos, só na filial em que foi dada, e fica na
sessão. O PIN errado conta tentativas (`RateLimit`, chave por operador).
A venda cancelada não é apagada: muda para `status = 'cancelada'`, os
itens voltam ao estoque por uma movimentação de entrada com origem
`cancelamento_venda`, e o Dashboard e a tela Filiais deixam de somá-la.

Banco criado antes deste recurso: o back-end cria as colunas sozinho
(`Hydra\Support\Migracoes`); `sql/migracao_cancelamento_vendas.sql` faz o
mesmo à mão.

### Filiais

Produtos, estoque, vendas e promoções são **por filial**. Todos os
endpoints dessas áreas (`/api/produtos*`, `/api/estoque/*`, `/api/vendas`,
`/api/promocoes*`) filtram pela filial ativa **guardada na sessão**, nunca
por um id enviado pelo navegador, e revalidam a cada requisição que o
usuário ainda tem acesso a ela (`Auth::requirePermissionNaFilial`). Sem
filial ativa válida eles respondem **409** com `"codigo":
"filial_nao_selecionada"`, e o front-end abre a janela de escolha.

O Administrador (cargo de nível administrador, pelo mesmo critério de
`CargoRepository::nivelEquivalente`) acessa todas as filiais ativas; os
demais, só as marcadas para eles na tela de Equipe (`usuario_filiais`).
Usuário não administrador sem nenhuma filial ativa vinculada não consegue
fazer login. Usuários, cargos e Configurações da Loja valem para a rede
inteira e não dependem da filial.

Banco criado antes deste módulo: rode `sql/migracao_filiais.sql` (com
backup antes; instruções no próprio arquivo).

Não há `DELETE /api/usuarios/{id}`: **funcionário não se exclui**. As
vendas (`vendas.id_usuario`) e as movimentações de estoque
(`movimentacoes_estoque.id_usuario`) gravam quem fez cada lançamento, e
apagar o usuário apagaria a autoria do histórico da loja. Para revogar o
acesso de quem saiu, mude o status dele para `inativo` pela tela de Equipe:
o login passa a ser recusado e a sessão aberta cai na requisição seguinte.

### Cargos e permissões

São **10 permissões**, recortadas pelas funções que alguém de fato exerce no
mercadinho. É o meio-termo entre as duas tentativas anteriores: a primeira
tinha 19 códigos (ver/criar/editar/excluir por módulo) e pedia uma decisão
que ninguém toma — "pode editar mas não excluir produto"; a segunda caiu
para 5 códigos grossos e juntou demais, a ponto de autorizar alguém a
conferir o estoque implicar autorizá-lo a lançar movimentação e mexer no
cadastro.

O corte atual separa **consultar** de **mexer** em cada área, e separa
Estoque de Caixa por inteiro.

| código | nome na tela | o que libera |
|---|---|---|
| `estoque.consultar` | Consultar Estoque | abrir a tela de Estoque e ler o catálogo (produtos, saldos, lotes, validades e o histórico de movimentações). É leitura: não cadastra nem movimenta. É a **base** das duas abaixo — sem ela a tela de Estoque não abre |
| `estoque.lancar` | Entradas e Saídas de Estoque | lançar entrada/saída e corrigir o saldo de um produto |
| `produtos.gerenciar` | Cadastro de Produtos | cadastrar, editar e excluir produtos |
| `produtos.editar_preco` | Alterar Preços | alterar preço de custo e de venda (RN04). Só tem efeito somada a `produtos.gerenciar`, que é o que libera o `PUT /api/produtos/{id}` |
| `vendas.operar` | Vendas no Caixa | abrir o PDV e finalizar vendas |
| `vendas.historico` | Histórico de Vendas | consultar as vendas já finalizadas e os detalhes de cada uma |
| `relatorios.visualizar` | Relatórios | abrir o Dashboard com o faturamento e os indicadores (RN16, RN17) |
| `equipe.gerenciar` | Equipe e Cargos | as telas de Equipe e de Cargos |
| `loja.configurar` | Configuração da Loja | ver e alterar os dados cadastrais da loja |

Cargos de sistema criados para toda loja nova:

| cargo | permissões |
|---|---|
| Administrador | todas as 9 |
| Operador de Caixa | `estoque.consultar`, `vendas.operar`, `vendas.historico`, `relatorios.visualizar` |
| Estoquista | `estoque.consultar`, `estoque.lancar`, `produtos.gerenciar` |

O Estoquista não recebe permissão de venda nenhuma e o Operador de Caixa não
recebe nenhuma de escrita no estoque. O que os dois compartilham é
`estoque.consultar`, porque o Caixa precisa ler o catálogo para montar a
venda — ler não é mexer.

Cada código corresponde a uma chamada real de `Auth::requirePermission()`
(ou `::requireAnyPermission()`, usada só em `GET /api/vendas`) — nenhum é
apenas decorativo. No front-end, as mesmas permissões escondem os itens da
barra lateral e barram a abertura da tela (`hydraAplicarMenuPorPermissao` e
`hydraGuardaDeTela`, em `Hydra.Front/js/api.js`). O cargo do usuário e suas
permissões são revalidados **a cada requisição**, de modo que inativar
alguém ou mudar o cargo dele tem efeito imediato, sem precisar relogar.

**Migração de um banco das versões anteriores.**
`CargoRepository::ensureDefaults()` roda a cada login e faz tudo sozinho:
cria o catálogo novo, copia o acesso dos códigos antigos para os novos e só
então apaga os antigos. Desta vez a regra **sobre-concede** de propósito:
quem tinha `estoque.gerenciar` recebe os três códigos que o substituem, e
quem tinha `vendas.operar` recebe também `vendas.historico` e
`relatorios.visualizar`, que antes vinham junto. Ninguém perde acesso que já
exercia — reabra Cargos e desmarque o que cada cargo não deve mais ter,
porque reduzir é reversível e ficar trancado do lado de fora não é.

Se algo der errado no meio da migração e ninguém mais conseguir abrir Equipe
ou Cargos, o diagnóstico e a recuperação são por SQL:

```sql
-- O que cada cargo tem hoje:
SELECT c.id_loja, c.id_cargo, c.nome, c.cargo_sistema,
       COALESCE(GROUP_CONCAT(p.codigo ORDER BY p.ordem), '(nenhuma)') AS permissoes
  FROM cargos c
  LEFT JOIN cargo_permissoes cp ON cp.id_cargo = c.id_cargo
  LEFT JOIN permissoes p        ON p.id_permissao = cp.id_permissao
 GROUP BY c.id_cargo
 ORDER BY c.id_loja, c.cargo_sistema DESC;

-- Devolve todas as permissões ao cargo "Administrador" (ajuste o id_loja):
INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao)
SELECT c.id_cargo, p.id_permissao
  FROM cargos c CROSS JOIN permissoes p
 WHERE c.id_loja = 1 AND c.nome = 'Administrador';

-- Realinha o ENUM legado, que sustenta "a loja precisa de um admin ativo":
UPDATE usuarios u JOIN cargos c ON c.id_cargo = u.id_cargo
   SET u.perfil = 'administrador'
 WHERE c.id_loja = 1 AND c.nome = 'Administrador';
```

Se o catálogo tiver ficado vazio, basta fazer login: `garantirCatalogo()` o
recria.

### Limite de tentativas

`login`, `esqueci-senha` e `redefinir-senha` contam tentativas na tabela
`tentativas_acesso`. Depois de 5 falhas para o mesmo e-mail, a rota
responde **429** e bloqueia por 15 minutos, dobrando a cada novo grupo de
falhas. Sem isso, o código de 6 dígitos da recuperação (1 milhão de
combinações, válido por 15 minutos) seria percorrível por um script.

Os códigos de confirmação de e-mail e de login (`verificar-email`,
`login/codigo`) usam a chave `codigo:<email>`, e os envios de código
(`registro`, `login`, reenvios) usam `envio:<email>`, para que "Reenviar
código" não vire um disparador ilimitado de e-mails.

### Confirmação de e-mail e código no login

A conta criada no Cadastro só tem o e-mail confirmado depois de digitar o
código enviado (`usuarios.email_verificado`). No login, quem ainda não
confirmou o e-mail e todo **Administrador** precisam digitar um código de
6 dígitos (válido por 10 minutos) enviado ao e-mail. Operador de Caixa e
Estoquista entram só com a senha. Funcionários criados em Gerenciar
Usuários já nascem com o e-mail confirmado. Banco já em uso: ver o
`ALTER TABLE usuarios` no comentário da tabela em `schema.sql`.

Autenticação é feita por sessão PHP (cookie `PHPSESSID`), que expira ao
fechar o navegador. Não há login persistente ("lembrar de mim"): o
sistema roda em terminais de loja compartilhados, onde manter alguém
logado por dias entregaria a conta do operador anterior a quem usasse a
máquina depois, e falsearia a autoria gravada nas movimentações de
estoque. O front-end precisa enviar `credentials: 'include'` nas
chamadas `fetch`.

## Alertas diários por WhatsApp

Os alertas usam exclusivamente a **WhatsApp Cloud API oficial da Meta**.
Somente o administrador da loja (`loja.configurar`) configura os alertas em
Configurações da Loja e cadastra seu próprio celular para recebê-los. O
telefone exige consentimento explícito e pode ser removido na tela ou
cancelado respondendo `SAIR`. Os alertas só são enviados enquanto o
administrador estiver ativo e mantiver a permissão. O resumo é calculado por
filial, usando `produtos.estoque_minimo` e `produtos.validade`.

O número remetente é da conta WhatsApp Business configurada pelo responsável
técnico na Meta e nas variáveis do servidor; não é cadastrado na tela da loja.
No modo de teste da Meta, cada celular destinatário também precisa ser
autorizado no painel da Meta. A loja escolhe WhatsApp, e-mail ou ambos; uma
falha de entrega WhatsApp usa o e-mail cadastrado na conta Hydra como
alternativa.

Defina as variáveis `WHATSAPP_*`, `ALERTAS_CRON_TOKEN` e `APP_URL` conforme
`.env.example`. `WHATSAPP_ENABLED=false` é o padrão e nunca chama a Meta:
os resumos seguem por e-mail. A entrega exige que o remetente e o template
`hydra_resumo_diario` estejam aprovados no idioma `pt_BR`; o passo a passo
está em [docs/whatsapp-template.md](docs/whatsapp-template.md). O token,
app secret e verify token são somente de servidor e não devem ser incluídos
no front-end ou em logs.

O histórico diário reserva cada destino antes do envio e tem uma chave única
por usuário, filial, data, canal e destinatário. Assim cada número recebe no
máximo uma mensagem diária, mesmo quando dois agendadores executam ao mesmo tempo. Se o WhatsApp estiver desligado ou
falhar, o resumo é enviado por e-mail. Sem alertas ativos na filial, nada é
enviado.

Disparo manual no servidor:

```bash
php bin/enviar-alertas.php
php bin/enviar-alertas.php 2026-11-08
```

Para agendamento externo, configure uma tarefa diária às 7h no fuso
`America/Sao_Paulo` (por exemplo, cron-job.org):

- Método: `POST`
- URL: `https://SEU-DOMINIO/api/interno/alertas/disparar`
- Cabeçalho: `X-Cron-Token: VALOR_DE_ALERTAS_CRON_TOKEN`
- Corpo: `{}` (opcionalmente `{"data":"AAAA-MM-DD"}` para execução manual)

A resposta JSON informa `enviados`, `pulados` e `falhas`. Sem token correto,
a rota responde `401`. A configuração preguiçosa cria as tabelas em bancos
existentes; o `schema.sql` também contém a estrutura completa para bancos
novos.

## Próximos módulos

Dois itens do modelo físico (Figura 21) existem no `schema.sql` mas ainda
não têm endpoints nem tela:

- **`clientes`** — a tabela e a FK `vendas.id_cliente` existem, e a API
  aceita `id_cliente` ao registrar uma venda, mas não há CRUD de
  clientes. A RN15 (associação opcional de cliente à venda) está
  implementada pela metade. A tela do Caixa **não expõe mais o cliente**:
  o que o mercadinho precisa saber de uma venda é quem operou o caixa, e
  o histórico passou a mostrar `vendas.id_usuario` (que sempre foi
  gravado) no lugar de uma coluna "Cliente" que vivia vazia. A tabela e a
  coluna permanecem no banco para um CRUD futuro.
- **`movimentacoes_financeiras`** — reservada para uma tela futura de
  lançamentos manuais. Os indicadores financeiros do Dashboard (RF06)
  são calculados direto de `vendas`.
