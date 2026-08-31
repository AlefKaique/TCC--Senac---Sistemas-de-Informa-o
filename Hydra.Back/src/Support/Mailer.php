<?php

namespace Hydra\Support;

/**
 * Cliente da API HTTP do Brevo (https://brevo.com, ex-Sendinblue), usado
 * para enviar o código de verificação da tela de Recuperar Senha
 * (Fig. 15). Usa a porta 443 (HTTPS) em vez de SMTP porque provedores
 * como o Render bloqueiam conexões de saída nas portas SMTP
 * (25/465/587) por padrão. O remetente (MAIL_FROM) precisa estar
 * verificado no Brevo — não é necessário ter domínio próprio.
 */
final class Mailer
{
    public static function send(string $to, string $subject, string $html): bool
    {
        $apiKey = Env::get('BREVO_API_KEY');
        if ($apiKey === null || $apiKey === '') {
            // Sem Brevo configurado (ambiente de desenvolvimento): registra
            // o e-mail no log em vez de falhar o fluxo.
            error_log("[Mailer] BREVO_API_KEY não configurado. E-mail não enviado para $to: $subject");
            return false;
        }

        $from = (string) Env::get('MAIL_FROM', 'no-reply@hydra.local');
        $fromName = (string) Env::get('MAIL_FROM_NAME', 'Hydra PDV');

        $payload = json_encode([
            'sender' => ['name' => $fromName, 'email' => $from],
            'to' => [['email' => $to]],
            'subject' => $subject,
            'htmlContent' => $html,
        ]);

        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\nAccept: application/json\r\napi-key: $apiKey\r\n",
                'content' => $payload,
                'ignore_errors' => true,
                'timeout' => 10,
            ],
        ]);

        $result = @file_get_contents('https://api.brevo.com/v3/smtp/email', false, $context);

        $status = 0;
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
            $status = (int) $m[1];
        }

        if ($result === false || $status >= 300) {
            error_log("[Mailer] Falha ao enviar via Brevo (status $status): " . ($result !== false && $result !== '' ? $result : 'sem resposta do servidor'));
            return false;
        }

        return true;
    }
}
