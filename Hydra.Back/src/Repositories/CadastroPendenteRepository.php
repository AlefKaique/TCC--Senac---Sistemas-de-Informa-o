<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/**
 * Cadastros (tela Criar conta) que ainda não confirmaram o e-mail.
 *
 * Antes a loja, a filial, os cargos e o usuário eram criados no clique em
 * "Criar conta", e o código só confirmava o e-mail depois. Quem desistisse
 * na tela do código deixava uma conta no sistema — e qualquer pessoa podia
 * ocupar o e-mail de outra, que depois ouviria "Já existe uma conta com
 * este e-mail". Agora os dados ficam aqui e a conta só nasce em
 * AuthController::verificarEmail(), com o código certo.
 *
 * A senha já chega com hash (bcrypt) e o código é guardado como SHA-256:
 * nada aqui serve para entrar no sistema se a tabela vazar.
 */
final class CadastroPendenteRepository
{
    /** Por quanto tempo um cadastro não confirmado continua valendo. */
    private const HORAS_VALIDADE = 24;

    public function __construct()
    {
        Migracoes::garantir('cadastros_pendentes_v1', static function (): void {
            db()->exec(
                'CREATE TABLE IF NOT EXISTS cadastros_pendentes (
                    email            VARCHAR(100) PRIMARY KEY,
                    nome             VARCHAR(100) NOT NULL,
                    nome_loja        VARCHAR(120) NOT NULL,
                    senha_hash       VARCHAR(255) NOT NULL,
                    codigo_hash      CHAR(64)     NOT NULL,
                    codigo_expira_em DATETIME     NOT NULL,
                    criado_em        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_cadastros_pendentes_criado (criado_em)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
        });
    }

    public static function hashCodigo(string $codigo): string
    {
        return hash('sha256', $codigo);
    }

    /** Grava ou substitui o cadastro pendente do e-mail (um novo "Criar conta" recomeça do zero). */
    public function salvar(string $email, string $nome, string $nomeLoja, string $senhaHash, string $codigo, string $expiraEm): void
    {
        db()->prepare(
            'INSERT INTO cadastros_pendentes (email, nome, nome_loja, senha_hash, codigo_hash, codigo_expira_em, criado_em)
             VALUES (:email, :nome, :nome_loja, :senha_hash, :codigo_hash, :expira, NOW())
             ON DUPLICATE KEY UPDATE
                nome = VALUES(nome), nome_loja = VALUES(nome_loja), senha_hash = VALUES(senha_hash),
                codigo_hash = VALUES(codigo_hash), codigo_expira_em = VALUES(codigo_expira_em), criado_em = NOW()'
        )->execute([
            'email' => $email,
            'nome' => $nome,
            'nome_loja' => $nomeLoja,
            'senha_hash' => $senhaHash,
            'codigo_hash' => self::hashCodigo($codigo),
            'expira' => $expiraEm,
        ]);
    }

    /**
     * Cadastro pendente ainda válido, com "codigo_valido" = 1 se o código
     * não expirou. O prazo é comparado no banco (NOW()), como em
     * UsuarioRepository::findByValidCodigoAcesso().
     */
    public function buscar(string $email): ?array
    {
        $stmt = db()->prepare(
            'SELECT *, (codigo_expira_em > NOW()) AS codigo_valido
               FROM cadastros_pendentes
              WHERE email = :email AND criado_em > DATE_SUB(NOW(), INTERVAL ' . self::HORAS_VALIDADE . ' HOUR)'
        );
        $stmt->execute(['email' => $email]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function atualizarCodigo(string $email, string $codigo, string $expiraEm): void
    {
        db()->prepare(
            'UPDATE cadastros_pendentes SET codigo_hash = :codigo_hash, codigo_expira_em = :expira WHERE email = :email'
        )->execute(['codigo_hash' => self::hashCodigo($codigo), 'expira' => $expiraEm, 'email' => $email]);
    }

    public function remover(string $email): void
    {
        db()->prepare('DELETE FROM cadastros_pendentes WHERE email = :email')->execute(['email' => $email]);
    }

    /** Apaga os cadastros abandonados há mais do que o prazo de validade. */
    public function limparExpirados(): void
    {
        db()->exec(
            'DELETE FROM cadastros_pendentes WHERE criado_em < DATE_SUB(NOW(), INTERVAL ' . self::HORAS_VALIDADE . ' HOUR)'
        );
    }
}
