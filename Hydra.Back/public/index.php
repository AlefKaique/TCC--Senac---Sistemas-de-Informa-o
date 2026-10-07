<?php

/**
 * Front controller único da API REST do Hydra. Todas as rotas passam
 * por aqui (ver .htaccess) — não há framework, apenas um roteador
 * simples o bastante para o escopo do projeto.
 */

declare(strict_types=1);

/*
 * Raiz do codigo PHP. Dois layouts sao suportados:
 *   - desenvolvimento: este arquivo esta em Hydra.Back/public/ e o
 *     codigo fica ao lado, em ../src e ../config;
 *   - imagem Docker: este arquivo e servido de /var/www/html/api/ e o
 *     codigo mora FORA da raiz publica do Apache, em /var/www/app/,
 *     para nao ser enderecavel pelo navegador.
 */
$appRoot = null;
foreach ([__DIR__ . '/..', '/var/www/app'] as $candidato) {
    if (is_dir($candidato . '/src')) {
        $appRoot = $candidato;
        break;
    }
}
if ($appRoot === null) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['erro' => 'Instalacao invalida: diretorio "src" nao encontrado']);
    exit;
}

spl_autoload_register(function (string $class) use ($appRoot): void {
    $prefix = 'Hydra\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $path = $appRoot . '/src/' . str_replace('\\', '/', $relative) . '.php';
    if (is_file($path)) {
        require $path;
    }
});

require $appRoot . '/config/database.php';

use Hydra\Controllers\AuthController;
use Hydra\Controllers\CargoController;
use Hydra\Controllers\EstoqueController;
use Hydra\Controllers\FilialController;
use Hydra\Controllers\LojaController;
use Hydra\Controllers\ProdutoController;
use Hydra\Controllers\PromocaoController;
use Hydra\Controllers\UsuarioController;
use Hydra\Controllers\VendaController;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\Response;

// ----- CORS -----
// CORS_ALLOWED_ORIGIN aceita uma lista separada por vírgula com as origens
// autorizadas (ex.: "https://hydra.exemplo.com,http://localhost:5500").
//
// O valor "*" continua existindo para desenvolvimento, mas agora SO vale
// quando APP_ENV=local. Antes ele ecoava de volta qualquer origem que
// chamasse a API, junto de Allow-Credentials: true - ou seja, qualquer
// site na internet era tratado como origem confiável. O SameSite=Lax do
// cookie evitava o pior na prática, mas isso era sorte, não defesa.
$origensConfig = (string) Env::get('CORS_ALLOWED_ORIGIN', '');
$ehLocal = Env::get('APP_ENV', 'production') === 'local';
$origin = $_SERVER['HTTP_ORIGIN'] ?? null;

$origensPermitidas = array_filter(array_map('trim', explode(',', $origensConfig)));

if ($origin !== null) {
    if (in_array($origin, $origensPermitidas, true)) {
        header("Access-Control-Allow-Origin: $origin");
        header('Access-Control-Allow-Credentials: true');
    } elseif ($ehLocal && in_array('*', $origensPermitidas, true)) {
        // Conveniência de desenvolvimento: front e back em portas diferentes.
        header("Access-Control-Allow-Origin: $origin");
        header('Access-Control-Allow-Credentials: true');
    }
    // Origem desconhecida em produção: nenhum header CORS é enviado e o
    // próprio navegador bloqueia a leitura da resposta.
}

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
    ['POST', '#^/api/auth/verificar-codigo-recuperacao$#', fn () => (new AuthController())->verificarCodigoRecuperacao()],
    ['POST', '#^/api/auth/verificar-email$#', fn () => (new AuthController())->verificarEmail()],
    ['POST', '#^/api/auth/reenviar-verificacao$#', fn () => (new AuthController())->reenviarVerificacao()],
    ['POST', '#^/api/auth/login/codigo$#', fn () => (new AuthController())->loginCodigo()],
    ['POST', '#^/api/auth/login/reenviar$#', fn () => (new AuthController())->loginReenviar()],

    ['GET', '#^/api/usuarios$#', fn () => (new UsuarioController())->index()],
    ['POST', '#^/api/usuarios$#', fn () => (new UsuarioController())->store()],
    ['PUT', '#^/api/usuarios/(\d+)$#', fn ($id) => (new UsuarioController())->update((int) $id)],
    // Não há DELETE de usuário: ver o comentário no fim de UsuarioController.

    ['GET', '#^/api/loja$#', fn () => (new LojaController())->show()],
    ['PUT', '#^/api/loja$#', fn () => (new LojaController())->update()],

    // "minhas" e "trocar" antes de "/api/filiais/(\d+)" só por clareza:
    // o padrão numérico não as capturaria de qualquer forma.
    ['GET', '#^/api/filiais/minhas$#', fn () => (new FilialController())->minhas()],
    ['POST', '#^/api/filiais/trocar$#', fn () => (new FilialController())->trocar()],
    ['GET', '#^/api/filiais$#', fn () => (new FilialController())->index()],
    ['POST', '#^/api/filiais$#', fn () => (new FilialController())->store()],
    ['PUT', '#^/api/filiais/(\d+)$#', fn ($id) => (new FilialController())->update((int) $id)],

    ['GET', '#^/api/cargos$#', fn () => (new CargoController())->index()],
    ['POST', '#^/api/cargos$#', fn () => (new CargoController())->store()],
    ['PUT', '#^/api/cargos/(\d+)$#', fn ($id) => (new CargoController())->update((int) $id)],
    ['DELETE', '#^/api/cargos/(\d+)$#', fn ($id) => (new CargoController())->destroy((int) $id)],

    ['GET', '#^/api/produtos$#', fn () => (new ProdutoController())->index()],
    ['POST', '#^/api/produtos$#', fn () => (new ProdutoController())->store()],
    ['PUT', '#^/api/produtos/(\d+)$#', fn ($id) => (new ProdutoController())->update((int) $id)],
    ['DELETE', '#^/api/produtos/(\d+)$#', fn ($id) => (new ProdutoController())->destroy((int) $id)],
    ['GET', '#^/api/produtos/(\d+)/movimentacoes$#', fn ($id) => (new ProdutoController())->movimentacoes((int) $id)],

    ['GET', '#^/api/estoque/movimentacoes$#', fn () => (new EstoqueController())->index()],
    ['POST', '#^/api/estoque/movimentacoes$#', fn () => (new EstoqueController())->store()],

    ['GET', '#^/api/vendas$#', fn () => (new VendaController())->index()],
    ['POST', '#^/api/vendas$#', fn () => (new VendaController())->store()],
    ['POST', '#^/api/vendas/autorizar-cancelamento$#', fn () => (new VendaController())->autorizarCancelamento()],
    ['POST', '#^/api/vendas/autorizar-cancelamento/encerrar$#', fn () => (new VendaController())->encerrarAutorizacao()],
    ['POST', '#^/api/vendas/(\d+)/cancelar$#', fn ($id) => (new VendaController())->cancelar((int) $id)],

    ['GET', '#^/api/promocoes$#', fn () => (new PromocaoController())->index()],
    ['POST', '#^/api/promocoes$#', fn () => (new PromocaoController())->store()],
    ['POST', '#^/api/promocoes/(\d+)/encerrar$#', fn ($id) => (new PromocaoController())->encerrar((int) $id)],
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
