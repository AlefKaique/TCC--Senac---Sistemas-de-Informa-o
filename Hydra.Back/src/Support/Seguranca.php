<?php

namespace Hydra\Support;

/**
 * Peças de segurança usadas em mais de um lugar: detecção de HTTPS atrás
 * de proxy, cabeçalhos de segurança das respostas da API e hash dos
 * códigos de 6 dígitos enviados por e-mail.
 */
final class Seguranca
{
    /**
     * A requisição chegou ao usuário por HTTPS?
     *
     * Em hospedagens como o Render, o HTTPS termina no proxy da frente e o
     * Apache recebe a requisição em HTTP puro: $_SERVER['HTTPS'] fica vazio
     * e só o cabeçalho X-Forwarded-Proto conta o protocolo original. Um
     * cliente pode forjar esse cabeçalho numa conexão HTTP, mas o único
     * efeito seria marcar o PRÓPRIO cookie como Secure (e o navegador dele
     * deixar de enviá-lo) — não abre brecha para mais ninguém.
     */
    public static function requisicaoHttps(): bool
    {
        if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
            return true;
        }
        // Pode vir como lista ("https, http") quando há mais de um proxy:
        // vale o primeiro, que é o protocolo usado pelo navegador.
        $proto = strtolower(trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
        if ($proto === 'https') {
            return true;
        }
        if (strtolower((string) ($_SERVER['HTTP_X_FORWARDED_SSL'] ?? '')) === 'on') {
            return true;
        }
        return (string) ($_SERVER['SERVER_PORT'] ?? '') === '443';
    }

    /**
     * O cookie de sessão deve levar a flag Secure?
     *
     * Sempre em produção declarada (APP_ENV=production): ali o sistema só
     * roda em HTTPS, e a flag não pode depender de o proxy repassar o
     * protocolo. Fora disso, segue o protocolo detectado, para não quebrar
     * o desenvolvimento em http://localhost.
     */
    public static function cookieSeguro(): bool
    {
        return Env::get('APP_ENV', '') === 'production' || self::requisicaoHttps();
    }

    /**
     * Cabeçalhos de segurança das respostas da API (JSON ou redirecionamento).
     *
     * Em produção o Apache (Hydra.Front/.htaccess) também os envia para as
     * páginas; estes cobrem a API quando ela roda sem Apache (php -S).
     */
    public static function enviarCabecalhosApi(): void
    {
        // Impede o navegador de "adivinhar" o tipo e tratar JSON como HTML/JS.
        header('X-Content-Type-Options: nosniff');
        // Nenhum site pode carregar a API dentro de um iframe (clickjacking).
        header('X-Frame-Options: DENY');
        // A API só devolve JSON: nada de scripts, estilos ou frames.
        header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
        // Links para fora não levam o caminho completo (com ids) no Referer.
        header('Referrer-Policy: strict-origin-when-cross-origin');
        // HSTS: o navegador passa a usar só HTTPS neste domínio por 1 ano.
        // Só faz sentido (e só é aceito pelo navegador) em resposta HTTPS.
        if (self::requisicaoHttps()) {
            header('Strict-Transport-Security: max-age=31536000');
        }
    }

    /**
     * Hash dos códigos de 6 dígitos (recuperação de senha, confirmação de
     * e-mail e segundo fator do login) antes de irem para o banco.
     *
     * Um código de 6 dígitos tem só 1 milhão de combinações: um SHA-256
     * simples seria revertido por força bruta em menos de um segundo por
     * quem tivesse uma cópia do banco. Por isso é um HMAC com uma chave que
     * NÃO está no banco (derivada de HYDRA_ENCRYPTION_KEY): sem ela, o hash
     * vazado não serve para nada. Sem a chave configurada, cai no SHA-256
     * simples, que ainda assim tira o código legível do banco.
     */
    public static function hashCodigo(string $codigo): string
    {
        $chave = self::chaveCodigos();
        return $chave !== null
            ? hash_hmac('sha256', $codigo, $chave)
            : hash('sha256', $codigo);
    }

    /** Subchave própria para os códigos, para não reusar a chave do AES em outra função. */
    private static function chaveCodigos(): ?string
    {
        $encoded = (string) Env::get('HYDRA_ENCRYPTION_KEY', '');
        $mestra = $encoded === '' ? false : base64_decode($encoded, true);
        if ($mestra === false || strlen($mestra) !== 32) {
            return null;
        }
        return hash_hmac('sha256', 'hydra-codigos-v1', $mestra, true);
    }
}
