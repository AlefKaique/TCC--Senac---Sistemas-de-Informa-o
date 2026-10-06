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

    /**
     * $emailVerificado é false só para a conta criada pelo Cadastro, que
     * ainda precisa confirmar o e-mail por código. Funcionários criados
     * pelo administrador já nascem confirmados.
     */
    public function create(
        int $idLoja,
        string $nome,
        string $email,
        string $senhaHash,
        string $perfil,
        ?int $idCargo = null,
        bool $emailVerificado = true
    ): int {
        $stmt = db()->prepare(
            'INSERT INTO usuarios (id_loja, nome, email, senha, perfil, id_cargo, email_verificado)
             VALUES (:id_loja, :nome, :email, :senha, :perfil, :id_cargo, :email_verificado)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'nome' => $nome,
            'email' => $email,
            'senha' => $senhaHash,
            'perfil' => $perfil,
            'id_cargo' => $idCargo,
            'email_verificado' => $emailVerificado ? 1 : 0,
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
            'SELECT u.id_usuario, u.id_loja, u.nome, u.email, u.perfil, u.status, u.data_criacao, u.ultimo_acesso,
                    u.id_cargo, c.nome AS cargo_nome, c.cor AS cargo_cor
             FROM usuarios u
             LEFT JOIN cargos c ON c.id_cargo = u.id_cargo
             WHERE u.id_usuario = :id'
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
            'SELECT u.id_usuario, u.nome, u.email, u.perfil, u.status, u.data_criacao, u.ultimo_acesso,
                    u.id_cargo, c.nome AS cargo_nome, c.cor AS cargo_cor
             FROM usuarios u
             LEFT JOIN cargos c ON c.id_cargo = u.id_cargo
             WHERE u.id_loja = :id_loja ORDER BY u.data_criacao ASC'
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

    /** Lembra a filial em que o usuário trabalhou por último: o próximo login volta para ela. */
    public function updateUltimaFilial(int $idUsuario, int $idFilial): void
    {
        $stmt = db()->prepare('UPDATE usuarios SET id_ultima_filial = :id_filial WHERE id_usuario = :id');
        $stmt->execute(['id_filial' => $idFilial, 'id' => $idUsuario]);
    }

    /** @param array<string,mixed> $dados */
    public function update(int $idUsuario, array $dados): void
    {
        $stmt = db()->prepare(
            'UPDATE usuarios SET nome = :nome, email = :email, perfil = :perfil, status = :status, id_cargo = :id_cargo
             WHERE id_usuario = :id'
        );
        $stmt->execute([
            'nome' => $dados['nome'],
            'email' => $dados['email'],
            'perfil' => $dados['perfil'],
            'status' => $dados['status'],
            'id_cargo' => $dados['id_cargo'] ?? null,
            'id' => $idUsuario,
        ]);
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

    /** Código de confirmação de e-mail / login do administrador (ver schema.sql). */
    public function setCodigoAcesso(int $idUsuario, string $codigo, string $expiraEm): void
    {
        $stmt = db()->prepare(
            'UPDATE usuarios SET codigo_acesso = :codigo, codigo_acesso_expira_em = :expira WHERE id_usuario = :id'
        );
        $stmt->execute(['codigo' => $codigo, 'expira' => $expiraEm, 'id' => $idUsuario]);
    }

    public function findByValidCodigoAcesso(int $idUsuario, string $codigo): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM usuarios
             WHERE id_usuario = :id AND codigo_acesso = :codigo AND codigo_acesso_expira_em > NOW()'
        );
        $stmt->execute(['id' => $idUsuario, 'codigo' => $codigo]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** Consome o código (uso único) e marca o e-mail como confirmado. */
    public function marcarEmailVerificadoELimparCodigo(int $idUsuario): void
    {
        $stmt = db()->prepare(
            'UPDATE usuarios SET email_verificado = 1, codigo_acesso = NULL, codigo_acesso_expira_em = NULL
             WHERE id_usuario = :id'
        );
        $stmt->execute(['id' => $idUsuario]);
    }

}
