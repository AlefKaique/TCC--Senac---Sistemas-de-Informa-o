<?php

namespace Hydra\Controllers;

use Hydra\Repositories\MercadoPagoRepository;
use Hydra\Repositories\MovimentacaoEstoqueRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Repositories\PromocaoRepository;
use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\VendaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\MercadoPagoClient;
use Hydra\Support\Response;
use RuntimeException;
use Throwable;

final class PixController
{
    private MercadoPagoRepository $mercadoPago;
    private ProdutoRepository $produtos;
    private VendaRepository $vendas;
    private PromocaoRepository $promocoes;
    private MovimentacaoEstoqueRepository $movimentacoes;

    public function __construct()
    {
        $this->mercadoPago = new MercadoPagoRepository();
        $this->produtos = new ProdutoRepository();
        $this->vendas = new VendaRepository();
        $this->promocoes = new PromocaoRepository();
        $this->movimentacoes = new MovimentacaoEstoqueRepository();
    }

    public function conta(): void
    {
        $user = Auth::requirePermission('loja.configurar');
        $conta = $this->mercadoPago->conta($user['id_loja']);
        Response::json([
            'configurado' => MercadoPagoClient::configurado(),
            'conectada' => $conta !== null,
            'mp_user_id' => $conta['mp_user_id'] ?? null,
        ]);
    }

    public function conectar(): void
    {
        Auth::requirePermission('loja.configurar');
        if (!MercadoPagoClient::configurado()) {
            Response::json(['erro' => 'A integração precisa ser configurada no servidor antes de conectar a conta Mercado Pago.'], 503);
            return;
        }

        $state = bin2hex(random_bytes(32));
        Auth::reabrirSessao();
        $_SESSION['mercadopago_oauth_state'] = $state;
        Auth::liberarSessao();
        Response::json(['authorization_url' => MercadoPagoClient::authorizationUrl($state)]);
    }

    public function callback(): void
    {
        $user = Auth::requirePermission('loja.configurar');
        $stateRecebido = (string) ($_GET['state'] ?? '');
        Auth::reabrirSessao();
        $stateEsperado = (string) ($_SESSION['mercadopago_oauth_state'] ?? '');
        unset($_SESSION['mercadopago_oauth_state']);
        Auth::liberarSessao();

        $frontend = rtrim((string) Env::get('HYDRA_FRONTEND_URL', ''), '/');
        if ($frontend === '' || $stateEsperado === '' || !hash_equals($stateEsperado, $stateRecebido)) {
            Response::json(['erro' => 'A conexão Mercado Pago expirou ou não corresponde a esta sessão. Inicie novamente.'], 400);
            return;
        }
        if (isset($_GET['error']) || empty($_GET['code'])) {
            header('Location: ' . $frontend . '?mercadopago=cancelada', true, 302);
            return;
        }

        try {
            $token = MercadoPagoClient::trocarCodigo((string) $_GET['code']);
            if (empty($token['access_token']) || empty($token['refresh_token']) || empty($token['user_id'])) {
                throw new RuntimeException('O Mercado Pago não retornou os dados necessários para conectar a conta.');
            }
            $expiraEm = (new \DateTimeImmutable('+' . max(60, (int) ($token['expires_in'] ?? 0)) . ' seconds'))
                ->format('Y-m-d H:i:s');
            $this->mercadoPago->salvarConta(
                (int) $user['id_loja'],
                (string) $token['user_id'],
                MercadoPagoClient::criptografar((string) $token['access_token']),
                MercadoPagoClient::criptografar((string) $token['refresh_token']),
                $expiraEm
            );
            header('Location: ' . $frontend . '?mercadopago=conectada', true, 302);
        } catch (Throwable $e) {
            error_log('[Hydra] Mercado Pago OAuth connection failed: ' . $e->getMessage());
            header('Location: ' . $frontend . '?mercadopago=erro', true, 302);
        }
    }

    public function desconectar(): void
    {
        $user = Auth::requirePermission('loja.configurar');
        if (!$this->mercadoPago->desconectarSeSemCobrancaAtiva((int) $user['id_loja'])) {
            Response::json(['erro' => 'Aguarde a conclusão ou o vencimento das cobranças Pix pendentes antes de desconectar a conta.'], 409);
            return;
        }
        Response::json(['ok' => true]);
    }

    public function criarPagamento(): void
    {
        $user = Auth::requirePermissionNaFilial('vendas.operar');
        $conta = $this->mercadoPago->conta((int) $user['id_loja']);
        if ($conta === null) {
            Response::json(['erro' => 'Conecte a conta Mercado Pago da loja nas Configurações antes de receber Pix por QR Code.'], 409);
            return;
        }

        $dados = \Hydra\Support\Request::json();
        $emailPagador = trim((string) ($dados['payer_email'] ?? ''));
        if (filter_var($emailPagador, FILTER_VALIDATE_EMAIL) === false) {
            Response::json(['erro' => 'Informe um e-mail válido do cliente para gerar a cobrança Pix.'], 422);
            return;
        }
        $entrada = $dados['itens'] ?? [];
        if (!is_array($entrada) || count($entrada) === 0 || count($entrada) > 100) {
            Response::json(['erro' => 'Adicione de 1 a 100 itens para gerar a cobrança Pix.'], 422);
            return;
        }

        $quantidadePorProduto = [];
        foreach ($entrada as $item) {
            $idProduto = (int) ($item['id_produto'] ?? 0);
            $quantidade = $item['quantidade'] ?? null;
            if ($idProduto <= 0 || !is_numeric($quantidade) || (float) $quantidade <= 0) {
                Response::json(['erro' => 'Há um item ou uma quantidade inválida no pedido.'], 422);
                return;
            }
            $quantidadePorProduto[$idProduto] = ($quantidadePorProduto[$idProduto] ?? 0.0) + (float) $quantidade;
        }

        // Produtos e promoções vigentes em duas consultas para o pedido
        // inteiro, em vez de duas por produto (até 100 itens).
        $produtosDoPedido = $this->produtos->findManyInFilial(array_keys($quantidadePorProduto), (int) $user['id_filial']);
        $promocoesVigentes = $this->promocoes->vigentesPorProduto((int) $user['id_filial']);
        $itens = [];
        $valorTotal = 0.0;
        foreach ($quantidadePorProduto as $idProduto => $quantidade) {
            $produto = $produtosDoPedido[(int) $idProduto] ?? null;
            if ($produto === null || $produto['status'] !== 'ativo') {
                Response::json(['erro' => 'Um dos produtos não está disponível nesta filial.'], 422);
                return;
            }
            if ($produto['preco_venda'] === null) {
                Response::json(['erro' => 'Defina o preço deste item antes de vender: ' . $produto['nome']], 422);
                return;
            }
            if ($quantidade > (float) $produto['quantidade']) {
                Response::json(['erro' => 'Estoque insuficiente para ' . $produto['nome']], 409);
                return;
            }
            $preco = $promocoesVigentes[(int) $idProduto]['preco_promocional']
                ?? (float) $produto['preco_venda'];
            $itens[] = [
                'id_produto' => (int) $idProduto,
                'quantidade' => $quantidade,
                'preco_unitario' => $preco,
            ];
            $valorTotal += $preco * $quantidade;
        }
        $valorTotal = round($valorTotal, 2);
        if ($valorTotal <= 0) {
            Response::json(['erro' => 'O total da cobrança Pix precisa ser maior que zero.'], 422);
            return;
        }
        if ($this->mercadoPago->pagamentoAtivo(
            (int) $user['id_loja'],
            (int) $user['id_usuario']
        ) !== null) {
            Response::json([
                'erro' => 'Este operador já possui uma cobrança Pix pendente. Retome a cobrança existente ou aguarde o vencimento antes de gerar outra.',
                'codigo' => 'pix_cobranca_pendente',
            ], 409);
            return;
        }

        try {
            $accessToken = $this->accessToken($conta, (int) $user['id_loja']);
        } catch (Throwable $e) {
            error_log('[Hydra] Mercado Pago token unavailable: ' . $e->getMessage());
            Response::json(['erro' => 'A conexão Mercado Pago expirou. Reconecte a conta nas Configurações da Loja.'], 409);
            return;
        }
        $idLocal = self::uuid();
        $expiraEm = (new \DateTimeImmutable('+30 minutes'))->format('Y-m-d H:i:s');
        $pdo = db();
        $pdo->beginTransaction();
        try {
            if (!$this->mercadoPago->bloquearConta((int) $user['id_loja'])) {
                throw new RuntimeException('A conta Mercado Pago foi desconectada. Conecte novamente nas Configurações da Loja.');
            }
            if ($this->mercadoPago->pagamentoAtivo(
                (int) $user['id_loja'],
                (int) $user['id_usuario']
            ) !== null) {
                $pdo->rollBack();
                Response::json([
                    'erro' => 'Este operador já possui uma cobrança Pix pendente. Retome a cobrança existente ou aguarde o vencimento antes de gerar outra.',
                    'codigo' => 'pix_cobranca_pendente',
                ], 409);
                return;
            }
            $this->mercadoPago->criarPagamento(
                $idLocal,
                (int) $user['id_loja'],
                (int) $user['id_filial'],
                (int) $user['id_usuario'],
                $itens,
                $valorTotal,
                $expiraEm
            );
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('[Hydra] Failed to create local Mercado Pago PIX record: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível iniciar a cobrança Pix. Confira a conexão da conta Mercado Pago.'], 409);
            return;
        }

        try {
            $pagamento = MercadoPagoClient::criarPix(
                $accessToken,
                $idLocal,
                $valorTotal,
                $emailPagador,
                'Venda Hydra ' . $idLocal
            );
            $dadosPix = $pagamento['point_of_interaction']['transaction_data'] ?? [];
            if (empty($pagamento['id']) || empty($dadosPix['qr_code']) || empty($dadosPix['qr_code_base64'])) {
                throw new RuntimeException('Mercado Pago não retornou os dados do QR Code Pix.');
            }
            $this->mercadoPago->anexarPagamentoMercadoPago(
                $idLocal,
                (string) $pagamento['id'],
                (string) $dadosPix['qr_code'],
                (string) $dadosPix['qr_code_base64'],
                isset($dadosPix['ticket_url']) ? (string) $dadosPix['ticket_url'] : null
            );
        } catch (Throwable $e) {
            $this->mercadoPago->marcarFalhaCriacao($idLocal);
            error_log('[Hydra] Mercado Pago PIX create failed: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível gerar a cobrança Pix. Confira a conexão Mercado Pago e tente novamente.'], 502);
            return;
        }

        Response::json([
            'id' => $idLocal,
            'valor' => $valorTotal,
            'expira_em' => $expiraEm,
            'qr_code' => $dadosPix['qr_code'],
            'qr_code_base64' => $dadosPix['qr_code_base64'],
            'ticket_url' => $dadosPix['ticket_url'] ?? null,
            'status' => 'pending',
        ], 201);
    }

    public function status(string $id): void
    {
        $user = Auth::requirePermission('vendas.operar');
        if (!preg_match('/^[a-f0-9-]{36}$/i', $id)) {
            Response::json(['erro' => 'Identificador de pagamento inválido.'], 422);
            return;
        }
        $pendente = $this->mercadoPago->pagamento(
            $id,
            (int) $user['id_loja'],
            (int) $user['id_usuario']
        );
        if ($pendente === null) {
            Response::json(['erro' => 'Cobrança Pix não encontrada nesta sessão de caixa.'], 404);
            return;
        }
        if (!(new FilialRepository())->podeAcessar(
            (int) $user['id_usuario'],
            (int) $user['id_loja'],
            Auth::ehAdministrador(),
            (int) $pendente['id_filial']
        )) {
            Response::json(['erro' => 'Você não tem mais acesso à filial desta cobrança Pix.'], 403);
            return;
        }
        $user['id_filial'] = (int) $pendente['id_filial'];
        if ($pendente['status'] === 'concluido' && $pendente['id_venda'] !== null) {
            Response::json(['status' => 'approved', 'venda' => $this->dadosVenda((int) $pendente['id_venda'], (int) $user['id_filial'])]);
            return;
        }
        if (in_array($pendente['status'], ['rejeitado', 'cancelado', 'expirado'], true)) {
            Response::json(['status' => $pendente['status']]);
            return;
        }
        $localExpirou = new \DateTimeImmutable($pendente['expira_em']) < new \DateTimeImmutable();
        if (empty($pendente['id_mp'])) {
            $this->mercadoPago->atualizarStatus($id, 'rejeitado');
            Response::json(['status' => 'rejeitado']);
            return;
        }

        try {
            $conta = $this->mercadoPago->conta((int) $user['id_loja']);
            if ($conta === null) {
                throw new RuntimeException('A conta Mercado Pago foi desconectada durante a cobrança.');
            }
            $pagamento = MercadoPagoClient::consultarPagamento(
                $this->accessToken($conta, (int) $user['id_loja']),
                (string) $pendente['id_mp']
            );
        } catch (Throwable $e) {
            error_log('[Hydra] Mercado Pago PIX status failed: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível consultar o pagamento Pix. A cobrança continua ativa; tente novamente.'], 502);
            return;
        }

        $statusMp = (string) ($pagamento['status'] ?? '');
        if ($statusMp !== 'approved') {
            if (in_array($statusMp, ['rejected', 'cancelled', 'refunded', 'charged_back'], true)) {
                $status = $statusMp === 'cancelled' ? 'cancelado' : 'rejeitado';
                $this->mercadoPago->atualizarStatus($id, $status);
                Response::json(['status' => $status]);
                return;
            }
            if ($localExpirou) {
                $this->mercadoPago->atualizarStatus($id, 'expirado');
                Response::json(['status' => 'expired']);
                return;
            }
            // O Caixa consulta a cada poucos segundos; depois que o QR já está
            // na tela ele pede ?sem_qr=1 e a imagem (dezenas de KB em base64)
            // deixa de ir em toda resposta.
            Response::json($this->respostaPendente($pendente, ($_GET['sem_qr'] ?? '') !== '1'));
            return;
        }

        if ((string) ($pagamento['external_reference'] ?? '') !== $id
            || strtoupper((string) ($pagamento['currency_id'] ?? '')) !== 'BRL'
            || abs((float) ($pagamento['transaction_amount'] ?? 0) - (float) $pendente['valor']) > 0.01
            || (string) ($pagamento['collector_id'] ?? '') !== (string) $conta['mp_user_id']) {
            error_log('[Hydra] Mercado Pago PIX payment validation mismatch for local payment ' . $id);
            Response::json(['erro' => 'O pagamento foi aprovado, mas não passou pela validação de segurança. Contate o suporte.'], 409);
            return;
        }

        try {
            $venda = $this->concluirVenda($id, $user);
            Response::json(['status' => 'approved', 'venda' => $venda]);
        } catch (RuntimeException $e) {
            Response::json([
                'status' => 'approved',
                'erro' => $e->getMessage(),
                'codigo' => 'pix_aprovado_venda_pendente',
            ], 409);
        } catch (Throwable $e) {
            error_log('[Hydra] Failed to record approved Mercado Pago PIX sale: ' . $e->getMessage());
            Response::json(['erro' => 'O pagamento foi aprovado, mas não foi possível registrar a venda. Contate o suporte.'], 500);
        }
    }

    public function pendenteAtual(): void
    {
        $user = Auth::requirePermission('vendas.operar');
        $pendente = $this->mercadoPago->pagamentoAtivo(
            (int) $user['id_loja'],
            (int) $user['id_usuario']
        );
        if ($pendente === null
            || !(new FilialRepository())->podeAcessar(
                (int) $user['id_usuario'],
                (int) $user['id_loja'],
                Auth::ehAdministrador(),
                (int) $pendente['id_filial']
            )) {
            Response::json(['pagamento' => null]);
            return;
        }
        Response::json([
            'pagamento' => array_merge(
                ['id' => $pendente['id_pagamento_pix']],
                $this->respostaPendente($pendente)
            ),
        ]);
    }

    /** @param array<string,mixed> $user
     *  @return array<string,mixed>
     */
    private function concluirVenda(string $id, array $user): array
    {
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $pendente = $this->mercadoPago->pagamento(
                $id,
                (int) $user['id_loja'],
                (int) $user['id_usuario'],
                true
            );
            if ($pendente === null) {
                throw new RuntimeException('Cobrança Pix não encontrada.');
            }
            if ($pendente['status'] === 'concluido' && $pendente['id_venda'] !== null) {
                $idVenda = (int) $pendente['id_venda'];
                $pdo->commit();
                return $this->dadosVenda($idVenda, (int) $user['id_filial']);
            }

            $itens = json_decode((string) $pendente['itens_json'], true, 512, JSON_THROW_ON_ERROR);
            $subtotal = 0.0;
            $itensGravar = [];
            $saidas = [];
            foreach ($itens as $item) {
                $produto = $this->produtos->findInFilial((int) $item['id_produto'], (int) $user['id_filial']);
                if ($produto === null || $produto['status'] !== 'ativo') {
                    throw new RuntimeException('O pagamento foi aprovado, mas um produto não está mais ativo. Verifique a venda e o pagamento.');
                }
                if (!$this->produtos->baixarQuantidadeSeHouver((int) $item['id_produto'], (float) $item['quantidade'])) {
                    throw new RuntimeException('O pagamento foi aprovado, mas o estoque mudou. Reponha o estoque e consulte o pagamento novamente.');
                }
                // Custo da época da venda, com a linha do produto já travada
                // pelo UPDATE acima (mesmo critério de VendaController::store).
                $itensGravar[] = [
                    'id_produto' => (int) $item['id_produto'],
                    'quantidade' => (float) $item['quantidade'],
                    'preco_unitario' => (float) $item['preco_unitario'],
                    'custo_unitario' => $this->vendas->custoAtualProdutoBloqueado((int) $item['id_produto']),
                ];
                $idProdutoItem = (int) $item['id_produto'];
                $saidas[$idProdutoItem] = (string) ((float) ($saidas[$idProdutoItem] ?? 0) + (float) $item['quantidade']);
                $subtotal += (float) $item['preco_unitario'] * (float) $item['quantidade'];
            }
            $subtotal = round($subtotal, 2);
            if (abs($subtotal - (float) $pendente['valor']) > 0.01) {
                throw new \LogicException('O total dos itens não corresponde ao valor Pix confirmado.');
            }

            $idVenda = $this->vendas->create(
                (int) $user['id_loja'],
                (int) $user['id_filial'],
                (int) $user['id_usuario'],
                null,
                $subtotal,
                0,
                $subtotal
            );
            // Antes: addItem() era chamado sem o custo (argumento obrigatório),
            // o que estourava ArgumentCountError e impedia gravar QUALQUER
            // venda paga por Pix. Agora grava itens e saídas de estoque de uma
            // vez, como a venda comum.
            $this->vendas->addItens($idVenda, $itensGravar);
            $this->movimentacoes->createMany(
                (int) $user['id_loja'],
                (int) $user['id_filial'],
                (int) $user['id_usuario'],
                $idVenda,
                'saida',
                $saidas,
                'venda'
            );
            $this->vendas->addPagamento($idVenda, 'pix', $subtotal);
            $this->mercadoPago->concluir($id, $idVenda);
            $pdo->commit();
            return $this->dadosVenda($idVenda, (int) $user['id_filial']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** @return array<string,mixed> */
    private function dadosVenda(int $idVenda, int $idFilial): array
    {
        $venda = $this->vendas->findInFilial($idVenda, $idFilial);
        if ($venda === null) {
            throw new RuntimeException('Venda aprovada não foi encontrada.');
        }
        $venda['itens'] = $this->vendas->listItensByVenda($idVenda);
        $venda['pagamentos'] = $this->vendas->listPagamentosByVenda($idVenda);
        return $venda;
    }

    /** @param array<string,mixed> $pendente
     *  @return array<string,mixed>
     */
    private function respostaPendente(array $pendente, bool $incluirQr = true): array
    {
        $resposta = [
            'status' => 'pending',
            'valor' => (float) $pendente['valor'],
            'expira_em' => $pendente['expira_em'],
        ];
        if ($incluirQr) {
            $resposta['qr_code'] = $pendente['qr_code'];
            $resposta['qr_code_base64'] = $pendente['qr_code_base64'];
            $resposta['ticket_url'] = $pendente['ticket_url'];
        }
        return $resposta;
    }

    /** @param array<string,mixed> $conta */
    private function accessToken(array $conta, int $idLoja): string
    {
        if (new \DateTimeImmutable($conta['expira_em']) <= new \DateTimeImmutable('+2 minutes')) {
            $refresh = MercadoPagoClient::descriptografar((string) $conta['refresh_token']);
            $token = MercadoPagoClient::renovarToken($refresh);
            if (empty($token['access_token']) || empty($token['refresh_token'])) {
                throw new RuntimeException('Não foi possível renovar a conexão Mercado Pago.');
            }
            $this->mercadoPago->salvarConta(
                $idLoja,
                (string) $conta['mp_user_id'],
                MercadoPagoClient::criptografar((string) $token['access_token']),
                MercadoPagoClient::criptografar((string) $token['refresh_token']),
                (new \DateTimeImmutable('+' . max(60, (int) ($token['expires_in'] ?? 0)) . ' seconds'))->format('Y-m-d H:i:s')
            );
            return (string) $token['access_token'];
        }
        return MercadoPagoClient::descriptografar((string) $conta['access_token']);
    }

    private static function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        $hex = bin2hex($data);
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4)
            . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
    }
}
