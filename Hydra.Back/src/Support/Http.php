<?php

namespace Hydra\Support;

/**
 * Requisição HTTP de saída com prazo de verdade.
 *
 * Mailer (Brevo) e MercadoPagoClient usavam file_get_contents() com
 * stream_context "timeout", que limita cada LEITURA, não a chamada inteira,
 * e não tem prazo próprio para conectar: um serviço lento ou um DNS travado
 * prendia a requisição do usuário bem além do valor configurado. Com curl,
 * CURLOPT_CONNECTTIMEOUT limita a conexão e CURLOPT_TIMEOUT a chamada toda
 * (mesmo padrão de WhatsApp.php). Sem a extensão curl, cai no método antigo.
 */
final class Http
{
    /**
     * @param string[] $headers linhas "Nome: valor"
     * @return array{status:int,body:string|false}
     */
    public static function request(
        string $method,
        string $url,
        array $headers,
        string $body = '',
        int $connectTimeout = 5,
        int $timeout = 10
    ): array {
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            $opcoes = [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => $connectTimeout,
                CURLOPT_TIMEOUT => $timeout,
            ];
            if ($method !== 'GET') {
                $opcoes[CURLOPT_POSTFIELDS] = $body;
            }
            curl_setopt_array($ch, $opcoes);
            $resposta = curl_exec($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            if ($resposta === false) {
                error_log('[Http] ' . $method . ' ' . parse_url($url, PHP_URL_HOST) . ' falhou: ' . curl_error($ch));
            }
            curl_close($ch);
            return ['status' => $status, 'body' => is_string($resposta) ? $resposta : false];
        }

        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'content' => $body,
                'timeout' => $timeout,
                'ignore_errors' => true,
            ],
        ]);
        $resposta = @file_get_contents($url, false, $context);
        $status = 0;
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
            $status = (int) $m[1];
        }
        return ['status' => $status, 'body' => $resposta];
    }
}
