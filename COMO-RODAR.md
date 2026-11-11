# Como rodar o Sistema Hydra localmente e no Render

O projeto tem duas partes que precisam rodar **ao mesmo tempo**, cada uma no
seu próprio terminal:

- **Backend** (`Hydra.Back`) — API em PHP que conecta no MySQL.
- **Frontend** (`Hydra.Front`) — as páginas HTML/CSS/JS.

Nenhuma das duas pode ser aberta clicando duas vezes no arquivo (`file://`)
— precisa ser servida por HTTP, senão os cookies de sessão e as chamadas
`fetch()` para a API não funcionam.

## Pré-requisitos

- PHP (já vem com o XAMPP). Confirme que funciona abrindo um terminal e
  rodando `php -v`.
- MySQL rodando (o serviço do XAMPP) com o banco `hydra_db` criado.
- Arquivo `Hydra.Back/.env` configurado com as credenciais do seu MySQL
  (copie de `Hydra.Back/.env.example` se ainda não existir).

## Passo a passo

### 1. Abra um terminal na raiz do projeto

No VS Code: menu **Terminal → New Terminal** (ou `` Ctrl+` ``). Confirme
que está na pasta raiz (`tcc-2026-1-e-2-hydra-main`) rodando `pwd` — se
não estiver, use `cd` até lá.

### 2. Suba o backend (porta 8080)

Nesse primeiro terminal, rode:

```
php -S localhost:8080 -t Hydra.Back/public Hydra.Back/public/index.php
```

Ele vai imprimir algo como:

```
PHP 8.2.12 Development Server (http://localhost:8080) started
```

e **ficar parado ali, sem devolver o prompt** — isso é esperado. É o
servidor rodando e escutando a porta 8080, como uma central telefônica
sempre ligada. Enquanto esse terminal estiver aberto com esse comando
ativo, o backend está no ar.

### 3. Abra um segundo terminal e suba o frontend (porta 5500)

Clique no `+` no painel do terminal para abrir um **segundo terminal**,
sem fechar o primeiro. Nele, use uma destas opções:

**Opção A — extensão Live Server do VS Code:** clique com o botão direito
em `Hydra.Front/pages/index.html` (ou `cadastro.html`) → **Open with Live
Server**. Por padrão ele abre em `http://127.0.0.1:5500` — **troque para
`http://localhost:5500`** na barra de endereço do navegador (veja o aviso
importante abaixo).

**Opção B — servidor embutido do PHP:**
```
php -S localhost:5500 -t Hydra.Front
```
e acesse `http://localhost:5500/pages/index.html` no navegador.

### 4. Use a aplicação

Com os dois servidores rodando, abra `http://localhost:5500/pages/cadastro.html`
(ou a porta que o Live Server escolher) no navegador e use normalmente.

> ⚠️ **Use sempre `localhost`, nunca `127.0.0.1`, tanto no front quanto no
> back.** Apesar de apontarem para a mesma máquina, o navegador trata
> `localhost` e `127.0.0.1` como domínios **diferentes** para fins de
> cookie de sessão. Se o front for aberto em `127.0.0.1` enquanto o
> backend está em `localhost` (ou vice-versa), o cookie de login criado
> por um não é enviado nas chamadas para o outro — o login parece
> funcionar, a tela abre, e no instante seguinte ela te joga de volta
> para a tela de login. Portas diferentes (5500 e 8080) não são problema,
> só o nome do host precisa ser o mesmo dos dois lados.

### 5. (Opcional) Login de Administrador da Equipe Hydra

O painel da Equipe Hydra (todos os mercados) fica em
`http://localhost:5500/pages/plataforma/login.html`. Também há o link
**Acesso Equipe Hydra** na tela de login. Para criar um Administrador com
acesso total que entra só com e-mail e senha, sem código por e-mail, rode
na pasta `Hydra.Back`:

```bash
php bin/criar-admin-plataforma.php "Equipe Hydra" admin@hydra.com --nivel=administrador --sem-codigo
```

Depois da apresentação, rode o mesmo comando com `--com-codigo` (responda
"N" para manter a senha) para voltar a exigir o código. Detalhes no
[README do backend](Hydra.Back/README.md#plataforma-hydra).

## Por que os dois terminais precisam ficar abertos

`php -S` não é um comando que "executa e termina" — ele inicia um
**processo de servidor** que fica escutando a porta o tempo todo. Cada vez
que uma página do front faz um `fetch()` para `http://localhost:8080/api/...`,
o navegador precisa achar algo *vivo* respondendo naquela porta naquele
exato momento.

Se você fechar o terminal (ou apertar `Ctrl+C`), o processo morre, a porta
fica vazia e qualquer requisição depois disso dá erro de **"Failed to
fetch"** no navegador — geralmente significa "o backend não está rodando".

## Parar os servidores

Clique no terminal correspondente e aperte `Ctrl+C`.

## Deixar o sistema mais rápido localmente (Apache do XAMPP)

O `php -S` do passo 2 é prático, mas **no Windows ele atende uma requisição
por vez**. Cada tela do Hydra dispara várias chamadas à API ao mesmo tempo
(sessão, filial, produtos, vendas...), e com o `php -S` elas entram numa fila
única: a tela demora a soma de todas. O Apache que já vem no XAMPP atende as
chamadas em paralelo. A troca é feita uma vez só:

1. **Abra a porta 8080 no Apache.** No XAMPP Control Panel, em Apache →
   **Config → httpd.conf**, procure a linha `Listen 80` e acrescente logo
   abaixo:

   ```
   Listen 8080
   ```

2. **Aponte a porta 8080 para o back-end.** Em Apache → **Config →
   Browse [Apache]**, abra `conf/extra/httpd-vhosts.conf` e acrescente no fim
   (troque o caminho pelo da pasta do projeto na sua máquina; use `/` e
   mantenha as aspas):

   ```
   <VirtualHost *:8080>
       ServerName localhost
       DocumentRoot "C:/caminho/do/projeto/Hydra.Back/public"
       <Directory "C:/caminho/do/projeto/Hydra.Back/public">
           AllowOverride All
           Require all granted
       </Directory>
   </VirtualHost>
   ```

   O `.htaccess` que já existe em `Hydra.Back/public` encaminha todas as
   chamadas para o `index.php`, então nada mais precisa mudar. Se o caminho
   da pasta tiver acentos e o Apache não subir, mova o projeto para uma pasta
   simples (ex.: `C:/projetos/hydra`).

3. **Ligue o OPcache** (o PHP deixa de recompilar o back-end a cada chamada).
   Em Apache → **Config → PHP (php.ini)**, confira que estas linhas existem
   e **não** começam com `;`:

   ```
   zend_extension=opcache
   opcache.enable=1
   ```

4. **No `Hydra.Back/.env`, use `DB_HOST=127.0.0.1`**, não `localhost`. No
   Windows, `localhost` tenta primeiro o IPv6 e só depois cai para o IPv4, o
   que pode atrasar cerca de 1 segundo **cada** conexão com o MySQL.

5. Reinicie o Apache no XAMPP Control Panel (Stop → Start).

Pronto: o back-end passa a responder em `http://localhost:8080/api` pelo
Apache, sempre que o XAMPP estiver com o Apache ligado. **Não rode mais o
`php -S` do passo 2** (os dois disputariam a mesma porta). O front continua
igual (passo 3), e o `api.js` não muda.

Para conferir, abra `http://localhost:8080/api/health` no navegador: deve
aparecer `{"status":"ok"}`.

## Erros comuns

| Sintoma | Causa provável |
|---|---|
| "Failed to fetch" no navegador | O backend (porta 8080) não está rodando — volte ao passo 2. |
| Login funciona, a tela abre e volta pro login sozinha | Front e back usando hostnames diferentes (`127.0.0.1` de um lado, `localhost` do outro) — troque tudo para `localhost`, veja o aviso no passo 4. |
| Login não persiste / sessão cai a cada request | A página foi aberta como `file://` em vez de `http://` — sirva pelo Live Server ou `php -S`. |
| "Falha ao conectar ao banco de dados" | MySQL não está rodando, ou `Hydra.Back/.env` tem credenciais erradas. O motivo exato é gravado no log de erro do PHP (no Render, aba **Logs** do serviço); defina `APP_DEBUG=true` para ver esse motivo na própria resposta da API. |
| CORS bloqueando a requisição | Confirme que `Hydra.Back/.env` tem `APP_ENV=local` **e** `CORS_ALLOWED_ORIGIN=*`. O curinga só vale com `APP_ENV=local`; em produção é preciso listar a origem exata, separada por vírgula. |
| "Muitas tentativas. Tente novamente em N minutos" | Proteção contra força bruta: 5 falhas no mesmo e-mail bloqueiam login e recuperação por 15 minutos. Para liberar durante um teste, apague a linha correspondente da tabela `tentativas_acesso`. |
| Código de recuperação não aparece na resposta | O campo `codigo_dev` só é devolvido com `APP_ENV=local` e sem `BREVO_API_KEY`. Em produção ele nunca volta — configure o Brevo. |

## Publicar no Render

O projeto não é uma aplicação Node: ele não possui `package.json` e não deve
usar `yarn start`. A configuração está em `render.yaml` e usa o `Dockerfile`
da raiz para servir o frontend e a API PHP no mesmo Web Service.

1. No Render, escolha **New > Blueprint** e conecte este repositório.
2. Confirme que o serviço usa o runtime **Docker**, com Dockerfile `./Dockerfile`
  e contexto `.`. Não informe `yarn start` como Start Command.
3. Crie um banco MySQL externo e informe no serviço as variáveis `DB_HOST`,
  `DB_USER` e `DB_PASS`. Mantenha `DB_PORT=3306` e `DB_NAME=hydra_db`.
  Essas três variáveis estão como `sync: false` no `render.yaml`, ou seja,
  **não** vêm do repositório: precisam ser preenchidas na própria dashboard
  do Render (Environment). Sem elas, a API tenta conectar em `127.0.0.1`
  como `root` — não existe MySQL dentro do container, então toda chamada
  responde "Falha ao conectar ao banco de dados".
4. Execute `schema.sql` nesse banco antes de testar o cadastro. O arquivo
  descreve o estado **final** do modelo e pressupõe um banco limpo — ele
  não migra um banco antigo. Para aplicar uma versão nova do schema,
  recrie o banco primeiro (`DROP DATABASE hydra_db; CREATE DATABASE
  hydra_db ...`, como indicado no cabeçalho do próprio arquivo) e execute
  tudo de novo. **Isso apaga os dados existentes.**

  Se o banco já estava em uso antes da remoção do código de barras e você
  quer **preservar os dados** em vez de recriá-lo, rode só os dois
  comandos documentados no comentário acima da tabela `produtos` em
  `schema.sql`, na ordem indicada lá (primeiro o `DROP INDEX`, depois o
  `DROP COLUMN` — inverter a ordem passaria a permitir apenas um produto
  por loja).
5. O endereço público do sistema será a raiz do serviço; o Render verificará
  automaticamente `/api/health`.
6. **Recomendado para velocidade:** defina `DB_PERSISTENT=true` em
  Environment. Com o MySQL fora do Render, abrir uma conexão nova custa
  várias idas e voltas pela rede em toda chamada da API; com a conexão
  persistente, cada processo do Apache reaproveita a sua. Antes, confira no
  plano do banco o limite de conexões simultâneas (cada processo do Apache
  segura uma conexão aberta).

O frontend detecta automaticamente a API no Render (`/api`). Em ambiente
  local, continua usando `http://localhost:8080/api`.
