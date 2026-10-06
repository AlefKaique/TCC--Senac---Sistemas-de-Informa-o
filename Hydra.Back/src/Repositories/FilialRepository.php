<?php

namespace Hydra\Repositories;

/**
 * Filiais da loja e o vínculo usuário-filial (ver "Filiais" no schema.sql).
 *
 * Quem decide se um usuário é Administrador NÃO é este repositório: os
 * métodos recebem $administrador já calculado pelo mesmo critério do cargo
 * (CargoRepository::nivelEquivalente), para que login, troca de filial e
 * tela de Equipe usem uma única regra.
 */
final class FilialRepository
{
    private const COLUNAS = 'f.id_filial, f.id_loja, f.nome, f.cnpj, f.telefone, f.endereco,
                             f.cidade, f.estado, f.cep, f.status, f.data_criacao';

    /** Campos cadastrais gravados por create()/update(); os ausentes viram NULL. */
    private const CAMPOS = ['cnpj', 'telefone', 'endereco', 'cidade', 'estado', 'cep'];

    /** @param array<string,?string> $dados nome (obrigatório), status e os CAMPOS */
    public function create(int $idLoja, array $dados): int
    {
        $stmt = db()->prepare(
            'INSERT INTO filiais (id_loja, nome, cnpj, telefone, endereco, cidade, estado, cep, status)
             VALUES (:id_loja, :nome, :cnpj, :telefone, :endereco, :cidade, :estado, :cep, :status)'
        );
        $stmt->execute(['id_loja' => $idLoja] + $this->parametros($dados));
        return (int) db()->lastInsertId();
    }

    /** @param array<string,?string> $dados nome, status e os CAMPOS */
    public function update(int $idFilial, array $dados): void
    {
        $stmt = db()->prepare(
            'UPDATE filiais SET nome = :nome, cnpj = :cnpj, telefone = :telefone, endereco = :endereco,
                    cidade = :cidade, estado = :estado, cep = :cep, status = :status
             WHERE id_filial = :id'
        );
        $stmt->execute(['id' => $idFilial] + $this->parametros($dados));
    }

    /** @param array<string,?string> $dados */
    private function parametros(array $dados): array
    {
        $params = [
            'nome' => $dados['nome'],
            'status' => $dados['status'] ?? 'ativa',
        ];
        foreach (self::CAMPOS as $campo) {
            $params[$campo] = $dados[$campo] ?? null;
        }
        return $params;
    }

    /** Filial da loja, em qualquer status; null se não existir ou for de outra loja. */
    public function findInLoja(int $idFilial, int $idLoja): ?array
    {
        $stmt = db()->prepare(
            'SELECT ' . self::COLUNAS . ' FROM filiais f WHERE f.id_filial = :id AND f.id_loja = :id_loja'
        );
        $stmt->execute(['id' => $idFilial, 'id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<int,array<string,mixed>> todas as filiais da loja, ativas primeiro */
    public function listByLoja(int $idLoja): array
    {
        $stmt = db()->prepare(
            'SELECT ' . self::COLUNAS . ' FROM filiais f
             WHERE f.id_loja = :id_loja
             ORDER BY f.status = \'ativa\' DESC, f.nome ASC'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->fetchAll();
    }

    /**
     * Filiais ATIVAS que o usuário pode acessar: todas as da loja para o
     * Administrador; para os demais, só as vinculadas a ele.
     *
     * @return array<int,array<string,mixed>>
     */
    public function permitidas(int $idUsuario, int $idLoja, bool $administrador): array
    {
        if ($administrador) {
            $stmt = db()->prepare(
                'SELECT ' . self::COLUNAS . ' FROM filiais f
                 WHERE f.id_loja = :id_loja AND f.status = \'ativa\'
                 ORDER BY f.nome ASC'
            );
            $stmt->execute(['id_loja' => $idLoja]);
            return $stmt->fetchAll();
        }

        $stmt = db()->prepare(
            'SELECT ' . self::COLUNAS . ' FROM filiais f
             JOIN usuario_filiais uf ON uf.id_filial = f.id_filial AND uf.id_usuario = :id_usuario
             WHERE f.id_loja = :id_loja AND f.status = \'ativa\'
             ORDER BY f.nome ASC'
        );
        $stmt->execute(['id_usuario' => $idUsuario, 'id_loja' => $idLoja]);
        return $stmt->fetchAll();
    }

    /** A filial existe, está ativa, é da loja do usuário e ele tem acesso a ela? */
    public function podeAcessar(int $idUsuario, int $idLoja, bool $administrador, int $idFilial): bool
    {
        $sql = 'SELECT 1 FROM filiais f
                WHERE f.id_filial = :id_filial AND f.id_loja = :id_loja AND f.status = \'ativa\'';
        $params = ['id_filial' => $idFilial, 'id_loja' => $idLoja];
        if (!$administrador) {
            $sql .= ' AND EXISTS (SELECT 1 FROM usuario_filiais uf
                                   WHERE uf.id_filial = f.id_filial AND uf.id_usuario = :id_usuario)';
            $params['id_usuario'] = $idUsuario;
        }
        $stmt = db()->prepare($sql);
        $stmt->execute($params);
        return (bool) $stmt->fetchColumn();
    }

    public function usuarioVinculado(int $idUsuario, int $idFilial): bool
    {
        $stmt = db()->prepare('SELECT 1 FROM usuario_filiais WHERE id_usuario = :id_usuario AND id_filial = :id_filial');
        $stmt->execute(['id_usuario' => $idUsuario, 'id_filial' => $idFilial]);
        return (bool) $stmt->fetchColumn();
    }

    /**
     * Quantas filiais ativas a loja tem. Com $travar = true, trava as linhas
     * da loja até o fim da transação aberta pelo chamador, para que dois
     * administradores não inativem ao mesmo tempo as duas últimas filiais.
     */
    public function countAtivas(int $idLoja, bool $travar = false): int
    {
        $sql = "SELECT id_filial FROM filiais WHERE id_loja = :id_loja AND status = 'ativa'";
        if ($travar) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = db()->prepare($sql);
        $stmt->execute(['id_loja' => $idLoja]);
        return count($stmt->fetchAll());
    }

    public function nomeEmUso(int $idLoja, string $nome, ?int $exceto = null): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM filiais WHERE id_loja = :id_loja AND nome = :nome AND id_filial <> :exceto'
        );
        $stmt->execute(['id_loja' => $idLoja, 'nome' => $nome, 'exceto' => $exceto ?? 0]);
        return (bool) $stmt->fetchColumn();
    }

    public function cnpjEmUso(string $cnpj, ?int $exceto = null): bool
    {
        $stmt = db()->prepare('SELECT 1 FROM filiais WHERE cnpj = :cnpj AND id_filial <> :exceto');
        $stmt->execute(['cnpj' => $cnpj, 'exceto' => $exceto ?? 0]);
        return (bool) $stmt->fetchColumn();
    }

    /** @return int[] ids das filiais vinculadas ao usuário */
    public function idsDoUsuario(int $idUsuario): array
    {
        $stmt = db()->prepare('SELECT id_filial FROM usuario_filiais WHERE id_usuario = :id ORDER BY id_filial');
        $stmt->execute(['id' => $idUsuario]);
        return array_map('intval', $stmt->fetchAll(\PDO::FETCH_COLUMN));
    }

    /**
     * Vínculos de todos os usuários da loja de uma vez (tela Equipe), em vez
     * de uma consulta por usuário.
     *
     * @return array<int,int[]> id_usuario => ids das filiais
     */
    public function idsPorUsuarioDaLoja(int $idLoja): array
    {
        $stmt = db()->prepare(
            'SELECT uf.id_usuario, uf.id_filial
               FROM usuario_filiais uf
               JOIN usuarios u ON u.id_usuario = uf.id_usuario
              WHERE u.id_loja = :id_loja
              ORDER BY uf.id_filial'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $porUsuario = [];
        foreach ($stmt->fetchAll() as $row) {
            $porUsuario[(int) $row['id_usuario']][] = (int) $row['id_filial'];
        }
        return $porUsuario;
    }

    /**
     * Substitui os vínculos do usuário pelos informados. O chamador já
     * conferiu que todos os ids são filiais da loja dele e deve chamar
     * dentro de uma transação.
     *
     * @param int[] $idsFiliais
     */
    public function definirVinculos(int $idUsuario, array $idsFiliais): void
    {
        $stmt = db()->prepare('DELETE FROM usuario_filiais WHERE id_usuario = :id');
        $stmt->execute(['id' => $idUsuario]);

        $insert = db()->prepare('INSERT INTO usuario_filiais (id_usuario, id_filial) VALUES (:id_usuario, :id_filial)');
        foreach (array_unique($idsFiliais) as $idFilial) {
            $insert->execute(['id_usuario' => $idUsuario, 'id_filial' => $idFilial]);
        }
    }

    public function vincular(int $idUsuario, int $idFilial): void
    {
        $stmt = db()->prepare('INSERT IGNORE INTO usuario_filiais (id_usuario, id_filial) VALUES (:id_usuario, :id_filial)');
        $stmt->execute(['id_usuario' => $idUsuario, 'id_filial' => $idFilial]);
    }

    /**
     * Mantém só os ids que são filiais da loja. Usado para validar a lista
     * de checkboxes da tela Equipe: um id de outra loja é descartado.
     *
     * @param int[] $ids
     * @return int[]
     */
    public function filtrarDaLoja(int $idLoja, array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), fn ($id) => $id > 0)));
        if ($ids === []) {
            return [];
        }
        $marcadores = implode(',', array_fill(0, count($ids), '?'));
        $stmt = db()->prepare("SELECT id_filial FROM filiais WHERE id_loja = ? AND id_filial IN ($marcadores)");
        $stmt->execute(array_merge([$idLoja], $ids));
        return array_map('intval', $stmt->fetchAll(\PDO::FETCH_COLUMN));
    }
}
