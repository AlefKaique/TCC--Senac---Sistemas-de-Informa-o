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
2. O banco `hydra_db` e as tabelas `lojas`/`usuarios` já devem existir —
   veja `schema.sql` caso precise recriá-las em um banco novo (o script é
   idempotente, usa `CREATE TABLE IF NOT EXISTS`).

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
| POST   | `/api/auth/esqueci-senha`     | pública              | Gera token de redefinição (Fig. 15) |
| POST   | `/api/auth/redefinir-senha`   | pública (via token)  | Define nova senha |
| GET    | `/api/usuarios`                | administrador        | Lista usuários da loja (Gerenciar Usuários) |
| POST   | `/api/usuarios`                | administrador        | Cria operador_caixa/estoquista |
| PUT    | `/api/usuarios/{id}`           | administrador        | Edita nome/e-mail/perfil/status |
| DELETE | `/api/usuarios/{id}`           | administrador        | Remove usuário (RN21: confirmação é no front) |
| GET    | `/api/loja`                    | administrador        | Dados da loja (Configurações da Loja) |
| PUT    | `/api/loja`                    | administrador        | Atualiza dados da loja |

Autenticação é feita por sessão PHP (cookie `PHPSESSID`), com suporte a
"lembrar de mim" via cookie `hydra_remember` (token de 30 dias por
padrão, configurável em `REMEMBER_ME_DAYS`). O front-end precisa enviar
`credentials: 'include'` nas chamadas `fetch`.

## Próximos módulos

Produtos, estoque, vendas e financeiro (Figuras 16-19) ainda não têm
tabelas/endpoints — o modelo físico documentado (Figura 21) já cobre
essas entidades e pode ser usado como base quando esses módulos forem
implementados.
