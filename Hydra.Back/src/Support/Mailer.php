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

        // Conexão em até 5 s e chamada inteira em até 10 s (ver Http).
        ['status' => $status, 'body' => $result] = Http::request(
            'POST',
            'https://api.brevo.com/v3/smtp/email',
            ['Content-Type: application/json', 'Accept: application/json', 'api-key: ' . $apiKey],
            (string) $payload,
            5,
            10
        );

        if ($result === false || $status >= 300) {
            error_log("[Mailer] Falha ao enviar via Brevo (status $status): " . ($result !== false && $result !== '' ? $result : 'sem resposta do servidor'));
            return false;
        }

        return true;
    }
}
