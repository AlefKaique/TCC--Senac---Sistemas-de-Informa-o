<?php

namespace Hydra\Controllers;

use Hydra\Repositories\AssinaturaRepository;
use Hydra\Repositories\AuditoriaPlataformaRepository;
use Hydra\Repositories\ContaRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Support\Auth;
use Hydra\Support\ConferenciaAssinatura;
use Hydra\Support\Env;
use Hydra\Support\MercadoPagoClient;
use Hydra\Support\RateLimit;
use Hydra\Support\Request;
use Hydra\Support\Response;
use Throwable;

/**
 * Tela "Privacidade" — exclusiva do titular da conta, quem cadastrou a loja
 * (Auth::requireTitular). Funcionários criados na tela Equipe recebem 403,
 * mesmo com o cargo Administrador.
 *
 *   - Fazer upgrade: abre o Checkout Pro do Mercado Pago (conta da Hydra).
 *     O plano é liberado quando o pagamento é confirmado — pelo retorno do
 *     navegador, pelo botão "Verificar pagamento", pelo webhook ou pela
 *     equipe Hydra no painel da plataforma (ConferenciaAssinatura).
 *   - Cancelar assinatura: o plano continua até o fim do período pago; em
 *     atraso, encerra a cobrança na hora.
 *   - Cancelar conta: desativa a loja e anonimiza os dados pessoais
 *     (ContaRepository::encerrar), com senha e confirmação digitada.
 *
 * Quem acompanha e corrige as assinaturas de todos os mercados (ativas,
 * atrasadas, pagamentos recebidos por fora) é a equipe Hydra, no painel da
 * plataforma: PlataformaAssinaturaController.
 *
 * Modelo de cobrança e prazos: ver AssinaturaRepository.
 */
final class ContaController
{
    private AssinaturaRepository $assinaturas;

    public function __construct()
    {
        $this->assinaturas = new AssinaturaRepository();
    }

    /** GET /api/conta/assinatura */
    public function assinatura(): void
    {
        $user = Auth::requireTitular();
        Response::json($this->resumo((int) $user['id_loja']));
    }

    /** POST /api/conta/assinatura/checkout  { "plano": "flex"|"premium", "retorno": "<url desta tela>" } */
    public function checkout(): void
    {
        $user = Auth::requireTitular();
        $idLoja = (int) $user['id_loja'];
        $dados = Request::json();
        $plano = (string) ($dados['plano'] ?? '');

        if (!in_array($plano, ['flex', 'premium'], true)) {
            Response::json(['erro' => 'Escolha o Hydra Flex ou o Hydra Premium.'], 422);
            return;
        }
        if (!MercadoPagoClient::assinaturaConfigurada()) {
            Response::json([
                'erro' => 'O pagamento online ainda não está disponível. Fale com o suporte Hydra pelo (11) 95820-6969.',
                'codigo' => 'pagamento_indisponivel',
            ], 503);
            return;
        }
        $estado = $this->assinaturas->estado($idLoja);
        if ($estado === null) {
            Response::json(['erro' => 'Loja não encontrada'], 404);
            return;
        }
        $info = AssinaturaRepository::PLANOS[$plano];
        if ($info['ordem'] < AssinaturaRepository::PLANOS[$estado['plano']]['ordem']) {
            Response::json([
                'erro' => 'Seu plano atual é superior a este. Para trocar por um plano menor, aguarde o fim do período ou fale com o suporte.',
            ], 422);
            return;
        }
        $retorno = $this->urlDeRetorno((string) ($dados['retorno'] ?? ''));
        if ($retorno === null) {
            Response::json(['erro' => 'Não foi possível montar o endereço de retorno do pagamento. Abra a tela pelo endereço do sistema e tente de novo.'], 422);
            return;
        }

        $id = AssinaturaRepository::novoId();
        $this->assinaturas->criarPagamento($id, $idLoja, (int) $user['id_usuario'], $plano, $info['valor'], $info['meses']);

        $preferencia = [
            'items' => [[
                'id' => 'hydra-' . $plano,
                'title' => $info['nome'] . ' - assinatura ' . mb_strtolower($info['periodo']),
                'description' => $info['meses'] === 1
                    ? 'Sistema Hydra PDV por 1 mês'
                    : 'Sistema Hydra PDV por ' . $info['meses'] . ' meses',
                'quantity' => 1,
                'currency_id' => 'BRL',
                'unit_price' => $info['valor'],
                'category_id' => 'services',
            ]],
            'payer' => ['name' => (string) $user['nome'], 'email' => (string) $user['email']],
            'external_reference' => $id,
            'back_urls' => ['success' => $retorno, 'pending' => $retorno, 'failure' => $retorno],
            'statement_descriptor' => 'HYDRA PDV',
            'expires' => true,
            'expiration_date_to' => (new \DateTimeImmutable('+3 days'))->format('Y-m-d\TH:i:s.vP'),
            'metadata' => ['id_loja' => $idLoja, 'plano' => $plano],
        ];
        // O Mercado Pago só volta sozinho para a loja (auto_return) em
        // endereços https; em http://localhost o comprador clica em "Voltar".
        if (str_starts_with($retorno, 'https://')) {
            $preferencia['auto_return'] = 'approved';
        }
        // Webhook opcional: confirma o pagamento mesmo se o comprador fechar
        // a aba antes de voltar (ex.: PIX pago pelo celular).
        $webhook = trim((string) Env::get('MERCADOPAGO_ASSINATURA_WEBHOOK_URL', ''));
        if (str_starts_with($webhook, 'https://')) {
            $preferencia['notification_url'] = $webhook;
        }

        try {
            $checkout = MercadoPagoClient::criarPreferenciaAssinatura($preferencia, $id);
            $this->assinaturas->anexarPreferencia($id, $checkout['id']);
        } catch (Throwable $e) {
            $this->assinaturas->descartar($id);
            error_log('[Hydra] Falha ao criar o checkout da assinatura: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível abrir o pagamento no Mercado Pago. Tente de novo em instantes.'], 502);
            return;
        }

        Response::json(['id' => $id, 'checkout_url' => $checkout['url']], 201);
    }

    /**
     * POST /api/conta/assinatura/pagamentos/{id}/verificar  { "payment_id"?: "123" }
     * Confere no Mercado Pago o checkout {id} desta loja e libera o plano se
     * houver pagamento aprovado. "payment_id" vem do retorno do navegador.
     */
    public function verificar(string $id): void
    {
        $user = Auth::requireTitular();
        $idLoja = (int) $user['id_loja'];

        $pagamento = $this->assinaturas->pagamento(strtolower($id), $idLoja);
        if ($pagamento === null) {
            Response::json(['erro' => 'Pagamento não encontrado.'], 404);
            return;
        }
        if ($pagamento['status'] === 'aprovado') {
            Response::json(['status' => 'aprovado'] + $this->resumo($idLoja));
            return;
        }
        if (!MercadoPagoClient::assinaturaConfigurada()) {
            Response::json(['erro' => 'O pagamento online não está configurado no servidor.'], 503);
            return;
        }

        $dados = Request::json();
        $paymentId = preg_replace('/\D/', '', (string) ($dados['payment_id'] ?? '')) ?? '';

        try {
            $status = (new ConferenciaAssinatura($this->assinaturas))
                ->conferir($pagamento, $paymentId !== '' ? $paymentId : null);
        } catch (Throwable $e) {
            error_log('[Hydra] Falha ao consultar pagamento da assinatura: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível consultar o Mercado Pago agora. Tente de novo em instantes.'], 502);
            return;
        }

        // Nenhuma tentativa de pagamento uma hora depois de abrir o checkout:
        // desistiu. O aviso de "pagamento em andamento" some da tela.
        if ($status === 'nao_encontrado' && $this->assinaturas->minutosDesdeCriacao($pagamento) > 60) {
            $this->assinaturas->descartar((string) $pagamento['id_pagamento']);
        }

        Response::json(['status' => $status] + $this->resumo($idLoja));
    }

    /**
     * POST /api/conta/assinatura/webhook — notificação do Mercado Pago, sem
     * sessão. O corpo não é confiável: o pagamento é sempre relido na API do
     * Mercado Pago com a credencial da Hydra antes de liberar qualquer plano.
     */
    public function webhook(): void
    {
        $corpo = Request::json();
        $tipo = (string) ($corpo['type'] ?? $_GET['type'] ?? $_GET['topic'] ?? '');
        // "data.id" na query string chega ao PHP como "data_id".
        $idMp = (string) ($corpo['data']['id'] ?? $_GET['data_id'] ?? ($tipo === 'payment' ? ($_GET['id'] ?? '') : ''));
        $idMp = preg_replace('/\D/', '', $idMp) ?? '';

        if ($tipo !== 'payment' || $idMp === '' || !MercadoPagoClient::assinaturaConfigurada()) {
            Response::json(['ok' => true]);
            return;
        }

        try {
            $mp = MercadoPagoClient::consultarPagamentoAssinatura($idMp);
        } catch (Throwable $e) {
            error_log('[Hydra] Webhook da assinatura: consulta ao Mercado Pago falhou: ' . $e->getMessage());
            // Erro faz o Mercado Pago reenviar a notificação mais tarde.
            Response::json(['erro' => 'Consulta indisponível'], 502);
            return;
        }

        (new ConferenciaAssinatura($this->assinaturas))->aplicarNotificacao($mp);
        Response::json(['ok' => true]);
    }

    /**
     * POST /api/conta/assinatura/cancelar
     * Dentro do período, vale até o vencimento; em atraso, encerra a cobrança.
     */
    public function cancelar(): void
    {
        $user = Auth::requireTitular();
        $idLoja = (int) $user['id_loja'];
        if (!$this->assinaturas->cancelar($idLoja)) {
            Response::json(['erro' => 'Não há assinatura para cancelar.'], 409);
            return;
        }
        $resumo = $this->resumo($idLoja);
        AuditoriaPlataformaRepository::registrarSemFalhar(
            null,
            'assinatura_cancelada_titular',
            $idLoja,
            $resumo['assinatura']['situacao'] === 'finalizada'
                ? 'Assinatura em atraso cancelada pelo titular; a loja voltou ao plano gratuito'
                : 'Assinatura cancelada pelo titular; vale até o fim do período pago'
        );
        Response::json(['ok' => true] + $resumo);
    }

    /** POST /api/conta/assinatura/reativar — desfaz o cancelamento dentro do período pago. */
    public function reativar(): void
    {
        $user = Auth::requireTitular();
        $idLoja = (int) $user['id_loja'];
        if (!$this->assinaturas->reativar($idLoja)) {
            Response::json(['erro' => 'Não há assinatura cancelada dentro do período para manter.'], 409);
            return;
        }
        AuditoriaPlataformaRepository::registrarSemFalhar(null, 'assinatura_reativada_titular', $idLoja, 'Titular desfez o cancelamento da assinatura');
        Response::json(['ok' => true] + $this->resumo($idLoja));
    }

    /** POST /api/conta/encerrar  { "senha": "...", "confirmacao": "ENCERRAR" } */
    public function encerrar(): void
    {
        $user = Auth::requireTitular();
        $dados = Request::json();
        $senha = (string) ($dados['senha'] ?? '');
        $confirmacao = mb_strtoupper(trim((string) ($dados['confirmacao'] ?? '')));

        if ($confirmacao !== 'ENCERRAR') {
            Response::json(['erro' => 'Digite ENCERRAR para confirmar.', 'campo' => 'confirmacao'], 422);
            return;
        }
        if ($senha === '') {
            Response::json(['erro' => 'Informe sua senha.', 'campo' => 'senha'], 422);
            return;
        }

        // Mesma trava do login: sem ela, quem encontrasse a sessão aberta
        // poderia testar senhas à vontade nesta rota.
        $chaveLimite = 'encerrar:' . $user['id_usuario'];
        RateLimit::requireNaoBloqueado($chaveLimite);
        $usuario = (new UsuarioRepository())->find((int) $user['id_usuario']);
        if ($usuario === null || !password_verify($senha, (string) $usuario['senha'])) {
            RateLimit::registrarFalha($chaveLimite);
            Response::json(['erro' => 'Senha incorreta.', 'campo' => 'senha'], 422);
            return;
        }

        (new ContaRepository())->encerrar((int) $user['id_loja'], (int) $user['id_usuario']);
        Auth::logout();
        Response::json(['ok' => true]);
    }

    /* ================= Apoio ================= */

    /** @return array<string,mixed> o que a tela precisa para se desenhar */
    private function resumo(int $idLoja): array
    {
        $estado = $this->assinaturas->estado($idLoja) ?? [
            'plano' => 'start', 'plano_contratado' => 'start', 'situacao' => 'gratuito',
            'valido_ate' => null, 'cancelada_em' => null, 'dias' => null,
        ];
        $ordemAtual = AssinaturaRepository::PLANOS[$estado['plano']]['ordem'];
        $vigente = in_array($estado['situacao'], ['ativa', 'cancelada'], true);

        $planos = [];
        foreach (AssinaturaRepository::PLANOS as $codigo => $info) {
            if ($codigo === 'start') {
                continue;
            }
            $planos[] = [
                'codigo' => $codigo,
                'nome' => $info['nome'],
                'valor' => $info['valor'],
                'meses' => $info['meses'],
                'periodo' => $info['periodo'],
                // Plano menor que o vigente não é oferecido até o fim do período.
                'pode_contratar' => $info['ordem'] >= $ordemAtual,
                // Pagar o mesmo plano contratado é renovar (também em atraso).
                'renovacao' => $codigo === $estado['plano_contratado']
                    && in_array($estado['situacao'], ['ativa', 'cancelada', 'atrasada'], true),
                // Com o plano valendo, o período novo começa no vencimento.
                'inicio' => $vigente ? $estado['valido_ate'] : null,
            ];
        }

        $pendente = $this->assinaturas->pendenteRecente($idLoja);

        return [
            'assinatura' => $estado + [
                'nome_plano' => AssinaturaRepository::PLANOS[$estado['plano']]['nome'],
                'nome_plano_contratado' => AssinaturaRepository::PLANOS[$estado['plano_contratado']]['nome'],
            ],
            'planos' => $planos,
            'pagamento_pendente' => $pendente === null ? null : [
                'id' => $pendente['id_pagamento'],
                'plano' => $pendente['plano'],
                'nome_plano' => AssinaturaRepository::PLANOS[$pendente['plano']]['nome'],
                'valor' => (float) $pendente['valor'],
                'criado_em' => $pendente['criado_em'],
            ],
            'pagamento_online' => MercadoPagoClient::assinaturaConfigurada(),
        ];
    }

    /**
     * Endereço para onde o Mercado Pago devolve o comprador: a própria tela
     * Privacidade, desde que num endereço conhecido do sistema. Recusa
     * qualquer outro destino, para a rota não virar um redirecionador.
     */
    private function urlDeRetorno(string $url): ?string
    {
        $partes = parse_url($url);
        if (!is_array($partes)
            || !in_array($partes['scheme'] ?? '', ['http', 'https'], true)
            || empty($partes['host'])
            || !str_ends_with((string) ($partes['path'] ?? ''), '/privacidade-conta.html')) {
            return null;
        }
        $origem = self::origem($partes);
        return in_array($origem, $this->origensConfiaveis(), true) ? $origem . $partes['path'] : null;
    }

    /** @return string[] */
    private function origensConfiaveis(): array
    {
        $origens = [];
        foreach (explode(',', (string) Env::get('CORS_ALLOWED_ORIGIN', '')) as $origem) {
            $origem = rtrim(trim($origem), '/');
            if ($origem !== '' && $origem !== '*') {
                $origens[] = $origem;
            }
        }
        foreach (['APP_URL', 'HYDRA_FRONTEND_URL'] as $chave) {
            $partes = parse_url((string) Env::get($chave, ''));
            if (is_array($partes) && !empty($partes['scheme']) && !empty($partes['host'])) {
                $origens[] = self::origem($partes);
            }
        }
        // Front e API no mesmo domínio (imagem Docker/Render).
        $host = (string) ($_SERVER['HTTP_HOST'] ?? '');
        if ($host !== '') {
            $origens[] = 'https://' . $host;
            $origens[] = 'http://' . $host;
        }
        return $origens;
    }

    /** @param array<string,mixed> $partes retorno de parse_url() */
    private static function origem(array $partes): string
    {
        return strtolower($partes['scheme'] . '://' . $partes['host'])
            . (isset($partes['port']) ? ':' . $partes['port'] : '');
    }
}
