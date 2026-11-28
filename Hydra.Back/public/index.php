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
use Hydra\Controllers\AlertaController;
use Hydra\Controllers\CatalogoHortifrutiController;
use Hydra\Controllers\CargoController;
use Hydra\Controllers\ContaController;
use Hydra\Controllers\ContatoController;
use Hydra\Controllers\DocumentoEstoqueController;
use Hydra\Controllers\EstoqueController;
use Hydra\Controllers\FilialController;
use Hydra\Controllers\LojaController;
use Hydra\Controllers\PlataformaAuthController;
use Hydra\Controllers\PlataformaAssinaturaController;
use Hydra\Controllers\PlataformaController;
use Hydra\Controllers\PlataformaEquipeController;
use Hydra\Controllers\PixController;
use Hydra\Controllers\ProdutoController;
use Hydra\Controllers\PromocaoController;
use Hydra\Controllers\RelatorioController;
use Hydra\Controllers\RelatorioEstoqueController;
use Hydra\Controllers\RelatorioVendasController;
use Hydra\Controllers\UsuarioController;
use Hydra\Controllers\VendaController;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\Response;
use Hydra\Support\Seguranca;

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

// Cabeçalhos de segurança (nosniff, anti-iframe, CSP, HSTS em HTTPS).
Seguranca::enviarCabecalhosApi();

header('Access-Control-Allow-Headers: Content-Type, X-Cron-Token, X-Hub-Signature-256');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Vary: Origin');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
// Remove o prefixo até "/api" para funcionar tanto em localhost:PORTA/api/...
// (php -S) quanto atrás de um subdiretório no Apache/XAMPP.
$path = preg_replace('#^.*?(/api/.*)$#', '$1', $path) ?? $path;
$path = rtrim($path, '/');
if ($path === '') {
    $path = '/';
}

// A sessão só é aberta quando pode existir: o navegador já mandou o cookie
// dela, ou a rota é de autenticação (que cria a sessão). Antes ela abria em
// toda chamada - o healthcheck do Render (/api/health, sem cookie) criava
// um arquivo de sessão novo a cada verificação, e rotas públicas como
// /api/catalogo-hortifruti travavam o arquivo à toa. Sem cookie,
// requireLogin() continua respondendo 401, porque não há usuário na sessão.
// Webhook e agendador usam autenticação própria e nunca abrem sessão. O
// formulário de contato da página inicial é público e não usa a sessão.
$rotaSemSessao = in_array($path, ['/api/health', '/api/whatsapp/webhook', '/api/interno/alertas/disparar', '/api/conta/assinatura/webhook', '/api/contato'], true);
// ".../auth/me" só LÊ a sessão: sem cookie não há o que ler, e a página
// inicial chama /api/auth/me em toda visita anônima.
$rotaDeAutenticacao = (str_starts_with($path, '/api/auth/') || str_starts_with($path, '/api/plataforma/auth/'))
    && !str_ends_with($path, '/auth/me');
if (!$rotaSemSessao && ($rotaDeAutenticacao || isset($_COOKIE[session_name()]))) {
    Auth::start();
}

set_exception_handler(function (Throwable $e): void {
    error_log($e->getMessage());
    Response::json(['erro' => 'Erro interno no servidor'], 500);
});

/** @var array<int,array{0:string,1:string,2:callable}> $routes */
$routes = [
    ['GET', '#^/api/health$#', fn () => Response::json(['status' => 'ok'])],
    ['POST', '#^/api/contato$#', fn () => (new ContatoController())->enviar()],
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

    // Plataforma: autenticação isolada das contas e sessões das lojas.
    ['POST', '#^/api/plataforma/auth/login$#', fn () => (new PlataformaAuthController())->login()],
    ['POST', '#^/api/plataforma/auth/codigo$#', fn () => (new PlataformaAuthController())->codigo()],
    ['POST', '#^/api/plataforma/auth/reenviar$#', fn () => (new PlataformaAuthController())->reenviar()],
    ['GET', '#^/api/plataforma/auth/me$#', fn () => (new PlataformaAuthController())->me()],
    ['POST', '#^/api/plataforma/auth/logout$#', fn () => (new PlataformaAuthController())->logout()],
    ['POST', '#^/api/plataforma/auth/primeiro-acesso$#', fn () => (new PlataformaEquipeController())->primeiroAcesso()],
    ['GET', '#^/api/plataforma/resumo$#', fn () => (new PlataformaController())->resumo()],
    ['GET', '#^/api/plataforma/rendimento$#', fn () => (new PlataformaController())->rendimento()],
    ['GET', '#^/api/plataforma/lojas$#', fn () => (new PlataformaController())->lojas()],
    ['GET', '#^/api/plataforma/lojas/(\d+)$#', fn ($id) => (new PlataformaController())->detalheLoja((int) $id)],
    ['POST', '#^/api/plataforma/lojas/(\d+)/suspender$#', fn ($id) => (new PlataformaController())->suspender((int) $id)],
    ['POST', '#^/api/plataforma/lojas/(\d+)/reativar$#', fn ($id) => (new PlataformaController())->reativar((int) $id)],
    // Assinaturas de todos os mercados (painel da plataforma).
    ['GET', '#^/api/plataforma/assinaturas$#', fn () => (new PlataformaAssinaturaController())->lista()],
    ['GET', '#^/api/plataforma/assinaturas/(\d+)$#', fn ($id) => (new PlataformaAssinaturaController())->detalhe((int) $id)],
    ['POST', '#^/api/plataforma/assinaturas/(\d+)/pagamentos$#', fn ($id) => (new PlataformaAssinaturaController())->registrarPagamento((int) $id)],
    ['POST', '#^/api/plataforma/assinaturas/(\d+)/ajustar$#', fn ($id) => (new PlataformaAssinaturaController())->ajustar((int) $id)],
    ['POST', '#^/api/plataforma/assinaturas/(\d+)/cancelar$#', fn ($id) => (new PlataformaAssinaturaController())->cancelar((int) $id)],
    ['POST', '#^/api/plataforma/assinaturas/(\d+)/reativar$#', fn ($id) => (new PlataformaAssinaturaController())->reativar((int) $id)],
    ['POST', '#^/api/plataforma/assinaturas/pagamentos/([a-f0-9-]{36})/conferir$#i', fn ($id) => (new PlataformaAssinaturaController())->conferir($id)],
    ['GET', '#^/api/plataforma/cadastros-pendentes$#', fn () => (new PlataformaController())->cadastrosPendentes()],
    ['GET', '#^/api/plataforma/auditoria$#', fn () => (new PlataformaController())->auditoria()],
    ['GET', '#^/api/plataforma/equipe$#', fn () => (new PlataformaEquipeController())->index()],
    ['POST', '#^/api/plataforma/equipe$#', fn () => (new PlataformaEquipeController())->criar()],
    ['PUT', '#^/api/plataforma/equipe/(\d+)$#', fn ($id) => (new PlataformaEquipeController())->atualizar((int) $id)],
    ['POST', '#^/api/plataforma/equipe/(\d+)/reenviar-convite$#', fn ($id) => (new PlataformaEquipeController())->reenviarConvite((int) $id)],

    ['GET', '#^/api/usuarios$#', fn () => (new UsuarioController())->index()],
    ['POST', '#^/api/usuarios$#', fn () => (new UsuarioController())->store()],
    ['PUT', '#^/api/usuarios/(\d+)$#', fn ($id) => (new UsuarioController())->update((int) $id)],
    // Não há DELETE de usuário: ver o comentário no fim de UsuarioController.

    ['GET', '#^/api/loja$#', fn () => (new LojaController())->show()],
    ['PUT', '#^/api/loja$#', fn () => (new LojaController())->update()],

    // Tela "Privacidade": só o titular da conta (quem cadastrou a loja).
    ['GET', '#^/api/conta/assinatura$#', fn () => (new ContaController())->assinatura()],
    ['POST', '#^/api/conta/assinatura/checkout$#', fn () => (new ContaController())->checkout()],
    ['POST', '#^/api/conta/assinatura/pagamentos/([a-f0-9-]{36})/verificar$#i', fn ($id) => (new ContaController())->verificar($id)],
    ['POST', '#^/api/conta/assinatura/cancelar$#', fn () => (new ContaController())->cancelar()],
    ['POST', '#^/api/conta/assinatura/reativar$#', fn () => (new ContaController())->reativar()],
    ['POST', '#^/api/conta/assinatura/webhook$#', fn () => (new ContaController())->webhook()],
    ['POST', '#^/api/conta/encerrar$#', fn () => (new ContaController())->encerrar()],

    ['GET', '#^/api/relatorios/resumo$#', fn () => (new RelatorioController())->resumo()],
    ['GET', '#^/api/relatorios/vendas-por-dia$#', fn () => (new RelatorioController())->vendasPorDia()],
    ['GET', '#^/api/relatorios/pagamentos$#', fn () => (new RelatorioController())->pagamentos()],
    ['GET', '#^/api/relatorios/horarios$#', fn () => (new RelatorioController())->horarios()],
    ['GET', '#^/api/relatorios/produtos$#', fn () => (new RelatorioController())->produtos()],
    ['GET', '#^/api/relatorios/estoque$#', fn () => (new RelatorioController())->estoque()],
    ['GET', '#^/api/relatorios/cancelamentos$#', fn () => (new RelatorioController())->cancelamentos()],
    ['GET', '#^/api/relatorios/operadores$#', fn () => (new RelatorioController())->operadores()],
    // Tela Relatório (pages/dashboard.html): estoque focado no produto.
    ['GET', '#^/api/relatorios/estoque-produtos$#', fn () => (new RelatorioEstoqueController())->relatorio()],
    // Relatório de vendas com valores: sem tela no momento (módulo financeiro futuro).
    ['GET', '#^/api/relatorios/vendas$#', fn () => (new RelatorioVendasController())->vendas()],
    ['GET', '#^/api/relatorios/preferencias$#', fn () => (new RelatorioVendasController())->preferencias()],
    ['PUT', '#^/api/relatorios/preferencias$#', fn () => (new RelatorioVendasController())->salvarPreferencias()],

    ['GET', '#^/api/alertas/preferencias$#', fn () => (new AlertaController())->preferencias()],
    ['PUT', '#^/api/alertas/preferencias$#', fn () => (new AlertaController())->salvarPreferencias()],
    ['POST', '#^/api/alertas/destinatarios$#', fn () => (new AlertaController())->adicionarDestinatario()],
    ['DELETE', '#^/api/alertas/destinatarios/(\d+)$#', fn ($id) => (new AlertaController())->removerDestinatario((int) $id)],
    ['POST', '#^/api/alertas/teste$#', fn () => (new AlertaController())->teste()],
    ['POST', '#^/api/interno/alertas/disparar$#', fn () => (new AlertaController())->disparar()],
    ['GET', '#^/api/whatsapp/webhook$#', fn () => (new AlertaController())->verificarWebhook()],
    ['POST', '#^/api/whatsapp/webhook$#', fn () => (new AlertaController())->webhook()],

    ['GET', '#^/api/pix/mercadopago/conta$#', fn () => (new PixController())->conta()],
    ['POST', '#^/api/pix/mercadopago/conectar$#', fn () => (new PixController())->conectar()],
    ['GET', '#^/api/pix/mercadopago/callback$#', fn () => (new PixController())->callback()],
    ['DELETE', '#^/api/pix/mercadopago/conta$#', fn () => (new PixController())->desconectar()],
    ['POST', '#^/api/pix/pagamentos$#', fn () => (new PixController())->criarPagamento()],
    ['GET', '#^/api/pix/pagamentos/pendente$#', fn () => (new PixController())->pendenteAtual()],
    ['GET', '#^/api/pix/pagamentos/([a-f0-9-]{36})$#i', fn ($id) => (new PixController())->status($id)],

    // "minhas" e "trocar" antes de "/api/filiais/(\d+)" só por clareza:
    // o padrão numérico não as capturaria de qualquer forma.
    ['GET', '#^/api/filiais/minhas$#', fn () => (new FilialController())->minhas()],
    ['POST', '#^/api/filiais/trocar$#', fn () => (new FilialController())->trocar()],
    ['GET', '#^/api/filiais$#', fn () => (new FilialController())->index()],
    ['POST', '#^/api/filiais$#', fn () => (new FilialController())->store()],
    ['PUT', '#^/api/filiais/(\d+)$#', fn ($id) => (new FilialController())->update((int) $id)],

    ['GET', '#^/api/catalogo-hortifruti$#', fn () => (new CatalogoHortifrutiController())->index()],
    ['POST', '#^/api/catalogo-hortifruti/importar$#', fn () => (new CatalogoHortifrutiController())->importar()],

    ['GET', '#^/api/cargos$#', fn () => (new CargoController())->index()],
    ['POST', '#^/api/cargos$#', fn () => (new CargoController())->store()],
    ['PUT', '#^/api/cargos/(\d+)$#', fn ($id) => (new CargoController())->update((int) $id)],
    ['DELETE', '#^/api/cargos/(\d+)$#', fn ($id) => (new CargoController())->destroy((int) $id)],

    ['GET', '#^/api/produtos/codigo-barras/(\d{8,14})$#', fn ($codigo) => (new ProdutoController())->buscarPorCodigoBarras($codigo)],
    ['GET', '#^/api/produtos/proximo-sku$#', fn () => (new ProdutoController())->proximoSku()],
    ['GET', '#^/api/produtos$#', fn () => (new ProdutoController())->index()],
    ['POST', '#^/api/produtos$#', fn () => (new ProdutoController())->store()],
    ['PUT', '#^/api/produtos/(\d+)$#', fn ($id) => (new ProdutoController())->update((int) $id)],
    ['DELETE', '#^/api/produtos/(\d+)$#', fn ($id) => (new ProdutoController())->destroy((int) $id)],
    ['GET', '#^/api/produtos/(\d+)/movimentacoes$#', fn ($id) => (new ProdutoController())->movimentacoes((int) $id)],

    ['GET', '#^/api/estoque/movimentacoes$#', fn () => (new EstoqueController())->index()],
    ['POST', '#^/api/estoque/movimentacoes$#', fn () => (new EstoqueController())->store()],
    // Documentos de entrada/saída com lotes (telas Nova entrada / Nova saída).
    ['GET', '#^/api/estoque/lotes$#', fn () => (new DocumentoEstoqueController())->lotes()],
    ['GET', '#^/api/estoque/documentos/proximo-numero$#', fn () => (new DocumentoEstoqueController())->proximoNumero()],
    ['GET', '#^/api/estoque/documentos$#', fn () => (new DocumentoEstoqueController())->index()],
    ['POST', '#^/api/estoque/documentos$#', fn () => (new DocumentoEstoqueController())->store()],
    ['GET', '#^/api/estoque/documentos/(\d+)$#', fn ($id) => (new DocumentoEstoqueController())->show((int) $id)],
    ['POST', '#^/api/estoque/documentos/(\d+)/estornar$#', fn ($id) => (new DocumentoEstoqueController())->estornar((int) $id)],

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
