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
| GET    | `/api/usuarios`                      | `usuarios.visualizar` | Lista usuários e cargos da loja |
| POST   | `/api/usuarios`                      | `usuarios.criar` | Cria usuário não administrativo |
| PUT    | `/api/usuarios/{id}`                 | `usuarios.editar` | Edita nome, e-mail, cargo e situação |
| DELETE | `/api/usuarios/{id}`                 | `usuarios.excluir` | Remove usuário (RN21: confirmação é no front) |
| GET    | `/api/cargos`                        | `cargos.visualizar` | Lista cargos da loja + catálogo de permissões |
| POST   | `/api/cargos`                        | `cargos.criar` | Cria cargo |
| PUT    | `/api/cargos/{id}`                   | `cargos.editar` | Altera nome, cor, descrição e permissões |
| DELETE | `/api/cargos/{id}`                   | `cargos.excluir` | Exclui cargo que não seja de sistema |
| GET    | `/api/produtos`                      | `produtos.visualizar` | Catálogo da loja (Controle de Estoque) |
| POST   | `/api/produtos`                      | `produtos.criar` | Cadastra produto (Fig. 25) |
| PUT    | `/api/produtos/{id}`                 | `produtos.editar` | Edita produto (preços exigem `produtos.editar_preco`, RN04) |
| DELETE | `/api/produtos/{id}`                 | `produtos.excluir` | Exclui ou inativa o produto (RN03) |
| GET    | `/api/produtos/{id}/movimentacoes`   | `estoque.visualizar` | Histórico de entradas/saídas do produto (RF10) |
| GET    | `/api/estoque/movimentacoes`         | `estoque.visualizar` | Movimentações da loja (Dashboard, RF06) |
| POST   | `/api/estoque/movimentacoes`         | `estoque.movimentar` | Lança entrada ou saída manual (RF03/RF12) |
| GET    | `/api/vendas`                        | `vendas.visualizar` | Histórico de vendas com itens e pagamentos |
| POST   | `/api/vendas`                        | `vendas.registrar` | Finaliza venda (itens, pagamentos e desconto) |
| GET    | `/api/loja`                          | `loja.visualizar` | Dados da loja (Configurações da Loja) |
| PUT    | `/api/loja`                          | `loja.configurar` | Atualiza dados da loja |

As permissões vivem na tabela `permissoes` e são atribuídas a cargos na
tela "Cargos". Cada uma corresponde a uma chamada real de
`Auth::requirePermission()` — nenhuma é apenas decorativa. O cargo do
usuário e suas permissões são revalidados **a cada requisição**, de modo
que inativar alguém ou mudar o cargo dele tem efeito imediato, sem
precisar relogar.

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
  implementada pela metade.
- **`movimentacoes_financeiras`** — reservada para uma tela futura de
  lançamentos manuais. Os indicadores financeiros do Dashboard (RF06)
  são calculados direto de `vendas`.
