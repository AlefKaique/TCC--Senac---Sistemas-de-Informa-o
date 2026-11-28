<?php

namespace Hydra\Controllers;

use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\LoteRepository;
use Hydra\Repositories\RelatorioEstoqueRepository;
use Hydra\Support\Auth;
use Hydra\Support\Response;

/**
 * Tela Relatório (pages/dashboard.html + js/relatorio-estoque.js): o
 * relatório de estoque, focado no produto e sem valores em dinheiro (a
 * parte financeira fica para um módulo futuro).
 *
 *   GET /api/relatorios/estoque-produtos
 *     data_inicio, data_fim  AAAA-MM-DD (obrigatórios, até 366 dias)
 *     busca                  nome, código de barras, PLU ou código do produto (opcional)
 *     categoria              categoria do produto (opcional)
 *     dias_validade          7, 15, 30 ou 60: o que conta como "vencendo" (padrão 30)
 *     tipo                   todas | entrada | saida: filtro da lista de movimentações
 *     pagina                 página da lista de movimentações (25 por página)
 *     secao=movimentacoes    devolve só a lista de movimentações (troca de página/tipo)
 *     completo=1             lista de movimentações inteira, para o PDF (até 2.000)
 *
 * O relatório é sempre da filial em que o usuário está trabalhando (a da
 * sessão). Para ver outra, ele troca de filial no menu. Exige a permissão
 * "relatorios.visualizar".
 */
final class RelatorioEstoqueController
{
    private const MAX_DIAS = 366;
    private const DIAS_VALIDADE = [7, 15, 30, 60];
    private const DIAS_VALIDADE_PADRAO = 30;
    private const POR_PAGINA = 25;
    private const LIMITE_PDF = 2000;
    private const LIMITE_PRODUTOS = 1000;
    private const MAX_BUSCA = 100;
    private const MAX_CATEGORIA = 60;

    public function __construct()
    {
        // Garante as tabelas de lotes/documentos e as colunas id_documento e
        // id_lote em movimentacoes_estoque (DDL, fora de transação).
        new LoteRepository();
    }

    public function relatorio(): void
    {
        $usuario = Auth::requirePermissionNaFilial('relatorios.visualizar');

        $periodo = $this->periodo();
        if ($periodo === null) {
            return;
        }
        [$de, $ate] = $periodo;

        $filtros = $this->filtros();
        if ($filtros === null) {
            return;
        }

        $idLoja = (int) $usuario['id_loja'];
        $idFilial = (int) $usuario['id_filial'];
        $repositorio = new RelatorioEstoqueRepository($idLoja, $idFilial, $filtros['busca'], $filtros['categoria']);

        $completo = ($_GET['completo'] ?? '0') === '1';
        $limite = $completo ? self::LIMITE_PDF : self::POR_PAGINA;
        $pagina = $completo ? 1 : $filtros['pagina'];
        $movimentacoes = $repositorio->movimentacoes($de, $ate, $filtros['tipo'], $limite, ($pagina - 1) * $limite)
            + ['pagina' => $pagina, 'por_pagina' => $limite, 'tipo' => $filtros['tipo']];

        if (($_GET['secao'] ?? '') === 'movimentacoes') {
            Response::json(['movimentacoes' => $movimentacoes]);
            return;
        }

        $hoje = new \DateTimeImmutable('today', new \DateTimeZone('America/Sao_Paulo'));
        $emFalta = $repositorio->emFalta();
        $vencendo = $repositorio->vencendo($hoje, $filtros['dias_validade']);
        $porProduto = $repositorio->porProduto($de, $ate, self::LIMITE_PRODUTOS);

        // Menor prazo de validade de cada produto, para o selo da tabela
        // "Entradas e saídas por produto".
        $prazoPorProduto = [];
        foreach ($vencendo as $lote) {
            $id = $lote['id_produto'];
            if (!isset($prazoPorProduto[$id]) || $lote['dias'] < $prazoPorProduto[$id]) {
                $prazoPorProduto[$id] = $lote['dias'];
            }
        }
        foreach ($porProduto as &$linha) {
            $linha['vence_em_dias'] = $prazoPorProduto[$linha['id_produto']] ?? null;
            unset($linha['id_produto']);
        }
        unset($linha);

        $filial = (new FilialRepository())->findInLoja($idFilial, $idLoja);
        $resumo = $repositorio->resumo($de, $ate) + [
            'em_falta' => [
                'total' => count($emFalta),
                'acabou' => count(array_filter($emFalta, static fn (array $item): bool => $item['situacao'] === 'acabou')),
            ],
            'vencendo' => [
                'lotes' => count($vencendo),
                'vencidos' => count(array_filter($vencendo, static fn (array $item): bool => $item['dias'] < 0)),
                'produtos' => count(array_unique(array_column($vencendo, 'id_produto'))),
            ],
        ];

        Response::json([
            'periodo' => ['data_inicio' => $de->format('Y-m-d'), 'data_fim' => $ate->format('Y-m-d')],
            'filial' => ['id_filial' => $idFilial, 'nome' => $filial['nome'] ?? ''],
            'hoje' => $hoje->format('Y-m-d'),
            'dias_validade' => $filtros['dias_validade'],
            'categorias' => $repositorio->categorias(),
            'resumo' => $resumo,
            'por_produto' => $porProduto,
            'por_produto_limitado' => count($porProduto) >= self::LIMITE_PRODUTOS,
            'movimentacoes' => $movimentacoes,
            'em_falta' => $emFalta,
            'vencendo' => array_map(static function (array $lote): array {
                unset($lote['id_produto']);
                return $lote;
            }, $vencendo),
        ]);
    }

    /** @return array{busca:string,categoria:string,dias_validade:int,tipo:string,pagina:int}|null null quando já respondeu com erro */
    private function filtros(): ?array
    {
        $busca = $_GET['busca'] ?? '';
        $categoria = $_GET['categoria'] ?? '';
        $dias = $_GET['dias_validade'] ?? (string) self::DIAS_VALIDADE_PADRAO;
        $tipo = $_GET['tipo'] ?? 'todas';
        $pagina = $_GET['pagina'] ?? '1';

        if (!is_string($busca) || !is_string($categoria) || !is_string($dias) || !is_string($tipo) || !is_string($pagina)) {
            Response::json(['erro' => 'Filtros inválidos.'], 422);
            return null;
        }
        $busca = trim($busca);
        $categoria = trim($categoria);
        if (mb_strlen($busca, 'UTF-8') > self::MAX_BUSCA || mb_strlen($categoria, 'UTF-8') > self::MAX_CATEGORIA) {
            Response::json(['erro' => 'O texto da busca está grande demais.'], 422);
            return null;
        }
        if (!ctype_digit($dias) || !in_array((int) $dias, self::DIAS_VALIDADE, true)) {
            Response::json(['erro' => 'Escolha 7, 15, 30 ou 60 dias para a validade.'], 422);
            return null;
        }
        if (!in_array($tipo, ['todas', 'entrada', 'saida'], true)) {
            Response::json(['erro' => 'Tipo de movimentação inválido.'], 422);
            return null;
        }
        if (!ctype_digit($pagina) || (int) $pagina < 1 || (int) $pagina > 100000) {
            Response::json(['erro' => 'Página inválida.'], 422);
            return null;
        }

        return [
            'busca' => $busca,
            'categoria' => $categoria,
            'dias_validade' => (int) $dias,
            'tipo' => $tipo,
            'pagina' => (int) $pagina,
        ];
    }

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
}
