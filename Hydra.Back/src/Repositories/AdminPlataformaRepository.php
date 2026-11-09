<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/** Persistência das contas exclusivas de administração da plataforma. */
final class AdminPlataformaRepository
{
    public function __construct()
    {
        Migracoes::garantirAdminsPlataforma();
    }

    public function findByEmail(string $email): ?array
    {
        $stmt = db()->prepare('SELECT * FROM admins_plataforma WHERE email = :email');
        $stmt->execute(['email' => $email]);
        $admin = $stmt->fetch();
        return $admin ?: null;
    }

    public function findAtivoById(int $idAdmin): ?array
    {
        $stmt = db()->prepare(
            "SELECT id_admin, nome, email, status, nivel
               FROM admins_plataforma
              WHERE id_admin = :id_admin AND status = 'ativo'"
        );
        $stmt->execute(['id_admin' => $idAdmin]);
        $admin = $stmt->fetch();
        return $admin ?: null;
    }

    public function salvarCodigo(int $idAdmin, string $codigo, string $expiraEm): void
    {
        db()->prepare(
            'UPDATE admins_plataforma
                SET codigo_acesso_hash = :codigo_hash, codigo_acesso_expira_em = :expira
              WHERE id_admin = :id_admin'
        )->execute([
            'codigo_hash' => hash('sha256', $codigo),
            'expira' => $expiraEm,
            'id_admin' => $idAdmin,
        ]);
    }

    public function validarCodigo(int $idAdmin, string $codigo): bool
    {
        $stmt = db()->prepare(
            'SELECT codigo_acesso_hash
               FROM admins_plataforma
              WHERE id_admin = :id_admin AND codigo_acesso_expira_em > NOW()'
        );
        $stmt->execute(['id_admin' => $idAdmin]);
        $hashSalvo = $stmt->fetchColumn();
        return is_string($hashSalvo)
            && hash_equals($hashSalvo, hash('sha256', $codigo));
    }

    /** Valida e consome o código atomicamente para impedir reutilização concorrente. */
    public function consumirCodigo(int $idAdmin, string $codigo): bool
    {
        $stmt = db()->prepare(
            'SELECT codigo_acesso_hash
               FROM admins_plataforma
              WHERE id_admin = :id_admin AND codigo_acesso_expira_em > NOW()'
        );
        $stmt->execute(['id_admin' => $idAdmin]);
        $hashSalvo = $stmt->fetchColumn();
        if (!is_string($hashSalvo) || !hash_equals($hashSalvo, hash('sha256', $codigo))) {
            return false;
        }

        $stmt = db()->prepare(
            'UPDATE admins_plataforma
                SET codigo_acesso_hash = NULL, codigo_acesso_expira_em = NULL
              WHERE id_admin = :id_admin
                AND codigo_acesso_hash = :codigo_hash
                AND codigo_acesso_expira_em > NOW()'
        );
        $stmt->execute(['id_admin' => $idAdmin, 'codigo_hash' => $hashSalvo]);
        return $stmt->rowCount() === 1;
    }

    public function limparCodigo(int $idAdmin): void
    {
        db()->prepare(
            'UPDATE admins_plataforma
                SET codigo_acesso_hash = NULL, codigo_acesso_expira_em = NULL
              WHERE id_admin = :id_admin'
        )->execute(['id_admin' => $idAdmin]);
    }

    public function registrarAcesso(int $idAdmin): void
    {
        db()->prepare('UPDATE admins_plataforma SET ultimo_acesso = NOW() WHERE id_admin = :id_admin')
            ->execute(['id_admin' => $idAdmin]);
    }

    public function criar(string $nome, string $email, string $senhaHash): int
    {
        $stmt = db()->prepare(
            "INSERT INTO admins_plataforma (nome, email, senha, status, nivel, senha_definida)
             VALUES (:nome, :email, :senha, 'ativo', 'proprietario', 1)"
        );
        $stmt->execute(['nome' => $nome, 'email' => $email, 'senha' => $senhaHash]);
        return (int) db()->lastInsertId();
    }

    public function criarMembro(
        string $nome,
        string $email,
        string $nivel,
        int $criadoPor,
        string $codigoHash,
        string $expiraEm
    ): int {
        $stmt = db()->prepare(
            "INSERT INTO admins_plataforma
                (nome, email, senha, codigo_acesso_hash, codigo_acesso_expira_em, status,
                 nivel, senha_definida, criado_por)
             VALUES (:nome, :email, :senha, :codigo_hash, :expira, 'ativo',
                     :nivel, 0, :criado_por)"
        );
        $stmt->execute([
            'nome' => $nome,
            'email' => $email,
            'senha' => password_hash(bin2hex(random_bytes(32)), PASSWORD_BCRYPT),
            'codigo_hash' => $codigoHash,
            'expira' => $expiraEm,
            'nivel' => $nivel,
            'criado_por' => $criadoPor,
        ]);
        return (int) db()->lastInsertId();
    }

    /** @return array<int,array<string,mixed>> */
    public function listarEquipe(): array
    {
        return db()->query(
            'SELECT id_admin, nome, email, nivel, status, senha_definida,
                    ultimo_acesso, data_criacao
               FROM admins_plataforma
              ORDER BY data_criacao DESC, id_admin DESC'
        )->fetchAll();
    }

    public function buscarMembro(int $idAdmin): ?array
    {
        $stmt = db()->prepare(
            'SELECT id_admin, nome, email, nivel, status, senha_definida
               FROM admins_plataforma WHERE id_admin = :id_admin'
        );
        $stmt->execute(['id_admin' => $idAdmin]);
        $membro = $stmt->fetch();
        return $membro ?: null;
    }

    public function atualizarMembro(int $idAdmin, ?string $nivel, ?string $status, int $atorId): array
    {
        db()->beginTransaction();
        try {
            // Travar os proprietários ativos evita duas alterações concorrentes
            // deixarem a equipe sem ninguém com acesso total.
            db()->query(
                "SELECT id_admin FROM admins_plataforma
                  WHERE nivel = 'proprietario' AND status = 'ativo' FOR UPDATE"
            )->fetchAll();
            $membro = $this->buscarMembro($idAdmin);
            if ($membro === null) {
                db()->rollBack();
                return ['erro' => 'Membro não encontrado.'];
            }

            $novoNivel = $nivel ?? $membro['nivel'];
            $novoStatus = $status ?? $membro['status'];
            if ($novoNivel === $membro['nivel'] && $novoStatus === $membro['status']) {
                db()->rollBack();
                return ['membro' => $membro];
            }
            if (
                $membro['nivel'] === 'proprietario'
                && $membro['status'] === 'ativo'
                && ($novoNivel !== 'proprietario' || $novoStatus !== 'ativo')
            ) {
                $stmt = db()->query(
                    "SELECT COUNT(*) FROM admins_plataforma
                      WHERE nivel = 'proprietario' AND status = 'ativo'"
                );
                if ((int) $stmt->fetchColumn() <= 1) {
                    db()->rollBack();
                    return ['erro' => 'A plataforma precisa de pelo menos um Proprietário ativo.'];
                }
            }

            db()->prepare(
                'UPDATE admins_plataforma
                    SET nivel = :nivel, status = :status
                  WHERE id_admin = :id_admin'
            )->execute(['nivel' => $novoNivel, 'status' => $novoStatus, 'id_admin' => $idAdmin]);
            (new AuditoriaPlataformaRepository())->registrar(
                $atorId,
                'equipe_alterada',
                null,
                'Membro ' . (string) $membro['email'] . ': nível '
                    . (string) $membro['nivel'] . ' → ' . $novoNivel . ', status '
                    . (string) $membro['status'] . ' → ' . $novoStatus
            );
            db()->commit();
            return ['membro' => $this->buscarMembro($idAdmin)];
        } catch (\Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            throw $e;
        }
    }

    public function findByEmailAndValidCode(string $email, string $codigo): ?array
    {
        $stmt = db()->prepare(
            "SELECT id_admin, nome, email, nivel, status, senha_definida
               FROM admins_plataforma
              WHERE email = :email AND status = 'ativo' AND senha_definida = 0
                AND codigo_acesso_hash = :codigo_hash AND codigo_acesso_expira_em > NOW()"
        );
        $stmt->execute(['email' => $email, 'codigo_hash' => hash('sha256', $codigo)]);
        $admin = $stmt->fetch();
        return $admin ?: null;
    }

    public function atualizarSenhaPrimeiroAcesso(int $idAdmin, string $senhaHash, string $codigoHash): bool
    {
        $stmt = db()->prepare(
            "UPDATE admins_plataforma
                SET senha = :senha, senha_definida = 1,
                    codigo_acesso_hash = NULL, codigo_acesso_expira_em = NULL
              WHERE id_admin = :id_admin AND status = 'ativo' AND senha_definida = 0
                AND codigo_acesso_hash = :codigo_hash AND codigo_acesso_expira_em > NOW()"
        );
        $stmt->execute(['senha' => $senhaHash, 'id_admin' => $idAdmin, 'codigo_hash' => $codigoHash]);
        return $stmt->rowCount() === 1;
    }

    public function atualizarCodigoHash(int $idAdmin, string $codigoHash, string $expiraEm): void
    {
        db()->prepare(
            'UPDATE admins_plataforma SET codigo_acesso_hash = :codigo_hash,
                    codigo_acesso_expira_em = :expira WHERE id_admin = :id_admin'
        )->execute(['codigo_hash' => $codigoHash, 'expira' => $expiraEm, 'id_admin' => $idAdmin]);
    }

    public function redefinirSenha(int $idAdmin, string $senhaHash): void
    {
        db()->prepare('UPDATE admins_plataforma SET senha = :senha WHERE id_admin = :id_admin')
            ->execute(['senha' => $senhaHash, 'id_admin' => $idAdmin]);
    }
}
