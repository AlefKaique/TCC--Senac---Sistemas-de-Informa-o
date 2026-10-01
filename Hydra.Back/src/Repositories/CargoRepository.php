<?php

namespace Hydra\Repositories;

/**
 * Módulo de Cargos e Permissões (estilo Discord) — ver schema.sql para
 * o desenho das tabelas "permissoes", "cargos" e "cargo_permissoes".
 *
 * Cada loja tem seus próprios cargos. Toda loja ganha, na primeira vez
 * em que este repositório é usado para ela, 3 cargos de sistema
 * (Administrador, Operador de Caixa e Estoquista) com as mesmas
 * permissões que o antigo ENUM "perfil" já garantia — assim nenhuma
 * loja cadastrada antes deste módulo perde acesso (ver ensureDefaults()).
 */
final class CargoRepository
{
    /**
     * Permissões de cada cargo de sistema, espelhando exatamente o que
     * Hydra\Support\Auth concedia antes deste módulo para cada valor do
     * ENUM "perfil". Isso garante que instalar o módulo de Cargos não
     * muda o comportamento de nenhuma loja já existente.
     */
    private const PERMISSOES_SISTEMA = [
        'administrador' => [
            'produtos.visualizar',
            'produtos.criar',
            'produtos.editar',
            'produtos.editar_preco',
            'produtos.excluir',
            'estoque.visualizar',
            'estoque.movimentar',
            'vendas.visualizar',
            'vendas.registrar',
            'usuarios.visualizar',
            'usuarios.criar',
            'usuarios.editar',
            'usuarios.excluir',
            'cargos.visualizar',
            'cargos.criar',
            'cargos.editar',
            'cargos.excluir',
            'loja.visualizar',
            'loja.configurar',
        ],
        'operador_caixa' => [
            // Precisa enxergar o catálogo para montar a venda no PDV.
            'produtos.visualizar',
            'vendas.visualizar',
            'vendas.registrar',
        ],
        'estoquista' => [
            'produtos.visualizar',
            'produtos.criar',
            'produtos.editar',
            'produtos.excluir',
            'estoque.visualizar',
            'estoque.movimentar',
        ],
    ];

    private const NOMES_SISTEMA = [
        'administrador' => 'Administrador',
        'operador_caixa' => 'Operador de Caixa',
        'estoquista' => 'Estoquista',
    ];

    private const CORES_SISTEMA = [
        'administrador' => '#ED4245',
        'operador_caixa' => '#57F287',
        'estoquista' => '#FEE75C',
    ];

    /** @return array<int,array<string,mixed>> catálogo global, agrupável por "categoria" no front-end */
    public function permissoesCatalogo(): array
    {
        $stmt = db()->query('SELECT codigo, nome, descricao, categoria FROM permissoes ORDER BY ordem ASC');
        return $stmt->fetchAll();
    }

    /**
     * Garante que a loja tenha os 3 cargos de sistema e que nenhum
     * usuário da loja fique com id_cargo nulo. Idempotente e barata
     * (um SELECT COUNT) — chamada a cada login e ao abrir a tela de
     * Cargos, para que lojas criadas antes deste módulo sejam migradas
     * sem precisar de um script de migração manual.
     */
    public function ensureDefaults(int $idLoja): void
    {
        $this->removerPermissoesAposentadas();

        $stmt = db()->prepare('SELECT COUNT(*) FROM cargos WHERE id_loja = :id_loja');
        $stmt->execute(['id_loja' => $idLoja]);
        $jaTemCargos = (int) $stmt->fetchColumn() > 0;

        if (!$jaTemCargos) {
            foreach (self::PERMISSOES_SISTEMA as $perfil => $codigos) {
                $idCargo = $this->inserirCargo(
                    $idLoja,
                    self::NOMES_SISTEMA[$perfil],
                    self::CORES_SISTEMA[$perfil],
                    null,
                    true
                );
                $this->sincronizarPermissoes($idCargo, $codigos);
            }
        }

        $this->backfillUsuariosSemCargo($idLoja);
    }

    /**
     * Permissões que saíram do catálogo depois de já terem sido gravadas
     * em algum banco. Sem isto elas continuariam aparecendo como checkbox
     * na tela de Cargos de quem não reaplicou o schema.sql — a mesma
     * estratégia de migração preguiçosa usada pelos cargos de sistema.
     *
     * - "vendas.aplicar_desconto": o PDV não tem campo de desconto, então
     *   a permissão nunca chegou a ser usada.
     */
    private const PERMISSOES_APOSENTADAS = ['vendas.aplicar_desconto'];

    private function removerPermissoesAposentadas(): void
    {
        $marcadores = implode(',', array_fill(0, count(self::PERMISSOES_APOSENTADAS), '?'));
        // As linhas correspondentes em cargo_permissoes somem junto, pelo
        // ON DELETE CASCADE declarado no schema.
        db()->prepare("DELETE FROM permissoes WHERE codigo IN ($marcadores)")
            ->execute(self::PERMISSOES_APOSENTADAS);
    }

    /** Usuários antigos (criados antes deste módulo) ganham o cargo de sistema equivalente ao seu "perfil" atual. */
    private function backfillUsuariosSemCargo(int $idLoja): void
    {
        $stmt = db()->prepare(
            "SELECT id_usuario, perfil FROM usuarios WHERE id_loja = :id_loja AND id_cargo IS NULL"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $usuariosSemCargo = $stmt->fetchAll();
        if ($usuariosSemCargo === []) {
            return;
        }

        $cargosPorNome = [];
        foreach ($this->listByLoja($idLoja) as $cargo) {
            if ($cargo['cargo_sistema']) {
                $cargosPorNome[$cargo['nome']] = (int) $cargo['id_cargo'];
            }
        }

        $update = db()->prepare('UPDATE usuarios SET id_cargo = :id_cargo WHERE id_usuario = :id');
        foreach ($usuariosSemCargo as $usuario) {
            $nomeCargo = self::NOMES_SISTEMA[$usuario['perfil']] ?? null;
            $idCargo = $nomeCargo !== null ? ($cargosPorNome[$nomeCargo] ?? null) : null;
            if ($idCargo !== null) {
                $update->execute(['id_cargo' => $idCargo, 'id' => $usuario['id_usuario']]);
            }
        }
    }

    /** @return array<int,array<string,mixed>> cada cargo com "permissoes" (códigos) e "qtd_usuarios" */
    public function listByLoja(int $idLoja): array
    {
        $stmt = db()->prepare(
            'SELECT id_cargo, id_loja, nome, descricao, cor, cargo_sistema, data_criacao
             FROM cargos WHERE id_loja = :id_loja ORDER BY cargo_sistema DESC, nome ASC'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $cargos = $stmt->fetchAll();

        foreach ($cargos as &$cargo) {
            $cargo['cargo_sistema'] = (bool) $cargo['cargo_sistema'];
            $cargo['permissoes'] = $this->permissoesDoCargo((int) $cargo['id_cargo']);
            $cargo['qtd_usuarios'] = $this->countUsuarios((int) $cargo['id_cargo']);
        }
        unset($cargo);

        return $cargos;
    }

    public function find(int $idCargo, int $idLoja): ?array
    {
        $stmt = db()->prepare(
            'SELECT id_cargo, id_loja, nome, descricao, cor, cargo_sistema, data_criacao
             FROM cargos WHERE id_cargo = :id AND id_loja = :id_loja'
        );
        $stmt->execute(['id' => $idCargo, 'id_loja' => $idLoja]);
        $cargo = $stmt->fetch();
        if ($cargo === false) {
            return null;
        }
        $cargo['cargo_sistema'] = (bool) $cargo['cargo_sistema'];
        $cargo['permissoes'] = $this->permissoesDoCargo($idCargo);
        $cargo['qtd_usuarios'] = $this->countUsuarios($idCargo);
        return $cargo;
    }

    /** @return string[] códigos de permissão do cargo */
    public function permissoesDoCargo(int $idCargo): array
    {
        $stmt = db()->prepare(
            'SELECT p.codigo FROM cargo_permissoes cp
             JOIN permissoes p ON p.id_permissao = cp.id_permissao
             WHERE cp.id_cargo = :id_cargo'
        );
        $stmt->execute(['id_cargo' => $idCargo]);
        return $stmt->fetchAll(\PDO::FETCH_COLUMN);
    }

    public function countUsuarios(int $idCargo): int
    {
        $stmt = db()->prepare('SELECT COUNT(*) FROM usuarios WHERE id_cargo = :id_cargo');
        $stmt->execute(['id_cargo' => $idCargo]);
        return (int) $stmt->fetchColumn();
    }

    public function countUsuariosAtivos(int $idCargo): int
    {
        $stmt = db()->prepare("SELECT COUNT(*) FROM usuarios WHERE id_cargo = :id_cargo AND status = 'ativo'");
        $stmt->execute(['id_cargo' => $idCargo]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Quantos usuários ATIVOS da loja têm a permissão informada através
     * de algum cargo diferente de $idCargoExcluido. Usada para impedir
     * que a edição das permissões de um cargo deixe a loja sem nenhum
     * usuário capaz de gerenciar usuários/cargos.
     */
    public function countUsuariosAtivosComPermissaoExcetoCargo(int $idLoja, string $codigo, int $idCargoExcluido): int
    {
        $stmt = db()->prepare(
            "SELECT COUNT(*) FROM usuarios u
             JOIN cargo_permissoes cp ON cp.id_cargo = u.id_cargo
             JOIN permissoes p ON p.id_permissao = cp.id_permissao
             WHERE u.id_loja = :id_loja AND u.status = 'ativo'
               AND u.id_cargo != :id_cargo_excluido AND p.codigo = :codigo"
        );
        $stmt->execute(['id_loja' => $idLoja, 'id_cargo_excluido' => $idCargoExcluido, 'codigo' => $codigo]);
        return (int) $stmt->fetchColumn();
    }

    public function nomeExists(int $idLoja, string $nome, ?int $ignorarId = null): bool
    {
        $sql = 'SELECT 1 FROM cargos WHERE id_loja = :id_loja AND nome = :nome';
        $params = ['id_loja' => $idLoja, 'nome' => $nome];
        if ($ignorarId !== null) {
            $sql .= ' AND id_cargo != :ignorar';
            $params['ignorar'] = $ignorarId;
        }
        $stmt = db()->prepare($sql);
        $stmt->execute($params);
        return (bool) $stmt->fetchColumn();
    }

    /** @param string[] $codigos */
    public function create(int $idLoja, string $nome, ?string $descricao, string $cor, array $codigos): int
    {
        $idCargo = $this->inserirCargo($idLoja, $nome, $cor, $descricao, false);
        $this->sincronizarPermissoes($idCargo, $codigos);
        return $idCargo;
    }

    /** @param string[] $codigos */
    public function update(int $idCargo, string $nome, ?string $descricao, string $cor, array $codigos): void
    {
        $stmt = db()->prepare(
            'UPDATE cargos SET nome = :nome, descricao = :descricao, cor = :cor WHERE id_cargo = :id'
        );
        $stmt->execute([
            'nome' => $nome,
            'descricao' => $descricao,
            'cor' => $cor,
            'id' => $idCargo,
        ]);
        $this->sincronizarPermissoes($idCargo, $codigos);
        $this->resincronizarPerfilDosUsuarios($idCargo);
    }

    public function delete(int $idCargo): void
    {
        $stmt = db()->prepare('DELETE FROM cargos WHERE id_cargo = :id');
        $stmt->execute(['id' => $idCargo]);
    }

    /**
     * Recalcula o "perfil" legado de cada usuário do cargo a partir das
     * permissões atuais do cargo (ver nivelEquivalente()). Necessário
     * porque editar as permissões de um cargo pode mudar o nível de
     * acesso de quem o possui, e "perfil" ainda sustenta regras como
     * "a loja precisa ter ao menos um administrador ativo".
     */
    private function resincronizarPerfilDosUsuarios(int $idCargo): void
    {
        $perfil = self::nivelEquivalente($this->permissoesDoCargo($idCargo));
        $stmt = db()->prepare('UPDATE usuarios SET perfil = :perfil WHERE id_cargo = :id_cargo');
        $stmt->execute(['perfil' => $perfil, 'id_cargo' => $idCargo]);
    }

    /**
     * Deriva o "perfil" (ENUM legado: administrador/operador_caixa/
     * estoquista) equivalente a um conjunto de permissões. Usada tanto
     * para popular usuarios.perfil quanto para decidir, na tela
     * Gerenciar Usuários, qual badge e quais regras de segurança
     * (ex.: "não pode criar administrador por aqui") se aplicam.
     *
     * @param string[] $codigos
     */
    public static function nivelEquivalente(array $codigos): string
    {
        // Qualquer permissao administrativa de escrita caracteriza o nivel
        // "administrador"; apenas ver a tela de Equipe ou de Cargos nao.
        $administrativas = [
            'usuarios.criar', 'usuarios.editar', 'usuarios.excluir',
            'cargos.criar', 'cargos.editar', 'cargos.excluir',
            'loja.configurar',
        ];
        if (array_intersect($administrativas, $codigos) !== []) {
            return 'administrador';
        }
        if (in_array('vendas.registrar', $codigos, true)) {
            return 'operador_caixa';
        }
        $deEstoque = [
            'produtos.criar', 'produtos.editar', 'produtos.excluir',
            'estoque.movimentar',
        ];
        if (array_intersect($deEstoque, $codigos) !== []) {
            return 'estoquista';
        }
        return 'operador_caixa';
    }

    private function inserirCargo(int $idLoja, string $nome, string $cor, ?string $descricao, bool $sistema): int
    {
        $stmt = db()->prepare(
            'INSERT INTO cargos (id_loja, nome, descricao, cor, cargo_sistema)
             VALUES (:id_loja, :nome, :descricao, :cor, :sistema)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'nome' => $nome,
            'descricao' => $descricao,
            'cor' => $cor,
            'sistema' => $sistema ? 1 : 0,
        ]);
        return (int) db()->lastInsertId();
    }

    /** @param string[] $codigos */
    private function sincronizarPermissoes(int $idCargo, array $codigos): void
    {
        $pdo = db();
        $pdo->prepare('DELETE FROM cargo_permissoes WHERE id_cargo = :id_cargo')
            ->execute(['id_cargo' => $idCargo]);

        if ($codigos === []) {
            return;
        }

        $placeholders = implode(',', array_fill(0, count($codigos), '?'));
        $stmt = $pdo->prepare("SELECT id_permissao, codigo FROM permissoes WHERE codigo IN ($placeholders)");
        $stmt->execute(array_values($codigos));
        $validos = $stmt->fetchAll();

        $insert = $pdo->prepare('INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao) VALUES (:id_cargo, :id_permissao)');
        foreach ($validos as $permissao) {
            $insert->execute(['id_cargo' => $idCargo, 'id_permissao' => $permissao['id_permissao']]);
        }
    }
}
