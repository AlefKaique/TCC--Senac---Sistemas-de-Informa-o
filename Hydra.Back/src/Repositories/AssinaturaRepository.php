<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/**
 * Plano da loja e pagamentos da assinatura.
 *
 * Modelo: cada pagamento aprovado libera o plano por um período (1 mês no
 * Hydra Flex, 12 no Hydra Premium). Não há cobrança automática: para
 * continuar depois do vencimento, a loja paga de novo — pelo Mercado Pago, na
 * tela Privacidade (só o titular), ou por fora (PIX direto, transferência...),
 * com o pagamento lançado pela equipe Hydra no painel da plataforma, em
 * Assinaturas (PlataformaAssinaturaController).
 *
 * Situações (SQL_SITUACAO):
 *   gratuito        - Hydra Start, sem plano pago
 *   ativa           - plano pago dentro do período
 *   cancelada       - não será renovada, mas ainda está no período pago
 *   atrasada        - o período terminou sem renovação nem cancelamento
 *   finalizada      - cancelada e com o período já terminado
 *   conta_encerrada - o titular encerrou a conta
 *
 * Fora do período (atrasada/finalizada) o plano que vale é o Hydra Start.
 *
 * Colunas em lojas: plano, plano_valido_ate, assinatura_cancelada_em,
 * conta_encerrada_em. Tabela: assinatura_pagamentos.
 * Ver Migracoes::garantirAssinaturas().
 */
final class AssinaturaRepository
{
    /** Os mesmos planos e preços da página inicial (pages/index.html). */
    public const PLANOS = [
        'start' => ['nome' => 'Hydra Start', 'valor' => 0.0, 'meses' => 0, 'ordem' => 0, 'periodo' => 'Gratuito'],
        'flex' => ['nome' => 'Hydra Flex', 'valor' => 100.0, 'meses' => 1, 'ordem' => 1, 'periodo' => 'Mensal'],
        'premium' => ['nome' => 'Hydra Premium', 'valor' => 1000.0, 'meses' => 12, 'ordem' => 2, 'periodo' => 'Anual'],
    ];

    /** Formas de pagamento gravadas em assinatura_pagamentos.forma. */
    public const FORMAS = [
        'pix' => 'PIX',
        'transferencia' => 'Transferência',
        'boleto' => 'Boleto',
        'cartao' => 'Cartão',
        'dinheiro' => 'Dinheiro',
        'mercado_pago' => 'Mercado Pago',
        'cortesia' => 'Cortesia',
        'outro' => 'Outro',
    ];

    /** As que a equipe Hydra pode escolher ao lançar um pagamento recebido por fora. */
    public const FORMAS_MANUAIS = ['pix', 'transferencia', 'boleto', 'cartao', 'dinheiro', 'cortesia', 'outro'];

    /** Por quantos dias um checkout iniciado e não pago aparece na tela (boleto leva até 3 dias úteis). */
    public const DIAS_PAGAMENTO_PENDENTE = 5;

    /** Situação da assinatura, calculada no banco. Exige a tabela lojas com o alias "l". */
    public const SQL_SITUACAO = "CASE
            WHEN l.conta_encerrada_em IS NOT NULL THEN 'conta_encerrada'
            WHEN l.plano = 'start' THEN 'gratuito'
            WHEN l.plano_valido_ate > NOW() AND l.assinatura_cancelada_em IS NOT NULL THEN 'cancelada'
            WHEN l.plano_valido_ate > NOW() THEN 'ativa'
            WHEN l.assinatura_cancelada_em IS NOT NULL THEN 'finalizada'
            ELSE 'atrasada'
        END";

    public function __construct()
    {
        // No construtor, antes de qualquer transação: DDL faz commit implícito.
        Migracoes::garantirAssinaturas();
    }

    /**
     * "plano" é o plano que vale AGORA; "plano_contratado" é o último pago.
     * "dias" = dias até o vencimento (negativo: dias em atraso).
     *
     * @return array{plano:string,plano_contratado:string,situacao:string,valido_ate:?string,cancelada_em:?string,dias:?int}|null
     */
    public function estado(int $idLoja): ?array
    {
        $stmt = db()->prepare(
            'SELECT l.plano, l.plano_valido_ate, l.assinatura_cancelada_em,
                    ' . self::SQL_SITUACAO . ' AS situacao,
                    DATEDIFF(l.plano_valido_ate, NOW()) AS dias
               FROM lojas l
              WHERE l.id_loja = :id_loja'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        return self::montarEstado($row);
    }

    /**
     * @param array<string,mixed> $row plano, plano_valido_ate, assinatura_cancelada_em, situacao, dias
     * @return array{plano:string,plano_contratado:string,situacao:string,valido_ate:?string,cancelada_em:?string,dias:?int}
     */
    public static function montarEstado(array $row): array
    {
        $contratado = (string) $row['plano'];
        $situacao = (string) $row['situacao'];
        $vigente = in_array($situacao, ['ativa', 'cancelada'], true);
        $pago = $contratado !== 'start';
        return [
            'plano' => $vigente ? $contratado : 'start',
            'plano_contratado' => $contratado,
            'situacao' => $situacao,
            'valido_ate' => $pago ? $row['plano_valido_ate'] : null,
            'cancelada_em' => $row['assinatura_cancelada_em'],
            'dias' => $pago && $row['dias'] !== null ? (int) $row['dias'] : null,
        ];
    }

    /**
     * Registra que a assinatura não será renovada. Dentro do período, o plano
     * continua até o vencimento (fica "cancelada"); em atraso, encerra a
     * cobrança na hora (fica "finalizada"). false se não havia o que cancelar.
     */
    public function cancelar(int $idLoja): bool
    {
        $stmt = db()->prepare(
            "UPDATE lojas
                SET assinatura_cancelada_em = NOW()
              WHERE id_loja = :id_loja
                AND plano <> 'start'
                AND assinatura_cancelada_em IS NULL
                AND conta_encerrada_em IS NULL"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->rowCount() === 1;
    }

    /** Desfaz o cancelamento enquanto o período pago não terminou. */
    public function reativar(int $idLoja): bool
    {
        $stmt = db()->prepare(
            "UPDATE lojas
                SET assinatura_cancelada_em = NULL
              WHERE id_loja = :id_loja
                AND plano <> 'start'
                AND plano_valido_ate > NOW()
                AND assinatura_cancelada_em IS NOT NULL
                AND conta_encerrada_em IS NULL"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->rowCount() === 1;
    }

    /* ============ Ações da equipe Hydra (painel da plataforma) ============ */
    // Chamar dentro de uma transação: o controller grava a auditoria junto.

    /**
     * Lança um pagamento recebido fora do Mercado Pago e estende o período.
     *
     * O período novo começa no vencimento atual, se o plano ainda vale. Em
     * atraso, a equipe escolhe: continuar do vencimento (a mensalidade
     * atrasada cobre os dias em que a loja usou sem pagar) ou começar hoje.
     *
     * @param array{plano:string,meses:int,valor:float,forma:string,pago_em:string,observacao:?string,contar_do_vencimento:bool} $dados
     * @return array{id:string,valido_de:string,valido_ate:string}|null null se a loja não existe ou a conta foi encerrada
     */
    public function registrarPagamentoManual(int $idLoja, array $dados, int $idAdmin): ?array
    {
        $loja = $this->travarLoja($idLoja);
        if ($loja === null || $loja['conta_encerrada_em'] !== null) {
            return null;
        }

        $vigente = (int) $loja['vigente'] === 1;
        $atrasada = !$vigente
            && $loja['plano'] !== 'start'
            && $loja['plano_valido_ate'] !== null
            && $loja['assinatura_cancelada_em'] === null;
        $inicio = $vigente || ($atrasada && $dados['contar_do_vencimento'])
            ? (string) $loja['plano_valido_ate']
            : (string) $loja['agora'];

        $meses = max(1, min(36, (int) $dados['meses']));
        // DATE_ADD do MySQL, a mesma conta do pagamento pelo Mercado Pago
        // (31/01 + 1 mês = 28 ou 29/02).
        $stmt = db()->prepare("SELECT DATE_ADD(:inicio, INTERVAL {$meses} MONTH)");
        $stmt->execute(['inicio' => $inicio]);
        $fim = (string) $stmt->fetchColumn();

        $id = self::novoId();
        db()->prepare(
            "INSERT INTO assinatura_pagamentos
                (id_pagamento, id_loja, plano, valor, meses, origem, forma, status,
                 pago_em, valido_de, valido_ate, observacao, id_admin)
             VALUES (:id, :id_loja, :plano, :valor, :meses, 'manual', :forma, 'aprovado',
                 :pago_em, :valido_de, :valido_ate, :observacao, :id_admin)"
        )->execute([
            'id' => $id,
            'id_loja' => $idLoja,
            'plano' => $dados['plano'],
            'valor' => number_format((float) $dados['valor'], 2, '.', ''),
            'meses' => $meses,
            'forma' => $dados['forma'],
            'pago_em' => $dados['pago_em'],
            'valido_de' => $inicio,
            'valido_ate' => $fim,
            'observacao' => $dados['observacao'],
            'id_admin' => $idAdmin,
        ]);
        db()->prepare(
            'UPDATE lojas
                SET plano = :plano, plano_valido_ate = :fim, assinatura_cancelada_em = NULL
              WHERE id_loja = :id_loja'
        )->execute(['plano' => $dados['plano'], 'fim' => $fim, 'id_loja' => $idLoja]);

        return ['id' => $id, 'valido_de' => $inicio, 'valido_ate' => $fim];
    }

    /**
     * Correção manual: troca o plano e/ou a data de vencimento. Voltar ao
     * Hydra Start limpa a data e o cancelamento. Num plano pago, um
     * cancelamento já registrado continua valendo.
     *
     * @param string|null $validoAte 'Y-m-d H:i:s'; ignorado no 'start'
     * @return bool false se a loja não existe ou a conta foi encerrada
     */
    public function ajustar(int $idLoja, string $plano, ?string $validoAte): bool
    {
        $loja = $this->travarLoja($idLoja);
        if ($loja === null || $loja['conta_encerrada_em'] !== null) {
            return false;
        }
        if ($plano === 'start') {
            db()->prepare(
                "UPDATE lojas
                    SET plano = 'start', plano_valido_ate = NULL, assinatura_cancelada_em = NULL
                  WHERE id_loja = :id_loja"
            )->execute(['id_loja' => $idLoja]);
        } else {
            db()->prepare(
                'UPDATE lojas SET plano = :plano, plano_valido_ate = :valido_ate WHERE id_loja = :id_loja'
            )->execute(['plano' => $plano, 'valido_ate' => $validoAte, 'id_loja' => $idLoja]);
        }
        return true;
    }

    /** @return array<string,mixed>|null a linha da loja, travada até o fim da transação */
    private function travarLoja(int $idLoja): ?array
    {
        $stmt = db()->prepare(
            "SELECT plano, plano_valido_ate, assinatura_cancelada_em, conta_encerrada_em,
                    NOW() AS agora,
                    (plano <> 'start' AND plano_valido_ate IS NOT NULL AND plano_valido_ate > NOW()) AS vigente
               FROM lojas
              WHERE id_loja = :id_loja
              FOR UPDATE"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $loja = $stmt->fetch();
        return $loja ?: null;
    }

    /* ================= Pagamentos (Mercado Pago) ================= */

    public function criarPagamento(string $id, int $idLoja, int $idUsuario, string $plano, float $valor, int $meses): void
    {
        db()->prepare(
            "INSERT INTO assinatura_pagamentos (id_pagamento, id_loja, id_usuario, plano, valor, meses, origem, status)
             VALUES (:id, :id_loja, :id_usuario, :plano, :valor, :meses, 'mercado_pago', 'criando')"
        )->execute([
            'id' => $id,
            'id_loja' => $idLoja,
            'id_usuario' => $idUsuario,
            'plano' => $plano,
            'valor' => number_format($valor, 2, '.', ''),
            'meses' => $meses,
        ]);
    }

    public function anexarPreferencia(string $id, string $idPreferencia): void
    {
        db()->prepare(
            "UPDATE assinatura_pagamentos
                SET id_preferencia = :id_preferencia, status = 'pendente'
              WHERE id_pagamento = :id AND status = 'criando'"
        )->execute(['id_preferencia' => $idPreferencia, 'id' => $id]);
    }

    /** Checkout que não chegou a abrir, ou abandonado sem pagamento nenhum. */
    public function descartar(string $id): void
    {
        db()->prepare(
            "UPDATE assinatura_pagamentos
                SET status = 'cancelado'
              WHERE id_pagamento = :id AND status IN ('criando', 'pendente')"
        )->execute(['id' => $id]);
    }

    /** Pagamento desta loja, ou null. */
    public function pagamento(string $id, int $idLoja): ?array
    {
        $stmt = db()->prepare(
            'SELECT * FROM assinatura_pagamentos WHERE id_pagamento = :id AND id_loja = :id_loja'
        );
        $stmt->execute(['id' => $id, 'id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** Pagamento por id, sem filtrar a loja: webhook (sem sessão) e painel da plataforma. */
    public function pagamentoSemLoja(string $id): ?array
    {
        $stmt = db()->prepare('SELECT * FROM assinatura_pagamentos WHERE id_pagamento = :id');
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** Checkout mais recente ainda aguardando pagamento, ou null. */
    public function pendenteRecente(int $idLoja): ?array
    {
        $stmt = db()->prepare(
            "SELECT * FROM assinatura_pagamentos
              WHERE id_loja = :id_loja
                AND status = 'pendente'
                AND criado_em > DATE_SUB(NOW(), INTERVAL " . self::DIAS_PAGAMENTO_PENDENTE . " DAY)
              ORDER BY criado_em DESC
              LIMIT 1"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** Minutos desde que o checkout foi criado (relógio do banco). */
    public function minutosDesdeCriacao(array $pagamento): int
    {
        $stmt = db()->prepare('SELECT TIMESTAMPDIFF(MINUTE, :criado_em, NOW())');
        $stmt->execute(['criado_em' => $pagamento['criado_em']]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Aplica um pagamento aprovado no Mercado Pago: estende o período da loja
     * e marca o pagamento como aprovado, numa transação.
     *
     * O período novo começa no fim do período pago atual (se ainda estiver
     * valendo) ou agora: quem renova antes do vencimento, ou passa do Flex
     * para o Premium no meio do mês, não perde os dias que já pagou.
     *
     * Idempotente: o retorno do navegador, o webhook e a conferência pelo
     * painel podem chegar ao mesmo tempo. Devolve false se o pagamento já
     * tinha sido aplicado (ou não existe).
     */
    public function aprovar(string $id, string $idMp, string $forma = 'mercado_pago'): bool
    {
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare('SELECT * FROM assinatura_pagamentos WHERE id_pagamento = :id FOR UPDATE');
            $stmt->execute(['id' => $id]);
            $pagamento = $stmt->fetch();
            if (!$pagamento || $pagamento['status'] === 'aprovado') {
                $pdo->commit();
                return false;
            }

            $meses = max(1, (int) $pagamento['meses']);
            $stmt = $pdo->prepare(
                "SELECT conta_encerrada_em,
                        IF(plano <> 'start' AND plano_valido_ate > NOW(), plano_valido_ate, NOW()) AS inicio,
                        DATE_ADD(
                            IF(plano <> 'start' AND plano_valido_ate > NOW(), plano_valido_ate, NOW()),
                            INTERVAL {$meses} MONTH
                        ) AS fim
                   FROM lojas
                  WHERE id_loja = :id_loja
                  FOR UPDATE"
            );
            $stmt->execute(['id_loja' => (int) $pagamento['id_loja']]);
            $loja = $stmt->fetch();

            if (!$loja || $loja['conta_encerrada_em'] !== null) {
                // Pago depois de a conta ser encerrada (ex.: PIX quitado mais
                // tarde): fica registrado, sem período, e o painel da
                // plataforma mostra "Devolver valor" para a equipe Hydra.
                $pdo->prepare(
                    "UPDATE assinatura_pagamentos
                        SET status = 'aprovado', id_mp = :id_mp, forma = :forma, pago_em = NOW()
                      WHERE id_pagamento = :id"
                )->execute(['id_mp' => $idMp, 'forma' => $forma, 'id' => $id]);
                $pdo->commit();
                error_log('[Hydra] Pagamento de assinatura ' . $id . ' aprovado para uma conta encerrada: providenciar reembolso.');
                return false;
            }

            $pdo->prepare(
                'UPDATE lojas
                    SET plano = :plano, plano_valido_ate = :fim, assinatura_cancelada_em = NULL
                  WHERE id_loja = :id_loja'
            )->execute([
                'plano' => $pagamento['plano'],
                'fim' => $loja['fim'],
                'id_loja' => (int) $pagamento['id_loja'],
            ]);
            $pdo->prepare(
                "UPDATE assinatura_pagamentos
                    SET status = 'aprovado', id_mp = :id_mp, forma = :forma, pago_em = NOW(),
                        valido_de = :inicio, valido_ate = :fim
                  WHERE id_pagamento = :id"
            )->execute([
                'id_mp' => $idMp,
                'forma' => $forma,
                'inicio' => $loja['inicio'],
                'fim' => $loja['fim'],
                'id' => $id,
            ]);
            $pdo->commit();
            return true;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** UUID v4: id_pagamento, que também vai como external_reference ao Mercado Pago. */
    public static function novoId(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        $hex = bin2hex($data);
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4)
            . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
    }
}
