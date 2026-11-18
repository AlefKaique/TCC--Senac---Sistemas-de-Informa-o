<?php

namespace Hydra\Controllers;

use Hydra\Repositories\AdminPlataformaRepository;
use Hydra\Repositories\AssinaturaRepository;
use Hydra\Repositories\AuditoriaPlataformaRepository;
use Hydra\Repositories\PlataformaAssinaturaRepository;
use Hydra\Support\Auth;
use Hydra\Support\ConferenciaAssinatura;
use Hydra\Support\MercadoPagoClient;
use Hydra\Support\Request;
use Hydra\Support\Response;
use Throwable;

/**
 * Painel da plataforma → Assinaturas: a equipe Hydra controla, de longe, a
 * assinatura de todos os mercados.
 *
 *   - Consulta (todos os níveis): lista com situação (ativa, vencendo,
 *     atrasada, cancelada...), indicadores de cobrança e o histórico de
 *     pagamentos de cada mercado.
 *   - Ações (Administrador, Proprietário e Gestor — os mesmos que podem
 *     suspender um mercado): lançar pagamento recebido por fora, alterar
 *     plano ou vencimento, cancelar / desfazer o cancelamento e conferir no
 *     Mercado Pago um pagamento feito pelo titular. Suspender o mercado por
 *     falta de pagamento usa a rota que já existia (PlataformaController).
 *
 * Toda ação fica na auditoria da plataforma, na mesma transação.
 */
final class PlataformaAssinaturaController
{
    private const MOTIVO_MIN = 10;
    private const MOTIVO_MAX = 200;

    /** Máximo de períodos lançados de uma vez: 12 meses no Flex, 3 anos no Premium. */
    private const MAX_PERIODOS = ['flex' => 12, 'premium' => 3];

    /** GET /api/plataforma/assinaturas?situacao=&plano=&busca=&ordem=&pagina= */
    public function lista(): void
    {
        Auth::requirePlataforma();
        $situacao = trim((string) ($_GET['situacao'] ?? ''));
        if ($situacao !== '' && !in_array($situacao, PlataformaAssinaturaRepository::SITUACOES, true)) {
            Response::json(['erro' => 'Filtro de situação inválido.'], 422);
            return;
        }
        $plano = trim((string) ($_GET['plano'] ?? ''));
        if ($plano !== '' && !isset(AssinaturaRepository::PLANOS[$plano])) {
            Response::json(['erro' => 'Filtro de plano inválido.'], 422);
            return;
        }
        $ordem = trim((string) ($_GET['ordem'] ?? ''));
        if (!in_array($ordem, PlataformaAssinaturaRepository::ORDENS, true)) {
            $ordem = 'prioridade';
        }
        $pagina = max(1, min(100000, (int) ($_GET['pagina'] ?? 1)));

        $repositorio = new PlataformaAssinaturaRepository();
        Response::json(['resumo' => $repositorio->resumo()] + $repositorio->listar([
            'situacao' => $situacao,
            'plano' => $plano,
            'busca' => mb_substr(trim((string) ($_GET['busca'] ?? '')), 0, 100),
            'ordem' => $ordem,
        ], $pagina));
    }

    /** GET /api/plataforma/assinaturas/{idLoja} */
    public function detalhe(int $idLoja): void
    {
        $admin = Auth::requirePlataforma();
        $dados = (new PlataformaAssinaturaRepository())->detalhe($idLoja);
        if ($dados === null) {
            Response::json(['erro' => 'Mercado não encontrado.'], 404);
            return;
        }

        $planos = [];
        foreach (AssinaturaRepository::PLANOS as $codigo => $info) {
            $planos[] = [
                'codigo' => $codigo,
                'nome' => $info['nome'],
                'valor' => $info['valor'],
                'meses' => $info['meses'],
                'periodo' => $info['periodo'],
                'max_periodos' => self::MAX_PERIODOS[$codigo] ?? 0,
            ];
        }
        $formas = [];
        foreach (AssinaturaRepository::FORMAS_MANUAIS as $codigo) {
            $formas[] = ['codigo' => $codigo, 'nome' => AssinaturaRepository::FORMAS[$codigo]];
        }

        Response::json($dados + [
            'planos' => $planos,
            'formas' => $formas,
            'pagamento_online' => MercadoPagoClient::assinaturaConfigurada(),
            'pode_gerenciar' => in_array($admin['nivel'], AdminPlataformaRepository::GESTAO, true),
        ]);
    }

    /**
     * POST /api/plataforma/assinaturas/{idLoja}/pagamentos
     * { plano, periodos, valor, forma, pago_em: "Y-m-d", observacao?, inicio?: "vencimento"|"hoje" }
     */
    public function registrarPagamento(int $idLoja): void
    {
        $admin = Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $dados = Request::json();

        $plano = (string) ($dados['plano'] ?? '');
        if (!isset(self::MAX_PERIODOS[$plano])) {
            Response::json(['erro' => 'Escolha o Hydra Flex ou o Hydra Premium.', 'campo' => 'plano'], 422);
            return;
        }
        $info = AssinaturaRepository::PLANOS[$plano];
        $maximo = self::MAX_PERIODOS[$plano];
        $periodos = filter_var($dados['periodos'] ?? null, FILTER_VALIDATE_INT, [
            'options' => ['min_range' => 1, 'max_range' => $maximo],
        ]);
        if ($periodos === false) {
            Response::json([
                'erro' => 'Informe de 1 a ' . $maximo . ($plano === 'flex' ? ' meses.' : ' anos.'),
                'campo' => 'periodos',
            ], 422);
            return;
        }

        $forma = (string) ($dados['forma'] ?? '');
        if (!in_array($forma, AssinaturaRepository::FORMAS_MANUAIS, true)) {
            Response::json(['erro' => 'Escolha a forma de pagamento.', 'campo' => 'forma'], 422);
            return;
        }
        $valor = self::valor($dados['valor'] ?? null);
        if ($forma === 'cortesia') {
            $valor = 0.0;
        } elseif ($valor === null || $valor <= 0 || $valor > 100000) {
            Response::json([
                'erro' => 'Informe o valor recebido. Para liberar o plano sem cobrança, escolha a forma "Cortesia".',
                'campo' => 'valor',
            ], 422);
            return;
        }

        $pagoEm = self::data($dados['pago_em'] ?? null);
        $hoje = new \DateTimeImmutable('today');
        if ($pagoEm === null || $pagoEm > $hoje || $pagoEm < $hoje->modify('-1 year')) {
            Response::json(['erro' => 'Informe a data do pagamento (até hoje, no máximo 1 ano atrás).', 'campo' => 'pago_em'], 422);
            return;
        }

        $observacao = trim((string) ($dados['observacao'] ?? ''));
        if (mb_strlen($observacao, 'UTF-8') > 200) {
            Response::json(['erro' => 'A observação pode ter até 200 caracteres.', 'campo' => 'observacao'], 422);
            return;
        }
        if ($forma === 'cortesia' && mb_strlen($observacao, 'UTF-8') < self::MOTIVO_MIN) {
            Response::json(['erro' => 'Explique na observação o motivo da cortesia (mínimo de 10 caracteres).', 'campo' => 'observacao'], 422);
            return;
        }

        $assinaturas = new AssinaturaRepository();
        $auditoria = new AuditoriaPlataformaRepository();
        if (!$this->exigirContaAberta($assinaturas, $idLoja)) {
            return;
        }

        $meses = $periodos * $info['meses'];
        db()->beginTransaction();
        try {
            $resultado = $assinaturas->registrarPagamentoManual($idLoja, [
                'plano' => $plano,
                'meses' => $meses,
                'valor' => round($valor, 2),
                'forma' => $forma,
                // Lançado hoje: hora exata; data passada: meio-dia daquele dia.
                'pago_em' => $pagoEm == $hoje ? date('Y-m-d H:i:s') : $pagoEm->format('Y-m-d') . ' 12:00:00',
                'observacao' => $observacao === '' ? null : $observacao,
                'contar_do_vencimento' => ($dados['inicio'] ?? 'vencimento') !== 'hoje',
            ], $admin['id']);
            if ($resultado === null) {
                db()->rollBack();
                Response::json(['erro' => 'A conta deste mercado foi encerrada. Atualize a página.'], 409);
                return;
            }
            $auditoria->registrar(
                $admin['id'],
                'assinatura_pagamento_registrado',
                $idLoja,
                mb_substr(
                    $info['nome'] . ' · ' . self::duracao($meses) . ' · ' . self::dinheiro($valor)
                    . ' (' . AssinaturaRepository::FORMAS[$forma] . '), pago em ' . $pagoEm->format('d/m/Y')
                    . ' · válido até ' . self::dataBR($resultado['valido_ate'])
                    . ($observacao !== '' ? ' · ' . $observacao : ''),
                    0,
                    255
                )
            );
            db()->commit();
        } catch (Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            throw $e;
        }

        Response::json(['ok' => true, 'valido_ate' => $resultado['valido_ate']], 201);
    }

    /** POST /api/plataforma/assinaturas/{idLoja}/ajustar  { plano, valido_ate?: "Y-m-d", motivo } */
    public function ajustar(int $idLoja): void
    {
        $admin = Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $dados = Request::json();

        $plano = (string) ($dados['plano'] ?? '');
        if (!isset(AssinaturaRepository::PLANOS[$plano])) {
            Response::json(['erro' => 'Escolha o plano.', 'campo' => 'plano'], 422);
            return;
        }
        $validoAte = null;
        if ($plano !== 'start') {
            $data = self::data($dados['valido_ate'] ?? null);
            $hoje = new \DateTimeImmutable('today');
            if ($data === null || $data < $hoje->modify('-3 years') || $data > $hoje->modify('+5 years')) {
                Response::json(['erro' => 'Informe uma data de vencimento válida.', 'campo' => 'valido_ate'], 422);
                return;
            }
            // Vale até o fim do dia escolhido.
            $validoAte = $data->format('Y-m-d') . ' 23:59:59';
        }
        $motivo = $this->motivo($dados);
        if ($motivo === null) {
            return;
        }

        $assinaturas = new AssinaturaRepository();
        $auditoria = new AuditoriaPlataformaRepository();
        $antes = $this->exigirContaAberta($assinaturas, $idLoja);
        if ($antes === null) {
            return;
        }
        if ($antes['plano_contratado'] === $plano
            && ($plano === 'start' || substr((string) $antes['valido_ate'], 0, 10) === substr((string) $validoAte, 0, 10))) {
            Response::json(['erro' => 'O plano e o vencimento já são esses. Nada foi alterado.'], 422);
            return;
        }

        db()->beginTransaction();
        try {
            if (!$assinaturas->ajustar($idLoja, $plano, $validoAte)) {
                db()->rollBack();
                Response::json(['erro' => 'A conta deste mercado foi encerrada. Atualize a página.'], 409);
                return;
            }
            $auditoria->registrar(
                $admin['id'],
                'assinatura_ajustada',
                $idLoja,
                mb_substr(
                    self::descrever($antes['plano_contratado'], $antes['valido_ate'])
                    . ' → ' . self::descrever($plano, $validoAte) . '. Motivo: ' . $motivo,
                    0,
                    255
                )
            );
            db()->commit();
        } catch (Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            throw $e;
        }
        Response::json(['ok' => true]);
    }

    /**
     * POST /api/plataforma/assinaturas/{idLoja}/cancelar  { motivo }
     * Ativa: não renova, vale até o vencimento. Atrasada: encerra a cobrança
     * e a loja fica no plano gratuito.
     */
    public function cancelar(int $idLoja): void
    {
        $admin = Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $motivo = $this->motivo(Request::json());
        if ($motivo === null) {
            return;
        }

        $assinaturas = new AssinaturaRepository();
        $auditoria = new AuditoriaPlataformaRepository();
        $antes = $this->exigirContaAberta($assinaturas, $idLoja);
        if ($antes === null) {
            return;
        }
        if (!in_array($antes['situacao'], ['ativa', 'atrasada'], true)) {
            Response::json(['erro' => 'Só dá para cancelar uma assinatura ativa ou em atraso.'], 409);
            return;
        }

        db()->beginTransaction();
        try {
            if (!$assinaturas->cancelar($idLoja)) {
                db()->rollBack();
                Response::json(['erro' => 'A assinatura foi alterada por outra pessoa. Atualize a página.'], 409);
                return;
            }
            $auditoria->registrar(
                $admin['id'],
                'assinatura_cancelada_plataforma',
                $idLoja,
                mb_substr(
                    ($antes['situacao'] === 'atrasada'
                        ? 'Cobrança em atraso encerrada; a loja voltou ao plano gratuito'
                        : 'Não será renovada; vale até ' . self::dataBR($antes['valido_ate']))
                    . '. Motivo: ' . $motivo,
                    0,
                    255
                )
            );
            db()->commit();
        } catch (Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            throw $e;
        }
        Response::json(['ok' => true]);
    }

    /** POST /api/plataforma/assinaturas/{idLoja}/reativar — desfaz o cancelamento dentro do período. */
    public function reativar(int $idLoja): void
    {
        $admin = Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $assinaturas = new AssinaturaRepository();
        $auditoria = new AuditoriaPlataformaRepository();
        $antes = $this->exigirContaAberta($assinaturas, $idLoja);
        if ($antes === null) {
            return;
        }
        if ($antes['situacao'] !== 'cancelada') {
            Response::json(['erro' => 'Só dá para desfazer o cancelamento enquanto o período pago não terminou.'], 409);
            return;
        }

        db()->beginTransaction();
        try {
            if (!$assinaturas->reativar($idLoja)) {
                db()->rollBack();
                Response::json(['erro' => 'A assinatura foi alterada por outra pessoa. Atualize a página.'], 409);
                return;
            }
            $auditoria->registrar(
                $admin['id'],
                'assinatura_reativada_plataforma',
                $idLoja,
                'Cancelamento desfeito; volta a contar como ativa até ' . self::dataBR($antes['valido_ate'])
            );
            db()->commit();
        } catch (Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            throw $e;
        }
        Response::json(['ok' => true]);
    }

    /**
     * POST /api/plataforma/assinaturas/pagamentos/{id}/conferir
     * Relê no Mercado Pago um checkout do titular e libera o plano se estiver
     * pago — para quando o webhook falhou e o titular não voltou à tela.
     */
    public function conferir(string $id): void
    {
        $admin = Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $assinaturas = new AssinaturaRepository();
        $pagamento = $assinaturas->pagamentoSemLoja(strtolower($id));
        if ($pagamento === null) {
            Response::json(['erro' => 'Pagamento não encontrado.'], 404);
            return;
        }
        if (($pagamento['origem'] ?? 'mercado_pago') !== 'mercado_pago') {
            Response::json(['erro' => 'Só pagamentos feitos pelo Mercado Pago podem ser conferidos.'], 422);
            return;
        }
        if ($pagamento['status'] === 'aprovado') {
            Response::json(['status' => 'aprovado']);
            return;
        }
        if (!MercadoPagoClient::assinaturaConfigurada()) {
            Response::json(['erro' => 'O pagamento online não está configurado no servidor (MERCADOPAGO_ACCESS_TOKEN).'], 503);
            return;
        }

        try {
            $status = (new ConferenciaAssinatura($assinaturas))->conferir($pagamento);
        } catch (Throwable $e) {
            error_log('[Hydra] Painel: falha ao conferir pagamento da assinatura: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível consultar o Mercado Pago agora. Tente de novo em instantes.'], 502);
            return;
        }

        $rotulos = [
            'aprovado' => 'aprovado — plano liberado',
            'pendente' => 'aguardando pagamento',
            'rejeitado' => 'recusado',
            'nao_encontrado' => 'nenhuma tentativa de pagamento',
        ];
        AuditoriaPlataformaRepository::registrarSemFalhar(
            $admin['id'],
            'assinatura_pagamento_conferido',
            (int) $pagamento['id_loja'],
            'Conferiu no Mercado Pago o checkout do ' . AssinaturaRepository::PLANOS[$pagamento['plano']]['nome']
                . ' (' . self::dinheiro((float) $pagamento['valor']) . '): ' . ($rotulos[$status] ?? $status)
        );
        Response::json(['status' => $status]);
    }

    /* ================= Apoio ================= */

    /**
     * Estado atual da assinatura, ou null com a resposta de erro já enviada
     * (mercado inexistente ou conta encerrada pelo titular).
     *
     * @return array<string,mixed>|null
     */
    private function exigirContaAberta(AssinaturaRepository $assinaturas, int $idLoja): ?array
    {
        $estado = $assinaturas->estado($idLoja);
        if ($estado === null) {
            Response::json(['erro' => 'Mercado não encontrado.'], 404);
            return null;
        }
        if ($estado['situacao'] === 'conta_encerrada') {
            Response::json(['erro' => 'A conta deste mercado foi encerrada pelo titular. A assinatura não pode mais ser alterada.'], 409);
            return null;
        }
        return $estado;
    }

    /** @param array<string,mixed> $dados */
    private function motivo(array $dados): ?string
    {
        $motivo = trim((string) ($dados['motivo'] ?? ''));
        $tamanho = mb_strlen($motivo, 'UTF-8');
        if ($tamanho < self::MOTIVO_MIN || $tamanho > self::MOTIVO_MAX) {
            Response::json(['erro' => 'Explique o motivo com 10 a 200 caracteres.', 'campo' => 'motivo'], 422);
            return null;
        }
        return $motivo;
    }

    /** Aceita número JSON ou texto "100", "100.5", "100,50". */
    private static function valor(mixed $valor): ?float
    {
        if (is_int($valor) || is_float($valor)) {
            return (float) $valor;
        }
        if (!is_string($valor) || preg_match('/^\d{1,6}([.,]\d{1,2})?$/', trim($valor)) !== 1) {
            return null;
        }
        return (float) str_replace(',', '.', trim($valor));
    }

    private static function data(mixed $valor): ?\DateTimeImmutable
    {
        if (!is_string($valor) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $valor) !== 1) {
            return null;
        }
        $data = \DateTimeImmutable::createFromFormat('!Y-m-d', $valor);
        return $data !== false && $data->format('Y-m-d') === $valor ? $data : null;
    }

    private static function dataBR(?string $dataHora): string
    {
        return $dataHora ? date('d/m/Y', strtotime($dataHora)) : '—';
    }

    private static function dinheiro(float $valor): string
    {
        return 'R$ ' . number_format($valor, 2, ',', '.');
    }

    private static function duracao(int $meses): string
    {
        if ($meses % 12 === 0) {
            return $meses === 12 ? '1 ano' : ($meses / 12) . ' anos';
        }
        return $meses === 1 ? '1 mês' : $meses . ' meses';
    }

    private static function descrever(string $plano, ?string $validoAte): string
    {
        if ($plano === 'start') {
            return 'Hydra Start (gratuito)';
        }
        return AssinaturaRepository::PLANOS[$plano]['nome'] . ' até ' . self::dataBR($validoAte);
    }
}
