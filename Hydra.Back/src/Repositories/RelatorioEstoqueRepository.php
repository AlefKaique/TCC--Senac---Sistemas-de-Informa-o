<?php

namespace Hydra\Repositories;

use Hydra\Controllers\DocumentoEstoqueController;

/**
 * Consultas da tela Relatório (pages/dashboard.html): o relatório de
 * estoque, focado no produto e sem valores em dinheiro.
 *
 *   - resumo()         cartões do topo: entradas e saídas do período;
 *   - porProduto()     quanto entrou, quanto foi vendido e quanto saiu por
 *                      outros motivos, produto a produto, no período;
 *   - movimentacoes()  cada entrada e saída do período, com o motivo;
 *   - emFalta()        produtos que acabaram ou estão no mínimo (agora);
 *   - vencendo()       lotes vencidos ou que vencem em até N dias (agora).
 *
 * Tudo é SEMPRE de uma filial só (a da sessão), com os filtros opcionais
 * de produto (nome ou código) e de categoria aplicados a todas as partes.
 */
final class RelatorioEstoqueRepository
{
    private const EPSILON = 0.0005;

    private int $idLoja;
    private int $idFilial;
    private string $busca;
    private string $categoria;

    public function __construct(int $idLoja, int $idFilial, string $busca = '', string $categoria = '')
    {
        $this->idLoja = $idLoja;
        $this->idFilial = $idFilial;
        $this->busca = $busca;
        $this->categoria = $categoria;
    }

    /** @return string[] categorias dos produtos ativos da filial, para o filtro da tela */
    public function categorias(): array
    {
        $stmt = $this->consultar(
            "SELECT DISTINCT p.categoria
               FROM produtos p
              WHERE p.id_loja = :ct_loja AND p.id_filial = :ct_filial AND p.status = 'ativo'
              ORDER BY p.categoria ASC",
            ['ct_loja' => $this->idLoja, 'ct_filial' => $this->idFilial]
        );
        return array_map('strval', $stmt->fetchAll(\PDO::FETCH_COLUMN));
    }

    /**
     * Números dos cartões de entradas e saídas do período.
     *
     * @return array{entradas:array{registros:int,produtos:int},saidas:array{registros:int,produtos:int,por_venda:int}}
     */
    public function resumo(\DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        [$filtro, $params] = $this->filtroMovimentacoes('rs', $de, $ate);
        $linha = $this->consultar(
            "SELECT COALESCE(SUM(m.tipo = 'entrada'), 0) AS entradas,
                    COUNT(DISTINCT CASE WHEN m.tipo = 'entrada' THEN m.id_produto END) AS produtos_entrada,
                    COALESCE(SUM(m.tipo = 'saida'), 0) AS saidas,
                    COUNT(DISTINCT CASE WHEN m.tipo = 'saida' THEN m.id_produto END) AS produtos_saida,
                    COALESCE(SUM(m.tipo = 'saida' AND m.origem = 'venda'), 0) AS saidas_venda
               FROM movimentacoes_estoque m
               JOIN produtos p ON p.id_produto = m.id_produto
              WHERE {$filtro}",
            $params
        )->fetch() ?: [];

        return [
            'entradas' => [
                'registros' => (int) ($linha['entradas'] ?? 0),
                'produtos' => (int) ($linha['produtos_entrada'] ?? 0),
            ],
            'saidas' => [
                'registros' => (int) ($linha['saidas'] ?? 0),
                'produtos' => (int) ($linha['produtos_saida'] ?? 0),
                'por_venda' => (int) ($linha['saidas_venda'] ?? 0),
            ],
        ];
    }

    /**
     * Entradas e saídas do período, produto a produto (só os produtos que
     * tiveram alguma movimentação). "Vendido" já desconta as vendas
     * canceladas, que devolvem o produto ao estoque; por isso o
     * cancelamento não conta como entrada.
     *
     * @return array<int,array<string,mixed>>
     */
    public function porProduto(\DateTimeImmutable $de, \DateTimeImmutable $ate, int $limite): array
    {
        [$filtro, $params] = $this->filtroMovimentacoes('pp', $de, $ate);
        $params['pp_limite'] = $limite;
        $linhas = $this->consultar(
            "SELECT p.id_produto, p.nome, p.categoria, p.unidade, p.quantidade, p.estoque_minimo, p.status,
                    SUM(CASE WHEN m.tipo = 'entrada' AND m.origem <> 'cancelamento_venda' THEN m.quantidade ELSE 0 END) AS entradas,
                    SUM(CASE WHEN m.tipo = 'saida' AND m.origem = 'venda' THEN m.quantidade ELSE 0 END)
                      - SUM(CASE WHEN m.tipo = 'entrada' AND m.origem = 'cancelamento_venda' THEN m.quantidade ELSE 0 END) AS vendido,
                    SUM(CASE WHEN m.tipo = 'saida' AND m.origem <> 'venda' THEN m.quantidade ELSE 0 END) AS outras_saidas,
                    COUNT(*) AS movimentacoes
               FROM movimentacoes_estoque m
               JOIN produtos p ON p.id_produto = m.id_produto
              WHERE {$filtro}
              GROUP BY p.id_produto
              ORDER BY p.nome ASC
              LIMIT :pp_limite",
            $params
        )->fetchAll();

        return array_map(fn (array $linha): array => [
            'id_produto' => (int) $linha['id_produto'],
            'nome' => $linha['nome'],
            'categoria' => $linha['categoria'],
            'unidade' => $linha['unidade'],
            'entradas' => round((float) $linha['entradas'], 3),
            'vendido' => round((float) $linha['vendido'], 3),
            'outras_saidas' => round((float) $linha['outras_saidas'], 3),
            'movimentacoes' => (int) $linha['movimentacoes'],
            'estoque' => round((float) $linha['quantidade'], 3),
            'estoque_minimo' => round((float) $linha['estoque_minimo'], 3),
            'situacao_estoque' => $linha['status'] === 'ativo'
                ? $this->situacaoEstoque((float) $linha['quantidade'], (float) $linha['estoque_minimo'])
                : 'inativo',
        ], $linhas);
    }

    /**
     * Cada entrada e saída do período, da mais recente para a mais antiga,
     * com o motivo em texto (venda nº, documento de entrada, perda...).
     *
     * @param string $tipo 'todas', 'entrada' ou 'saida'
     * @return array{itens:array<int,array<string,mixed>>,total:int}
     */
    public function movimentacoes(
        \DateTimeImmutable $de,
        \DateTimeImmutable $ate,
        string $tipo,
        int $limite,
        int $deslocamento
    ): array {
        [$filtro, $params] = $this->filtroMovimentacoes('mv', $de, $ate);
        if ($tipo === 'entrada' || $tipo === 'saida') {
            $filtro .= ' AND m.tipo = :mv_tipo';
            $params['mv_tipo'] = $tipo;
        }

        $total = (int) $this->consultar(
            "SELECT COUNT(*) FROM movimentacoes_estoque m
               JOIN produtos p ON p.id_produto = m.id_produto
              WHERE {$filtro}",
            $params
        )->fetchColumn();

        $params['mv_limite'] = $limite;
        $params['mv_deslocamento'] = $deslocamento;
        $linhas = $this->consultar(
            "SELECT m.id_movimentacao, m.data_movimentacao, m.tipo, m.quantidade, m.origem,
                    p.nome, p.categoria, p.unidade,
                    u.nome AS responsavel,
                    v.numero_venda,
                    d.numero AS documento, d.subtipo, d.nota_fiscal, d.fornecedor,
                    l.codigo AS lote
               FROM movimentacoes_estoque m
               JOIN produtos p ON p.id_produto = m.id_produto
               LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario
               LEFT JOIN vendas v ON v.id_venda = m.id_venda
               LEFT JOIN documentos_estoque d ON d.id_documento = m.id_documento
               LEFT JOIN lotes l ON l.id_lote = m.id_lote
              WHERE {$filtro}
              ORDER BY m.data_movimentacao DESC, m.id_movimentacao DESC
              LIMIT :mv_limite OFFSET :mv_deslocamento",
            $params
        )->fetchAll();

        return [
            'itens' => array_map(fn (array $linha): array => [
                'data' => $linha['data_movimentacao'],
                'tipo' => $linha['tipo'],
                'quantidade' => round((float) $linha['quantidade'], 3),
                'unidade' => $linha['unidade'],
                'produto' => $linha['nome'],
                'categoria' => $linha['categoria'],
                'motivo' => $this->motivo($linha),
                'detalhe' => $this->detalhe($linha),
                'responsavel' => $linha['responsavel'],
            ], $linhas),
            'total' => $total,
        ];
    }

    /**
     * Produtos ativos que acabaram ou estão no estoque mínimo ou abaixo
     * dele. É a situação de agora, sem período.
     *
     * @return array<int,array<string,mixed>>
     */
    public function emFalta(): array
    {
        [$filtro, $params] = $this->filtroProdutos('ef');
        $linhas = $this->consultar(
            "SELECT p.nome, p.categoria, p.unidade, p.quantidade, p.estoque_minimo,
                    (SELECT MAX(me.data_movimentacao)
                       FROM movimentacoes_estoque me
                      WHERE me.id_produto = p.id_produto AND me.tipo = 'entrada'
                        AND me.origem <> 'cancelamento_venda') AS ultima_entrada
               FROM produtos p
              WHERE {$filtro}
                AND p.status = 'ativo'
                AND (p.quantidade <= 0 OR (p.estoque_minimo > 0 AND p.quantidade <= p.estoque_minimo))
              ORDER BY (p.quantidade <= 0) DESC, p.quantidade / NULLIF(p.estoque_minimo, 0) ASC, p.nome ASC",
            $params
        )->fetchAll();

        return array_map(function (array $linha): array {
            $quantidade = (float) $linha['quantidade'];
            $minimo = (float) $linha['estoque_minimo'];
            return [
                'nome' => $linha['nome'],
                'categoria' => $linha['categoria'],
                'unidade' => $linha['unidade'],
                'estoque' => round($quantidade, 3),
                'estoque_minimo' => round($minimo, 3),
                'falta' => round(max($minimo - $quantidade, 0), 3),
                'situacao' => $this->situacaoEstoque($quantidade, $minimo),
                'ultima_entrada' => $linha['ultima_entrada'],
            ];
        }, $linhas);
    }

    /**
     * Lotes com saldo vencidos ou que vencem até $hoje + $dias.
     *
     * O saldo de cada lote é calculado aqui, sem gravar nada: a venda baixa
     * só produtos.quantidade, e os lotes só são acertados na próxima
     * operação de lote (LoteRepository::sincronizar). Para o relatório não
     * mostrar um lote que já foi vendido, a diferença é aplicada do mesmo
     * jeito que sincronizar() faria: falta sai dos lotes que vencem primeiro
     * (FEFO); sobra entra no lote do cadastro do produto.
     *
     * @return array<int,array<string,mixed>>
     */
    public function vencendo(\DateTimeImmutable $hoje, int $dias): array
    {
        [$filtro, $params] = $this->filtroProdutos('vc');
        $limite = $hoje->modify("+{$dias} days")->format('Y-m-d');
        $params['vc_limite'] = $limite;
        $params['vc_limite_lote'] = $limite;
        $linhas = $this->consultar(
            "SELECT p.id_produto, p.nome, p.categoria, p.unidade, p.quantidade, p.lote, p.validade,
                    l.id_lote, l.codigo AS lote_codigo, l.validade AS lote_validade, l.quantidade AS lote_quantidade
               FROM produtos p
               LEFT JOIN lotes l ON l.id_produto = p.id_produto AND l.quantidade > 0
              WHERE {$filtro}
                AND p.status = 'ativo'
                AND p.quantidade > 0
                AND (p.validade <= :vc_limite
                     OR EXISTS (SELECT 1 FROM lotes lv
                                 WHERE lv.id_produto = p.id_produto AND lv.quantidade > 0
                                   AND lv.validade <= :vc_limite_lote))
              ORDER BY p.id_produto ASC, l.validade IS NULL, l.validade ASC, l.id_lote ASC",
            $params
        )->fetchAll();

        $produtos = [];
        foreach ($linhas as $linha) {
            $id = (int) $linha['id_produto'];
            if (!isset($produtos[$id])) {
                $produtos[$id] = ['produto' => $linha, 'lotes' => []];
            }
            if ($linha['id_lote'] !== null) {
                $produtos[$id]['lotes'][] = [
                    'codigo' => (string) $linha['lote_codigo'],
                    'validade' => $linha['lote_validade'],
                    'saldo' => (float) $linha['lote_quantidade'],
                ];
            }
        }

        $resultado = [];
        foreach ($produtos as $id => $grupo) {
            $produto = $grupo['produto'];
            foreach ($this->saldoDosLotes($produto, $grupo['lotes']) as $lote) {
                if ($lote['saldo'] <= self::EPSILON || $lote['validade'] === null || $lote['validade'] > $limite) {
                    continue;
                }
                $validade = new \DateTimeImmutable($lote['validade'], $hoje->getTimezone());
                $resultado[] = [
                    'id_produto' => $id,
                    'nome' => $produto['nome'],
                    'categoria' => $produto['categoria'],
                    'unidade' => $produto['unidade'],
                    'lote' => $lote['codigo'],
                    'quantidade' => round($lote['saldo'], 3),
                    'validade' => $lote['validade'],
                    'dias' => (int) $hoje->diff($validade)->format('%r%a'),
                ];
            }
        }

        usort($resultado, static fn (array $a, array $b): int => [$a['validade'], $a['nome']] <=> [$b['validade'], $b['nome']]);
        return $resultado;
    }

    /* ================= Apoio ================= */

    /**
     * Saldo de cada lote depois de aplicar a diferença entre
     * produtos.quantidade e a soma dos lotes (ver vencendo()).
     *
     * @param array<string,mixed> $produto
     * @param array<int,array{codigo:string,validade:?string,saldo:float}> $lotes em ordem FEFO
     * @return array<int,array{codigo:string,validade:?string,saldo:float}>
     */
    private function saldoDosLotes(array $produto, array $lotes): array
    {
        $soma = array_sum(array_column($lotes, 'saldo'));
        $diferenca = round((float) $produto['quantidade'] - $soma, 3);

        if ($diferenca < -self::EPSILON) {
            $falta = -$diferenca;
            foreach ($lotes as &$lote) {
                if ($falta <= self::EPSILON) {
                    break;
                }
                $tira = min($falta, $lote['saldo']);
                $lote['saldo'] = round($lote['saldo'] - $tira, 3);
                $falta = round($falta - $tira, 3);
            }
            unset($lote);
        } elseif ($diferenca > self::EPSILON) {
            $codigo = trim((string) ($produto['lote'] ?? '')) !== '' ? trim((string) $produto['lote']) : 'SEM-LOTE';
            $achou = false;
            foreach ($lotes as &$lote) {
                if (strcasecmp($lote['codigo'], $codigo) === 0) {
                    $lote['saldo'] = round($lote['saldo'] + $diferenca, 3);
                    $achou = true;
                    break;
                }
            }
            unset($lote);
            if (!$achou) {
                $lotes[] = ['codigo' => $codigo, 'validade' => $produto['validade'] ?: null, 'saldo' => $diferenca];
            }
        }
        return $lotes;
    }

    private function situacaoEstoque(float $quantidade, float $minimo): string
    {
        if ($quantidade <= self::EPSILON) {
            return 'acabou';
        }
        if ($minimo > 0 && $quantidade < $minimo) {
            return 'abaixo';
        }
        if ($minimo > 0 && $quantidade <= $minimo + self::EPSILON) {
            return 'no_minimo';
        }
        return 'ok';
    }

    /** Motivo da movimentação em texto, do jeito que aparece na tela e no PDF. */
    private function motivo(array $linha): string
    {
        $entrada = $linha['tipo'] === 'entrada';
        return match ($linha['origem']) {
            'cadastro' => 'Estoque inicial (cadastro do produto)',
            'ajuste_manual' => $entrada ? 'Ajuste manual (entrada)' : 'Ajuste manual (saída)',
            'venda' => $linha['numero_venda'] !== null ? 'Venda nº ' . $linha['numero_venda'] : 'Venda',
            'cancelamento_venda' => ($linha['numero_venda'] !== null ? 'Venda nº ' . $linha['numero_venda'] : 'Venda')
                . ' cancelada (voltou ao estoque)',
            'estorno' => 'Estorno de documento',
            'documento' => $entrada
                ? (DocumentoEstoqueController::TIPOS_ENTRADA[$linha['subtipo']] ?? 'Entrada de estoque')
                : (DocumentoEstoqueController::MOTIVOS_SAIDA[$linha['subtipo']] ?? 'Saída de estoque'),
            default => $entrada ? 'Entrada' : 'Saída',
        };
    }

    /** Documento, nota fiscal, fornecedor e lote, quando existem. */
    private function detalhe(array $linha): string
    {
        $partes = [];
        if ($linha['documento'] !== null) {
            $partes[] = 'Doc. ' . $linha['documento'];
        }
        if ($linha['nota_fiscal'] !== null && $linha['nota_fiscal'] !== '') {
            $partes[] = 'NF ' . $linha['nota_fiscal'];
        }
        if ($linha['fornecedor'] !== null && $linha['fornecedor'] !== '') {
            $partes[] = $linha['fornecedor'];
        }
        if ($linha['lote'] !== null && $linha['lote'] !== '' && $linha['lote'] !== 'SEM-LOTE') {
            $partes[] = 'Lote ' . $linha['lote'];
        }
        return implode(' · ', $partes);
    }

    /**
     * Filial da sessão + filtros de produto e categoria. $prefixo separa os
     * nomes dos marcadores: a conexão usa prepares nativos, que não aceitam
     * o mesmo marcador nomeado duas vezes na mesma consulta.
     *
     * @return array{0:string,1:array<string,int|string>}
     */
    private function filtroProdutos(string $prefixo): array
    {
        $sql = "p.id_loja = :{$prefixo}_loja AND p.id_filial = :{$prefixo}_filial";
        $params = ["{$prefixo}_loja" => $this->idLoja, "{$prefixo}_filial" => $this->idFilial];

        if ($this->busca !== '') {
            // % e _ digitados pelo usuário valem como texto, não como curinga.
            // O escape é declarado ("!") para não depender do modo do MySQL
            // (NO_BACKSLASH_ESCAPES muda o significado da barra invertida).
            $texto = str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $this->busca);
            $sql .= " AND (p.nome LIKE :{$prefixo}_nome ESCAPE '!' OR p.codigo_barras LIKE :{$prefixo}_barras ESCAPE '!'"
                . " OR p.plu = :{$prefixo}_plu OR CAST(p.codigo AS CHAR) = :{$prefixo}_codigo)";
            $params["{$prefixo}_nome"] = '%' . $texto . '%';
            $params["{$prefixo}_barras"] = $texto . '%';
            $params["{$prefixo}_plu"] = $this->busca;
            $params["{$prefixo}_codigo"] = $this->busca;
        }
        if ($this->categoria !== '') {
            $sql .= " AND p.categoria = :{$prefixo}_categoria";
            $params["{$prefixo}_categoria"] = $this->categoria;
        }
        return [$sql, $params];
    }

    /**
     * filtroProdutos() + movimentações da mesma filial no período
     * (data final inclusiva).
     *
     * @return array{0:string,1:array<string,int|string>}
     */
    private function filtroMovimentacoes(string $prefixo, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        [$sql, $params] = $this->filtroProdutos($prefixo);
        $sql .= " AND m.id_loja = :{$prefixo}_mloja AND m.id_filial = :{$prefixo}_mfilial"
            . " AND m.data_movimentacao >= :{$prefixo}_de AND m.data_movimentacao < :{$prefixo}_fim";
        $params["{$prefixo}_mloja"] = $this->idLoja;
        $params["{$prefixo}_mfilial"] = $this->idFilial;
        $params["{$prefixo}_de"] = $de->format('Y-m-d 00:00:00');
        $params["{$prefixo}_fim"] = $ate->modify('+1 day')->format('Y-m-d 00:00:00');
        return [$sql, $params];
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
