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

## Erros comuns

| Sintoma | Causa provável |
|---|---|
| "Failed to fetch" no navegador | O backend (porta 8080) não está rodando — volte ao passo 2. |
| Login funciona, a tela abre e volta pro login sozinha | Front e back usando hostnames diferentes (`127.0.0.1` de um lado, `localhost` do outro) — troque tudo para `localhost`, veja o aviso no passo 4. |
| Login não persiste / sessão cai a cada request | A página foi aberta como `file://` em vez de `http://` — sirva pelo Live Server ou `php -S`. |
| "Falha ao conectar ao banco de dados" | MySQL não está rodando, ou `Hydra.Back/.env` tem credenciais erradas. |
| CORS bloqueando a requisição | Confirme que `CORS_ALLOWED_ORIGIN` em `Hydra.Back/.env` está como `*` (padrão) durante o desenvolvimento. |

## Publicar no Render

O projeto não é uma aplicação Node: ele não possui `package.json` e não deve
usar `yarn start`. A configuração está em `render.yaml` e usa o `Dockerfile`
da raiz para servir o frontend e a API PHP no mesmo Web Service.

1. No Render, escolha **New > Blueprint** e conecte este repositório.
2. Confirme que o serviço usa o runtime **Docker**, com Dockerfile `./Dockerfile`
  e contexto `.`. Não informe `yarn start` como Start Command.
3. Crie um banco MySQL externo e informe no serviço as variáveis `DB_HOST`,
  `DB_USER` e `DB_PASS`. Mantenha `DB_PORT=3306` e `DB_NAME=hydra_db`.
4. Execute `schema.sql` nesse banco antes de testar o cadastro.
5. O endereço público do sistema será a raiz do serviço; o Render verificará
  automaticamente `/api/health`.

O frontend detecta automaticamente a API no Render (`/api`). Em ambiente
  local, continua usando `http://localhost:8080/api`.
