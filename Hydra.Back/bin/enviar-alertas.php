<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$appRoot = dirname(__DIR__);
spl_autoload_register(static function (string $class) use ($appRoot): void {
    $prefix = 'Hydra\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $arquivo = $appRoot . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($arquivo)) {
        require $arquivo;
    }
});
require $appRoot . '/config/database.php';

try {
    $data = $argv[1] ?? null;
    $resultado = (new \Hydra\Services\EnvioAlertas())->executar($data);
    fwrite(STDOUT, json_encode($resultado, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) . PHP_EOL);
} catch (Throwable $e) {
    fwrite(STDERR, 'Falha ao executar os alertas: ' . $e->getMessage() . PHP_EOL);
    exit(1);
}
