<?php

namespace Hydra\Repositories;

/**
 * Módulo de Cargos e Permissões (estilo Discord) — ver schema.sql para
 * o desenho das tabelas "permissoes", "cargos" e "cargo_permissoes".
 *
 * Cada loja tem seus próprios cargos. Toda loja ganha, na primeira vez
 * em que este repositório é usado para ela, 3 cargos de sistema
 * (Administrador, Operador de Caixa e Estoquista) — ver ensureDefaults(),
 * que também é onde vive a migração preguiçosa do catálogo de permissões.
 *
 * O catálogo tem 5 permissões, uma por área do sistema. A granularidade
 * anterior (19 códigos, ver/criar/editar/excluir por módulo) não
 * correspondia a nenhuma decisão real de um mercadinho: configura-se "quem
 * cuida do estoque", não "quem pode editar mas não excluir produto".
 */
final class CargoRepository
{
    /**
     * Permissões de cada cargo de sistema.
     *
     * O Operador de Caixa não recebe "estoque.gerenciar": ele precisa
     * enxergar o catálogo para montar a venda, e é por isso que
     * GET /api/produtos usa Auth::requireAnyPermission() e aceita
     * "vendas.operar" — em vez de exigir poder de escrita no estoque de
     * quem só opera o caixa.
     */
    private const PERMISSOES_SISTEMA = [
        'administrador' => [
            'estoque.gerenciar',
            'produtos.editar_preco',
            'vendas.operar',
            'equipe.gerenciar',
            'loja.configurar',
        ],
        'operador_caixa' => [
            'vendas.operar',
        ],
        'estoquista' => [
            'estoque.gerenciar',
        ],
    ];

    /**
     * Catálogo das 5 permissões, espelhando o bloco INSERT do schema.sql.
     * Existe também em PHP porque o INSERT do schema só roda se o arquivo
     * for reaplicado à mão: sem isto, um banco criado na versão anterior
     * ficaria com ZERO permissões no catálogo depois da aposentadoria dos
     * códigos antigos, e a tela de Cargos abriria sem nenhum checkbox.
     *
     * Mantenha em sincronia com schema.sql.
     *
     * @var array<int,array{0:string,1:string,2:string,3:string,4:int}>
     */
    private const CATALOGO = [
        ['estoque.gerenciar',     'Estoque e Produtos',   'Cadastrar, editar e excluir produtos e lançar entradas e saídas de estoque',              'Operação',      10],
        ['produtos.editar_preco', 'Alterar Preços',       'Alterar preço de custo e de venda (RN04) — só tem efeito junto com "Estoque e Produtos"', 'Operação',      11],
        ['vendas.operar',         'Vendas no Caixa',      'Operar o Caixa (PDV), finalizar vendas e consultar o histórico',                          'Operação',      12],
        ['equipe.gerenciar',      'Equipe e Cargos',      'Gerenciar os usuários da loja e os cargos e suas permissões',                             'Administração', 20],
        ['loja.configurar',       'Configuração da Loja', 'Ver e alterar os dados cadastrais da loja',                                               'Administração', 21],
    ];

    /**
     * De onde cada permissão nova herda o acesso que o cargo já tinha na
     * granularidade antiga (19 códigos).
     *
     * A regra SUB-concede de propósito: só quem tinha algum código de
     * ESCRITA na área ganha a permissão grossa, porque ela também concede
     * escrita. "produtos.visualizar" e "estoque.visualizar" sozinhos não
     * geram nada — um cargo que só tinha esses dois termina sem permissão
     * alguma, porque "só olhar o estoque" deixou de existir. O
     * administrador remarca esses cargos na tela de Cargos.
     *
     * "loja.configurar" e "produtos.editar_preco" não aparecem como
     * destino de si mesmos: as linhas deles em "permissoes" sobrevivem à
     * migração com o mesmo id_permissao, então quem já os tinha continua
     * tendo, sem remap.
     *
     * @var array<string,string[]>
     */
    private const MIGRACAO_PERMISSOES = [
        'estoque.gerenciar' => ['produtos.criar', 'produtos.editar', 'produtos.excluir', 'estoque.movimentar'],
        'vendas.operar'     => ['vendas.visualizar', 'vendas.registrar'],
        'equipe.gerenciar'  => [
            'usuarios.visualizar', 'usuarios.criar', 'usuarios.editar', 'usuarios.excluir',
            'cargos.visualizar', 'cargos.criar', 'cargos.editar', 'cargos.excluir',
        ],
        'loja.configurar'   => ['loja.visualizar'],
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
     * Garante que o catálogo de permissões exista, que o acesso gravado na
     * granularidade antiga seja migrado, que a loja tenha os 3 cargos de
     * sistema e que nenhum usuário dela fique com id_cargo nulo.
     * Idempotente e barata — chamada a cada login (AuthController::login) e
     * ao abrir Equipe/Cargos, para que bancos criados em versões anteriores
     * sejam migrados sem script manual.
     *
     * NÃO abre transação de propósito: AuthController::registro() já chama
     * este método DENTRO de uma transação, e o PDO não aceita aninhamento.
     * A segurança sem transação vem da ORDEM abaixo — o passo destrutivo
     * (remover as permissões aposentadas) é o último, então uma requisição
     * que morra no meio deixa o cargo com os códigos novos E os antigos
     * (acesso de sobra, nunca de menos) e a próxima chamada termina o
     * serviço.
     */
    public function ensureDefaults(int $idLoja): void
    {
        $this->garantirCatalogo();

        if ($this->temPermissoesAposentadas()) {
            // Ordem crítica: copiar antes de apagar. Invertido, o DELETE
            // levaria o acesso antigo embora antes de haver de onde copiá-lo,
            // e todo cargo de toda loja ficaria sem permissão alguma — sem
            // nenhum caminho de volta pela interface.
            $this->remapearPermissoesDosCargos();
            $this->removerPermissoesAposentadas();
            $this->resincronizarPerfilDeTodosOsCargos();
        }

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
     * - os 17 códigos granulares da versão anterior. Dos 19, sobrevivem só
     *   "produtos.editar_preco" e "loja.configurar", reaproveitados como
     *   códigos novos (ver CATALOGO).
     *
     * CUIDADO: este DELETE só pode rodar DEPOIS de
     * remapearPermissoesDosCargos(). Ver o docblock de ensureDefaults().
     */
    private const PERMISSOES_APOSENTADAS = [
        'vendas.aplicar_desconto',
        'produtos.visualizar', 'produtos.criar', 'produtos.editar', 'produtos.excluir',
        'estoque.visualizar', 'estoque.movimentar',
        'vendas.visualizar', 'vendas.registrar',
        'usuarios.visualizar', 'usuarios.criar', 'usuarios.editar', 'usuarios.excluir',
        'cargos.visualizar', 'cargos.criar', 'cargos.editar', 'cargos.excluir',
        'loja.visualizar',
    ];

    /**
     * ON DUPLICATE KEY UPDATE, e não INSERT IGNORE: "produtos.editar_preco"
     * e "loja.configurar" já existem em bancos antigos e precisam ganhar o
     * nome/descrição novos SEM trocar de id_permissao — senão as linhas de
     * cargo_permissoes que apontam para elas perderiam o vínculo.
     */
    private function garantirCatalogo(): void
    {
        $stmt = db()->prepare(
            'INSERT INTO permissoes (codigo, nome, descricao, categoria, ordem)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               nome = VALUES(nome), descricao = VALUES(descricao),
               categoria = VALUES(categoria), ordem = VALUES(ordem)'
        );
        foreach (self::CATALOGO as $linha) {
            $stmt->execute($linha);
        }
    }

    /**
     * Uma única busca pelo índice UNIQUE de "codigo": é este o custo da
     * migração no caso normal, em que ela já rodou.
     */
    private function temPermissoesAposentadas(): bool
    {
        $marcadores = implode(',', array_fill(0, count(self::PERMISSOES_APOSENTADAS), '?'));
        $stmt = db()->prepare("SELECT 1 FROM permissoes WHERE codigo IN ($marcadores) LIMIT 1");
        $stmt->execute(self::PERMISSOES_APOSENTADAS);
        return (bool) $stmt->fetchColumn();
    }

    /**
     * Copia, para TODOS os cargos de TODAS as lojas, o acesso que eles já
     * tinham nos códigos antigos para os códigos novos equivalentes.
     *
     * Global, e não por loja, porque removerPermissoesAposentadas() apaga
     * linhas de "permissoes" (tabela global) e o ON DELETE CASCADE de
     * cargo_permissoes atinge todas as lojas de uma vez. Se o remap fosse
     * por loja, o primeiro login da loja A apagaria o acesso dos cargos da
     * loja B antes de qualquer usuário dela ter logado — e a loja B ficaria
     * trancada para sempre.
     */
    private function remapearPermissoesDosCargos(): void
    {
        $insert = db()->prepare(
            'INSERT IGNORE INTO cargo_permissoes (id_cargo, id_permissao)
             VALUES (:id_cargo, :id_permissao)'
        );

        foreach (self::MIGRACAO_PERMISSOES as $novoCodigo => $codigosAntigos) {
            $idNovo = $this->idDaPermissao($novoCodigo);
            if ($idNovo === null) {
                // garantirCatalogo() roda antes; na dúvida, não concede nada
                // (e também não apaga nada).
                continue;
            }

            $marcadores = implode(',', array_fill(0, count($codigosAntigos), '?'));
            $stmt = db()->prepare(
                "SELECT DISTINCT cp.id_cargo
                   FROM cargo_permissoes cp
                   JOIN permissoes p ON p.id_permissao = cp.id_permissao
                  WHERE p.codigo IN ($marcadores)"
            );
            $stmt->execute($codigosAntigos);

            foreach ($stmt->fetchAll(\PDO::FETCH_COLUMN) as $idCargo) {
                $insert->execute(['id_cargo' => (int) $idCargo, 'id_permissao' => $idNovo]);
            }
        }
    }

    private function idDaPermissao(string $codigo): ?int
    {
        $stmt = db()->prepare('SELECT id_permissao FROM permissoes WHERE codigo = :codigo');
        $stmt->execute(['codigo' => $codigo]);
        $id = $stmt->fetchColumn();
        return $id === false ? null : (int) $id;
    }

    private function removerPermissoesAposentadas(): void
    {
        $marcadores = implode(',', array_fill(0, count(self::PERMISSOES_APOSENTADAS), '?'));
        // As linhas correspondentes em cargo_permissoes somem junto, pelo
        // ON DELETE CASCADE declarado no schema.
        db()->prepare("DELETE FROM permissoes WHERE codigo IN ($marcadores)")
            ->execute(self::PERMISSOES_APOSENTADAS);
    }

    /**
     * usuarios.perfil é derivado das permissões do cargo (nivelEquivalente())
     * e sustenta a regra "a loja precisa de um administrador ativo"
     * (UsuarioRepository::countAdminsAtivos). Trocar os códigos por baixo dos
     * cargos pode mudar esse nível — o caso real é um cargo que só tinha
     * "loja.visualizar" (nível operador_caixa) e passa a ter
     * "loja.configurar" (nível administrador). Sem este resync o ENUM
     * gravado ficaria divergente do que as permissões dizem.
     */
    private function resincronizarPerfilDeTodosOsCargos(): void
    {
        $ids = db()->query('SELECT id_cargo FROM cargos')->fetchAll(\PDO::FETCH_COLUMN);
        foreach ($ids as $idCargo) {
            $this->resincronizarPerfilDosUsuarios((int) $idCargo);
        }
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
        // Qualquer permissão administrativa caracteriza o nível
        // "administrador". Com permissões grossas não existe mais o caso
        // "só ver a tela de Equipe": quem vê, gerencia.
        if (array_intersect(['equipe.gerenciar', 'loja.configurar'], $codigos) !== []) {
            return 'administrador';
        }
        if (in_array('vendas.operar', $codigos, true)) {
            return 'operador_caixa';
        }
        if (in_array('estoque.gerenciar', $codigos, true)) {
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
