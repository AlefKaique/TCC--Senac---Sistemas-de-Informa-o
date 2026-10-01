<?php

use Hydra\Support\Env;

Env::load(__DIR__ . '/../.env');

/**
 * Retorna uma conexão PDO única (singleton por request) com o MySQL.
 * Usa sempre prepared statements — nunca concatenar valores em SQL.
 */
function db(): PDO
{
    static $pdo = null;

    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $host = Env::get('DB_HOST', '127.0.0.1');
    $port = Env::get('DB_PORT', '3306');
    $name = Env::get('DB_NAME', 'hydra_db');
    $user = Env::get('DB_USER', 'root');
    $pass = Env::get('DB_PASS', '');

    // Fuso usado pelo sistema. Sem isto, CURRENT_TIMESTAMP (default de
    // data_criacao e data_movimentacao) grava no fuso do servidor MySQL,
    // que em hospedagem gerenciada costuma ser UTC - e o historico aparecia
    // 3 horas adiantado para o usuario no Brasil. Usamos o deslocamento em
    // vez do nome "America/Sao_Paulo" porque o nome exige as tabelas de
    // fuso do MySQL carregadas, o que nem todo provedor faz. O Brasil nao
    // adota mais horario de verao, entao -03:00 vale o ano todo.
    $timezone = Env::get('APP_TIMEZONE_OFFSET', '-03:00');

    $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";

    try {
        $pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);

        $stmt = $pdo->prepare('SET time_zone = :tz');
        $stmt->execute(['tz' => $timezone]);
    } catch (PDOException $e) {
        // O motivo real (host recusando conexão, usuário/senha inválidos,
        // banco inexistente...) vai para o log de erro do servidor — no
        // Render, aparece na aba "Logs" do serviço. A senha nunca é
        // registrada. Para ver o motivo direto na resposta da API durante
        // uma investigação, defina APP_DEBUG=true nas variáveis de ambiente.
        error_log(sprintf(
            '[Hydra] Falha ao conectar ao MySQL (host=%s porta=%s banco=%s usuario=%s): %s',
            $host,
            $port,
            $name,
            $user,
            $e->getMessage()
        ));

        $resposta = ['erro' => 'Falha ao conectar ao banco de dados'];
        if (Env::get('APP_DEBUG', 'false') === 'true') {
            $resposta['detalhe'] = $e->getMessage();
            $resposta['conexao'] = "host={$host} porta={$port} banco={$name} usuario={$user}";
        }

        \Hydra\Support\Response::json($resposta, 500);
        exit;
    }

    return $pdo;
}
