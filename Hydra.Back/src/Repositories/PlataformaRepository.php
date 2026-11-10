<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/** Consultas agregadas e ações administrativas da área da plataforma. */
final class PlataformaRepository
{
    private const SQL_MERCADOS = "
        SELECT l.id_loja, l.nome_loja, l.cnpj, l.telefone, l.endereco, l.cidade, l.estado, l.cep,
               l.status AS status_loja, l.motivo_status, l.status_alterado_em, l.data_criacao,
               (SELECT COUNT(*) FROM filiais f WHERE f.id_loja = l.id_loja) AS total_filiais,
               (SELECT COUNT(*) FROM usuarios uc WHERE uc.id_loja = l.id_loja) AS total_usuarios,
               (SELECT MAX(u.ultimo_acesso) FROM usuarios u WHERE u.id_loja = l.id_loja) AS ultimo_acesso,
               (SELECT MAX(v.data_venda) FROM vendas v
                 WHERE v.id_loja = l.id_loja AND v.status <> 'cancelada') AS ultima_venda,
               CASE
                   WHEN l.status = 'suspensa' THEN 'suspenso'
                   WHEN NOT EXISTS (SELECT 1 FROM vendas vn
                                     WHERE vn.id_loja = l.id_loja AND vn.status <> 'cancelada') THEN 'novo'
                   WHEN GREATEST(
                       COALESCE((SELECT MAX(ua.ultimo_acesso) FROM usuarios ua WHERE ua.id_loja = l.id_loja), '1000-01-01'),
                       COALESCE((SELECT MAX(va.data_venda) FROM vendas va
                                  WHERE va.id_loja = l.id_loja AND va.status <> 'cancelada'), '1000-01-01')
                   ) >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 'ativo'
                   WHEN GREATEST(
                       COALESCE((SELECT MAX(ub.ultimo_acesso) FROM usuarios ub WHERE ub.id_loja = l.id_loja), '1000-01-01'),
                       COALESCE((SELECT MAX(vb.data_venda) FROM vendas vb
                                  WHERE vb.id_loja = l.id_loja AND vb.status <> 'cancelada'), '1000-01-01')
                   ) >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 'ocioso'
                   ELSE 'inativo'
               END AS status_calculado
          FROM lojas l
    ";

    public function __construct()
    {
        Migracoes::garantirAdminsPlataforma();
    }

    /** @return array<string,mixed> */
    public function resumo(): array
    {
        // SQL_MERCADOS (várias subconsultas por loja) é calculado UMA vez; os
        // totais por status e a lista de ociosos saem dessas linhas em PHP.
        // Antes a mesma derivada era materializada duas vezes por abertura.
        $mercados = db()->query(
            'SELECT id_loja, nome_loja, cidade, estado, ultimo_acesso, ultima_venda,
                    status_calculado, data_criacao
               FROM (' . self::SQL_MERCADOS . ') mercados'
        )->fetchAll();

        $inicioDoMes = date('Y-m-01 00:00:00');
        $status = ['total' => count($mercados), 'ativos' => 0, 'novos' => 0, 'ociosos' => 0,
            'inativos' => 0, 'suspensos' => 0, 'novos_mes' => 0];
        $chavesStatus = ['ativo' => 'ativos', 'novo' => 'novos', 'ocioso' => 'ociosos',
            'inativo' => 'inativos', 'suspenso' => 'suspensos'];
        $ociosos = [];
        foreach ($mercados as $mercado) {
            $chave = $chavesStatus[$mercado['status_calculado']] ?? null;
            if ($chave !== null) {
                $status[$chave]++;
            }
            if ((string) $mercado['data_criacao'] >= $inicioDoMes) {
                $status['novos_mes']++;
            }
            if ($mercado['status_calculado'] === 'ocioso') {
                $ociosos[] = $mercado;
            }
        }
        // Ordem antiga: o sinal de vida mais recente (acesso ou venda), do
        // mais antigo para o mais novo. Datas "Y-m-d H:i:s" comparam como texto.
        $ultimoSinal = static fn (array $m): string => max(
            (string) ($m['ultimo_acesso'] ?? '1000-01-01'),
            (string) ($m['ultima_venda'] ?? '1000-01-01')
        );
        usort($ociosos, static fn ($a, $b) => strcmp($ultimoSinal($a), $ultimoSinal($b)));
        $precisamAtencao = array_map(static fn ($m) => [
            'id_loja' => $m['id_loja'],
            'nome_loja' => $m['nome_loja'],
            'cidade' => $m['cidade'],
            'estado' => $m['estado'],
            'ultimo_acesso' => $m['ultimo_acesso'],
            'ultima_venda' => $m['ultima_venda'],
            'status_calculado' => $m['status_calculado'],
        ], array_slice($ociosos, 0, 5));

        $pendentes = (int) db()->query('SELECT COUNT(*) FROM cadastros_pendentes')->fetchColumn();
        $filiais = (int) db()->query("SELECT COUNT(*) FROM filiais WHERE status = 'ativa'")->fetchColumn();
        $usuarios = (int) db()->query("SELECT COUNT(*) FROM usuarios WHERE status = 'ativo'")->fetchColumn();
        $iniciados = $pendentes + $status['total'];
        $confirmados = $status['total'];
        // Por loja, com EXISTS (índice id_loja de vendas), em vez de
        // COUNT(DISTINCT) sobre a tabela de vendas inteira.
        $primeirasVendas = (int) db()->query(
            "SELECT COUNT(*) FROM lojas l
              WHERE EXISTS (SELECT 1 FROM vendas v WHERE v.id_loja = l.id_loja AND v.status <> 'cancelada')"
        )->fetchColumn();

        $mensal = db()->query(
            "SELECT DATE_FORMAT(data_criacao, '%Y-%m') AS mes, COUNT(*) AS quantidade
               FROM lojas
              WHERE data_criacao >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')
              GROUP BY DATE_FORMAT(data_criacao, '%Y-%m') ORDER BY mes"
        )->fetchAll();

        return [
            'mercados' => $status,
            'cadastros_pendentes' => $pendentes,
            'filiais_ativas' => $filiais,
            'usuarios_ativos' => $usuarios,
            'novos_cadastros_por_mes' => $mensal,
            'funil' => [
                'iniciados' => $iniciados,
                'confirmados' => $confirmados,
                'primeira_venda' => $primeirasVendas,
            ],
            'precisam_atencao' => $precisamAtencao,
        ];
    }

    /** @return array<string,mixed> */
    public function rendimento(int $dias): array
    {
        $hoje = new \DateTimeImmutable('today');
        $inicio = $hoje->modify('-' . ($dias - 1) . ' days');
        $fim = $hoje->modify('+1 day');
        $inicioAnterior = $inicio->modify('-' . $dias . ' days');

        $stmt = db()->prepare(
            "SELECT COUNT(*) AS vendas, COALESCE(SUM(valor_total), 0) AS faturamento,
                    COUNT(DISTINCT id_loja) AS mercados_com_vendas
               FROM vendas
              WHERE status = 'concluida'
                AND data_venda >= :inicio AND data_venda < :fim"
        );
        $stmt->execute([
            'inicio' => $inicio->format('Y-m-d H:i:s'),
            'fim' => $fim->format('Y-m-d H:i:s'),
        ]);
        $atual = $stmt->fetch() ?: ['vendas' => 0, 'faturamento' => 0, 'mercados_com_vendas' => 0];

        $stmtAnterior = db()->prepare(
            "SELECT COALESCE(SUM(valor_total), 0) AS faturamento
               FROM vendas
              WHERE status = 'concluida'
                AND data_venda >= :inicio_anterior AND data_venda < :fim_anterior"
        );
        $stmtAnterior->execute([
            'inicio_anterior' => $inicioAnterior->format('Y-m-d H:i:s'),
            'fim_anterior' => $inicio->format('Y-m-d H:i:s'),
        ]);
        $faturamentoAnterior = (float) $stmtAnterior->fetchColumn();

        $stmtMercados = db()->prepare(
            "SELECT l.id_loja AS id, l.nome_loja AS nome, l.cidade, l.estado AS uf,
                    COUNT(v.id_venda) AS vendas, COALESCE(SUM(v.valor_total), 0) AS faturamento,
                    COALESCE(AVG(v.valor_total), 0) AS ticket_medio
               FROM lojas l
               LEFT JOIN vendas v
                 ON v.id_loja = l.id_loja AND v.status = 'concluida'
                AND v.data_venda >= :inicio_mercados AND v.data_venda < :fim_mercados
              GROUP BY l.id_loja, l.nome_loja, l.cidade, l.estado
             HAVING COUNT(v.id_venda) > 0
              ORDER BY faturamento DESC, vendas DESC, l.nome_loja ASC
              LIMIT 10"
        );
        $stmtMercados->execute([
            'inicio_mercados' => $inicio->format('Y-m-d H:i:s'),
            'fim_mercados' => $fim->format('Y-m-d H:i:s'),
        ]);
        $mercados = $stmtMercados->fetchAll();

        $formato = $dias === 365 ? '%Y-%m' : '%Y-%m-%d';
        $stmtEvolucao = db()->prepare(
            "SELECT DATE_FORMAT(data_venda, '{$formato}') AS periodo,
                    COALESCE(SUM(valor_total), 0) AS faturamento,
                    COUNT(*) AS vendas
               FROM vendas
              WHERE status = 'concluida'
                AND data_venda >= :inicio_evolucao AND data_venda < :fim_evolucao
              GROUP BY periodo ORDER BY periodo"
        );
        $stmtEvolucao->execute([
            'inicio_evolucao' => $inicio->format('Y-m-d H:i:s'),
            'fim_evolucao' => $fim->format('Y-m-d H:i:s'),
        ]);

        return [
            'periodo' => [
                'dias' => $dias,
                'inicio' => $inicio->format('Y-m-d'),
                'fim' => $hoje->format('Y-m-d'),
            ],
            'resumo' => [
                'faturamento' => (float) $atual['faturamento'],
                'vendas' => (int) $atual['vendas'],
                'ticket_medio' => (int) $atual['vendas'] > 0
                    ? (float) $atual['faturamento'] / (int) $atual['vendas']
                    : 0,
                'mercados_com_vendas' => (int) $atual['mercados_com_vendas'],
                'faturamento_anterior' => $faturamentoAnterior,
                'variacao_percentual' => $faturamentoAnterior > 0
                    ? (((float) $atual['faturamento'] - $faturamentoAnterior) / $faturamentoAnterior) * 100
                    : null,
            ],
            'evolucao' => $stmtEvolucao->fetchAll(),
            'mercados' => $mercados,
        ];
    }

    /** @param array<string,string> $filtros */
    public function listarLojas(array $filtros, int $pagina): array
    {
        $where = [];
        $params = [];
        if ($filtros['status'] !== '') {
            $where[] = 'status_calculado = :status';
            $params['status'] = $filtros['status'];
        }
        if ($filtros['uf'] !== '') {
            $where[] = 'UPPER(estado) = :uf';
            $params['uf'] = strtoupper($filtros['uf']);
        }
        if ($filtros['busca'] !== '') {
            $where[] = '(nome_loja LIKE :busca_nome OR cnpj LIKE :busca_cnpj)';
            $termo = '%' . $filtros['busca'] . '%';
            $params['busca_nome'] = $termo;
            $params['busca_cnpj'] = $termo;
        }
        $sqlWhere = $where === [] ? '' : ' WHERE ' . implode(' AND ', $where);
        $ordem = match ($filtros['ordem']) {
            'acesso' => 'GREATEST(COALESCE(ultimo_acesso, "1000-01-01"), COALESCE(ultima_venda, "1000-01-01")) DESC',
            'nome' => 'nome_loja ASC',
            default => 'data_criacao DESC',
        };
        $base = '(' . self::SQL_MERCADOS . ') mercados' . $sqlWhere;

        $contagem = db()->prepare('SELECT COUNT(*) FROM ' . $base);
        $contagem->execute($params);
        $total = (int) $contagem->fetchColumn();

        $stmt = db()->prepare(
            'SELECT id_loja AS id, nome_loja AS nome, cidade, estado AS uf, status_calculado AS status,
                    total_filiais, total_usuarios, ultimo_acesso, ultima_venda, data_criacao
               FROM ' . $base . ' ORDER BY ' . $ordem . ' LIMIT 20 OFFSET :offset'
        );
        foreach ($params as $chave => $valor) {
            $stmt->bindValue(':' . $chave, $valor);
        }
        $stmt->bindValue(':offset', ($pagina - 1) * 20, \PDO::PARAM_INT);
        $stmt->execute();

        return [
            'lojas' => $stmt->fetchAll(),
            'paginacao' => [
                'pagina' => $pagina,
                'por_pagina' => 20,
                'total' => $total,
                'total_paginas' => (int) ceil($total / 20),
            ],
        ];
    }

    public function detalheLoja(int $idLoja): ?array
    {
        $stmt = db()->prepare(
            'SELECT id_loja AS id, nome_loja AS nome, cnpj, telefone, endereco, cidade, estado AS uf, cep,
                    status_loja, status_calculado AS status, motivo_status, status_alterado_em, data_criacao,
                    total_filiais, total_usuarios, ultimo_acesso, ultima_venda
               FROM (' . self::SQL_MERCADOS . ') mercados WHERE id_loja = :id_loja'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $loja = $stmt->fetch();
        if (!$loja) {
            return null;
        }

        $stmt = db()->prepare(
            "SELECT nome, email FROM usuarios
              WHERE id_loja = :id_loja AND perfil = 'administrador' AND status = 'ativo'
              ORDER BY nome"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $admins = $stmt->fetchAll();

        $stmt = db()->prepare(
            'SELECT nome, cidade, estado AS uf, status, data_criacao
               FROM filiais WHERE id_loja = :id_loja ORDER BY nome'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $filiais = $stmt->fetchAll();

        $stmt = db()->prepare(
            'SELECT COALESCE(c.nome, u.perfil) AS cargo, COUNT(*) AS quantidade
               FROM usuarios u LEFT JOIN cargos c ON c.id_cargo = u.id_cargo
              WHERE u.id_loja = :id_loja AND u.status = "ativo"
              GROUP BY COALESCE(c.nome, u.perfil) ORDER BY cargo'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $usuariosPorCargo = $stmt->fetchAll();

        $stmt = db()->prepare(
            "SELECT COUNT(*) FROM produtos
              WHERE id_loja = :id_loja AND status = 'ativo'"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $produtosAtivos = (int) $stmt->fetchColumn();

        $stmt = db()->prepare(
            "SELECT COUNT(*) AS quantidade, COALESCE(SUM(valor_total), 0) AS total
               FROM vendas
              WHERE id_loja = :id_loja AND status <> 'cancelada'
                AND data_venda >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $vendas30Dias = $stmt->fetch() ?: ['quantidade' => 0, 'total' => 0];

        $stmt = db()->prepare(
            "SELECT acao, detalhe, data FROM auditoria_plataforma
              WHERE id_loja = :id_loja AND acao IN ('mercado_suspenso', 'mercado_reativado')
              ORDER BY data DESC LIMIT 10"
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $alteracoesStatus = $stmt->fetchAll();
        $stmtTimeline = db()->prepare(
            "SELECT (SELECT MIN(data_venda) FROM vendas
                      WHERE id_loja = :id_loja_vendas AND status <> 'cancelada') AS primeira_venda,
                    (SELECT MAX(ultimo_acesso) FROM usuarios WHERE id_loja = :id_loja_acessos) AS ultimo_acesso"
        );
        $stmtTimeline->execute(['id_loja_vendas' => $idLoja, 'id_loja_acessos' => $idLoja]);
        $marcos = $stmtTimeline->fetch() ?: [];

        return [
            'loja' => $loja,
            'administradores' => $admins,
            'filiais' => $filiais,
            'usuarios_por_cargo' => $usuariosPorCargo,
            'produtos_ativos' => $produtosAtivos,
            'vendas_30_dias' => [
                'quantidade' => (int) $vendas30Dias['quantidade'],
                'total' => (float) $vendas30Dias['total'],
            ],
            'linha_do_tempo' => [
                'cadastro' => $loja['data_criacao'],
                'primeira_venda' => $marcos['primeira_venda'] ?? null,
                'ultimo_acesso' => $marcos['ultimo_acesso'] ?? null,
                'alteracoes_status' => $alteracoesStatus,
            ],
        ];
    }

    public function statusLoja(int $idLoja): ?string
    {
        $stmt = db()->prepare('SELECT status FROM lojas WHERE id_loja = :id_loja');
        $stmt->execute(['id_loja' => $idLoja]);
        $status = $stmt->fetchColumn();
        return $status === false ? null : (string) $status;
    }

    public function alterarStatusLoja(int $idLoja, string $status, string $motivo): bool
    {
        $stmt = db()->prepare(
            'UPDATE lojas SET status = :status, motivo_status = :motivo, status_alterado_em = NOW()
              WHERE id_loja = :id_loja AND status <> :status_atual'
        );
        $stmt->execute([
            'status' => $status,
            'motivo' => $motivo,
            'id_loja' => $idLoja,
            'status_atual' => $status,
        ]);
        return $stmt->rowCount() > 0;
    }

    /** @return array<int,array<string,mixed>> */
    public function cadastrosPendentes(): array
    {
        return db()->query(
            'SELECT nome, email, nome_loja AS loja, criado_em,
                    TIMESTAMPDIFF(DAY, criado_em, NOW()) AS dias
               FROM cadastros_pendentes ORDER BY criado_em DESC'
        )->fetchAll();
    }

    public function auditoria(array $filtros, int $pagina): array
    {
        $where = [];
        $params = [];
        if ($filtros['acao'] !== '') {
            $where[] = 'a.acao = :acao';
            $params['acao'] = $filtros['acao'];
        }
        if ($filtros['id_admin'] > 0) {
            $where[] = 'a.id_admin = :id_admin';
            $params['id_admin'] = $filtros['id_admin'];
        }
        if ($filtros['de'] !== '') {
            $where[] = 'a.data >= :data_de';
            $params['data_de'] = $filtros['de'] . ' 00:00:00';
        }
        if ($filtros['ate'] !== '') {
            $where[] = 'a.data <= :data_ate';
            $params['data_ate'] = $filtros['ate'] . ' 23:59:59';
        }
        $condicao = $where === [] ? '' : ' WHERE ' . implode(' AND ', $where);
        $contagem = db()->prepare('SELECT COUNT(*) FROM auditoria_plataforma a' . $condicao);
        $contagem->execute($params);
        $total = (int) $contagem->fetchColumn();

        $stmt = db()->prepare(
            'SELECT a.id_auditoria, a.id_admin, ap.nome AS membro, a.acao,
                    a.id_loja, l.nome_loja AS mercado, a.detalhe, a.ip, a.data
               FROM auditoria_plataforma a
               LEFT JOIN admins_plataforma ap ON ap.id_admin = a.id_admin
               LEFT JOIN lojas l ON l.id_loja = a.id_loja'
            . $condicao . ' ORDER BY a.data DESC, a.id_auditoria DESC LIMIT 20 OFFSET :offset'
        );
        foreach ($params as $chave => $valor) {
            $stmt->bindValue(':' . $chave, $valor);
        }
        $stmt->bindValue(':offset', ($pagina - 1) * 20, \PDO::PARAM_INT);
        $stmt->execute();
        $membros = db()->query(
            'SELECT id_admin, nome FROM admins_plataforma ORDER BY nome'
        )->fetchAll();
        return [
            'registros' => $stmt->fetchAll(),
            'paginacao' => ['pagina' => $pagina, 'por_pagina' => 20, 'total' => $total, 'total_paginas' => (int) ceil($total / 20)],
            'membros' => $membros,
        ];
    }
}
