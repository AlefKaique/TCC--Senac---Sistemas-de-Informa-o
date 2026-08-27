<?php

/**
 * Front controller único da API REST do Hydra. Todas as rotas passam
 * por aqui (ver .htaccess) — não há framework, apenas um roteador
 * simples o bastante para o escopo do projeto.
 */

declare(strict_types=1);

spl_autoload_register(function (string $class): void {
    $prefix = 'Hydra\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $path = __DIR__ . '/../src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

require __DIR__ . '/../config/database.php';

use Hydra\Controllers\AuthController;
use Hydra\Controllers\LojaController;
use Hydra\Controllers\UsuarioController;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\Response;

// ----- CORS (desenvolvimento: front-end e back-end em origens/portas diferentes) -----
$allowedOrigin = Env::get('CORS_ALLOWED_ORIGIN', '*');
$origin = $_SERVER['HTTP_ORIGIN'] ?? null;
if ($allowedOrigin === '*' && $origin !== null) {
    // Com cookies de sessão é preciso ecoar a origem exata (o header "*"
    // não é aceito pelo navegador quando Allow-Credentials é usado).
    header("Access-Control-Allow-Origin: $origin");
} else {
    header("Access-Control-Allow-Origin: $allowedOrigin");
}
header('Access-Control-Allow-Credentials: true');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Vary: Origin');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

Auth::start();

set_exception_handler(function (Throwable $e): void {
    error_log($e->getMessage());
    Response::json(['erro' => 'Erro interno no servidor'], 500);
});

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
// Remove o prefixo até "/api" para funcionar tanto em localhost:PORTA/api/...
// (php -S) quanto atrás de um subdiretório no Apache/XAMPP.
$path = preg_replace('#^.*?(/api/.*)$#', '$1', $path) ?? $path;
$path = rtrim($path, '/');
if ($path === '') {
    $path = '/';
}

/** @var array<int,array{0:string,1:string,2:callable}> $routes */
$routes = [
    ['GET', '#^/api/health$#', fn () => Response::json(['status' => 'ok'])],
    ['POST', '#^/api/auth/registro$#', fn () => (new AuthController())->registro()],
    ['POST', '#^/api/auth/login$#', fn () => (new AuthController())->login()],
    ['POST', '#^/api/auth/logout$#', fn () => (new AuthController())->logout()],
    ['GET', '#^/api/auth/me$#', fn () => (new AuthController())->me()],
    ['POST', '#^/api/auth/esqueci-senha$#', fn () => (new AuthController())->esqueciSenha()],
    ['POST', '#^/api/auth/redefinir-senha$#', fn () => (new AuthController())->redefinirSenha()],

    ['GET', '#^/api/usuarios$#', fn () => (new UsuarioController())->index()],
    ['POST', '#^/api/usuarios$#', fn () => (new UsuarioController())->store()],
    ['PUT', '#^/api/usuarios/(\d+)$#', fn ($id) => (new UsuarioController())->update((int) $id)],
    ['DELETE', '#^/api/usuarios/(\d+)$#', fn ($id) => (new UsuarioController())->destroy((int) $id)],

    ['GET', '#^/api/loja$#', fn () => (new LojaController())->show()],
    ['PUT', '#^/api/loja$#', fn () => (new LojaController())->update()],
];

foreach ($routes as [$routeMethod, $pattern, $handler]) {
    if ($routeMethod !== $method) {
        continue;
    }
    if (preg_match($pattern, $path, $matches)) {
        array_shift($matches);
        $handler(...$matches);
        exit;
    }
}

Response::json(['erro' => 'Rota não encontrada'], 404);
