<?php

namespace Hydra\Controllers;

use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\RelatorioPreferenciaRepository;
use Hydra\Repositories\RelatorioVendasRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Tela Relatório de Vendas (pages/dashboard.html, item "Relatório" do menu).
 *
 *   GET /api/relatorios/vendas        — o relatório, só com os blocos pedidos
 *   GET /api/relatorios/preferencias  — blocos salvos, acesso e filiais do seletor
 *   PUT /api/relatorios/preferencias  — salva os blocos marcados
 *
 * Quem vê o quê (validado aqui, não só escondido na tela):
 *   - ADM (cargo de nível administrador: "Equipe e Cargos" ou
 *     "Configuração da Loja"): todas as filiais ativas da loja, a
 *     comparação entre elas, operadores, cancelamentos e lucro;
 *   - Gerente (cargo com "Relatório Completo"): só a filial em que está
 *     trabalhando, com operadores, cancelamentos e lucro;
 *   - Funcionário (só "Relatórios"): só a filial em que está trabalhando,
 *     sem operadores, sem cancelamentos e sem lucro.
 */
final class RelatorioVendasController
{
    /** Os 7 blocos do Passo 2 da tela, na ordem em que aparecem. */
    private const BLOCOS = ['mais_vendidos', 'dia_a_dia', 'horarios', 'pagamentos', 'parados', 'vai_acabar', 'operadores'];

    /** Ferramentas mantidas da tela anterior, pedidas por botão (não são chips). */
    private const EXTRAS = ['cancelamentos', 'lista_compras', 'validade'];

    /** Primeira vez na tela: só o essencial. */
    private const PADRAO = ['mais_vendidos', 'dia_a_dia'];

    /** Blocos que só Gerente e ADM podem pedir. */
    private const SO_COMPLETO = ['operadores', 'cancelamentos'];

    private const MAX_DIAS = 90;
    private const TOP_PRODUTOS = 5;
    private const PRODUTOS_POR_PAGINA = 20;
    private const PARADOS_MAX_VENDAS = 2;
    private const PARADOS_LIMITE = 50;
    private const ACABA_EM_ATE_DIAS = 30;
    private const ACABA_LIMITE = 30;
    private const CANCELAMENTOS_LIMITE = 100;
    private const VALIDADE_DIAS_AVISO = 30;

    private const MESES = [
        1 => 'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
        'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
    ];

    /** GET /api/relatorios/preferencias */
    public function preferencias(): void
    {
        $usuario = Auth::requirePermissionNaFilial('relatorios.visualizar');
        $acesso = $this->acesso();
        $permitidos = $this->blocosPermitidos($acesso);
        $salvos = (new RelatorioPreferenciaRepository())->blocos((int) $usuario['id_usuario']);
        $blocos = array_values(array_intersect($permitidos, $salvos ?? self::PADRAO));

        Response::json([
            'blocos' => $blocos,
            'blocos_disponiveis' => $permitidos,
            'primeira_vez' => $salvos === null,
            'acesso' => $acesso,
            'filiais' => array_map(
                static fn (array $filial): array => ['id_filial' => (int) $filial['id_filial'], 'nome' => $filial['nome']],
                $this->filiaisVisiveis($usuario, $acesso)
            ),
            'id_filial_ativa' => (int) $usuario['id_filial'],
        ]);
    }

    /** PUT /api/relatorios/preferencias — corpo: {"blocos": ["mais_vendidos", ...]} */
    public function salvarPreferencias(): void
    {
        $usuario = Auth::requirePermission('relatorios.visualizar');
        $dados = Request::json();
        $blocos = $dados['blocos'] ?? null;
        if (!is_array($blocos) || array_filter($blocos, static fn ($bloco) => !is_string($bloco)) !== []) {
            Response::json(['erro' => 'Envie a lista de detalhes marcados.'], 422);
            return;
        }
        $desconhecidos = array_diff($blocos, self::BLOCOS);
        if ($desconhecidos !== []) {
            Response::json(['erro' => 'Detalhe desconhecido: ' . implode(', ', $desconhecidos) . '.'], 422);
            return;
        }
        $permitidos = $this->blocosPermitidos($this->acesso());
        if (array_diff($blocos, $permitidos) !== []) {
            Response::json(['erro' => 'Seu cargo não pode ver as vendas por operador.'], 403);
            return;
        }

        // Ordem fixa da tela e sem repetição, venha como vier.
        $blocos = array_values(array_intersect(self::BLOCOS, $blocos));
        (new RelatorioPreferenciaRepository())->salvar((int) $usuario['id_usuario'], $blocos);
        Response::json(['mensagem' => 'Escolha salva.', 'blocos' => $blocos]);
    }

    /**
     * GET /api/relatorios/vendas
     *   data_inicio, data_fim  AAAA-MM-DD (obrigatórios, até 90 dias)
     *   id_filial              número da filial ou "todas" (só ADM)
     *   blocos                 lista separada por vírgula (pode ficar vazia)
     *   resumo                 "0" para não calcular os cartões (paginação, impressões)
     *   produtos_pagina        0 = os 5 primeiros; 1, 2... = lista completa, 20 por página
     */
    public function vendas(): void
    {
        $usuario = Auth::requirePermissionNaFilial('relatorios.visualizar');
        $acesso = $this->acesso();

        $periodo = $this->periodo();
        if ($periodo === null) {
            return;
        }
        [$de, $ate] = $periodo;

        $filial = $this->filialPedida($usuario, $acesso);
        if ($filial === null) {
            return;
        }

        $blocos = $this->blocosPedidos($acesso);
        if ($blocos === null) {
            return;
        }

        $pagina = $_GET['produtos_pagina'] ?? '0';
        if (!is_string($pagina) || !ctype_digit($pagina) || (int) $pagina > 10000) {
            Response::json(['erro' => 'Página da lista de produtos inválida.'], 422);
            return;
        }
        $pagina = (int) $pagina;

        $dias = (int) $de->diff($ate)->days + 1;
        $anterior = $this->periodoAnterior($de, $ate);
        $repositorio = new RelatorioVendasRepository();
        $ids = $filial['ids'];

        $resposta = [
            'periodo' => ['data_inicio' => $de->format('Y-m-d'), 'data_fim' => $ate->format('Y-m-d'), 'dias' => $dias],
            'periodo_anterior' => [
                'data_inicio' => $anterior['de']->format('Y-m-d'),
                'data_fim' => $anterior['ate']->format('Y-m-d'),
                'rotulo' => $anterior['rotulo'],
            ],
            'filial' => ['id_filial' => $filial['id'], 'nome' => $filial['nome']],
            'acesso' => $acesso,
            'blocos_pedidos' => $blocos,
        ];

        if (($_GET['resumo'] ?? '1') !== '0') {
            $resposta['resumo'] = $repositorio->resumo($ids, $de, $ate, $acesso['lucro']);
            $resposta['resumo_anterior'] = $repositorio->resumo($ids, $anterior['de'], $anterior['ate'], $acesso['lucro']);
            if ($filial['id'] === null && count($ids) > 1) {
                $resposta['comparacao_filiais'] = $repositorio->comparacaoFiliais($ids, $de, $ate, $acesso['lucro']);
            }
        }

        foreach ($blocos as $bloco) {
            $resposta[$bloco] = match ($bloco) {
                'mais_vendidos' => $repositorio->maisVendidos(
                    $ids,
                    $de,
                    $ate,
                    $pagina === 0 ? self::TOP_PRODUTOS : self::PRODUTOS_POR_PAGINA,
                    $pagina === 0 ? 0 : ($pagina - 1) * self::PRODUTOS_POR_PAGINA
                ) + [
                    'pagina' => $pagina,
                    'por_pagina' => $pagina === 0 ? self::TOP_PRODUTOS : self::PRODUTOS_POR_PAGINA,
                ],
                'dia_a_dia' => $repositorio->diaADia($ids, $de, $ate),
                'horarios' => $repositorio->horarios($ids, $de, $ate),
                'pagamentos' => $repositorio->pagamentos($ids, $de, $ate),
                'parados' => $repositorio->parados($ids, $de, $ate, self::PARADOS_MAX_VENDAS, self::PARADOS_LIMITE),
                'vai_acabar' => $repositorio->vaiAcabar($ids, $de, $ate, $dias, self::ACABA_EM_ATE_DIAS, self::ACABA_LIMITE),
                'operadores' => $repositorio->operadores($ids, $de, $ate),
                'cancelamentos' => $repositorio->cancelamentos($ids, $de, $ate, self::CANCELAMENTOS_LIMITE),
                'lista_compras' => $repositorio->listaCompras($ids),
                'validade' => $repositorio->validade(
                    $ids,
                    new \DateTimeImmutable('today', new \DateTimeZone('America/Sao_Paulo')),
                    self::VALIDADE_DIAS_AVISO
                ),
            };
        }

        Response::json($resposta);
    }

    /* ================= Permissões ================= */

    /** @return array{nivel:string,todas_filiais:bool,operadores:bool,cancelamentos:bool,lucro:bool} */
    private function acesso(): array
    {
        $adm = Auth::ehAdministrador();
        $completo = $adm || Auth::can('relatorios.completo');
        return [
            'nivel' => $adm ? 'adm' : ($completo ? 'gerente' : 'funcionario'),
            'todas_filiais' => $adm,
            'operadores' => $completo,
            'cancelamentos' => $completo,
            'lucro' => $completo,
        ];
    }

    /** @return string[] chips que este usuário pode marcar */
    private function blocosPermitidos(array $acesso): array
    {
        return array_values(array_filter(
            self::BLOCOS,
            static fn (string $bloco): bool => $bloco !== 'operadores' || $acesso['operadores']
        ));
    }

    /**
     * ADM: todas as filiais ativas da loja. Os demais: só a filial em que
     * estão trabalhando (a da sessão, já conferida por requireFilial()).
     *
     * @return array<int,array<string,mixed>>
     */
    private function filiaisVisiveis(array $usuario, array $acesso): array
    {
        $repositorio = new FilialRepository();
        if ($acesso['todas_filiais']) {
            return $repositorio->permitidas((int) $usuario['id_usuario'], (int) $usuario['id_loja'], true);
        }
        $filial = $repositorio->findInLoja((int) $usuario['id_filial'], (int) $usuario['id_loja']);
        return $filial === null ? [] : [$filial];
    }

    /**
     * @return array{id:?int,nome:string,ids:int[]}|null null quando já respondeu com erro
     */
    private function filialPedida(array $usuario, array $acesso): ?array
    {
        $ativa = (int) $usuario['id_filial'];
        $pedido = $_GET['id_filial'] ?? ($acesso['todas_filiais'] ? 'todas' : (string) $ativa);
        if (!is_string($pedido) || ($pedido !== 'todas' && !ctype_digit($pedido))) {
            Response::json(['erro' => 'Filial inválida.'], 422);
            return null;
        }

        $visiveis = $this->filiaisVisiveis($usuario, $acesso);
        if ($pedido === 'todas') {
            if (!$acesso['todas_filiais']) {
                Response::json(['erro' => 'Seu cargo só vê o relatório da filial em que você está trabalhando.'], 403);
                return null;
            }
            if ($visiveis === []) {
                Response::json(['erro' => 'Nenhuma filial ativa encontrada.'], 404);
                return null;
            }
            return [
                'id' => null,
                'nome' => 'Todas as filiais',
                'ids' => array_map(static fn (array $filial): int => (int) $filial['id_filial'], $visiveis),
            ];
        }

        $id = (int) $pedido;
        if (!$acesso['todas_filiais'] && $id !== $ativa) {
            Response::json(['erro' => 'Seu cargo só vê o relatório da filial em que você está trabalhando.'], 403);
            return null;
        }
        foreach ($visiveis as $filial) {
            if ((int) $filial['id_filial'] === $id) {
                return ['id' => $id, 'nome' => $filial['nome'], 'ids' => [$id]];
            }
        }
        Response::json(['erro' => 'Filial não encontrada ou desativada.'], 404);
        return null;
    }

    /** @return string[]|null null quando já respondeu com erro */
    private function blocosPedidos(array $acesso): ?array
    {
        $entrada = $_GET['blocos'] ?? '';
        if (!is_string($entrada)) {
            Response::json(['erro' => 'Envie os detalhes separados por vírgula.'], 422);
            return null;
        }
        $pedidos = array_values(array_unique(array_filter(array_map('trim', explode(',', $entrada)), 'strlen')));
        $desconhecidos = array_diff($pedidos, self::BLOCOS, self::EXTRAS);
        if ($desconhecidos !== []) {
            Response::json(['erro' => 'Detalhe desconhecido: ' . implode(', ', $desconhecidos) . '.'], 422);
            return null;
        }
        if (!$acesso['operadores'] && array_intersect($pedidos, self::SO_COMPLETO) !== []) {
            Response::json(['erro' => 'Seu cargo não pode ver as vendas por operador nem os cancelamentos.'], 403);
            return null;
        }
        return $pedidos;
    }

    /* ================= Datas ================= */

    /** @return array{0:\DateTimeImmutable,1:\DateTimeImmutable}|null null quando já respondeu com erro */
    private function periodo(): ?array
    {
        $timezone = new \DateTimeZone('America/Sao_Paulo');
        $de = $this->data($_GET['data_inicio'] ?? null, $timezone);
        $ate = $this->data($_GET['data_fim'] ?? null, $timezone);
        if ($de === null || $ate === null) {
            Response::json(['erro' => 'Informe a data inicial e a data final no formato AAAA-MM-DD.'], 422);
            return null;
        }
        if ($de > $ate) {
            Response::json(['erro' => 'A data inicial não pode ser depois da data final.'], 422);
            return null;
        }
        if ((int) $de->diff($ate)->days + 1 > self::MAX_DIAS) {
            Response::json(['erro' => 'Escolha um período de até ' . self::MAX_DIAS . ' dias.'], 422);
            return null;
        }
        return [$de, $ate];
    }

    private function data(mixed $valor, \DateTimeZone $timezone): ?\DateTimeImmutable
    {
        if (!is_string($valor) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $valor)) {
            return null;
        }
        $data = \DateTimeImmutable::createFromFormat('!Y-m-d', $valor, $timezone);
        if ($data === false || $data->format('Y-m-d') !== $valor) {
            return null;
        }
        return $data;
    }

    /**
     * Período usado na comparação dos cartões, com o texto que a tela põe
     * depois de "a mais que" / "a menos que":
     *   - mês inteiro (Mês passado): o mês anterior inteiro — "em outubro";
     *   - do dia 1 até um dia do mesmo mês (Este mês): os mesmos dias do mês
     *     anterior — "no mesmo período do mês passado";
     *   - qualquer outro: o mesmo número de dias logo antes — "ontem",
     *     "na semana anterior", "nos 14 dias anteriores".
     *
     * @return array{de:\DateTimeImmutable,ate:\DateTimeImmutable,rotulo:string}
     */
    private function periodoAnterior(\DateTimeImmutable $de, \DateTimeImmutable $ate): array
    {
        $dias = (int) $de->diff($ate)->days + 1;
        $mesmoMes = $de->format('Y-m') === $ate->format('Y-m');
        $mesInteiro = $mesmoMes && $de->format('j') === '1'
            && $ate->format('Y-m-d') === $ate->modify('last day of this month')->format('Y-m-d');
        // "Hoje" no dia 1º cai no último caso ("ontem"), não no do mês.
        if ($mesInteiro || ($mesmoMes && $de->format('j') === '1' && $dias > 1)) {
            $inicioAnterior = $de->modify('first day of previous month');
            $fimDoMesAnterior = $de->modify('last day of previous month');
            if ($mesInteiro) {
                $mes = self::MESES[(int) $inicioAnterior->format('n')];
                $ano = $inicioAnterior->format('Y') !== $de->format('Y') ? ' de ' . $inicioAnterior->format('Y') : '';
                return ['de' => $inicioAnterior, 'ate' => $fimDoMesAnterior, 'rotulo' => "em {$mes}{$ano}"];
            }
            $fimAnterior = $inicioAnterior->modify('+' . ((int) $ate->format('j') - 1) . ' days');
            if ($fimAnterior > $fimDoMesAnterior) {
                $fimAnterior = $fimDoMesAnterior;
            }
            return ['de' => $inicioAnterior, 'ate' => $fimAnterior, 'rotulo' => 'no mesmo período do mês passado'];
        }

        $inicioAnterior = $de->modify("-{$dias} days");
        $fimAnterior = $de->modify('-1 day');
        if ($dias === 1) {
            $hoje = new \DateTimeImmutable('today', $de->getTimezone());
            $rotulo = match ($de->format('Y-m-d')) {
                $hoje->format('Y-m-d') => 'ontem',
                $hoje->modify('-1 day')->format('Y-m-d') => 'anteontem',
                default => 'no dia anterior',
            };
        } elseif ($dias === 7) {
            $rotulo = 'na semana anterior';
        } else {
            $rotulo = "nos {$dias} dias anteriores";
        }
        return ['de' => $inicioAnterior, 'ate' => $fimAnterior, 'rotulo' => $rotulo];
    }
}
