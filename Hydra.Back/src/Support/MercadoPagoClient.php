<?php

namespace Hydra\Support;

use RuntimeException;

final class MercadoPagoClient
{
    public static function configurado(): bool
    {
        return (string) Env::get('MERCADOPAGO_CLIENT_ID', '') !== ''
            && (string) Env::get('MERCADOPAGO_CLIENT_SECRET', '') !== ''
            && (string) Env::get('MERCADOPAGO_REDIRECT_URI', '') !== ''
            && self::chaveCriptografia() !== null
            && function_exists('openssl_encrypt')
            && function_exists('openssl_decrypt');
    }

    public static function authorizationUrl(string $state): string
    {
        self::exigirConfiguracao();
        return 'https://auth.mercadopago.com/authorization?' . http_build_query([
            'client_id' => Env::get('MERCADOPAGO_CLIENT_ID'),
            'response_type' => 'code',
            'platform_id' => 'mp',
            'redirect_uri' => Env::get('MERCADOPAGO_REDIRECT_URI'),
            'state' => $state,
        ]);
    }

    /** @return array<string,mixed> */
    public static function trocarCodigo(string $code): array
    {
        self::exigirConfiguracao();
        return self::solicitar('POST', 'https://api.mercadopago.com/oauth/token', [
            'client_id' => Env::get('MERCADOPAGO_CLIENT_ID'),
            'client_secret' => Env::get('MERCADOPAGO_CLIENT_SECRET'),
            'grant_type' => 'authorization_code',
            'code' => $code,
            'redirect_uri' => Env::get('MERCADOPAGO_REDIRECT_URI'),
        ], true);
    }

    /** @return array<string,mixed> */
    public static function renovarToken(string $refreshToken): array
    {
        self::exigirConfiguracao();
        return self::solicitar('POST', 'https://api.mercadopago.com/oauth/token', [
            'client_id' => Env::get('MERCADOPAGO_CLIENT_ID'),
            'client_secret' => Env::get('MERCADOPAGO_CLIENT_SECRET'),
            'grant_type' => 'refresh_token',
            'refresh_token' => $refreshToken,
        ], true);
    }

    /** @return array<string,mixed> */
    public static function criarPix(string $accessToken, string $externalReference, float $valor, string $email, string $descricao): array
    {
        return self::solicitar('POST', 'https://api.mercadopago.com/v1/payments', [
            'transaction_amount' => round($valor, 2),
            'description' => $descricao,
            'payment_method_id' => 'pix',
            'external_reference' => $externalReference,
            'date_of_expiration' => (new \DateTimeImmutable('+30 minutes'))->format(DATE_ATOM),
            'payer' => ['email' => $email],
        ], false, $accessToken, $externalReference);
    }

    /** @return array<string,mixed> */
    public static function consultarPagamento(string $accessToken, string $idPagamento): array
    {
        return self::solicitar(
            'GET',
            'https://api.mercadopago.com/v1/payments/' . rawurlencode($idPagamento),
            [],
            false,
            $accessToken
        );
    }

    public static function criptografar(string $valor): string
    {
        $key = self::chaveCriptografia();
        if ($key === null) {
            throw new RuntimeException('A chave de criptografia do Mercado Pago não está configurada.');
        }
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($valor, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($cipher === false) {
            throw new RuntimeException('Não foi possível proteger as credenciais Mercado Pago.');
        }
        return base64_encode($iv . $tag . $cipher);
    }

    public static function descriptografar(string $valor): string
    {
        $key = self::chaveCriptografia();
        $dados = base64_decode($valor, true);
        if ($key === null || $dados === false || strlen($dados) < 29) {
            throw new RuntimeException('Credenciais Mercado Pago inválidas ou chave de criptografia divergente.');
        }
        $plain = openssl_decrypt(substr($dados, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, substr($dados, 0, 12), substr($dados, 12, 16));
        if ($plain === false) {
            throw new RuntimeException('Não foi possível abrir as credenciais Mercado Pago.');
        }
        return $plain;
    }

    private static function exigirConfiguracao(): void
    {
        if (!self::configurado()) {
            throw new RuntimeException(
                'Integração Mercado Pago indisponível: configure MERCADOPAGO_CLIENT_ID, MERCADOPAGO_CLIENT_SECRET, MERCADOPAGO_REDIRECT_URI e HYDRA_ENCRYPTION_KEY.'
            );
        }
    }

    private static function chaveCriptografia(): ?string
    {
        $encoded = (string) Env::get('HYDRA_ENCRYPTION_KEY', '');
        $key = $encoded === '' ? false : base64_decode($encoded, true);
        return $key !== false && strlen($key) === 32 ? $key : null;
    }

    /**
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    private static function solicitar(
        string $method,
        string $url,
        array $body,
        bool $formEncoded = false,
        ?string $accessToken = null,
        ?string $idempotencyKey = null
    ): array {
        $headers = ['Accept: application/json'];
        if ($accessToken !== null) {
            $headers[] = 'Authorization: Bearer ' . $accessToken;
        }
        if ($idempotencyKey !== null) {
            $headers[] = 'X-Idempotency-Key: ' . $idempotencyKey;
        }
        $content = '';
        if ($method !== 'GET') {
            $headers[] = $formEncoded
                ? 'Content-Type: application/x-www-form-urlencoded'
                : 'Content-Type: application/json';
            $content = $formEncoded
                ? http_build_query($body)
                : json_encode($body, JSON_THROW_ON_ERROR);
        }

        $context = stream_context_create([
            'http' => [
                'method' => $method,
                'header' => implode("\r\n", $headers),
                'content' => $content,
                'timeout' => 15,
                'ignore_errors' => true,
            ],
        ]);
        $response = @file_get_contents($url, false, $context);
        $statusLine = $http_response_header[0] ?? '';
        preg_match('/\s(\d{3})\s/', $statusLine, $matches);
        $status = isset($matches[1]) ? (int) $matches[1] : 0;
        $data = is_string($response) ? json_decode($response, true) : null;
        if ($status < 200 || $status >= 300 || !is_array($data)) {
            error_log('[Hydra] Mercado Pago request failed with HTTP ' . $status);
            throw new RuntimeException('O Mercado Pago não concluiu a solicitação. Verifique a conexão da conta e tente novamente.');
        }
        return $data;
    }
}
