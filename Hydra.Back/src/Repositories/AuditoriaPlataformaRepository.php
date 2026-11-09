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
}
