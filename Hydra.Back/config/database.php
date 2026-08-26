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

    $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";

    try {
        $pdo = new PDO($dsn, $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (PDOException $e) {
        \Hydra\Support\Response::json(['erro' => 'Falha ao conectar ao banco de dados'], 500);
        exit;
    }

    return $pdo;
}
