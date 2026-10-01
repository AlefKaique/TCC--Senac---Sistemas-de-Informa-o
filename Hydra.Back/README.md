# Hydra.Back

API REST em PHP (PDO + MySQL) do Sistema Hydra. Sem framework — um front
controller único (`public/index.php`) roteia as requisições para os
`Controllers`, que usam `Repositories` (prepared statements) para acessar
o banco `hydra_db`.

Cobre por enquanto o módulo de **Cadastro de Usuário e Permissões** (loja +
usuários), que dá suporte às telas: Cadastro (Fig. 13), Login (Fig. 14),
Recuperar senha (Fig. 15), Gerenciar Usuários e Configurações da Loja.

## Configuração

1. Copie `.env.example` para `.env` e ajuste as credenciais do MySQL local.
2. O banco `hydra_db` e suas tabelas já devem existir — execute
   `schema.sql` para criá-las. O arquivo descreve o estado final do
   modelo e espera um banco limpo: para reaplicá-lo, recrie o banco
   antes (as linhas de `DROP DATABASE` / `CREATE DATABASE` estão
   comentadas no cabeçalho dele).
3. (Opcional) Preencha as variáveis `MAIL_*` no `.env` com um SMTP válido
   para o envio real do código da tela de Recuperar Senha. Sem isso, o
   código volta na resposta da API (`codigo_dev`) só para teste local.

## Rodando localmente

Com o PHP embutido (sem precisar do Apache do XAMPP):

```bash
php -S localhost:8080 -t public public/index.php
```

A API fica disponível em `http://localhost:8080/api/...`.

Alternativamente, aponte um VirtualHost do Apache (XAMPP) para a pasta
`public/` deste projeto — o `.htaccess` já cuida do roteamento.

## Endpoints

| Método | Rota                          | Autenticação        | Descrição |
|--------|-------------------------------|----------------------|-----------|
| POST   | `/api/auth/registro`          | pública              | Onboarding: cria loja + usuário administrador (Fig. 13) |
| POST   | `/api/auth/login`             | pública              | Login (Fig. 14) |
| POST   | `/api/auth/logout`            | logado               | Encerra a sessão |
| GET    | `/api/auth/me`                | logado               | Usuário autenticado atual |
| POST   | `/api/auth/esqueci-senha`     | pública              | Envia código de verificação por e-mail (Fig. 15) |
| POST   | `/api/auth/redefinir-senha`   | pública (via código) | Valida o código e define nova senha |
| GET    | `/api/usuarios`                | administrador        | Lista usuários da loja (Gerenciar Usuários) |
| POST   | `/api/usuarios`                | administrador        | Cria operador_caixa/estoquista |
| PUT    | `/api/usuarios/{id}`           | administrador        | Edita nome/e-mail/perfil/status |
| DELETE | `/api/usuarios/{id}`           | administrador        | Remove usuário (RN21: confirmação é no front) |
| GET    | `/api/loja`                    | administrador        | Dados da loja (Configurações da Loja) |
| PUT    | `/api/loja`                    | administrador        | Atualiza dados da loja |

Autenticação é feita por sessão PHP (cookie `PHPSESSID`), que expira ao
fechar o navegador. Não há login persistente ("lembrar de mim"): o
sistema roda em terminais de loja compartilhados, onde manter alguém
logado por dias entregaria a conta do operador anterior a quem usasse a
máquina depois, e falsearia a autoria gravada nas movimentações de
estoque. O front-end precisa enviar `credentials: 'include'` nas
chamadas `fetch`.

## Próximos módulos

Produtos, estoque, vendas e financeiro (Figuras 16-19) ainda não têm
tabelas/endpoints — o modelo físico documentado (Figura 21) já cobre
essas entidades e pode ser usado como base quando esses módulos forem
implementados.
