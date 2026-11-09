<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

final class AlertaEnviadoRepository
{
    public function __construct()
    {
        Migracoes::garantirAlertasWhatsApp();
    }

    public function jaEnviadoHoje(
        int $idUsuario,
        int $idFilial,
        string $data,
        string $canal,
        int $idDestinatario = 0
    ): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM alertas_enviados
              WHERE id_usuario = :id_usuario AND id_filial = :id_filial
                AND data_referencia = :data AND canal = :canal
                AND id_destinatario_alerta = :id_destinatario
              LIMIT 1'
        );
        $stmt->execute([
            'id_usuario' => $idUsuario,
            'id_filial' => $idFilial,
            'data' => $data,
            'canal' => $canal,
            'id_destinatario' => $idDestinatario,
        ]);
        return (bool) $stmt->fetchColumn();
    }

    /**
     * Reserva o envio antes da chamada externa. A chave única evita que
     * duas execuções simultâneas do agendador entreguem o mesmo resumo.
     *
     * @param array<string,int|string> $dados
     */
    public function registrar(array $dados): bool
    {
        $stmt = db()->prepare(
            "INSERT IGNORE INTO alertas_enviados
                (id_usuario, id_loja, id_filial, data_referencia, canal, id_destinatario_alerta,
                 qtd_estoque, qtd_validade, status)
             VALUES
                (:id_usuario, :id_loja, :id_filial, :data, :canal, :id_destinatario_alerta,
                 :qtd_estoque, :qtd_validade, 'enviado')"
        );
        $stmt->execute($dados);
        return $stmt->rowCount() === 1;
    }

    public function atualizarResultado(
        int $idUsuario,
        int $idFilial,
        string $data,
        string $canal,
        int $idDestinatario,
        string $status,
        ?string $idMensagem = null,
        ?string $erro = null
    ): void {
        $stmt = db()->prepare(
            'UPDATE alertas_enviados
                SET status = IF(
                        status IN (\'entregue\', \'lido\', \'falhou\') AND :status_preservacao = \'enviado\',
                        status,
                        :status_novo
                    ),
                    id_mensagem_meta = :id_mensagem, erro = :erro
              WHERE id_usuario = :id_usuario AND id_filial = :id_filial
                AND data_referencia = :data AND canal = :canal
                AND id_destinatario_alerta = :id_destinatario'
        );
        $stmt->execute([
            'status_preservacao' => $status,
            'status_novo' => $status,
            'id_mensagem' => $idMensagem,
            'erro' => $erro === null ? null : substr($erro, 0, 255),
            'id_usuario' => $idUsuario,
            'id_filial' => $idFilial,
            'data' => $data,
            'canal' => $canal,
            'id_destinatario' => $idDestinatario,
        ]);
    }

    public function atualizarStatusPorMensagem(string $idMensagem, string $status): void
    {
        if (!in_array($status, ['entregue', 'lido', 'falhou'], true)) {
            return;
        }
        db()->prepare(
            'UPDATE alertas_enviados SET status = :status
              WHERE id_mensagem_meta = :id_mensagem'
        )->execute(['status' => $status, 'id_mensagem' => $idMensagem]);
    }

    /** @return array<int,array<string,mixed>> */
    public function ultimosDoUsuario(int $idUsuario): array
    {
        $stmt = db()->prepare(
            'SELECT a.data_referencia, a.canal, a.status, a.qtd_estoque, a.qtd_validade,
                    a.criado_em, f.nome AS nome_filial
               FROM alertas_enviados a
               JOIN filiais f ON f.id_filial = a.id_filial
              WHERE a.id_usuario = :id_usuario
              ORDER BY a.criado_em DESC, a.id_alerta DESC
              LIMIT 10'
        );
        $stmt->execute(['id_usuario' => $idUsuario]);
        return $stmt->fetchAll();
    }
}
