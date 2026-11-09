<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

final class PreferenciaAlertaRepository
{
    public function __construct()
    {
        Migracoes::garantirAlertasWhatsApp();
    }

    /** @return array<string,mixed>|null */
    public function buscar(int $idUsuario): ?array
    {
        $stmt = db()->prepare('SELECT * FROM preferencias_alerta WHERE id_usuario = :id_usuario');
        $stmt->execute(['id_usuario' => $idUsuario]);
        $preferencia = $stmt->fetch();
        return $preferencia ?: null;
    }

    /** @param array<string,mixed> $dados */
    public function salvar(int $idUsuario, array $dados): void
    {
        $stmt = db()->prepare(
            'INSERT INTO preferencias_alerta
                (id_usuario, telefone_whatsapp, canal, consentimento, consentimento_em,
                 alerta_estoque, alerta_validade, dias_validade)
             VALUES
                (:id_usuario, :telefone, :canal, :consentimento,
                 IF(:consentimento_data = 1, NOW(), NULL), :alerta_estoque, :alerta_validade, :dias_validade)
             ON DUPLICATE KEY UPDATE
                telefone_whatsapp = VALUES(telefone_whatsapp),
                canal = VALUES(canal),
                consentimento = VALUES(consentimento),
                consentimento_em = IF(VALUES(consentimento) = 1, NOW(), NULL),
                alerta_estoque = VALUES(alerta_estoque),
                alerta_validade = VALUES(alerta_validade),
                dias_validade = VALUES(dias_validade)'
        );
        $stmt->execute([
            'id_usuario' => $idUsuario,
            'telefone' => $dados['telefone'],
            'canal' => $dados['canal'],
            'consentimento' => $dados['consentimento'],
            'consentimento_data' => $dados['consentimento'],
            'alerta_estoque' => $dados['alerta_estoque'],
            'alerta_validade' => $dados['alerta_validade'],
            'dias_validade' => $dados['dias_validade'],
        ]);
    }

    public function desativarPorTelefone(string $telefone): void
    {
        db()->prepare(
            'UPDATE preferencias_alerta
                SET consentimento = 0, consentimento_em = NULL
              WHERE telefone_whatsapp = :telefone'
        )->execute(['telefone' => $telefone]);
        db()->prepare(
            'UPDATE destinatarios_alerta
                SET consentimento = 0, consentimento_em = NULL, ativo = 0
              WHERE telefone_whatsapp = :telefone'
        )->execute(['telefone' => $telefone]);
    }

    /** @return array<int,array<string,mixed>> */
    public function listarDestinatarios(int $idUsuario): array
    {
        $stmt = db()->prepare(
            'SELECT id_destinatario, telefone_whatsapp, consentimento, consentimento_em
               FROM destinatarios_alerta
              WHERE id_usuario = :id_usuario AND ativo = 1
              ORDER BY criado_em ASC, id_destinatario ASC'
        );
        $stmt->execute(['id_usuario' => $idUsuario]);
        return $stmt->fetchAll();
    }

    public function adicionarDestinatario(int $idUsuario, int $idLoja, string $telefone): void
    {
        db()->prepare(
            'INSERT INTO destinatarios_alerta
                (id_usuario, id_loja, telefone_whatsapp, consentimento, consentimento_em, ativo)
             VALUES (:id_usuario, :id_loja, :telefone, 1, NOW(), 1)
             ON DUPLICATE KEY UPDATE
                id_loja = VALUES(id_loja),
                consentimento = 1,
                consentimento_em = NOW(),
                ativo = 1'
        )->execute([
            'id_usuario' => $idUsuario,
            'id_loja' => $idLoja,
            'telefone' => $telefone,
        ]);
    }

    public function removerDestinatario(int $idUsuario, int $idDestinatario): bool
    {
        $stmt = db()->prepare(
            'UPDATE destinatarios_alerta
                SET ativo = 0, consentimento = 0, consentimento_em = NULL
              WHERE id_destinatario = :id_destinatario AND id_usuario = :id_usuario AND ativo = 1'
        );
        $stmt->execute(['id_destinatario' => $idDestinatario, 'id_usuario' => $idUsuario]);
        return $stmt->rowCount() > 0;
    }

    /** @return array<int,array<string,mixed>> */
    public function listarDestinatariosAptos(int $idUsuario): array
    {
        $stmt = db()->prepare(
            'SELECT id_destinatario, telefone_whatsapp
               FROM destinatarios_alerta
              WHERE id_usuario = :id_usuario AND ativo = 1 AND consentimento = 1
              ORDER BY id_destinatario ASC'
        );
        $stmt->execute(['id_usuario' => $idUsuario]);
        return $stmt->fetchAll();
    }

    /** @return array<int,array<string,mixed>> usuário × filial com permissão atual */
    public function listarAptosParaEnvio(): array
    {
        $stmt = db()->query(
            "SELECT DISTINCT u.id_usuario, u.id_loja, u.nome AS nome_usuario, u.email,
                    p.telefone_whatsapp, p.canal, p.consentimento,
                    p.alerta_estoque, p.alerta_validade, p.dias_validade,
                    f.id_filial, f.nome AS nome_filial
               FROM preferencias_alerta p
               JOIN usuarios u ON u.id_usuario = p.id_usuario AND u.status = 'ativo'
               JOIN cargos c ON c.id_cargo = u.id_cargo AND c.id_loja = u.id_loja
               JOIN cargo_permissoes cp ON cp.id_cargo = c.id_cargo
               JOIN permissoes perm ON perm.id_permissao = cp.id_permissao
                                      AND perm.codigo = 'loja.configurar'
               JOIN filiais f ON f.id_loja = u.id_loja AND f.status = 'ativa'
              WHERE (EXISTS (
                        SELECT 1
                          FROM cargo_permissoes cp_admin
                          JOIN permissoes p_admin ON p_admin.id_permissao = cp_admin.id_permissao
                         WHERE cp_admin.id_cargo = c.id_cargo
                           AND p_admin.codigo IN ('equipe.gerenciar', 'loja.configurar')
                    )
                    OR EXISTS (
                        SELECT 1 FROM usuario_filiais uf
                         WHERE uf.id_usuario = u.id_usuario AND uf.id_filial = f.id_filial
                    ))
              ORDER BY u.id_usuario, f.id_filial"
        );
        return $stmt->fetchAll();
    }
}
