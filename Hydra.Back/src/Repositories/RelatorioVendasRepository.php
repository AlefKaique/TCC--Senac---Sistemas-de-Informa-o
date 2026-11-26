<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/**
 * Consultas da tela Relatório de Vendas (GET /api/relatorios/vendas).
 *
 * Uma consulta (ou um par delas) por bloco da tela, e o controller só
 * chama as dos blocos pedidos. Regras comuns:
 *   - toda consulta é preparada; o único texto montado no PHP são os
 *     NOMES dos marcadores da lista de filiais (":p_f0, :p_f1...") e
 *     trechos constantes deste arquivo, nunca um valor vindo da requisição;
 *   - as somas e contagens são feitas no MySQL (SUM, COUNT, GROUP BY);
 *   - só entram vendas concluídas: venda cancelada não é dinheiro que
 *     entrou (os blocos de operador e de cancelamentos contam as
 *     canceladas à parte, de propósito);
 *   - $filiais é a lista já autorizada pelo controller (uma filial, ou
 *     todas as da loja para o administrador). Nunca vem vazia.
 *
 * Índices usados: vendas (id_filial, status, data_venda) e
 * (id_filial, status, data_cancelamento), itens_venda (id_venda,
 * id_produto) e (id_produto), pagamentos (id_venda), produtos
 * (id_filial, status). Ver Migracoes::garantirRelatorioVendas().
 */
final class RelatorioVendasRepository
{
    /**
     * Quanto cada item rendeu de verdade. O desconto da venda é rateado
     * pelos itens (valor_total / subtotal), para a soma dos itens bater com
     * o "Dinheiro que entrou", que é a soma de vendas.valor_total.
     */
    private const RECEITA_ITEM = 'iv.quantidade * iv.preco_unitario * COALESCE(v.valor_total / NULLIF(v.subtotal, 0), 1)';

    /** Ordem fixa das formas de pagamento na tela (todas aparecem, mesmo zeradas). */
    private const FORMAS_PAGAMENTO = ['pix', 'cartao_debito', 'cartao_credito', 'dinheiro', 'vale_refeicao'];

    private const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

    public function __construct()
    {
        Migracoes::garantirRelatorioVendas();
    }

    /* ================= Resumo (cartões do topo) ================= */

    /**
     * Dinheiro que entrou, quantidade de vendas, média por venda e, para
     * quem pode ver, o lucro estimado.
     *
     * O lucro só considera os itens com custo registrado na venda
     * (itens_venda.custo_unitario, o custo do produto no momento da venda).
     * Os itens sem custo ficam de fora e são devolvidos à parte, para a
     * tela avisar em texto em vez de inflar o lucro.
     *
     * @param int[] $filiais
     * @return array<string,mixed>
     */
    public function resumo(array $filiais, \DateTimeImmutable $de, \DateTimeImmutable $ate, bool $comLucro): array
    {
        [$filtro, $params] = $this->filtroVendas('r', $filiais, $de, $ate);
        $linha = $this->consultar(
            "SELECT COUNT(*) AS num_vendas, COALESCE(SUM(v.valor_total), 0) AS faturamento
               FROM vendas v
              WHERE {$filtro}",
            $params
        )->fetch() ?: [];

        $numVendas = (int) ($linha['num_vendas'] ?? 0);
        $faturamento = (float) ($linha['faturamento'] ?? 0);
        $resumo = [
            'faturamento' => round($faturamento, 2),
            'num_vendas' => $numVendas,
            'media_venda' => $numVendas > 0 ? round($faturamento / $numVendas, 2) : null,
        ];
        if (!$comLucro) {
            return $resumo;
        }

        $receita = self::RECEITA_ITEM;
        [$filtro, $params] = $this->filtroVendas('l', $filiais, $de, $ate);
        $lucro = $this->consultar(
            "SELECT COALESCE(SUM(CASE WHEN iv.custo_unitario IS NOT NULL
                                      THEN {$receita} - iv.quantidade * iv.custo_unitario END), 0) AS lucro,
                    COUNT(DISTINCT CASE WHEN iv.custo_unitario IS NULL THEN iv.id_produto END) AS produtos_sem_custo,
                    COALESCE(SUM(CASE WHEN iv.custo_unitario IS NULL THEN {$receita} END), 0) AS faturamento_sem_custo
               FROM itens_venda iv
               JOIN vendas v ON v.id_venda = iv.id_venda
              WHERE {$filtro}",
            $params
        )->fetch() ?: [];

        return $resumo + [
            'lucro' => round((float) ($lucro['lucro'] ?? 0), 2),
            'produtos_sem_custo' => (int) ($lucro['produtos_sem_custo'] ?? 0),
            'faturamento_sem_custo' => round((float) ($lucro['faturamento_sem_custo'] ?? 0), 2),
        ];
    }

    /**
     * Comparação entre filiais (só para o administrador com "Todas as
     * filiais"): uma linha por filial, inclusive as que não venderam.
     *
     * @param int[] $filiais
     * @return array<int,array<string,mixed>>
     */
    public function comparacaoFiliais(array $filiais, \DateTimeImmutable $de, \DateTimeImmutable $ate, bool $comLucro): array
    {
        [$listaFiliais, $params] = $this->listaFiliais('c', $filiais, 'f.id_filial');
        $params['c_de'] = $de->format('Y-m-d 00:00:00');
        $params['c_fim'] = $ate->modify('+1 day')->format('Y-m-d 00:00:00');
        $linhas = $this->consultar(
            "SELECT f.id_filial, f.nome,
                    COUNT(v.id_venda) AS num_vendas,
                    COALESCE(SUM(v.valor_total), 0) AS faturamento
               FROM filiais f
               LEFT JOIN vendas v ON v.id_filial = f.id_filial
                                 AND v.status = 'concluida'
                                 AND v.data_venda >= :c_de AND v.data_venda < :c_fim
              WHERE {$listaFiliais}
              GROUP BY f.id_filial, f.nome
              ORDER BY faturamento DESC, f.nome ASC",
            $params
        )->fetchAll();

        $lucroPorFilial = [];
        if ($comLucro) {
            $receita = self::RECEITA_ITEM;
            [$filtro, $params] = $this->filtroVendas('cl', $filiais, $de, $ate);
            $lucroPorFilial = $this->consultar(
                "SELECT v.id_filial,
                        COALESCE(SUM(CASE WHEN iv.custo_unitario IS NOT NULL
                                          THEN {$receita} - iv.quantidade * iv.custo_unitario END), 0) AS lucro
                   FROM itens_venda iv
                   JOIN vendas v ON v.id_venda = iv.id_venda
                  WHERE {$filtro}
                  GROUP BY v.id_filial",
                $params
            )->fetchAll(\PDO::FETCH_KEY_PAIR);
        }

        return array_map(static function (array $linha) use ($comLucro, $lucroPorFilial): array {
            $numVendas = (int) $linha['num_vendas'];
            $faturamento = (float) $linha['faturamento'];
            $item = [
                'id_filial' => (int) $linha['id_filial'],
                'nome' => $linha['nome'],
                'faturamento' => round($faturamento, 2),
                'num_vendas' => $numVendas,
                'media_venda' => $numVendas > 0 ? round($faturamento / $numVendas, 2) : null,
            ];
            if ($comLucro) {
                $item['lucro'] = round((float) ($lucroPorFilial[$linha['id_filial']] ?? 0), 2);
            }
            return $item;
        }, $linhas);
    }

    /* ================= Blocos opcionais ================= */

    /**
     * Produtos que mais venderam, por dinheiro que entrou. Os produtos são
     * cadastrados por filial; o agrupamento é por nome e unidade para que,
     * em "Todas as filiais", o mesmo produto de duas filiais some numa
     * linha só.
     *
     * @param int[] $filiais
     * @return array<string,mixed>
     */
    public function maisVendidos(
        array $filiais,
        \DateTimeImmutable $de,
        \DateTimeImmutable $ate,
        int $limite,
        int $deslocamento
    ): array {
        $receita = self::RECEITA_ITEM;
        [$filtro, $params] = $this->filtroVendas('t', $filiais, $de, $ate);
        $totais = $this->consultar(
            "SELECT COUNT(*) AS total_produtos,
                    COALESCE(SUM(t.faturamento), 0) AS faturamento_total,
                    COALESCE(MAX(t.faturamento), 0) AS faturamento_primeiro
               FROM (
                    SELECT SUM({$receita}) AS faturamento
                      FROM itens_venda iv
                      JOIN vendas v ON v.id_venda = iv.id_venda
                      JOIN produtos p ON p.id_produto = iv.id_produto
                     WHERE {$filtro}
                     GROUP BY p.nome, p.unidade
               ) t",
            $params
        )->fetch() ?: [];
        $faturamentoTotal = (float) ($totais['faturamento_total'] ?? 0);

        [$filtro, $params] = $this->filtroVendas('m', $filiais, $de, $ate);
        $params['limite'] = $limite;
        $params['deslocamento'] = $deslocamento;
        $linhas = $this->consultar(
            "SELECT p.nome, p.unidade,
                    SUM(iv.quantidade) AS quantidade,
                    SUM({$receita}) AS faturamento
               FROM itens_venda iv
               JOIN vendas v ON v.id_venda = iv.id_venda
               JOIN produtos p ON p.id_produto = iv.id_produto
              WHERE {$filtro}
              GROUP BY p.nome, p.unidade
              ORDER BY faturamento DESC, p.nome ASC
              LIMIT :limite OFFSET :deslocamento",
            $params
        )->fetchAll();

        $itens = [];
        foreach ($linhas as $indice => $linha) {
            $faturamento = (float) $linha['faturamento'];
            $itens[] = [
                'posicao' => $deslocamento + $indice + 1,
                'nome' => $linha['nome'],
                'unidade' => $linha['unidade'],
                'quantidade' => round((float) $linha['quantidade'], 3),
                'faturamento' => round($faturamento, 2),
                'percentual' => $faturamentoTotal > 0 ? round($faturamento / $faturamentoTotal * 100, 1) : 0.0,
            ];
        }

        return [
            'itens' => $itens,
            'total_produtos' => (int) ($totais['total_produtos'] ?? 0),
            'faturamento_total' => round($faturamentoTotal, 2),
            'faturamento_primeiro' => round((float) ($totais['faturamento_primeiro'] ?? 0), 2),
        ];
    }

    /**
     * Dia a dia: uma linha por data com venda, o total do dia e o produto
     * campeão (o que mais rendeu naquela data; por dinheiro e não por
     * quantidade, porque quilo e unidade não se somam).
     *
     * O campeão sai sem função de janela (ROW_NUMBER), que o MySQL 5.7 não
     * tem: o total de cada produto por dia é comparado com o maior total do
     * mesmo dia. Em empate, fica o primeiro em ordem alfabética.
     *
     * @param int[] $filiais
     * @return array<string,mixed>
     */
    public function diaADia(array $filiais, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        [$filtro, $params] = $this->filtroVendas('d', $filiais, $de, $ate);
        $dias = $this->consultar(
            "SELECT DATE(v.data_venda) AS data, COUNT(*) AS num_vendas, SUM(v.valor_total) AS total
               FROM vendas v
              WHERE {$filtro}
              GROUP BY DATE(v.data_venda)
              ORDER BY data ASC",
            $params
        )->fetchAll();

        [$filtro, $params] = $this->filtroVendas('dt', $filiais, $de, $ate);
        $total = $this->consultar(
            "SELECT COUNT(*) AS num_vendas, COALESCE(SUM(v.valor_total), 0) AS total
               FROM vendas v
              WHERE {$filtro}",
            $params
        )->fetch() ?: [];

        $receita = self::RECEITA_ITEM;
        [$filtroA, $paramsA] = $this->filtroVendas('ca', $filiais, $de, $ate);
        [$filtroB, $paramsB] = $this->filtroVendas('cb', $filiais, $de, $ate);
        $porProdutoDia = static fn (string $filtro): string =>
            "SELECT DATE(v.data_venda) AS data, p.nome, p.unidade,
                    SUM(iv.quantidade) AS quantidade, SUM({$receita}) AS faturamento
               FROM itens_venda iv
               JOIN vendas v ON v.id_venda = iv.id_venda
               JOIN produtos p ON p.id_produto = iv.id_produto
              WHERE {$filtro}
              GROUP BY DATE(v.data_venda), p.nome, p.unidade";
        $sqlProdutosDoDia = $porProdutoDia($filtroA);
        $sqlMaiorDoDia = $porProdutoDia($filtroB);
        $campeoesLinhas = $this->consultar(
            "SELECT x.data, x.nome, x.unidade, x.quantidade, x.faturamento
               FROM ({$sqlProdutosDoDia}) x
               JOIN (
                    SELECT y.data, MAX(y.faturamento) AS maior
                      FROM ({$sqlMaiorDoDia}) y
                     GROUP BY y.data
               ) m ON m.data = x.data AND m.maior = x.faturamento
              ORDER BY x.data ASC, x.nome ASC",
            $paramsA + $paramsB
        )->fetchAll();
        $campeoes = [];
        foreach ($campeoesLinhas as $linha) {
            $campeoes[$linha['data']] ??= [
                'nome' => $linha['nome'],
                'unidade' => $linha['unidade'],
                'quantidade' => round((float) $linha['quantidade'], 3),
                'faturamento' => round((float) $linha['faturamento'], 2),
            ];
        }

        return [
            'dias' => array_map(fn (array $linha): array => [
                'data' => $linha['data'],
                'dia_semana' => self::DIAS_SEMANA[(int) (new \DateTimeImmutable($linha['data']))->format('w')],
                'num_vendas' => (int) $linha['num_vendas'],
                'total' => round((float) $linha['total'], 2),
                'campeao' => $campeoes[$linha['data']] ?? null,
            ], $dias),
            'total' => [
                'num_vendas' => (int) ($total['num_vendas'] ?? 0),
                'total' => round((float) ($total['total'] ?? 0), 2),
            ],
        ];
    }

    /**
     * Horário de movimento em três faixas: manhã (7h às 12h), tarde (12h às
     * 18h) e noite (18h às 22h). Venda fora delas aparece numa quarta
     * linha, para os totais baterem com o resumo.
     *
     * @param int[] $filiais
     * @return array<int,array<string,mixed>>
     */
    public function horarios(array $filiais, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        [$filtro, $params] = $this->filtroVendas('h', $filiais, $de, $ate);
        $linhas = $this->consultar(
            "SELECT CASE
                        WHEN HOUR(v.data_venda) BETWEEN 7 AND 11 THEN 'manha'
                        WHEN HOUR(v.data_venda) BETWEEN 12 AND 17 THEN 'tarde'
                        WHEN HOUR(v.data_venda) BETWEEN 18 AND 21 THEN 'noite'
                        ELSE 'fora'
                    END AS faixa,
                    COUNT(*) AS num_vendas,
                    SUM(v.valor_total) AS valor
               FROM vendas v
              WHERE {$filtro}
              GROUP BY faixa",
            $params
        )->fetchAll(\PDO::FETCH_UNIQUE);

        $faixas = [
            'manha' => 'Manhã (7h às 12h)',
            'tarde' => 'Tarde (12h às 18h)',
            'noite' => 'Noite (18h às 22h)',
            'fora' => 'Fora desses horários',
        ];
        $valorTotal = array_sum(array_map(static fn ($linha) => (float) $linha['valor'], $linhas));
        $resultado = [];
        foreach ($faixas as $codigo => $rotulo) {
            if ($codigo === 'fora' && !isset($linhas['fora'])) {
                continue;
            }
            $valor = (float) ($linhas[$codigo]['valor'] ?? 0);
            $resultado[] = [
                'faixa' => $codigo,
                'rotulo' => $rotulo,
                'valor' => round($valor, 2),
                'num_vendas' => (int) ($linhas[$codigo]['num_vendas'] ?? 0),
                'percentual' => $valorTotal > 0 ? round($valor / $valorTotal * 100, 1) : 0.0,
            ];
        }
        return $resultado;
    }

    /**
     * Como o cliente pagou: valor e % por forma de pagamento. A venda paga
     * em duas formas conta nas duas (cada parte no seu valor).
     *
     * @param int[] $filiais
     * @return array<int,array<string,mixed>>
     */
    public function pagamentos(array $filiais, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        [$filtro, $params] = $this->filtroVendas('pg', $filiais, $de, $ate);
        $linhas = $this->consultar(
            "SELECT pg.forma_pagamento AS forma,
                    SUM(pg.valor) AS valor,
                    COUNT(DISTINCT pg.id_venda) AS num_vendas
               FROM pagamentos pg
               JOIN vendas v ON v.id_venda = pg.id_venda
              WHERE {$filtro}
              GROUP BY pg.forma_pagamento",
            $params
        )->fetchAll(\PDO::FETCH_UNIQUE);

        $valorTotal = array_sum(array_map(static fn ($linha) => (float) $linha['valor'], $linhas));
        return array_map(static function (string $forma) use ($linhas, $valorTotal): array {
            $valor = (float) ($linhas[$forma]['valor'] ?? 0);
            return [
                'forma' => $forma,
                'valor' => round($valor, 2),
                'num_vendas' => (int) ($linhas[$forma]['num_vendas'] ?? 0),
                'percentual' => $valorTotal > 0 ? round($valor / $valorTotal * 100, 1) : 0.0,
            ];
        }, self::FORMAS_PAGAMENTO);
    }

    /**
     * Produtos que pararam de vender: estoque acima de zero e no máximo
     * $maxVendas vendas no período. "Dinheiro parado" é o estoque vezes o
     * preço de custo; sem custo cadastrado, vezes o preço de venda (a linha
     * avisa).
     *
     * @param int[] $filiais
     * @return array<string,mixed>
     */
    public function parados(
        array $filiais,
        \DateTimeImmutable $de,
        \DateTimeImmutable $ate,
        int $maxVendas,
        int $limite
    ): array {
        $consulta = function (string $p) use ($filiais, $de, $ate, $maxVendas): array {
            [$filtro, $params] = $this->filtroVendas($p . 'v', $filiais, $de, $ate);
            [$listaFiliais, $paramsFiliais] = $this->listaFiliais($p . 'p', $filiais, 'p.id_filial');
            $params += $paramsFiliais;
            $params[$p . '_max'] = $maxVendas;
            $sql = "SELECT p.id_produto, p.nome, p.unidade, p.quantidade, f.nome AS filial,
                           COALESCE(s.num_vendas, 0) AS num_vendas,
                           COALESCE(s.quantidade, 0) AS quantidade_vendida,
                           p.quantidade * COALESCE(p.preco_custo, p.preco_venda, 0) AS valor_parado,
                           (p.preco_custo IS NULL) AS sem_custo
                      FROM produtos p
                      JOIN filiais f ON f.id_filial = p.id_filial
                      LEFT JOIN (
                           SELECT iv.id_produto,
                                  COUNT(DISTINCT iv.id_venda) AS num_vendas,
                                  SUM(iv.quantidade) AS quantidade
                             FROM itens_venda iv
                             JOIN vendas v ON v.id_venda = iv.id_venda
                            WHERE {$filtro}
                            GROUP BY iv.id_produto
                      ) s ON s.id_produto = p.id_produto
                     WHERE {$listaFiliais}
                       AND p.status = 'ativo'
                       AND p.quantidade > 0
                       AND COALESCE(s.num_vendas, 0) <= :{$p}_max";
            return [$sql, $params];
        };

        [$sql, $params] = $consulta('pt');
        $totais = $this->consultar(
            "SELECT COUNT(*) AS quantidade, COALESCE(SUM(t.valor_parado), 0) AS valor_parado
               FROM ({$sql}) t",
            $params
        )->fetch() ?: [];

        [$sql, $params] = $consulta('pl');
        $params['limite'] = $limite;
        $linhas = $this->consultar(
            "{$sql} ORDER BY valor_parado DESC, p.nome ASC LIMIT :limite",
            $params
        )->fetchAll();

        return [
            'itens' => array_map(static fn (array $linha): array => [
                'nome' => $linha['nome'],
                'unidade' => $linha['unidade'],
                'filial' => $linha['filial'],
                'estoque' => round((float) $linha['quantidade'], 3),
                'num_vendas' => (int) $linha['num_vendas'],
                'quantidade_vendida' => round((float) $linha['quantidade_vendida'], 3),
                'valor_parado' => round((float) $linha['valor_parado'], 2),
                'sem_custo' => (bool) $linha['sem_custo'],
            ], $linhas),
            'total_produtos' => (int) ($totais['quantidade'] ?? 0),
            'valor_parado_total' => round((float) ($totais['valor_parado'] ?? 0), 2),
            'max_vendas' => $maxVendas,
            'limite' => $limite,
        ];
    }

    /**
     * Vai acabar logo: estoque atual dividido pela média de venda por dia
     * no período. Só entram produtos que venderam no período e que, nesse
     * ritmo, acabam em até $limiteDias dias (os que já acabaram vêm com 0).
     *
     * @param int[] $filiais
     * @return array<string,mixed>
     */
    public function vaiAcabar(
        array $filiais,
        \DateTimeImmutable $de,
        \DateTimeImmutable $ate,
        int $diasPeriodo,
        int $limiteDias,
        int $limite
    ): array {
        [$filtro, $params] = $this->filtroVendas('va', $filiais, $de, $ate);
        [$listaFiliais, $paramsFiliais] = $this->listaFiliais('vp', $filiais, 'p.id_filial');
        $params += $paramsFiliais;
        $params['dias_media'] = $diasPeriodo;
        $params['dias_ritmo'] = $diasPeriodo;
        $params['limite_dias'] = $limiteDias;
        $params['limite'] = $limite;
        $linhas = $this->consultar(
            "SELECT p.nome, p.unidade, p.quantidade, f.nome AS filial,
                    SUM(iv.quantidade) / :dias_media AS media_diaria,
                    CASE WHEN p.quantidade <= 0 THEN 0
                         ELSE p.quantidade / (SUM(iv.quantidade) / :dias_ritmo) END AS dias_restantes
               FROM produtos p
               JOIN filiais f ON f.id_filial = p.id_filial
               JOIN itens_venda iv ON iv.id_produto = p.id_produto
               JOIN vendas v ON v.id_venda = iv.id_venda
              WHERE {$listaFiliais}
                AND p.status = 'ativo'
                AND {$filtro}
              GROUP BY p.id_produto, p.nome, p.unidade, p.quantidade, f.nome
             HAVING SUM(iv.quantidade) > 0 AND dias_restantes <= :limite_dias
              ORDER BY dias_restantes ASC, p.nome ASC
              LIMIT :limite",
            $params
        )->fetchAll();

        return [
            'itens' => array_map(static fn (array $linha): array => [
                'nome' => $linha['nome'],
                'unidade' => $linha['unidade'],
                'filial' => $linha['filial'],
                'estoque' => round((float) $linha['quantidade'], 3),
                'media_diaria' => round((float) $linha['media_diaria'], 3),
                'dias_restantes' => round((float) $linha['dias_restantes'], 1),
            ], $linhas),
            'limite_dias' => $limiteDias,
            'dias_periodo' => $diasPeriodo,
        ];
    }

    /**
     * Vendas por operador: vendas concluídas, valor e quantas das vendas
     * dele no período foram canceladas.
     *
     * @param int[] $filiais
     * @return array<int,array<string,mixed>>
     */
    public function operadores(array $filiais, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        [$filtro, $params] = $this->filtroVendas('op', $filiais, $de, $ate, true);
        $linhas = $this->consultar(
            "SELECT v.id_usuario, COALESCE(u.nome, 'Usuário removido') AS nome,
                    SUM(v.status = 'concluida') AS num_vendas,
                    COALESCE(SUM(CASE WHEN v.status = 'concluida' THEN v.valor_total END), 0) AS valor,
                    SUM(v.status = 'cancelada') AS cancelamentos
               FROM vendas v
               LEFT JOIN usuarios u ON u.id_usuario = v.id_usuario
              WHERE {$filtro}
              GROUP BY v.id_usuario, u.nome
              ORDER BY valor DESC, nome ASC",
            $params
        )->fetchAll();

        return array_map(static fn (array $linha): array => [
            'nome' => $linha['nome'],
            'num_vendas' => (int) $linha['num_vendas'],
            'valor' => round((float) $linha['valor'], 2),
            'cancelamentos' => (int) $linha['cancelamentos'],
        ], $linhas);
    }

    /* ================= Ferramentas mantidas da tela anterior ================= */

    /**
     * Cancelamentos do período (pela data do cancelamento): totais e a lista
     * dos mais recentes, com quem operava e quem autorizou.
     *
     * @param int[] $filiais
     * @return array<string,mixed>
     */
    public function cancelamentos(array $filiais, \DateTimeImmutable $de, \DateTimeImmutable $ate, int $limite): array
    {
        $filtro = function (string $p) use ($filiais, $de, $ate): array {
            [$listaFiliais, $params] = $this->listaFiliais($p, $filiais, 'v.id_filial');
            $params[$p . '_de'] = $de->format('Y-m-d 00:00:00');
            $params[$p . '_fim'] = $ate->modify('+1 day')->format('Y-m-d 00:00:00');
            return [
                "{$listaFiliais} AND v.status = 'cancelada'
                 AND v.data_cancelamento >= :{$p}_de AND v.data_cancelamento < :{$p}_fim",
                $params,
            ];
        };

        [$sqlFiltro, $params] = $filtro('xt');
        $totais = $this->consultar(
            "SELECT COUNT(*) AS quantidade, COALESCE(SUM(v.valor_total), 0) AS valor
               FROM vendas v
              WHERE {$sqlFiltro}",
            $params
        )->fetch() ?: [];

        [$sqlFiltro, $params] = $filtro('xl');
        $params['limite'] = $limite;
        $linhas = $this->consultar(
            "SELECT v.numero_venda, f.nome AS filial, v.data_cancelamento, v.valor_total,
                    COALESCE(uo.nome, u.nome, 'Usuário removido') AS operador,
                    COALESCE(ua.nome, 'Não informado') AS autorizador,
                    v.motivo_cancelamento AS motivo
               FROM vendas v
               JOIN filiais f ON f.id_filial = v.id_filial
               LEFT JOIN usuarios u ON u.id_usuario = v.id_usuario
               LEFT JOIN usuarios uo ON uo.id_usuario = v.id_operador_cancelamento
               LEFT JOIN usuarios ua ON ua.id_usuario = v.id_autorizador_cancelamento
              WHERE {$sqlFiltro}
              ORDER BY v.data_cancelamento DESC, v.id_venda DESC
              LIMIT :limite",
            $params
        )->fetchAll();

        return [
            'quantidade' => (int) ($totais['quantidade'] ?? 0),
            'valor' => round((float) ($totais['valor'] ?? 0), 2),
            'limite' => $limite,
            'itens' => array_map(static fn (array $linha): array => [
                'numero_venda' => (int) $linha['numero_venda'],
                'filial' => $linha['filial'],
                'data_cancelamento' => $linha['data_cancelamento'],
                'valor' => round((float) $linha['valor_total'], 2),
                'operador' => $linha['operador'],
                'autorizador' => $linha['autorizador'],
                'motivo' => $linha['motivo'],
            ], $linhas),
        ];
    }

    /**
     * Lista de compras para imprimir: produtos que acabaram ou estão no
     * estoque mínimo ou abaixo dele. É a situação de agora, sem período.
     *
     * @param int[] $filiais
     * @return array<int,array<string,mixed>>
     */
    public function listaCompras(array $filiais): array
    {
        [$listaFiliais, $params] = $this->listaFiliais('lc', $filiais, 'p.id_filial');
        $linhas = $this->consultar(
            "SELECT p.nome, p.unidade, p.quantidade, p.estoque_minimo, f.nome AS filial,
                    GREATEST(p.estoque_minimo - p.quantidade, 0) AS falta
               FROM produtos p
               JOIN filiais f ON f.id_filial = p.id_filial
              WHERE {$listaFiliais}
                AND p.status = 'ativo'
                AND (p.quantidade <= 0 OR (p.estoque_minimo > 0 AND p.quantidade <= p.estoque_minimo))
              ORDER BY f.nome ASC, (p.quantidade <= 0) DESC, p.quantidade / NULLIF(p.estoque_minimo, 0) ASC, p.nome ASC",
            $params
        )->fetchAll();

        return array_map(static function (array $linha): array {
            $quantidade = (float) $linha['quantidade'];
            $minimo = (float) $linha['estoque_minimo'];
            return [
                'nome' => $linha['nome'],
                'unidade' => $linha['unidade'],
                'filial' => $linha['filial'],
                'estoque' => round($quantidade, 3),
                'estoque_minimo' => round($minimo, 3),
                'falta' => round((float) $linha['falta'], 3),
                'situacao' => $quantidade <= 0 ? 'Acabou' : ($quantidade < $minimo ? 'Abaixo do mínimo' : 'No mínimo'),
            ];
        }, $linhas);
    }

    /**
     * Relatório de validade para imprimir: produtos com estoque vencidos ou
     * que vencem nos próximos $diasAviso dias.
     *
     * @param int[] $filiais
     * @return array<int,array<string,mixed>>
     */
    public function validade(array $filiais, \DateTimeImmutable $hoje, int $diasAviso): array
    {
        [$listaFiliais, $params] = $this->listaFiliais('vl', $filiais, 'p.id_filial');
        $params['hoje'] = $hoje->format('Y-m-d');
        $params['limite_validade'] = $hoje->modify("+{$diasAviso} days")->format('Y-m-d');
        $linhas = $this->consultar(
            "SELECT p.nome, p.unidade, p.quantidade, p.validade, f.nome AS filial,
                    DATEDIFF(p.validade, :hoje) AS dias
               FROM produtos p
               JOIN filiais f ON f.id_filial = p.id_filial
              WHERE {$listaFiliais}
                AND p.status = 'ativo'
                AND p.quantidade > 0
                AND p.validade IS NOT NULL
                AND p.validade <= :limite_validade
              ORDER BY p.validade ASC, p.nome ASC",
            $params
        )->fetchAll();

        return array_map(static fn (array $linha): array => [
            'nome' => $linha['nome'],
            'unidade' => $linha['unidade'],
            'filial' => $linha['filial'],
            'estoque' => round((float) $linha['quantidade'], 3),
            'validade' => $linha['validade'],
            'dias' => (int) $linha['dias'],
        ], $linhas);
    }

    /* ================= Apoio ================= */

    /**
     * Filtro das vendas do relatório: filiais autorizadas, intervalo de
     * datas (data_fim inclusiva) e status. $prefixo diferencia os nomes dos
     * marcadores, porque a conexão usa prepares nativos (sem emulação), que
     * não aceitam o mesmo marcador nomeado duas vezes numa consulta.
     *
     * @param int[] $filiais
     * @return array{0:string,1:array<string,int|string>}
     */
    private function filtroVendas(
        string $prefixo,
        array $filiais,
        \DateTimeImmutable $de,
        \DateTimeImmutable $ate,
        bool $incluirCanceladas = false
    ): array {
        [$listaFiliais, $params] = $this->listaFiliais($prefixo, $filiais, 'v.id_filial');
        $params[$prefixo . '_de'] = $de->format('Y-m-d 00:00:00');
        $params[$prefixo . '_fim'] = $ate->modify('+1 day')->format('Y-m-d 00:00:00');
        $status = $incluirCanceladas
            ? "v.status IN ('concluida', 'cancelada')"
            : "v.status = 'concluida'";
        return [
            "{$listaFiliais} AND {$status}
             AND v.data_venda >= :{$prefixo}_de AND v.data_venda < :{$prefixo}_fim",
            $params,
        ];
    }

    /**
     * "coluna IN (:p_f0, :p_f1, ...)" com um marcador por filial.
     *
     * @param int[] $filiais
     * @return array{0:string,1:array<string,int>}
     */
    private function listaFiliais(string $prefixo, array $filiais, string $coluna): array
    {
        $marcadores = [];
        $params = [];
        foreach (array_values($filiais) as $indice => $idFilial) {
            $marcadores[] = ":{$prefixo}_f{$indice}";
            $params["{$prefixo}_f{$indice}"] = (int) $idFilial;
        }
        return [$coluna . ' IN (' . implode(', ', $marcadores) . ')', $params];
    }

    /**
     * Prepara e executa ligando cada valor com o tipo certo: LIMIT e OFFSET
     * precisam de inteiro de verdade (PDO::PARAM_INT), não de texto.
     *
     * @param array<string,int|string> $params
     */
    private function consultar(string $sql, array $params): \PDOStatement
    {
        $stmt = db()->prepare($sql);
        foreach ($params as $nome => $valor) {
            $stmt->bindValue(':' . $nome, $valor, is_int($valor) ? \PDO::PARAM_INT : \PDO::PARAM_STR);
        }
        $stmt->execute();
        return $stmt;
    }
}
