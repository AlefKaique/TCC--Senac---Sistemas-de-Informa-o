<?php

namespace Hydra\Support;

/**
 * Cliente SMTP mínimo (sem dependências externas) usado para enviar o
 * código de verificação da tela de Recuperar Senha (Fig. 15). Suporta
 * conexão implícita SSL (porta 465, MAIL_ENCRYPTION=ssl) e STARTTLS
 * (porta 587, MAIL_ENCRYPTION=tls — padrão).
 */
final class Mailer
{
    public static function send(string $to, string $subject, string $html): bool
    {
        $host = Env::get('MAIL_HOST');
        if ($host === null || $host === '') {
            // Sem SMTP configurado (ambiente de desenvolvimento): registra
            // o e-mail no log em vez de falhar o fluxo.
            error_log("[Mailer] MAIL_HOST não configurado. E-mail não enviado para $to: $subject");
            return false;
        }

        $port = (int) Env::get('MAIL_PORT', '587');
        $user = (string) Env::get('MAIL_USER', '');
        $pass = (string) Env::get('MAIL_PASS', '');
        $from = (string) Env::get('MAIL_FROM', $user !== '' ? $user : 'no-reply@hydra.local');
        $fromName = (string) Env::get('MAIL_FROM_NAME', 'Hydra PDV');
        $encryption = strtolower((string) Env::get('MAIL_ENCRYPTION', 'tls'));

        $transport = $encryption === 'ssl' ? "ssl://$host" : $host;
        $socket = @stream_socket_client("$transport:$port", $errno, $errstr, 10);
        if ($socket === false) {
            error_log("[Mailer] Falha ao conectar em $host:$port — $errstr");
            return false;
        }

        try {
            self::expect($socket, 220);
            self::command($socket, 'EHLO hydra.local', 250);

            if ($encryption === 'tls') {
                self::command($socket, 'STARTTLS', 220);
                if (!stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                    throw new \RuntimeException('Falha ao iniciar TLS com o servidor SMTP');
                }
                self::command($socket, 'EHLO hydra.local', 250);
            }

            if ($user !== '') {
                self::command($socket, 'AUTH LOGIN', 334);
                self::command($socket, base64_encode($user), 334);
                self::command($socket, base64_encode($pass), 235);
            }

            self::command($socket, "MAIL FROM:<$from>", 250);
            self::command($socket, "RCPT TO:<$to>", 250);
            self::command($socket, 'DATA', 354);

            $headers = [
                "From: $fromName <$from>",
                "To: <$to>",
                "Subject: $subject",
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=UTF-8',
            ];
            $body = implode("\r\n", $headers) . "\r\n\r\n" . $html;
            // Dot-stuffing: linhas que começam com "." precisam ser
            // escapadas para não serem interpretadas como fim dos dados.
            $body = preg_replace('/\r\n\./', "\r\n..", $body) ?? $body;
            self::command($socket, $body . "\r\n.", 250);

            self::command($socket, 'QUIT', 221);
            return true;
        } catch (\Throwable $e) {
            error_log('[Mailer] ' . $e->getMessage());
            return false;
        } finally {
            fclose($socket);
        }
    }

    /** @param resource $socket */
    private static function command($socket, string $line, int $expectedCode): void
    {
        fwrite($socket, $line . "\r\n");
        self::expect($socket, $expectedCode);
    }

    /** @param resource $socket */
    private static function expect($socket, int $expectedCode): void
    {
        $response = '';
        while ($line = fgets($socket, 515)) {
            $response .= $line;
            // Respostas multi-linha do SMTP usam "-" após o código (ex.:
            // "250-..."); a última linha usa um espaço ("250 ...").
            if (preg_match('/^\d{3} /', $line)) {
                break;
            }
        }
        $code = (int) substr($response, 0, 3);
        if ($code !== $expectedCode) {
            throw new \RuntimeException("Resposta SMTP inesperada (esperado $expectedCode): $response");
        }
    }
}
