<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/**
 * Consultas do painel da plataforma (Assinaturas): a situação da assinatura
 * de todos os mercados, os indicadores de cobrança e o histórico de
 * pagamentos de um mercado. As ações ficam em AssinaturaRepository.
 */
final class PlataformaAssinaturaRepository
{
    public const POR_PAGINA = 20;

    /** Filtros aceitos. "vencendo" = ativa e vence nos próximos 7 dias. */
    public const SITUACOES = ['ativa', 'vencendo', 'atrasada', 'cancelada', 'finalizada', 'gratuito', 'conta_encerrada'];

    public const ORDENS = ['prioridade', 'vencimento', 'nome', 'recentes'];

    /** Ações da auditoria que contam a história da assinatura de um mercado. */
    public const ACOES_HISTORICO = [
        'assinatura_paga_titular', 'assinatura_cancelada_titular', 'assinatura_reativada_titular',
        'assinatura_pagamento_registrado', 'assinatura_ajustada', 'assinatura_cancelada_plataforma',
        'assinatura_reativada_plataforma', 'assinatura_pagamento_conferido',
        'mercado_suspenso', 'mercado_reativado', 'conta_encerrada_titular',
    ];

    public function __construct()
    {
        Migracoes::garantirAssinaturas();
        Migracoes::garantirAdminsPlataforma();
    }

    /** Uma linha por loja, com a situação calculada no banco. */
    private static function sqlBase(): string
    {
        return 'SELECT l.id_loja, l.nome_loja, l.cnpj, l.telefone, l.cidade, l.estado,
                       l.status AS status_loja, l.motivo_status, l.status_alterado_em, l.data_criacao,
                       l.plano, l.plano_valido_ate, l.assinatura_cancelada_em, l.conta_encerrada_em,
                       ' . AssinaturaRepository::SQL_SITUACAO . ' AS situacao,
                       DATEDIFF(l.plano_valido_ate, NOW()) AS dias,
                       u.nome AS titular_nome, u.email AS titular_email
                  FROM lojas l
                  LEFT JOIN usuarios u ON u.id_usuario = l.id_usuario_titular';
    }

    /** @return array<string,mixed> indicadores do topo da tela */
    public function resumo(): array
    {
        $linhas = db()->query(
            "SELECT situacao, plano, COUNT(*) AS quantidade,
                    SUM(situacao = 'ativa' AND plano_valido_ate <= DATE_ADD(NOW(), INTERVAL 7 DAY)) AS vencendo
               FROM (" . self::sqlBase() . ") assinaturas
              GROUP BY situacao, plano"
        )->fetchAll();

        $quantidades = array_fill_keys(['ativa', 'atrasada', 'cancelada', 'finalizada', 'gratuito', 'conta_encerrada'], 0);
        $vencendo = 0;
        $receitaMensal = 0.0;
        $valorEmAtraso = 0.0;
        foreach ($linhas as $linha) {
            $situacao = (string) $linha['situacao'];
            $quantidade = (int) $linha['quantidade'];
            $quantidades[$situacao] = ($quantidades[$situacao] ?? 0) + $quantidade;
            $vencendo += (int) $linha['vencendo'];
            $plano = AssinaturaRepository::PLANOS[$linha['plano']] ?? null;
            if ($plano === null || $plano['meses'] === 0) {
                continue;
            }
            // Receita recorrente: o que as assinaturas ativas rendem por mês
            // (o Premium anual entra como 1/12 por mês).
            if ($situacao === 'ativa') {
                $receitaMensal += $quantidade * $plano['valor'] / $plano['meses'];
            }
            // Em atraso: um período de cada assinatura atrasada.
            if ($situacao === 'atrasada') {
                $valorEmAtraso += $quantidade * $plano['valor'];
            }
        }

        $stmt = db()->prepare(
            "SELECT COALESCE(SUM(valor), 0) FROM assinatura_pagamentos
              WHERE status = 'aprovado' AND pago_em >= :inicio"
        );
        $stmt->execute(['inicio' => date('Y-m-01 00:00:00')]);
        $recebidoNoMes = (float) $stmt->fetchColumn();

        $pendentes = (int) db()->query(
            "SELECT COUNT(*) FROM assinatura_pagamentos
              WHERE status = 'pendente'
                AND criado_em > DATE_SUB(NOW(), INTERVAL " . AssinaturaRepository::DIAS_PAGAMENTO_PENDENTE . ' DAY)'
        )->fetchColumn();

        // Pagos pelo Mercado Pago depois de a conta ser encerrada: o plano
        // não foi liberado (valido_de vazio) e o valor precisa ser devolvido.
        $aDevolver = (int) db()->query(
            "SELECT COUNT(*) FROM assinatura_pagamentos
              WHERE status = 'aprovado' AND origem = 'mercado_pago' AND valido_de IS NULL"
        )->fetchColumn();

        return [
            'ativas' => $quantidades['ativa'],
            'vencendo_7_dias' => $vencendo,
            'atrasadas' => $quantidades['atrasada'],
            'canceladas' => $quantidades['cancelada'],
            'finalizadas' => $quantidades['finalizada'],
            'gratuitas' => $quantidades['gratuito'],
            'contas_encerradas' => $quantidades['conta_encerrada'],
            'receita_mensal' => round($receitaMensal, 2),
            'valor_em_atraso' => round($valorEmAtraso, 2),
            'recebido_no_mes' => round($recebidoNoMes, 2),
            'checkouts_pendentes' => $pendentes,
            'pagamentos_a_devolver' => $aDevolver,
        ];
    }

    /**
     * @param array{situacao:string,plano:string,busca:string,ordem:string} $filtros
     * @return array{assinaturas:array<int,array<string,mixed>>,paginacao:array<string,int>}
     */
    public function listar(array $filtros, int $pagina): array
    {
        $where = [];
        $params = [];
        if ($filtros['situacao'] === 'vencendo') {
            $where[] = "situacao = 'ativa' AND plano_valido_ate <= DATE_ADD(NOW(), INTERVAL 7 DAY)";
        } elseif ($filtros['situacao'] !== '') {
            $where[] = 'situacao = :situacao';
            $params['situacao'] = $filtros['situacao'];
        }
        if ($filtros['plano'] !== '') {
            $where[] = 'plano = :plano';
            $params['plano'] = $filtros['plano'];
        }
        if ($filtros['busca'] !== '') {
            $where[] = '(nome_loja LIKE :busca_nome OR cnpj LIKE :busca_cnpj
                         OR titular_nome LIKE :busca_titular OR titular_email LIKE :busca_email)';
            $termo = '%' . addcslashes($filtros['busca'], '%_\\') . '%';
            $params['busca_nome'] = $termo;
            $params['busca_cnpj'] = $termo;
            $params['busca_titular'] = $termo;
            $params['busca_email'] = $termo;
        }
        $condicao = $where === [] ? '' : ' WHERE ' . implode(' AND ', $where);
        $ordem = match ($filtros['ordem']) {
            // Primeiro quem precisa de ação: atrasadas (a mais antiga antes),
            // depois as ativas que vencem antes.
            'prioridade' => "FIELD(situacao, 'atrasada', 'ativa', 'cancelada', 'finalizada', 'gratuito', 'conta_encerrada'),
                             CASE WHEN situacao IN ('atrasada', 'ativa', 'cancelada') THEN plano_valido_ate END ASC,
                             nome_loja ASC",
            'vencimento' => 'plano_valido_ate IS NULL, plano_valido_ate ASC, nome_loja ASC',
            'nome' => 'nome_loja ASC',
            default => 'data_criacao DESC',
        };
        $base = '(' . self::sqlBase() . ') assinaturas' . $condicao;

        $contagem = db()->prepare('SELECT COUNT(*) FROM ' . $base);
        $contagem->execute($params);
        $total = (int) $contagem->fetchColumn();

        $stmt = db()->prepare('SELECT * FROM ' . $base . ' ORDER BY ' . $ordem . ' LIMIT ' . self::POR_PAGINA . ' OFFSET :offset');
        foreach ($params as $chave => $valor) {
            $stmt->bindValue(':' . $chave, $valor);
        }
        $stmt->bindValue(':offset', ($pagina - 1) * self::POR_PAGINA, \PDO::PARAM_INT);
        $stmt->execute();
        $linhas = $stmt->fetchAll();

        [$ultimos, $comPendente] = $this->pagamentosDasLojas(array_map(static fn ($l) => (int) $l['id_loja'], $linhas));

        $assinaturas = array_map(static function (array $linha) use ($ultimos, $comPendente): array {
            $id = (int) $linha['id_loja'];
            return self::formatarLinha($linha) + [
                'ultimo_pagamento' => $ultimos[$id] ?? null,
                'pagamento_pendente' => isset($comPendente[$id]),
            ];
        }, $linhas);

        return [
            'assinaturas' => $assinaturas,
            'paginacao' => [
                'pagina' => $pagina,
                'por_pagina' => self::POR_PAGINA,
                'total' => $total,
                'total_paginas' => (int) ceil($total / self::POR_PAGINA),
            ],
        ];
    }

    /** @return array<string,mixed>|null tudo o que a tela de um mercado precisa */
    public function detalhe(int $idLoja): ?array
    {
        $stmt = db()->prepare('SELECT * FROM (' . self::sqlBase() . ') assinaturas WHERE id_loja = :id_loja');
        $stmt->execute(['id_loja' => $idLoja]);
        $linha = $stmt->fetch();
        if (!$linha) {
            return null;
        }

        $stmt = db()->prepare(
            "SELECT p.id_pagamento AS id, p.plano, p.valor, p.meses, p.origem, p.forma, p.status,
                    p.pago_em, p.criado_em, p.valido_de, p.valido_ate, p.id_mp, p.observacao,
                    ap.nome AS registrado_por, u.nome AS usuario_nome,
                    (p.status = 'aprovado' AND p.origem = 'mercado_pago' AND p.valido_de IS NULL) AS devolver
               FROM assinatura_pagamentos p
               LEFT JOIN admins_plataforma ap ON ap.id_admin = p.id_admin
               LEFT JOIN usuarios u ON u.id_usuario = p.id_usuario
              WHERE p.id_loja = :id_loja AND p.status <> 'criando'
              ORDER BY COALESCE(p.pago_em, p.criado_em) DESC
              LIMIT 50"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $pagamentos = array_map(static function (array $p): array {
            $p['valor'] = (float) $p['valor'];
            $p['meses'] = (int) $p['meses'];
            $p['devolver'] = (int) $p['devolver'] === 1;
            $p['nome_plano'] = AssinaturaRepository::PLANOS[$p['plano']]['nome'] ?? $p['plano'];
            $p['nome_forma'] = AssinaturaRepository::FORMAS[$p['forma'] ?? ''] ?? null;
            return $p;
        }, $stmt->fetchAll());

        $marcadores = [];
        $params = ['id_loja' => $idLoja];
        foreach (self::ACOES_HISTORICO as $i => $acao) {
            $marcadores[] = ':acao' . $i;
            $params['acao' . $i] = $acao;
        }
        $stmt = db()->prepare(
            'SELECT a.acao, a.detalhe, a.data, ap.nome AS membro
               FROM auditoria_plataforma a
               LEFT JOIN admins_plataforma ap ON ap.id_admin = a.id_admin
              WHERE a.id_loja = :id_loja AND a.acao IN (' . implode(', ', $marcadores) . ')
              ORDER BY a.data DESC, a.id_auditoria DESC
              LIMIT 30'
        );
        $stmt->execute($params);

        return [
            'assinatura' => self::formatarLinha($linha),
            'pagamentos' => $pagamentos,
            'historico' => $stmt->fetchAll(),
        ];
    }

    /** @param array<string,mixed> $linha linha de sqlBase() */
    private static function formatarLinha(array $linha): array
    {
        $estado = AssinaturaRepository::montarEstado($linha);
        $plano = AssinaturaRepository::PLANOS[$estado['plano_contratado']];
        return [
            'id' => (int) $linha['id_loja'],
            'nome' => $linha['nome_loja'],
            'cnpj' => $linha['cnpj'],
            'telefone' => $linha['telefone'],
            'cidade' => $linha['cidade'],
            'uf' => $linha['estado'],
            'status_loja' => $linha['status_loja'],
            'motivo_status' => $linha['motivo_status'],
            'status_alterado_em' => $linha['status_alterado_em'],
            'data_criacao' => $linha['data_criacao'],
            'conta_encerrada_em' => $linha['conta_encerrada_em'],
            'titular_nome' => $linha['titular_nome'],
            'titular_email' => $linha['titular_email'],
            'nome_plano' => $plano['nome'],
            'valor_plano' => $plano['valor'],
            'periodo_plano' => $plano['periodo'],
        ] + $estado;
    }

    /**
     * Último pagamento aprovado e checkout em andamento de cada loja da página.
     *
     * @param int[] $ids
     * @return array{0:array<int,array<string,mixed>>,1:array<int,true>}
     */
    private function pagamentosDasLojas(array $ids): array
    {
        if ($ids === []) {
            return [[], []];
        }
        $marcadores = [];
        $params = [];
        foreach (array_values($ids) as $i => $id) {
            $marcadores[] = ':id' . $i;
            $params['id' . $i] = $id;
        }
        $in = implode(', ', $marcadores);

        $stmt = db()->prepare(
            "SELECT id_loja, pago_em, valor, origem, forma
               FROM assinatura_pagamentos
              WHERE status = 'aprovado' AND id_loja IN ({$in})
              ORDER BY pago_em DESC"
        );
        $stmt->execute($params);
        $ultimos = [];
        foreach ($stmt->fetchAll() as $p) {
            $id = (int) $p['id_loja'];
            if (!isset($ultimos[$id])) {
                $ultimos[$id] = [
                    'pago_em' => $p['pago_em'],
                    'valor' => (float) $p['valor'],
                    'origem' => $p['origem'],
                    'nome_forma' => AssinaturaRepository::FORMAS[$p['forma'] ?? ''] ?? null,
                ];
            }
        }

        $stmt = db()->prepare(
            "SELECT DISTINCT id_loja FROM assinatura_pagamentos
              WHERE status = 'pendente' AND id_loja IN ({$in})
                AND criado_em > DATE_SUB(NOW(), INTERVAL " . AssinaturaRepository::DIAS_PAGAMENTO_PENDENTE . ' DAY)'
        );
        $stmt->execute($params);
        $comPendente = [];
        foreach ($stmt->fetchAll(\PDO::FETCH_COLUMN) as $id) {
            $comPendente[(int) $id] = true;
        }

        return [$ultimos, $comPendente];
    }
}
