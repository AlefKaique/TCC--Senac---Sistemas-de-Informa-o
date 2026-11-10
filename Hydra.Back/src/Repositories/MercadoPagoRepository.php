<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

final class MercadoPagoRepository
{
    public function __construct()
    {
        Migracoes::garantir('mercadopago_pix_v1', static function (): void {
            db()->exec(
                'CREATE TABLE IF NOT EXISTS mercadopago_contas (
                    id_loja INT PRIMARY KEY,
                    mp_user_id VARCHAR(40) NOT NULL,
                    access_token TEXT NOT NULL,
                    refresh_token TEXT NOT NULL,
                    expira_em DATETIME NOT NULL,
                    atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
            db()->exec(
                "CREATE TABLE IF NOT EXISTS pagamentos_pix_pendentes (
                    id_pagamento_pix CHAR(36) PRIMARY KEY,
                    id_loja INT NOT NULL,
                    id_filial INT NOT NULL,
                    id_usuario INT NOT NULL,
                    id_mp VARCHAR(40) NULL UNIQUE,
                    qr_code TEXT NULL,
                    qr_code_base64 TEXT NULL,
                    ticket_url VARCHAR(500) NULL,
                    itens_json JSON NOT NULL,
                    valor DECIMAL(10,2) NOT NULL,
                    status ENUM('criando','pendente','aprovado','rejeitado','cancelado','expirado','concluido') NOT NULL,
                    id_venda INT NULL,
                    expira_em DATETIME NOT NULL,
                    criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    atualizado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_pix_filial_status (id_filial, status, criado_em),
                    FOREIGN KEY (id_venda) REFERENCES vendas(id_venda) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
            );
        });
        // Cobrança ativa do operador (consultada ao abrir o Caixa e ao criar
        // um Pix): o único índice começava por id_filial.
        Migracoes::garantir('indices_pix_v1', static fn () => Migracoes::criarIndiceSeFaltar(
            'pagamentos_pix_pendentes',
            'idx_pix_loja_status_expira',
            'id_loja, status, expira_em'
        ));
    }

    /** @return array<string,mixed>|null */
    public function conta(int $idLoja): ?array
    {
        $stmt = db()->prepare('SELECT * FROM mercadopago_contas WHERE id_loja = :id_loja');
        $stmt->execute(['id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function salvarConta(int $idLoja, string $mpUserId, string $accessToken, string $refreshToken, string $expiraEm): void
    {
        $stmt = db()->prepare(
            'INSERT INTO mercadopago_contas (id_loja, mp_user_id, access_token, refresh_token, expira_em)
             VALUES (:id_loja, :mp_user_id, :access_token, :refresh_token, :expira_em)
             ON DUPLICATE KEY UPDATE mp_user_id = VALUES(mp_user_id),
                 access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
                 expira_em = VALUES(expira_em)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'mp_user_id' => $mpUserId,
            'access_token' => $accessToken,
            'refresh_token' => $refreshToken,
            'expira_em' => $expiraEm,
        ]);
    }

    public function removerConta(int $idLoja): void
    {
        db()->prepare('DELETE FROM mercadopago_contas WHERE id_loja = :id_loja')
            ->execute(['id_loja' => $idLoja]);
    }

    public function bloquearConta(int $idLoja): bool
    {
        $stmt = db()->prepare('SELECT id_loja FROM mercadopago_contas WHERE id_loja = :id_loja FOR UPDATE');
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->fetchColumn() !== false;
    }

    public function temCobrancaAtiva(int $idLoja): bool
    {
        $stmt = db()->prepare(
            "SELECT 1 FROM pagamentos_pix_pendentes
              WHERE id_loja = :id_loja AND status IN ('criando', 'pendente')
                AND expira_em > NOW() LIMIT 1"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->fetchColumn() !== false;
    }

    public function desconectarSeSemCobrancaAtiva(int $idLoja): bool
    {
        $pdo = db();
        $pdo->beginTransaction();
        try {
            if ($this->bloquearConta($idLoja) && $this->temCobrancaAtiva($idLoja)) {
                $pdo->rollBack();
                return false;
            }
            $this->removerConta($idLoja);
            $pdo->commit();
            return true;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** @param array<int,array{id_produto:int,quantidade:float,preco_unitario:float}> $itens */
    public function criarPagamento(
        string $id,
        int $idLoja,
        int $idFilial,
        int $idUsuario,
        array $itens,
        float $valor,
        string $expiraEm
    ): void {
        $stmt = db()->prepare(
            "INSERT INTO pagamentos_pix_pendentes
                (id_pagamento_pix, id_loja, id_filial, id_usuario, itens_json, valor, status, expira_em)
             VALUES (:id, :id_loja, :id_filial, :id_usuario, :itens, :valor, 'criando', :expira_em)"
        );
        $stmt->execute([
            'id' => $id,
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
            'id_usuario' => $idUsuario,
            'itens' => json_encode($itens, JSON_THROW_ON_ERROR),
            'valor' => $valor,
            'expira_em' => $expiraEm,
        ]);
    }

    public function anexarPagamentoMercadoPago(string $id, string $idMp, string $qrCode, string $qrCodeBase64, ?string $ticketUrl): void
    {
        $stmt = db()->prepare(
            "UPDATE pagamentos_pix_pendentes SET id_mp = :id_mp, qr_code = :qr_code,
                qr_code_base64 = :qr_code_base64, ticket_url = :ticket_url, status = 'pendente'
              WHERE id_pagamento_pix = :id AND status = 'criando'"
        );
        $stmt->execute([
            'id_mp' => $idMp,
            'qr_code' => $qrCode,
            'qr_code_base64' => $qrCodeBase64,
            'ticket_url' => $ticketUrl,
            'id' => $id,
        ]);
    }

    public function marcarFalhaCriacao(string $id): void
    {
        db()->prepare(
            "UPDATE pagamentos_pix_pendentes SET status = 'rejeitado'
              WHERE id_pagamento_pix = :id AND status = 'criando'"
        )->execute(['id' => $id]);
    }

    /** @return array<string,mixed>|null */
    public function pagamentoAtivo(int $idLoja, int $idUsuario): ?array
    {
        $stmt = db()->prepare(
            "SELECT * FROM pagamentos_pix_pendentes
              WHERE id_loja = :id_loja AND id_usuario = :id_usuario
                AND status IN ('criando', 'pendente') AND expira_em > NOW()
              ORDER BY criado_em DESC LIMIT 1"
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_usuario' => $idUsuario,
        ]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<string,mixed>|null */
    public function pagamento(string $id, int $idLoja, int $idUsuario, bool $bloquear = false): ?array
    {
        $sql = 'SELECT * FROM pagamentos_pix_pendentes
                 WHERE id_pagamento_pix = :id AND id_loja = :id_loja AND id_usuario = :id_usuario';
        if ($bloquear) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = db()->prepare($sql);
        $stmt->execute([
            'id' => $id,
            'id_loja' => $idLoja,
            'id_usuario' => $idUsuario,
        ]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function atualizarStatus(string $id, string $status): void
    {
        db()->prepare('UPDATE pagamentos_pix_pendentes SET status = :status WHERE id_pagamento_pix = :id')
            ->execute(['status' => $status, 'id' => $id]);
    }

    public function concluir(string $id, int $idVenda): void
    {
        db()->prepare(
            "UPDATE pagamentos_pix_pendentes SET status = 'concluido', id_venda = :id_venda
              WHERE id_pagamento_pix = :id"
        )->execute(['id_venda' => $idVenda, 'id' => $id]);
    }
}
