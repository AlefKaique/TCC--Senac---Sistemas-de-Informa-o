<?php

namespace Hydra\Support;

/**
 * Limite de tentativas para as rotas de autenticação.
 *
 * O login e a redefinição de senha aceitavam tentativas ilimitadas. No
 * caso da redefinição isso era especialmente grave: o código enviado por
 * e-mail tem 6 dígitos (1 milhão de combinações) e vale 15 minutos, o
 * que é percorrível por um script em poucos minutos sem nenhuma trava.
 *
 * A contagem fica na tabela "tentativas_acesso", e não na sessão, porque
 * um atacante simplesmente não reaproveitaria a sessão entre tentativas.
 * A chave é "<ação>:<alvo>" — normalmente o e-mail, que é o que o
 * atacante precisa fixar para ter alguma chance.
 */
final class RateLimit
{
    /** Tentativas falhas toleradas antes do primeiro bloqueio. */
    public const MAX_TENTATIVAS = 5;

    /** Minutos de bloqueio aplicados a cada novo grupo de falhas. */
    private const MINUTOS_BLOQUEIO = 15;

    /**
     * Encerra a requisição com 429 se a chave estiver bloqueada.
     * Chamar antes de validar a credencial.
     */
    public static function requireNaoBloqueado(string $chave): void
    {
        $restante = self::segundosRestantes($chave);
        if ($restante <= 0) {
            return;
        }

        $minutos = (int) ceil($restante / 60);
        Response::json([
            'erro' => "Muitas tentativas. Tente novamente em {$minutos} minuto"
                . ($minutos === 1 ? '' : 's') . '.',
        ], 429);
        exit;
    }

    /** Registra uma tentativa que falhou e bloqueia ao atingir o limite. */
    public static function registrarFalha(string $chave): void
    {
        $stmt = db()->prepare(
            'INSERT INTO tentativas_acesso (chave, tentativas, atualizado_em)
             VALUES (:chave, 1, NOW())
             ON DUPLICATE KEY UPDATE tentativas = tentativas + 1, atualizado_em = NOW()'
        );
        $stmt->execute(['chave' => $chave]);

        $stmt = db()->prepare('SELECT tentativas FROM tentativas_acesso WHERE chave = :chave');
        $stmt->execute(['chave' => $chave]);
        $tentativas = (int) $stmt->fetchColumn();

        if ($tentativas >= self::MAX_TENTATIVAS) {
            // O bloqueio cresce a cada novo grupo de falhas: 15 min nas
            // primeiras 5, 30 min nas 10 primeiras, e assim por diante.
            $fator = intdiv($tentativas, self::MAX_TENTATIVAS);
            $minutos = self::MINUTOS_BLOQUEIO * $fator;
            $stmt = db()->prepare(
                'UPDATE tentativas_acesso
                    SET bloqueado_ate = DATE_ADD(NOW(), INTERVAL :minutos MINUTE)
                  WHERE chave = :chave'
            );
            $stmt->bindValue('minutos', $minutos, \PDO::PARAM_INT);
            $stmt->bindValue('chave', $chave);
            $stmt->execute();
        }
    }

    /** Zera a contagem após uma tentativa bem-sucedida. */
    public static function limpar(string $chave): void
    {
        $stmt = db()->prepare('DELETE FROM tentativas_acesso WHERE chave = :chave');
        $stmt->execute(['chave' => $chave]);
    }

    /** Segundos que faltam para o bloqueio expirar (0 se não há bloqueio). */
    public static function segundosRestantes(string $chave): int
    {
        $stmt = db()->prepare(
            'SELECT TIMESTAMPDIFF(SECOND, NOW(), bloqueado_ate)
               FROM tentativas_acesso
              WHERE chave = :chave AND bloqueado_ate IS NOT NULL AND bloqueado_ate > NOW()'
        );
        $stmt->execute(['chave' => $chave]);
        $restante = $stmt->fetchColumn();
        return $restante === false ? 0 : max(0, (int) $restante);
    }
}
