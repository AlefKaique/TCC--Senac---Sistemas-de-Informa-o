<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

final class RelatorioRepository
{
    public function __construct()
    {
        Migracoes::garantirRelatoriosReais();
    }

    /** @return array<string,mixed> */
    public function resumo(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $dias = (int) $de->diff($ate)->days + 1;
        $inicioAnterior = $de->modify("-{$dias} days");
        $fimAnterior = $de;
        $resumo = $this->resumoPeriodo($idFilial, $de, $ate->modify('+1 day'));
        $anterior = $this->resumoPeriodo($idFilial, $inicioAnterior, $fimAnterior);
        $hoje = new \DateTimeImmutable('today', new \DateTimeZone('America/Sao_Paulo'));
        $resumoHoje = $this->resumoPeriodo($idFilial, $hoje, $hoje->modify('+1 day'));
        $semanaPassada = $hoje->modify('-7 days');
        $resumoSemana = $this->resumoPeriodo($idFilial, $semanaPassada, $semanaPassada->modify('+1 day'));

        return [
            ...$resumo,
            'anterior' => $anterior,
            'hoje' => [
                'faturamento' => $resumoHoje['faturamento'],
                'num_vendas' => $resumoHoje['num_vendas'],
            ],
            'mesmo_dia_semana_passada' => [
                'faturamento' => $resumoSemana['faturamento'],
                'num_vendas' => $resumoSemana['num_vendas'],
            ],
        ];
    }

    /** @return array<string,mixed> */
    private function resumoPeriodo(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $fim): array
    {
        $stmt = db()->prepare(
            "SELECT COUNT(*) AS num_vendas,
                    COALESCE(SUM(v.valor_total), 0) AS faturamento,
                    COALESCE(SUM(v.desconto), 0) AS descontos,
                    COALESCE(SUM(c.custo), 0) AS custo,
                    COALESCE(SUM(c.itens_vendidos), 0) AS itens_vendidos,
                    COALESCE(SUM(c.faturamento_sem_custo), 0) AS faturamento_sem_custo,
                    COALESCE(SUM(c.venda_custo_estimado), 0) AS vendas_custo_estimado
               FROM vendas v
               LEFT JOIN (
                    SELECT iv.id_venda,
                           SUM(iv.quantidade * COALESCE(iv.custo_unitario, 0)) AS custo,
                           SUM(iv.quantidade) AS itens_vendidos,
                           SUM(CASE WHEN iv.custo_unitario IS NULL AND v.subtotal > 0
                                    THEN iv.quantidade * iv.preco_unitario * (v.valor_total / NULLIF(v.subtotal, 0))
                                    ELSE 0 END) AS faturamento_sem_custo,
                           MAX(iv.custo_estimado) AS venda_custo_estimado
                      FROM itens_venda iv
                      JOIN vendas v ON v.id_venda = iv.id_venda
                     GROUP BY iv.id_venda
               ) c ON c.id_venda = v.id_venda
              WHERE v.id_filial = :id_filial
                AND v.data_venda >= :de AND v.data_venda < :fim
                AND v.status = 'concluida'"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $fim->format('Y-m-d 00:00:00'),
        ]);
        $row = $stmt->fetch() ?: [];
        $stmt = db()->prepare(
            "SELECT COUNT(DISTINCT iv.id_produto)
               FROM itens_venda iv
               JOIN vendas v ON v.id_venda = iv.id_venda
              WHERE v.id_filial = :id_filial
                AND v.data_venda >= :de AND v.data_venda < :fim
                AND v.status = 'concluida' AND iv.custo_unitario IS NULL"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $fim->format('Y-m-d 00:00:00'),
        ]);
        $produtosSemCusto = (int) $stmt->fetchColumn();
        $faturamento = (float) ($row['faturamento'] ?? 0);
        $custo = (float) ($row['custo'] ?? 0);
        $numVendas = (int) ($row['num_vendas'] ?? 0);
        $lucro = $faturamento - $custo;
        return [
            'faturamento' => round($faturamento, 2),
            'lucro' => round($lucro, 2),
            'margem' => $faturamento > 0 ? round($lucro / $faturamento * 100, 2) : null,
            'num_vendas' => $numVendas,
            'ticket_medio' => $numVendas > 0 ? round($faturamento / $numVendas, 2) : null,
            'descontos' => round((float) ($row['descontos'] ?? 0), 2),
            'itens_vendidos' => round((float) ($row['itens_vendidos'] ?? 0), 3),
            'produtos_sem_custo' => [
                'quantidade' => $produtosSemCusto,
                'faturamento' => round((float) ($row['faturamento_sem_custo'] ?? 0), 2),
            ],
            'vendas_custo_estimado' => (int) ($row['vendas_custo_estimado'] ?? 0),
        ];
    }

    /** @return array{atual:array<int,array<string,mixed>>,anterior:array<int,array<string,mixed>>} */
    public function vendasPorDia(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $dias = (int) $de->diff($ate)->days + 1;
        $anteriorDe = $de->modify("-{$dias} days");
        return [
            'atual' => $this->serieDiaria($idFilial, $de, $ate->modify('+1 day')),
            'anterior' => $this->serieDiaria($idFilial, $anteriorDe, $de),
        ];
    }

    /** @return array<int,array<string,mixed>> */
    private function serieDiaria(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $fim): array
    {
        $stmt = db()->prepare(
            "SELECT DATE(v.data_venda) AS data, SUM(v.valor_total) AS faturamento,
                    SUM(v.valor_total - COALESCE(c.custo, 0)) AS lucro, COUNT(*) AS num_vendas
               FROM vendas v
               LEFT JOIN (
                    SELECT iv.id_venda, SUM(iv.quantidade * COALESCE(iv.custo_unitario, 0)) AS custo
                      FROM itens_venda iv GROUP BY iv.id_venda
               ) c ON c.id_venda = v.id_venda
              WHERE v.id_filial = :id_filial AND v.status = 'concluida'
                AND v.data_venda >= :de AND v.data_venda < :fim
              GROUP BY DATE(v.data_venda)"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $fim->format('Y-m-d 00:00:00'),
        ]);
        $porDia = [];
        foreach ($stmt->fetchAll() as $row) {
            $porDia[(string) $row['data']] = [
                'data' => (string) $row['data'],
                'faturamento' => round((float) $row['faturamento'], 2),
                'lucro' => round((float) $row['lucro'], 2),
                'num_vendas' => (int) $row['num_vendas'],
            ];
        }
        $serie = [];
        for ($dia = $de; $dia < $fim; $dia = $dia->modify('+1 day')) {
            $key = $dia->format('Y-m-d');
            $serie[] = $porDia[$key] ?? [
                'data' => $key,
                'faturamento' => 0.0,
                'lucro' => 0.0,
                'num_vendas' => 0,
            ];
        }
        return $serie;
    }

    /** @return array<int,array<string,mixed>> */
    public function pagamentos(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $stmt = db()->prepare(
            "SELECT p.forma_pagamento AS forma, SUM(p.valor) AS valor,
                    COUNT(DISTINCT v.id_venda) AS num_vendas
               FROM pagamentos p
               JOIN vendas v ON v.id_venda = p.id_venda
              WHERE v.id_filial = :id_filial AND v.status = 'concluida'
                AND v.data_venda >= :de AND v.data_venda < :fim
              GROUP BY p.forma_pagamento ORDER BY valor DESC"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $ate->modify('+1 day')->format('Y-m-d 00:00:00'),
        ]);
        $rows = $stmt->fetchAll();
        $total = array_sum(array_map(static fn ($row) => (float) $row['valor'], $rows));
        return array_map(static fn ($row) => [
            'forma' => $row['forma'],
            'valor' => round((float) $row['valor'], 2),
            'percentual' => $total > 0 ? round((float) $row['valor'] / $total * 100, 2) : 0.0,
            'num_vendas' => (int) $row['num_vendas'],
        ], $rows);
    }

    /** @return array{matriz:array<int,array<string,mixed>>,pico:?array<string,mixed>} */
    public function horarios(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $stmt = db()->prepare(
            "SELECT DAYOFWEEK(data_venda) - 1 AS dia_semana, HOUR(data_venda) AS hora,
                    COUNT(*) AS num_vendas, SUM(valor_total) AS faturamento
               FROM vendas
              WHERE id_filial = :id_filial AND status = 'concluida'
                AND data_venda >= :de AND data_venda < :fim
              GROUP BY DAYOFWEEK(data_venda), HOUR(data_venda)"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $ate->modify('+1 day')->format('Y-m-d 00:00:00'),
        ]);
        $contagemDias = array_fill(0, 7, 0);
        for ($dia = $de; $dia <= $ate; $dia = $dia->modify('+1 day')) {
            $contagemDias[(int) $dia->format('w')]++;
        }
        $linhas = [];
        $pico = null;
        foreach ($stmt->fetchAll() as $row) {
            $diaSemana = (int) $row['dia_semana'];
            $numDias = max(1, $contagemDias[$diaSemana]);
            $linha = [
                'dia_semana' => $diaSemana,
                'hora' => (int) $row['hora'],
                'num_vendas' => round((int) $row['num_vendas'] / $numDias, 2),
                'faturamento' => round((float) $row['faturamento'] / $numDias, 2),
            ];
            $linhas[] = $linha;
            if ($pico === null
                || $linha['num_vendas'] > $pico['num_vendas']
                || ($linha['num_vendas'] === $pico['num_vendas'] && $linha['faturamento'] > $pico['faturamento'])) {
                $pico = $linha;
            }
        }
        return ['matriz' => $linhas, 'pico' => $pico];
    }

    /** @return array<string,mixed> */
    public function produtos(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $stmt = db()->prepare(
            "SELECT p.id_produto, p.nome, p.unidade,
                    SUM(iv.quantidade) AS quantidade,
                    SUM(CASE WHEN v.subtotal > 0
                             THEN iv.quantidade * iv.preco_unitario * (v.valor_total / NULLIF(v.subtotal, 0))
                             ELSE 0 END) AS faturamento,
                    SUM(iv.quantidade * COALESCE(iv.custo_unitario, 0)) AS custo,
                    SUM(CASE WHEN iv.custo_unitario IS NULL THEN 1 ELSE 0 END) AS itens_sem_custo
               FROM itens_venda iv
               JOIN vendas v ON v.id_venda = iv.id_venda
               JOIN produtos p ON p.id_produto = iv.id_produto
              WHERE v.id_filial = :id_filial AND v.status = 'concluida'
                AND v.data_venda >= :de AND v.data_venda < :fim
              GROUP BY p.id_produto, p.nome, p.unidade"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $ate->modify('+1 day')->format('Y-m-d 00:00:00'),
        ]);
        $items = array_map(static function ($row): array {
            $faturamento = (float) $row['faturamento'];
            $lucro = $faturamento - (float) $row['custo'];
            return [
                'id_produto' => (int) $row['id_produto'],
                'nome' => $row['nome'],
                'unidade' => $row['unidade'],
                'quantidade' => round((float) $row['quantidade'], 3),
                'faturamento' => round($faturamento, 2),
                'lucro' => round($lucro, 2),
                'margem' => $faturamento > 0 ? round($lucro / $faturamento * 100, 2) : null,
                'sem_custo' => (int) $row['itens_sem_custo'] > 0,
            ];
        }, $stmt->fetchAll());
        $porFaturamento = $items;
        $porLucro = $items;
        $margemBaixa = array_values(array_filter($items, static fn ($item) => $item['margem'] !== null && $item['margem'] < 10));
        usort($porFaturamento, static fn ($a, $b) => $b['faturamento'] <=> $a['faturamento']);
        usort($porLucro, static fn ($a, $b) => $b['lucro'] <=> $a['lucro']);
        usort($margemBaixa, static fn ($a, $b) => $a['margem'] <=> $b['margem']);

        $totalFaturamento = array_sum(array_column($items, 'faturamento'));
        $acumulado = 0.0;
        $curva = [];
        $totais = ['A' => 0, 'B' => 0, 'C' => 0];
        foreach ($porFaturamento as $item) {
            $acumulado += $item['faturamento'];
            $percentual = $totalFaturamento > 0 ? $acumulado / $totalFaturamento : 0;
            $classe = $percentual <= 0.80 ? 'A' : ($percentual <= 0.95 ? 'B' : 'C');
            $totais[$classe]++;
            $curva[] = [...$item, 'classe' => $classe, 'percentual_acumulado' => round($percentual * 100, 2)];
        }
        return [
            'top_faturamento' => array_slice($porFaturamento, 0, 10),
            'top_lucro' => array_slice($porLucro, 0, 10),
            'menor_margem' => array_slice($margemBaixa, 0, 10),
            'curva_abc' => $curva,
            'totais_curva_abc' => $totais,
        ];
    }

    /** @return array<string,mixed> */
    public function estoque(int $idFilial): array
    {
        $hoje = new \DateTimeImmutable('today', new \DateTimeZone('America/Sao_Paulo'));
        $inicio = $hoje->modify('-29 days');
        $stmt = db()->prepare(
            "SELECT COUNT(CASE WHEN preco_custo IS NULL THEN 1 END) AS produtos_sem_custo,
                    COALESCE(SUM(quantidade * preco_custo), 0) AS valor_estoque_custo,
                    COALESCE(SUM(quantidade * preco_venda), 0) AS valor_estoque_venda
               FROM produtos WHERE id_filial = :id_filial AND status = 'ativo'"
        );
        $stmt->execute(['id_filial' => $idFilial]);
        $totais = $stmt->fetch() ?: [];

        $stmt = db()->prepare(
            "SELECT p.id_produto, p.nome, p.unidade, p.quantidade,
                    SUM(iv.quantidade) / 30 AS media_diaria,
                    CEIL(p.quantidade / (SUM(iv.quantidade) / 30)) AS dias_restantes
               FROM produtos p
               JOIN itens_venda iv ON iv.id_produto = p.id_produto
               JOIN vendas v ON v.id_venda = iv.id_venda
              WHERE p.id_filial = :id_filial AND p.status = 'ativo'
                AND p.quantidade > 0 AND v.status = 'concluida'
                AND v.data_venda >= :inicio AND v.data_venda < :fim
              GROUP BY p.id_produto, p.nome, p.unidade, p.quantidade
             HAVING SUM(iv.quantidade) > 0
                AND p.quantidade / (SUM(iv.quantidade) / 30) <= 7
              ORDER BY dias_restantes ASC, p.nome ASC"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'inicio' => $inicio->format('Y-m-d 00:00:00'),
            'fim' => $hoje->modify('+1 day')->format('Y-m-d 00:00:00'),
        ]);
        $ruptura = array_map(static function ($row) use ($hoje): array {
            $diasRestantes = max(1, (int) $row['dias_restantes']);
            return [
                'id_produto' => (int) $row['id_produto'],
                'nome' => $row['nome'],
                'unidade' => $row['unidade'],
                'quantidade' => round((float) $row['quantidade'], 3),
                'media_diaria' => round((float) $row['media_diaria'], 3),
                'dias_restantes' => $diasRestantes,
                'data_prevista' => $hoje->modify("+{$diasRestantes} days")->format('Y-m-d'),
            ];
        }, $stmt->fetchAll());

        $stmt = db()->prepare(
            "SELECT p.id_produto, p.nome, p.unidade, p.quantidade,
                    p.quantidade * p.preco_custo AS valor_parado_custo,
                    (SELECT MAX(v2.data_venda)
                       FROM itens_venda iv2 JOIN vendas v2 ON v2.id_venda = iv2.id_venda
                      WHERE iv2.id_produto = p.id_produto AND v2.status = 'concluida') AS ultima_venda
               FROM produtos p
              WHERE p.id_filial = :id_filial AND p.status = 'ativo' AND p.quantidade > 0
                AND NOT EXISTS (
                    SELECT 1 FROM itens_venda iv
                    JOIN vendas v ON v.id_venda = iv.id_venda
                    WHERE iv.id_produto = p.id_produto AND v.status = 'concluida'
                      AND v.data_venda >= :inicio AND v.data_venda < :fim
                )
              ORDER BY valor_parado_custo DESC, p.nome ASC"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'inicio' => $inicio->format('Y-m-d 00:00:00'),
            'fim' => $hoje->modify('+1 day')->format('Y-m-d 00:00:00'),
        ]);
        $parados = array_map(static fn ($row) => [
            'id_produto' => (int) $row['id_produto'],
            'nome' => $row['nome'],
            'unidade' => $row['unidade'],
            'quantidade' => round((float) $row['quantidade'], 3),
            'valor_parado_custo' => $row['valor_parado_custo'] === null ? null : round((float) $row['valor_parado_custo'], 2),
            'ultima_venda' => $row['ultima_venda'],
        ], $stmt->fetchAll());

        $stmt = db()->prepare(
            "SELECT id_produto, nome, categoria, unidade, quantidade, estoque_minimo, validade
               FROM produtos WHERE id_filial = :id_filial AND status = 'ativo'
              ORDER BY quantidade ASC, nome ASC"
        );
        $stmt->execute(['id_filial' => $idFilial]);
        $dataHoje = $hoje->format('Y-m-d');
        $alertasEstoque = [];
        $alertasValidade = [];
        foreach ($stmt->fetchAll() as $row) {
            $quantidade = (float) $row['quantidade'];
            $minimo = (float) $row['estoque_minimo'];
            $status = $quantidade <= 0 ? 'empty'
                : ($minimo <= 0 ? 'ok' : ($quantidade < $minimo / 2 ? 'critical' : ($quantidade < $minimo ? 'warning' : 'ok')));
            if ($status !== 'ok') {
                $alertasEstoque[] = [...$row, 'status' => $status];
            }
            if ($row['validade'] !== null) {
                $dias = (int) $hoje->diff(new \DateTimeImmutable((string) $row['validade']))->format('%r%a');
                if ($dias < 0 || $dias <= 30) {
                    $alertasValidade[] = [...$row, 'status' => $dias < 0 ? 'expired' : 'warning'];
                }
            }
        }
        usort($alertasValidade, static function ($a, $b): int {
            $ordem = ['expired' => 0, 'warning' => 1];
            return ($ordem[$a['status']] <=> $ordem[$b['status']])
                ?: strcmp((string) $a['validade'], (string) $b['validade']);
        });

        return [
            'valor_estoque_custo' => round((float) ($totais['valor_estoque_custo'] ?? 0), 2),
            'valor_estoque_venda' => round((float) ($totais['valor_estoque_venda'] ?? 0), 2),
            'produtos_sem_custo' => (int) ($totais['produtos_sem_custo'] ?? 0),
            'ruptura' => $ruptura,
            'parados' => $parados,
            'alertas_estoque' => $alertasEstoque,
            'alertas_validade' => $alertasValidade,
        ];
    }

    /** @return array<string,mixed> */
    public function cancelamentos(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $intervalo = 'v.data_cancelamento >= :de AND v.data_cancelamento < :fim';
        $params = [
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $ate->modify('+1 day')->format('Y-m-d 00:00:00'),
        ];
        $stmt = db()->prepare(
            "SELECT COUNT(*) AS quantidade, COALESCE(SUM(valor_total), 0) AS valor_total
               FROM vendas v WHERE v.id_filial = :id_filial AND v.status = 'cancelada' AND {$intervalo}"
        );
        $stmt->execute($params);
        $total = $stmt->fetch() ?: [];
        $stmt = db()->prepare(
            "SELECT COALESCE(SUM(valor_total), 0) FROM vendas
              WHERE id_filial = :id_filial AND status = 'concluida'
                AND data_venda >= :de AND data_venda < :fim"
        );
        $stmt->execute($params);
        $vendasConcluidas = (float) $stmt->fetchColumn();
        $valorCancelado = (float) ($total['valor_total'] ?? 0);
        $base = $vendasConcluidas + $valorCancelado;
        $agrupar = static function (string $campoId) use ($params, $intervalo): array {
            $stmt = db()->prepare(
                "SELECT COALESCE(u.nome, 'Usuário removido') AS nome,
                        COUNT(*) AS quantidade, SUM(v.valor_total) AS valor
                   FROM vendas v LEFT JOIN usuarios u ON u.id_usuario = v.{$campoId}
                  WHERE v.id_filial = :id_filial AND v.status = 'cancelada' AND {$intervalo}
                  GROUP BY v.{$campoId}, u.nome ORDER BY quantidade DESC, nome ASC"
            );
            $stmt->execute($params);
            return array_map(static fn ($row) => [
                'nome' => $row['nome'],
                'quantidade' => (int) $row['quantidade'],
                'valor' => round((float) $row['valor'], 2),
            ], $stmt->fetchAll());
        };
        $stmt = db()->prepare(
            "SELECT v.numero_venda, v.data_cancelamento AS data, v.valor_total AS valor,
                    COALESCE(uo.nome, u.nome, 'Usuário removido') AS operador,
                    COALESCE(ua.nome, 'Não informado') AS autorizador, v.motivo_cancelamento AS motivo
               FROM vendas v
               LEFT JOIN usuarios u ON u.id_usuario = v.id_usuario
               LEFT JOIN usuarios uo ON uo.id_usuario = v.id_operador_cancelamento
               LEFT JOIN usuarios ua ON ua.id_usuario = v.id_autorizador_cancelamento
              WHERE v.id_filial = :id_filial AND v.status = 'cancelada' AND {$intervalo}
              ORDER BY v.data_cancelamento DESC, v.id_venda DESC LIMIT 20"
        );
        $stmt->execute($params);
        $ultimos = array_map(static fn ($row) => [
            'numero_venda' => (int) $row['numero_venda'],
            'data' => $row['data'],
            'valor' => round((float) $row['valor'], 2),
            'operador' => $row['operador'],
            'autorizador' => $row['autorizador'],
            'motivo' => $row['motivo'],
        ], $stmt->fetchAll());
        return [
            'quantidade' => (int) ($total['quantidade'] ?? 0),
            'valor_total' => round($valorCancelado, 2),
            'percentual_sobre_vendas' => $base > 0 ? round($valorCancelado / $base * 100, 2) : 0.0,
            'por_operador' => $agrupar('id_operador_cancelamento'),
            'por_autorizador' => $agrupar('id_autorizador_cancelamento'),
            'ultimos' => $ultimos,
        ];
    }

    /** @return array<int,array<string,mixed>> */
    public function operadores(int $idFilial, \DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $stmt = db()->prepare(
            "SELECT u.id_usuario, u.nome, COUNT(*) AS num_vendas, SUM(v.valor_total) AS faturamento
               FROM vendas v JOIN usuarios u ON u.id_usuario = v.id_usuario
              WHERE v.id_filial = :id_filial AND v.status = 'concluida'
                AND v.data_venda >= :de AND v.data_venda < :fim
              GROUP BY u.id_usuario, u.nome ORDER BY faturamento DESC"
        );
        $params = [
            'id_filial' => $idFilial,
            'de' => $de->format('Y-m-d 00:00:00'),
            'fim' => $ate->modify('+1 day')->format('Y-m-d 00:00:00'),
        ];
        $stmt->execute($params);
        $linhas = $stmt->fetchAll();
        $cancelamentos = db()->prepare(
            "SELECT id_operador_cancelamento AS id_usuario, COUNT(*) AS quantidade
               FROM vendas
              WHERE id_filial = :id_filial AND status = 'cancelada'
                AND data_cancelamento >= :de AND data_cancelamento < :fim
              GROUP BY id_operador_cancelamento"
        );
        $cancelamentos->execute($params);
        $porUsuario = [];
        foreach ($cancelamentos->fetchAll() as $linha) {
            if ($linha['id_usuario'] !== null) {
                $porUsuario[(int) $linha['id_usuario']] = (int) $linha['quantidade'];
            }
        }
        return array_map(static function ($row) use ($porUsuario): array {
            $numVendas = (int) $row['num_vendas'];
            $faturamento = (float) $row['faturamento'];
            return [
                'nome' => $row['nome'],
                'num_vendas' => $numVendas,
                'faturamento' => round($faturamento, 2),
                'ticket_medio' => $numVendas > 0 ? round($faturamento / $numVendas, 2) : null,
                'cancelamentos' => $porUsuario[(int) $row['id_usuario']] ?? 0,
            ];
        }, $linhas);
    }
}
