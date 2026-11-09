# Template de resumo diário do Hydra

## Cadastro do template

- **Nome:** `hydra_resumo_diario`
- **Categoria:** Utilidade
- **Idioma:** Português (Brasil), `pt_BR`
- **Corpo:**

```text
Olá, {{1}}! Resumo de hoje da filial {{2}}: {{3}} produto(s) abaixo do estoque mínimo e {{4}} produto(s) vencendo ou vencidos. Veja os detalhes: {{5}}. Para não receber mais, responda SAIR.
```

Exemplo de valores para a revisão da Meta:

| Variável | Exemplo |
|---|---|
| `{{1}}` | Maria |
| `{{2}}` | Loja Centro |
| `{{3}}` | 4 |
| `{{4}}` | 2 |
| `{{5}}` | `https://SEU-DOMINIO/pages/controle-estoque.html` |

O texto é somente informativo sobre estoque e validade, sem oferta ou
conteúdo promocional. Mantenha as variáveis na mesma ordem do corpo.

## Configuração da Meta

1. Acesse o [Meta for Developers](https://developers.facebook.com/) e crie
   um app do tipo **Business**.
2. No painel do app, adicione o produto **WhatsApp** e abra a configuração
   da API.
3. Use o número de teste fornecido pela Meta para desenvolvimento. Copie o
   **Phone number ID** (não o número de telefone) para
   `WHATSAPP_PHONE_NUMBER_ID`.
4. Adicione em **To / Destinatários** cada número de celular autorizado para
   teste no WhatsApp. O número deve estar em formato internacional.
5. Gere um token de acesso para o app/WhatsApp e grave-o somente no servidor
   como `WHATSAPP_ACCESS_TOKEN`. Não cole o token em código, documentação
   pública, navegador ou logs.
6. Em **Message templates**, crie o template acima como categoria
   **Utility**, idioma `pt_BR`, nome `hydra_resumo_diario`. Aguarde a
   aprovação antes de enviar mensagens de resumo.
7. Em **Webhooks**, configure como callback:
   `https://SEU-DOMINIO/api/whatsapp/webhook`. Defina um valor aleatório e
   privado em `WHATSAPP_VERIFY_TOKEN` no servidor e informe exatamente o
   mesmo valor na verificação da Meta.
8. Assine o campo **messages** para receber mensagens de usuários e
   atualizações de entrega/leitura. O app secret usado para validar
   `X-Hub-Signature-256` deve ficar somente em `WHATSAPP_APP_SECRET`.
9. No servidor, configure também `WHATSAPP_API_VERSION`, o Phone number ID,
   o token, o app secret, o verify token e `WHATSAPP_ENABLED=true`.
   Mantenha `WHATSAPP_ENABLED=false` enquanto não estiver pronto; nesse modo
   a aplicação não chama a Meta e usa o e-mail como alternativa.

Configure o agendador HTTP separadamente com um `ALERTAS_CRON_TOKEN` forte.
Esse segredo é diferente do verify token do webhook.

## Teste local com ngrok

1. Inicie o Hydra.Back localmente:

   ```bash
   php -S localhost:8080 -t public public/index.php
   ```

2. Em outro terminal, abra um túnel HTTPS para a porta da API:

   ```bash
   ngrok http 8080
   ```

3. Copie a URL HTTPS criada pelo ngrok e use
   `https://URL-DO-TUNEL/api/whatsapp/webhook` como callback no painel da
   Meta. Configure o mesmo `WHATSAPP_VERIFY_TOKEN` no `.env` local e na
   verificação do webhook.
4. Assine `messages` e use o botão de teste do painel de Webhooks da Meta.
   O callback GET de verificação precisa responder o `hub.challenge`; os
   POSTs precisam chegar com uma assinatura válida da Meta.
5. Com `WHATSAPP_ENABLED=true`, credenciais de teste e o template aprovado,
   salve um número destinatário autorizado e o consentimento na tela
   Configurações da Loja. Use **Enviar mensagem de teste**. Teste também a
   resposta `SAIR` para confirmar a revogação do consentimento.

Não publique o token, o app secret nem o verify token junto com a URL do
túnel. O número de teste da Meta só consegue enviar para destinatários
previamente autorizados no painel.
