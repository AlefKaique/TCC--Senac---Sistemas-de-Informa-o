<?php

namespace Hydra\Repositories;

final class LojaRepository
{
    public function create(string $nomeLoja): int
    {
        $stmt = db()->prepare('INSERT INTO lojas (nome_loja) VALUES (:nome_loja)');
        $stmt->execute(['nome_loja' => $nomeLoja]);
        return (int) db()->lastInsertId();
    }

    public function find(int $idLoja): ?array
    {
        $stmt = db()->prepare('SELECT * FROM lojas WHERE id_loja = :id_loja');
        $stmt->execute(['id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @param array<string,mixed> $dados */
    public function update(int $idLoja, array $dados): void
    {
        $stmt = db()->prepare(
            'UPDATE lojas SET
                nome_loja = :nome_loja,
                cnpj = :cnpj,
                telefone = :telefone,
                endereco = :endereco,
                cidade = :cidade,
                estado = :estado,
                cep = :cep
             WHERE id_loja = :id_loja'
        );
        $stmt->execute([
            'nome_loja' => $dados['nome_loja'],
            'cnpj' => $dados['cnpj'] !== '' ? $dados['cnpj'] : null,
            'telefone' => $dados['telefone'] !== '' ? $dados['telefone'] : null,
            'endereco' => $dados['endereco'] !== '' ? $dados['endereco'] : null,
            'cidade' => $dados['cidade'] !== '' ? $dados['cidade'] : null,
            'estado' => $dados['estado'] !== '' ? $dados['estado'] : null,
            'cep' => $dados['cep'] !== '' ? $dados['cep'] : null,
            'id_loja' => $idLoja,
        ]);
    }

    /**
     * RN25: outra loja já usa este CNPJ? $cnpjNormalizado vem sem máscara
     * (Validacao::normalizarCnpj); a coluna é limpa do mesmo jeito no SQL,
     * porque registros antigos foram gravados com e sem pontuação.
     */
    public function cnpjEmUsoPorOutraLoja(string $cnpjNormalizado, int $idLojaAtual): bool
    {
        $stmt = db()->prepare(
            "SELECT 1 FROM lojas
              WHERE id_loja <> :id_loja
                AND cnpj IS NOT NULL
                AND REPLACE(REPLACE(REPLACE(REPLACE(UPPER(cnpj), '.', ''), '/', ''), '-', ''), ' ', '') = :cnpj
              LIMIT 1"
        );
        $stmt->execute(['id_loja' => $idLojaAtual, 'cnpj' => $cnpjNormalizado]);
        return (bool) $stmt->fetchColumn();
    }

    /** Logo da loja como data URL (ou null para remover). Ver LojaController::update(). */
    public function atualizarLogo(int $idLoja, ?string $logo): void
    {
        $stmt = db()->prepare('UPDATE lojas SET logo = :logo WHERE id_loja = :id_loja');
        $stmt->execute(['logo' => $logo, 'id_loja' => $idLoja]);
    }
}
