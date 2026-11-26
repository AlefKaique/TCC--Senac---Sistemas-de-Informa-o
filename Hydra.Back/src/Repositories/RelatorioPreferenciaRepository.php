<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/**
 * Blocos que cada usuário deixa marcados no Passo 2 da tela Relatório
 * ("O que você quer ver na tela"), para a tela abrir do mesmo jeito na
 * próxima vez. Tabela relatorio_preferencia.
 */
final class RelatorioPreferenciaRepository
{
    public function __construct()
    {
        Migracoes::garantirRelatorioVendas();
    }

    /** @return string[]|null null quando o usuário ainda não salvou nenhuma escolha */
    public function blocos(int $idUsuario): ?array
    {
        $stmt = db()->prepare('SELECT blocos FROM relatorio_preferencia WHERE id_usuario = :id_usuario');
        $stmt->execute(['id_usuario' => $idUsuario]);
        $valor = $stmt->fetchColumn();
        if (!is_string($valor)) {
            return null;
        }
        $blocos = json_decode($valor, true);
        return is_array($blocos) ? array_values(array_filter($blocos, 'is_string')) : null;
    }

    /** @param string[] $blocos códigos já validados pelo controller */
    public function salvar(int $idUsuario, array $blocos): void
    {
        $stmt = db()->prepare(
            'INSERT INTO relatorio_preferencia (id_usuario, blocos)
             VALUES (:id_usuario, :blocos)
             ON DUPLICATE KEY UPDATE blocos = VALUES(blocos)'
        );
        $stmt->execute([
            'id_usuario' => $idUsuario,
            'blocos' => json_encode(array_values($blocos), JSON_THROW_ON_ERROR),
        ]);
    }
}
