<?php

namespace Hydra\Repositories;

final class UsuarioRepository
{
    public function emailExists(string $email): bool
    {
        $stmt = db()->prepare('SELECT 1 FROM usuarios WHERE email = :email');
        $stmt->execute(['email' => $email]);
        return (bool) $stmt->fetchColumn();
    }

    public function create(int $idLoja, string $nome, string $email, string $senhaHash, string $perfil): int
    {
        $stmt = db()->prepare(
            'INSERT INTO usuarios (id_loja, nome, email, senha, perfil)
             VALUES (:id_loja, :nome, :email, :senha, :perfil)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'nome' => $nome,
            'email' => $email,
            'senha' => $senhaHash,
            'perfil' => $perfil,
        ]);
        return (int) db()->lastInsertId();
    }

    public function findByEmail(string $email): ?array
    {
        $stmt = db()->prepare('SELECT * FROM usuarios WHERE email = :email');
        $stmt->execute(['email' => $email]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function find(int $idUsuario): ?array
    {
        $stmt = db()->prepare('SELECT * FROM usuarios WHERE id_usuario = :id');
        $stmt->execute(['id' => $idUsuario]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** Igual a find(), mas sem colunas sensíveis (senha, tokens) — segura para devolver em respostas JSON. */
    public function findPublic(int $idUsuario): ?array
    {
        $stmt = db()->prepare(
            'SELECT id_usuario, id_loja, nome, email, perfil, status, data_criacao, ultimo_acesso
             FROM usuarios WHERE id_usuario = :id'
        );
        $stmt->execute(['id' => $idUsuario]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function findInLoja(int $idUsuario, int $idLoja): ?array
    {
        $stmt = db()->prepare('SELECT * FROM usuarios WHERE id_usuario = :id AND id_loja = :id_loja');
        $stmt->execute(['id' => $idUsuario, 'id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<int,array<string,mixed>> */
    public function listByLoja(int $idLoja): array
    {
        $stmt = db()->prepare(
            'SELECT id_usuario, nome, email, perfil, status, data_criacao, ultimo_acesso
             FROM usuarios WHERE id_loja = :id_loja ORDER BY data_criacao ASC'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->fetchAll();
    }

    public function countAdminsAtivos(int $idLoja): int
    {
        $stmt = db()->prepare(
            "SELECT COUNT(*) FROM usuarios
             WHERE id_loja = :id_loja AND perfil = 'administrador' AND status = 'ativo'"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return (int) $stmt->fetchColumn();
    }

    public function updateUltimoAcesso(int $idUsuario): void
    {
        $stmt = db()->prepare('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id_usuario = :id');
        $stmt->execute(['id' => $idUsuario]);
    }

    /** @param array<string,mixed> $dados */
    public function update(int $idUsuario, array $dados): void
    {
        $stmt = db()->prepare(
            'UPDATE usuarios SET nome = :nome, email = :email, perfil = :perfil, status = :status
             WHERE id_usuario = :id'
        );
        $stmt->execute([
            'nome' => $dados['nome'],
            'email' => $dados['email'],
            'perfil' => $dados['perfil'],
            'status' => $dados['status'],
            'id' => $idUsuario,
        ]);
    }

    public function delete(int $idUsuario): void
    {
        $stmt = db()->prepare('DELETE FROM usuarios WHERE id_usuario = :id');
        $stmt->execute(['id' => $idUsuario]);
    }

    public function setResetToken(int $idUsuario, string $token, string $expiraEm): void
    {
        $stmt = db()->prepare(
            'UPDATE usuarios SET reset_token = :token, reset_token_expira_em = :expira WHERE id_usuario = :id'
        );
        $stmt->execute(['token' => $token, 'expira' => $expiraEm, 'id' => $idUsuario]);
    }

    /** Valida o código de recuperação (RN05) exigindo também o e-mail, já que o código tem só 6 dígitos. */
    public function findByValidResetCode(string $email, string $code): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM usuarios WHERE email = :email AND reset_token = :token AND reset_token_expira_em > NOW()'
        );
        $stmt->execute(['email' => $email, 'token' => $code]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function updatePasswordAndClearResetToken(int $idUsuario, string $senhaHash): void
    {
        $stmt = db()->prepare(
            'UPDATE usuarios SET senha = :senha, reset_token = NULL, reset_token_expira_em = NULL
             WHERE id_usuario = :id'
        );
        $stmt->execute(['senha' => $senhaHash, 'id' => $idUsuario]);
    }

    public function setRememberToken(int $idUsuario, ?string $token): void
    {
        $stmt = db()->prepare('UPDATE usuarios SET remember_token = :token WHERE id_usuario = :id');
        $stmt->execute(['token' => $token, 'id' => $idUsuario]);
    }

    public function findByRememberToken(string $token): ?array
    {
        $stmt = db()->prepare('SELECT * FROM usuarios WHERE remember_token = :token');
        $stmt->execute(['token' => $token]);
        $row = $stmt->fetch();
        return $row ?: null;
    }
}
