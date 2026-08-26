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
}
