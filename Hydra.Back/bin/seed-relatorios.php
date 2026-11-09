<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "Este script só pode ser executado pelo CLI.\n");
    exit(1);
}

$appRoot = dirname(__DIR__);
spl_autoload_register(static function (string $class) use ($appRoot): void {
    $prefix = 'Hydra\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $file = $appRoot . DIRECTORY_SEPARATOR . 'src' . DIRECTORY_SEPARATOR
        . str_replace('\\', DIRECTORY_SEPARATOR, $relative) . '.php';
    if (is_file($file)) {
        require $file;
    }
});
require $appRoot . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'database.php';

function falhar(string $mensagem): void
{
    fwrite(STDERR, $mensagem . PHP_EOL);
    exit(1);
}

function proximo(string $nome, array $antes, array $depois, float $esperado, float $tolerancia = 0.011): void
{
    $diferenca = (float) ($depois[$nome] ?? 0) - (float) ($antes[$nome] ?? 0);
    if (abs($diferenca - $esperado) > $tolerancia) {
        throw new RuntimeException(sprintf(
            'Validação de %s falhou: incremento esperado %.3f, obtido %.3f.',
            $nome,
            $esperado,
            $diferenca
        ));
    }
}

if (\Hydra\Support\Env::get('APP_ENV', 'production') !== 'local') {
    falhar('Bloqueado: APP_ENV precisa ser "local". Nenhuma alteração foi feita.');
}
$hostBanco = strtolower(trim((string) \Hydra\Support\Env::get('DB_HOST', '127.0.0.1'), '[]'));
if (!in_array($hostBanco, ['localhost', '127.0.0.1', '::1'], true)) {
    falhar('Bloqueado: o validador só pode usar um MySQL local (localhost/loopback). Nenhuma alteração foi feita.');
}
$nomeBanco = strtolower((string) \Hydra\Support\Env::get('DB_NAME', 'hydra_db'));
if (preg_match('/(^|[_-])(prod|production|live)([_-]|$)/', $nomeBanco)) {
    falhar('Bloqueado: o nome do banco indica produção. Nenhuma alteração foi feita.');
}

$idFilial = null;
foreach ($argv as $argumento) {
    if (preg_match('/^--id-filial=(\d+)$/', $argumento, $matches)) {
        $idFilial = (int) $matches[1];
    }
}
if ($idFilial === null || $idFilial < 1 || !in_array('--confirm-test-data', $argv, true)) {
    falhar("Uso: APP_ENV=local php bin/seed-relatorios.php --id-filial=ID --confirm-test-data\nOs registros de teste são sempre revertidos ao final.");
}

try {
    \Hydra\Support\Migracoes::garantirRelatoriosReais();
    $pdo = db();
    $stmt = $pdo->prepare(
        'SELECT f.id_loja, u.id_usuario, u.nome AS nome_usuario, p.id_produto
           FROM filiais f
           JOIN usuarios u ON u.id_loja = f.id_loja AND u.status = \'ativo\'
           JOIN produtos p ON p.id_filial = f.id_filial AND p.status = \'ativo\'
          WHERE f.id_filial = :id_filial
          ORDER BY u.id_usuario, p.id_produto LIMIT 1'
    );
    $stmt->execute(['id_filial' => $idFilial]);
    $fixture = $stmt->fetch();
    if (!$fixture) {
        falhar('Filial inválida ou sem usuário e produto ativos. Nenhuma venda de teste foi criada.');
    }

    $idLoja = (int) $fixture['id_loja'];
    $idUsuario = (int) $fixture['id_usuario'];
    $idProduto = (int) $fixture['id_produto'];
    $nomeUsuario = (string) $fixture['nome_usuario'];
    $inicio = new DateTimeImmutable('2000-01-01', new DateTimeZone('America/Sao_Paulo'));
    $fim = $inicio;
    $repo = new \Hydra\Repositories\RelatorioRepository();

    $pdo->beginTransaction();
    try {
        $antes = [
            'resumo' => $repo->resumo($idFilial, $inicio, $fim),
            'diario' => $repo->vendasPorDia($idFilial, $inicio, $fim),
            'pagamentos' => $repo->pagamentos($idFilial, $inicio, $fim),
            'horarios' => $repo->horarios($idFilial, $inicio, $fim),
            'produtos' => $repo->produtos($idFilial, $inicio, $fim),
            'cancelamentos' => $repo->cancelamentos($idFilial, $inicio, $fim),
            'operadores' => $repo->operadores($idFilial, $inicio, $fim),
        ];

        $stmt = $pdo->prepare(
            'SELECT numero_venda FROM vendas
              WHERE id_filial = :id_filial
              ORDER BY numero_venda DESC LIMIT 1 FOR UPDATE'
        );
        $stmt->execute(['id_filial' => $idFilial]);
        $numero = (int) ($stmt->fetchColumn() ?: 0);
        $insertVenda = $pdo->prepare(
            'INSERT INTO vendas
                (id_loja, id_filial, numero_venda, id_usuario, subtotal, desconto, valor_total, data_venda, status)
             VALUES
                (:id_loja, :id_filial, :numero, :id_usuario, :subtotal, 0, :total, :data, :status)'
        );
        $insertItem = $pdo->prepare(
            'INSERT INTO itens_venda
                (id_venda, id_produto, quantidade, preco_unitario, custo_unitario, custo_estimado)
             VALUES (:id_venda, :id_produto, :quantidade, 10, 4, 0)'
        );
        $insertPagamento = $pdo->prepare(
            'INSERT INTO pagamentos (id_venda, forma_pagamento, valor) VALUES (:id_venda, \'dinheiro\', :valor)'
        );
        $dataVenda = $inicio->format('Y-m-d') . ' 10:00:00';
        foreach ([[2.0, 20.0, 'concluida'], [1.0, 10.0, 'concluida'], [0.5, 5.0, 'cancelada']] as $index => [$quantidade, $valor, $status]) {
            $insertVenda->execute([
                'id_loja' => $idLoja,
                'id_filial' => $idFilial,
                'numero' => $numero + $index + 1,
                'id_usuario' => $idUsuario,
                'subtotal' => $valor,
                'total' => $valor,
                'data' => $dataVenda,
                'status' => $status,
            ]);
            $idVenda = (int) $pdo->lastInsertId();
            $insertItem->execute([
                'id_venda' => $idVenda,
                'id_produto' => $idProduto,
                'quantidade' => $quantidade,
            ]);
            if ($status === 'concluida') {
                $insertPagamento->execute(['id_venda' => $idVenda, 'valor' => $valor]);
            } else {
                $pdo->prepare(
                    "UPDATE vendas
                        SET data_cancelamento = :data, motivo_cancelamento = 'Seed de validação local',
                            id_operador_cancelamento = :id_operador, id_autorizador_cancelamento = :id_autorizador
                      WHERE id_venda = :id_venda"
                )->execute([
                    'data' => $dataVenda,
                    'id_operador' => $idUsuario,
                    'id_autorizador' => $idUsuario,
                    'id_venda' => $idVenda,
                ]);
            }
        }

        $depois = [
            'resumo' => $repo->resumo($idFilial, $inicio, $fim),
            'diario' => $repo->vendasPorDia($idFilial, $inicio, $fim),
            'pagamentos' => $repo->pagamentos($idFilial, $inicio, $fim),
            'horarios' => $repo->horarios($idFilial, $inicio, $fim),
            'produtos' => $repo->produtos($idFilial, $inicio, $fim),
            'cancelamentos' => $repo->cancelamentos($idFilial, $inicio, $fim),
            'operadores' => $repo->operadores($idFilial, $inicio, $fim),
        ];

        proximo('faturamento', $antes['resumo'], $depois['resumo'], 30);
        proximo('lucro', $antes['resumo'], $depois['resumo'], 18);
        proximo('num_vendas', $antes['resumo'], $depois['resumo'], 2, 0);
        $ticketAnterior = (float) ($antes['resumo']['ticket_medio'] ?? 0);
        $ticketEsperado = ((float) $antes['resumo']['faturamento'] + 30)
            / ((int) $antes['resumo']['num_vendas'] + 2) - $ticketAnterior;
        proximo('ticket_medio', $antes['resumo'], $depois['resumo'], $ticketEsperado);
        $diarioAntes = array_column($antes['diario']['atual'], 'faturamento', 'data');
        $diarioDepois = array_column($depois['diario']['atual'], 'faturamento', 'data');
        proximo('faturamento', ['faturamento' => $diarioAntes['2000-01-01'] ?? 0], ['faturamento' => $diarioDepois['2000-01-01'] ?? 0], 30);
        $dinheiroAntes = array_column($antes['pagamentos'], 'valor', 'forma');
        $dinheiroDepois = array_column($depois['pagamentos'], 'valor', 'forma');
        proximo('dinheiro', $dinheiroAntes, $dinheiroDepois, 30);
        proximo('quantidade', $antes['cancelamentos'], $depois['cancelamentos'], 1, 0);
        proximo('valor_total', $antes['cancelamentos'], $depois['cancelamentos'], 5);
        $canceladoAntes = (float) $antes['cancelamentos']['valor_total'];
        $concluidoAntes = (float) $antes['resumo']['faturamento'];
        $percentualEsperado = ($canceladoAntes + 5) / ($concluidoAntes + 30 + $canceladoAntes + 5) * 100;
        if (abs((float) $depois['cancelamentos']['percentual_sobre_vendas'] - $percentualEsperado) > 0.02) {
            throw new RuntimeException('Validação do percentual de cancelamento falhou.');
        }
        $produtoAntes = array_column($antes['produtos']['curva_abc'], null, 'id_produto')[$idProduto] ?? ['faturamento' => 0, 'lucro' => 0];
        $produtoDepois = array_column($depois['produtos']['curva_abc'], null, 'id_produto')[$idProduto] ?? [];
        proximo('faturamento', $produtoAntes, $produtoDepois, 30);
        proximo('lucro', $produtoAntes, $produtoDepois, 18);
        $diaSemana = (int) $inicio->format('w');
        $horaAntes = null;
        $horaDepois = null;
        foreach ($antes['horarios']['matriz'] as $linha) {
            if ($linha['dia_semana'] === $diaSemana && $linha['hora'] === 10) {
                $horaAntes = $linha['num_vendas'];
            }
        }
        foreach ($depois['horarios']['matriz'] as $linha) {
            if ($linha['dia_semana'] === $diaSemana && $linha['hora'] === 10) {
                $horaDepois = $linha['num_vendas'];
            }
        }
        proximo('num_vendas', ['num_vendas' => $horaAntes ?? 0], ['num_vendas' => $horaDepois ?? 0], 2);
        $operadorAntes = array_column($antes['operadores'], null, 'nome')[$nomeUsuario] ?? ['num_vendas' => 0, 'faturamento' => 0];
        $operadorDepois = array_column($depois['operadores'], null, 'nome')[$nomeUsuario] ?? [];
        proximo('num_vendas', $operadorAntes, $operadorDepois, 2, 0);
        proximo('faturamento', $operadorAntes, $operadorDepois, 30);

        $pdo->rollBack();
        fwrite(STDOUT, json_encode([
            'status' => 'ok',
            'filial' => $idFilial,
            'fixture' => [
                'vendas_concluidas' => 2,
                'vendas_canceladas' => 1,
                'faturamento' => 30,
                'lucro' => 18,
                'produto_id' => $idProduto,
                'dados_revertidos' => true,
            ],
            'validacoes' => ['resumo', 'ticket_medio', 'serie_diaria', 'pagamentos', 'horarios', 'produtos', 'cancelamentos', 'operadores'],
        ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . PHP_EOL);
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
} catch (Throwable $e) {
    fwrite(STDERR, 'Falha ao validar relatórios: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}
