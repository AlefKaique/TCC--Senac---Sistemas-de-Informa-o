<?php

namespace Hydra\Support;

use Hydra\Repositories\AssinaturaRepository;
use Hydra\Repositories\AuditoriaPlataformaRepository;

/**
 * Confere no Mercado Pago (conta da Hydra) um checkout de assinatura e libera
 * o plano quando há pagamento aprovado.
 *
 * Usada pela tela Privacidade (retorno do navegador e botão "Verificar
 * pagamento"), pelo webhook e pelo painel da plataforma ("Conferir no
 * Mercado Pago"). Nada vindo do navegador vale como prova: o pagamento é
 * sempre relido na API do Mercado Pago, e o valor e a moeda precisam bater
 * com o checkout criado pelo Hydra.
 */
final class ConferenciaAssinatura
{
    private AssinaturaRepository $assinaturas;

    public function __construct(?AssinaturaRepository $assinaturas = null)
    {
        $this->assinaturas = $assinaturas ?? new AssinaturaRepository();
    }

    /**
     * Procura um pagamento aprovado do checkout e o aplica. Devolve
     * 'aprovado', 'pendente' (PIX/boleto aguardando), 'rejeitado' ou
     * 'nao_encontrado'. Um mesmo checkout pode ter várias tentativas (um
     * cartão recusado e depois um PIX aprovado), por isso olha todas.
     *
     * @param array<string,mixed> $pagamento linha de assinatura_pagamentos
     * @param string|null $paymentId id do pagamento no Mercado Pago, se já conhecido
     */
    public function conferir(array $pagamento, ?string $paymentId = null): string
    {
        $referencia = (string) $pagamento['id_pagamento'];
        $situacao = 'nao_encontrado';

        $lotes = [];
        if ($paymentId !== null && $paymentId !== '') {
            // Consulta direta: a busca por referência pode demorar alguns
            // segundos para enxergar um pagamento recém-feito.
            $lotes[] = static fn (): array => [MercadoPagoClient::consultarPagamentoAssinatura($paymentId)];
        }
        $lotes[] = static fn (): array => MercadoPagoClient::buscarPagamentosAssinatura($referencia);

        foreach ($lotes as $buscar) {
            foreach ($buscar() as $mp) {
                if ((string) ($mp['external_reference'] ?? '') !== $referencia) {
                    continue;
                }
                $status = (string) ($mp['status'] ?? '');
                if ($status === 'approved') {
                    if (!self::confere($mp, $pagamento)) {
                        error_log('[Hydra] Pagamento de assinatura ' . $referencia . ' aprovado com valor ou moeda divergente.');
                        continue;
                    }
                    $this->aplicar($pagamento, $mp);
                    return 'aprovado';
                }
                if (in_array($status, ['pending', 'in_process', 'in_mediation', 'authorized'], true)) {
                    $situacao = 'pendente';
                } elseif ($situacao === 'nao_encontrado') {
                    $situacao = 'rejeitado';
                }
            }
        }
        return $situacao;
    }

    /**
     * Webhook: aplica o pagamento já relido na API do Mercado Pago, se for de
     * um checkout de assinatura, estiver aprovado e o valor conferir.
     *
     * @param array<string,mixed> $mp
     */
    public function aplicarNotificacao(array $mp): void
    {
        $referencia = strtolower((string) ($mp['external_reference'] ?? ''));
        $pagamento = preg_match('/^[a-f0-9-]{36}$/', $referencia) ? $this->assinaturas->pagamentoSemLoja($referencia) : null;
        if ($pagamento !== null
            && ($pagamento['origem'] ?? 'mercado_pago') === 'mercado_pago'
            && ($mp['status'] ?? '') === 'approved'
            && self::confere($mp, $pagamento)) {
            $this->aplicar($pagamento, $mp);
        }
    }

    /**
     * Libera o plano e registra na auditoria só quando ESTA chamada aplicou
     * o pagamento (retorno do navegador, webhook e painel podem chegar juntos).
     *
     * @param array<string,mixed> $pagamento
     * @param array<string,mixed> $mp
     */
    private function aplicar(array $pagamento, array $mp): void
    {
        if ($this->assinaturas->aprovar((string) $pagamento['id_pagamento'], (string) $mp['id'], self::forma($mp))) {
            AuditoriaPlataformaRepository::registrarSemFalhar(
                null,
                'assinatura_paga_titular',
                (int) $pagamento['id_loja'],
                'Pagamento aprovado no Mercado Pago: ' . AssinaturaRepository::PLANOS[$pagamento['plano']]['nome']
                    . ' (R$ ' . number_format((float) $pagamento['valor'], 2, ',', '.') . ')'
            );
        }
    }

    /**
     * @param array<string,mixed> $mp pagamento lido na API do Mercado Pago
     * @param array<string,mixed> $pagamento linha de assinatura_pagamentos
     */
    private static function confere(array $mp, array $pagamento): bool
    {
        return strtoupper((string) ($mp['currency_id'] ?? '')) === 'BRL'
            && abs((float) ($mp['transaction_amount'] ?? 0) - (float) $pagamento['valor']) <= 0.01;
    }

    /**
     * Meio de pagamento usado no Mercado Pago, nos códigos de
     * AssinaturaRepository::FORMAS.
     *
     * @param array<string,mixed> $mp
     */
    private static function forma(array $mp): string
    {
        if ((string) ($mp['payment_method_id'] ?? '') === 'pix') {
            return 'pix';
        }
        return match ((string) ($mp['payment_type_id'] ?? '')) {
            'credit_card', 'debit_card', 'prepaid_card' => 'cartao',
            'ticket', 'atm' => 'boleto',
            'bank_transfer' => 'pix',
            default => 'mercado_pago',
        };
    }
}
