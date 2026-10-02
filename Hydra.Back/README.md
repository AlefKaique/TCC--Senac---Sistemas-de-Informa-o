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
   comentadas no cabeçalho dele).
3. (Opcional) Preencha `BREVO_API_KEY` e `MAIL_*` no `.env` para o envio
   real do código da tela de Recuperar Senha. O envio usa a **API HTTP do
   Brevo**, não SMTP — provedores como o Render bloqueiam as portas 25,
   465 e 587. Sem a chave, o código volta na resposta da API
   (`codigo_dev`), mas **apenas quando `APP_ENV=local`**.
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
| POST   | `/api/auth/registro`                 | pública | Onboarding: cria loja + usuário administrador (Fig. 13); não abre sessão — o front redireciona para o Login |
| POST   | `/api/auth/login`                    | pública | Login (Fig. 14) |
| POST   | `/api/auth/logout`                   | logado | Encerra a sessão |
| GET    | `/api/auth/me`                       | logado | Usuário autenticado atual, com suas permissões |
| POST   | `/api/auth/esqueci-senha`            | pública | Envia código de verificação por e-mail (Fig. 15) |
| POST   | `/api/auth/redefinir-senha`          | pública (via código) | Valida o código e define nova senha |
| GET    | `/api/usuarios`                      | `equipe.gerenciar` | Lista usuários e cargos da loja |
| POST   | `/api/usuarios`                      | `equipe.gerenciar` | Cria usuário não administrativo |
| PUT    | `/api/usuarios/{id}`                 | `equipe.gerenciar` | Edita nome, e-mail, cargo e situação (ativo/inativo) |
| GET    | `/api/cargos`                        | `equipe.gerenciar` | Lista cargos da loja + catálogo de permissões |
| POST   | `/api/cargos`                        | `equipe.gerenciar` | Cria cargo |
| PUT    | `/api/cargos/{id}`                   | `equipe.gerenciar` | Altera nome, cor, descrição e permissões |
| DELETE | `/api/cargos/{id}`                   | `equipe.gerenciar` | Exclui cargo que não seja de sistema |
| GET    | `/api/produtos`                      | `estoque.gerenciar` **ou** `vendas.operar` | Catálogo da loja (Controle de Estoque e Caixa) |
| POST   | `/api/produtos`                      | `estoque.gerenciar` | Cadastra produto (Fig. 25) |
| PUT    | `/api/produtos/{id}`                 | `estoque.gerenciar` | Edita produto (preços exigem `produtos.editar_preco`, RN04) |
| DELETE | `/api/produtos/{id}`                 | `estoque.gerenciar` | Exclui ou inativa o produto (RN03) |
| GET    | `/api/produtos/{id}/movimentacoes`   | `estoque.gerenciar` | Histórico de entradas/saídas do produto (RF10) |
| GET    | `/api/estoque/movimentacoes`         | `estoque.gerenciar` | Movimentações da loja (Dashboard, RF06) |
| POST   | `/api/estoque/movimentacoes`         | `estoque.gerenciar` | Lança entrada ou saída manual (RF03/RF12) |
| GET    | `/api/vendas`                        | `vendas.operar` | Histórico de vendas com itens, pagamentos e o nome do usuário que registrou |
| POST   | `/api/vendas`                        | `vendas.operar` | Finaliza venda (itens, pagamentos e desconto) |
| GET    | `/api/loja`                          | `loja.configurar` | Dados da loja (Configurações da Loja) |
| PUT    | `/api/loja`                          | `loja.configurar` | Atualiza dados da loja |

Não há `DELETE /api/usuarios/{id}`: **funcionário não se exclui**. As
vendas (`vendas.id_usuario`) e as movimentações de estoque
(`movimentacoes_estoque.id_usuario`) gravam quem fez cada lançamento, e
apagar o usuário apagaria a autoria do histórico da loja. Para revogar o
acesso de quem saiu, mude o status dele para `inativo` pela tela de Equipe:
o login passa a ser recusado e a sessão aberta cai na requisição seguinte.

### Cargos e permissões

São **5 permissões**, uma por área do sistema. A granularidade anterior (19
códigos, ver/criar/editar/excluir por módulo) não correspondia a nenhuma
decisão real de um mercadinho: configura-se "quem cuida do estoque", não
"quem pode editar mas não excluir produto".

| código | nome na tela | o que libera |
|---|---|---|
| `estoque.gerenciar` | Estoque e Produtos | cadastrar, editar e excluir produtos; lançar entradas e saídas |
| `produtos.editar_preco` | Alterar Preços | alterar preço de custo e de venda (RN04). Só tem efeito somada a `estoque.gerenciar`, que é o que libera o `PUT /api/produtos/{id}` |
| `vendas.operar` | Vendas no Caixa | operar o PDV, finalizar vendas, ver o histórico — e ler o catálogo de produtos |
| `equipe.gerenciar` | Equipe e Cargos | as telas de Equipe e de Cargos |
| `loja.configurar` | Configuração da Loja | ver e alterar os dados cadastrais da loja |

Cada uma corresponde a uma chamada real de `Auth::requirePermission()` (ou
`::requireAnyPermission()`, usada só em `GET /api/produtos`) — nenhuma é
apenas decorativa. O cargo do usuário e suas permissões são revalidados **a
cada requisição**, de modo que inativar alguém ou mudar o cargo dele tem
efeito imediato, sem precisar relogar.

**Migração de um banco da versão anterior.** `CargoRepository::ensureDefaults()`
roda a cada login e faz tudo sozinho: cria o catálogo novo, copia o acesso
dos códigos antigos para os novos e só então apaga os antigos. A regra
sub-concede de propósito — só quem tinha algum código de **escrita** na área
ganha a permissão grossa, porque ela também concede escrita. Consequência a
conferir depois de atualizar: um cargo feito à mão que só tinha
`produtos.visualizar`/`estoque.visualizar` termina **sem permissão alguma**,
porque "só olhar o estoque" deixou de existir — reabra Cargos e marque o que
ele deve poder fazer.

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

Autenticação é feita por sessão PHP (cookie `PHPSESSID`), que expira ao
fechar o navegador. Não há login persistente ("lembrar de mim"): o
sistema roda em terminais de loja compartilhados, onde manter alguém
logado por dias entregaria a conta do operador anterior a quem usasse a
máquina depois, e falsearia a autoria gravada nas movimentações de
estoque. O front-end precisa enviar `credentials: 'include'` nas
chamadas `fetch`.

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
