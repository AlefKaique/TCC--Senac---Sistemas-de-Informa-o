<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/** Registra eventos relevantes de autenticação dos administradores da plataforma. */
final class AuditoriaPlataformaRepository
{
    public function __construct()
    {
        Migracoes::garantirAdminsPlataforma();
    }

    public function registrar(?int $idAdmin, string $acao, ?int $idLoja = null, ?string $detalhe = null): void
    {
        db()->prepare(
            'INSERT INTO auditoria_plataforma (id_admin, acao, id_loja, detalhe, ip)
             VALUES (:id_admin, :acao, :id_loja, :detalhe, :ip)'
        )->execute([
            'id_admin' => $idAdmin,
            'acao' => $acao,
            'id_loja' => $idLoja,
            'detalhe' => $detalhe,
            'ip' => $_SERVER['REMOTE_ADDR'] ?? null,
        ]);
    }

    /**
     * Para registros que não podem desfazer a ação já concluída (ex.: o
     * pagamento do titular confirmado pelo Mercado Pago): uma falha aqui vai
     * só para o log do servidor.
     */
    public static function registrarSemFalhar(?int $idAdmin, string $acao, ?int $idLoja = null, ?string $detalhe = null): void
    {
        try {
            (new self())->registrar($idAdmin, $acao, $idLoja, $detalhe === null ? null : mb_substr($detalhe, 0, 255));
        } catch (\Throwable $e) {
            error_log('[Hydra] Falha ao registrar auditoria (' . $acao . '): ' . $e->getMessage());
        }
    }
}
