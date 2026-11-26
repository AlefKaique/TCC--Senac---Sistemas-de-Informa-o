<?php

namespace Hydra\Controllers;

use Hydra\Repositories\DocumentoEstoqueRepository;
use Hydra\Repositories\LoteRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Repositories\SkuRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Telas "Nova entrada de estoque" e "Nova saída de estoque".
 *
 * Um documento tem cabeçalho (tipo/motivo, fornecedor, nota, justificativa)
 * e vários itens. Entrada soma ao lote informado (cria o lote se for novo);
 * saída baixa dos lotes escolhidos ou, sem escolha, por FEFO. Tudo numa
 * transação: ou o documento inteiro entra, ou nada muda. Venda não passa
 * por aqui — a baixa de venda continua vindo do PDV.
 */
final class DocumentoEstoqueController
{
    public const TIPOS_ENTRADA = [
        'compra' => 'Compra (com nota fiscal)',
        'devolucao_cliente' => 'Devolução de cliente',
        'transferencia' => 'Transferência entre filiais',
        'ajuste_inventario' => 'Ajuste de inventário',
    ];
    public const MOTIVOS_ENTRADA = [
        'reposicao_programada' => 'Reposição programada',
        'compra_emergencial' => 'Compra emergencial',
        'devolucao_cliente' => 'Devolução de cliente',
        'transferencia_filial' => 'Transferência entre filiais',
        'correcao_inventario' => 'Correção de inventário',
        'bonificacao' => 'Bonificação do fornecedor',
        'outro' => 'Outro',
    ];
    public const MOTIVOS_SAIDA = [
        'vencimento' => 'Vencimento',
        'perda' => 'Perda ou avaria',
        'consumo_interno' => 'Consumo interno',
        'transferencia' => 'Transferência entre filiais',
        'devolucao_fornecedor' => 'Devolução ao fornecedor',
    ];
    /** Entradas que exigem justificativa (descrição ou observação em todos os itens). */
    private const ENTRADA_EXIGE_JUSTIFICATIVA = ['devolucao_cliente', 'ajuste_inventario'];
    private const MIN_JUSTIFICATIVA = 10;

    private ProdutoRepository $produtos;
    private LoteRepository $lotes;
    private DocumentoEstoqueRepository $documentos;

    public function __construct()
    {
        // Construtores com migração (DDL) rodam antes de qualquer transação.
        $this->produtos = new ProdutoRepository();
        new SkuRepository();
        $this->lotes = new LoteRepository();
        $this->documentos = new DocumentoEstoqueRepository();
    }

    /**
     * GET /api/estoque/lotes?id_produto=N
     * Lotes do produto em ordem FEFO, já reconciliados com o saldo atual.
     */
    public function lotes(): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.lancar');
        $produto = $this->produtos->findInFilial((int) ($_GET['id_produto'] ?? 0), $user['id_filial']);
        if ($produto === null) {
            Response::json(['erro' => 'Produto não encontrado'], 404);
            return;
        }
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $lotes = $this->lotes->sincronizar($produto);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            error_log('[Hydra] Falha ao ler lotes: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível carregar os lotes do produto'], 500);
            return;
        }
        Response::json([
            'id_produto' => (int) $produto['id_produto'],
            'lotes' => array_map(static fn ($l) => [
                'id_lote' => (int) $l['id_lote'],
                'codigo' => $l['codigo'],
                'validade' => $l['validade'],
                'quantidade' => (float) $l['quantidade'],
                'custo_unitario' => $l['custo_unitario'] !== null ? (float) $l['custo_unitario'] : null,
            ], $lotes),
        ]);
    }

    /** GET /api/estoque/documentos/proximo-numero?tipo=entrada|saida (prévia, não reserva). */
    public function proximoNumero(): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.lancar');
        $tipo = ($_GET['tipo'] ?? '') === 'saida' ? 'saida' : 'entrada';
        Response::json(['numero' => $this->documentos->proximoNumero($user['id_loja'], $tipo, false)]);
    }

    /** GET /api/estoque/documentos — últimos documentos da filial. */
    public function index(): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.consultar');
        Response::json(['documentos' => $this->documentos->listar($user['id_filial'])]);
    }

    /** GET /api/estoque/documentos/{id} */
    public function show(int $id): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.consultar');
        $documento = $this->documentos->buscar($id, $user['id_filial']);
        if ($documento === null) {
            Response::json(['erro' => 'Documento não encontrado'], 404);
            return;
        }
        Response::json(['documento' => $documento]);
    }

    /** POST /api/estoque/documentos */
    public function store(): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.lancar');
        $dados = Request::json();
        $tipo = (string) ($dados['tipo'] ?? '');
        if (!in_array($tipo, ['entrada', 'saida'], true)) {
            Response::json(['erro' => 'Tipo de movimentação inválido'], 422);
            return;
        }

        $cabecalho = $tipo === 'entrada' ? $this->validarCabecalhoEntrada($dados) : $this->validarCabecalhoSaida($dados);
        if (isset($cabecalho['erro'])) {
            Response::json($cabecalho, 422);
            return;
        }
        $itens = is_array($dados['itens'] ?? null) ? array_values($dados['itens']) : [];
        if ($itens === []) {
            Response::json(['erro' => 'Adicione pelo menos um produto', 'campo' => 'itens'], 422);
            return;
        }
        if (count($itens) > 200) {
            Response::json(['erro' => 'Um documento pode ter no máximo 200 itens'], 422);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $numero = $this->documentos->proximoNumero($user['id_loja'], $tipo, true);
            $resultado = $tipo === 'entrada'
                ? $this->gravarEntrada($user, $cabecalho, $itens, $numero)
                : $this->gravarSaida($user, $cabecalho, $itens, $numero);
            if (isset($resultado['erro'])) {
                $pdo->rollBack();
                Response::json($resultado, 422);
                return;
            }
            $pdo->commit();
        } catch (\PDOException $e) {
            $pdo->rollBack();
            if ($e->getCode() === '23000') {
                Response::json(['erro' => 'Outro documento foi gravado ao mesmo tempo. Confirme de novo.'], 409);
                return;
            }
            error_log('[Hydra] Falha ao gravar documento de estoque: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível gravar a movimentação. Nada foi alterado.'], 500);
            return;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            error_log('[Hydra] Falha ao gravar documento de estoque: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível gravar a movimentação. Nada foi alterado.'], 500);
            return;
        }

        Response::json(['documento' => $this->documentos->buscar($resultado['id_documento'], $user['id_filial'])], 201);
    }

    /**
     * POST /api/estoque/documentos/{id}/estornar  { justificativa }
     * Gera o documento contrário e marca o original como estornado.
     */
    public function estornar(int $id): void
    {
        $user = Auth::requirePermissionNaFilial('estoque.lancar');
        $justificativa = $this->texto(Request::json()['justificativa'] ?? '', 500);
        if (mb_strlen($justificativa) < self::MIN_JUSTIFICATIVA) {
            Response::json(['erro' => 'Explique o estorno em pelo menos 10 caracteres', 'campo' => 'justificativa'], 422);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $original = $this->documentos->buscar($id, $user['id_filial'], true);
            if ($original === null) {
                $pdo->rollBack();
                Response::json(['erro' => 'Documento não encontrado'], 404);
                return;
            }
            if ($original['status'] !== 'confirmado' || $original['subtipo'] === 'estorno') {
                $pdo->rollBack();
                Response::json(['erro' => 'Este documento já foi estornado ou é um estorno, e não pode ser estornado.'], 422);
                return;
            }

            $tipoContrario = $original['tipo'] === 'entrada' ? 'saida' : 'entrada';
            $numero = $this->documentos->proximoNumero($user['id_loja'], $tipoContrario, true);
            $idEstorno = $this->documentos->criar([
                'id_loja' => $user['id_loja'],
                'id_filial' => $user['id_filial'],
                'numero' => $numero,
                'tipo' => $tipoContrario,
                'subtipo' => 'estorno',
                'justificativa' => 'Estorno de ' . $original['numero'] . ': ' . $justificativa,
                'data_documento' => date('Y-m-d'),
                'id_usuario' => $user['id_usuario'],
                'id_documento_estornado' => (int) $original['id_documento'],
                'custo_total' => $original['custo_total'],
            ]);

            foreach ($original['itens'] as $item) {
                $produto = $this->produtos->findInFilial((int) $item['id_produto'], $user['id_filial']);
                if ($produto === null) {
                    continue;
                }
                $lotes = $this->lotes->sincronizar($produto);
                $quantidade = (float) $item['quantidade'];
                $idLote = $item['id_lote'] !== null ? (int) $item['id_lote'] : null;

                if ($tipoContrario === 'saida') {
                    $lote = $this->acharLote($lotes, $idLote);
                    if ($lote === null || (float) $lote['quantidade'] + 0.0005 < $quantidade) {
                        $pdo->rollBack();
                        Response::json(['erro' => sprintf(
                            'Não dá para estornar: o lote %s de "%s" tem só %s em estoque (parte já saiu).',
                            $item['codigo_lote'] ?? '?',
                            $item['nome_produto'],
                            $this->qtd($lote['quantidade'] ?? 0)
                        )], 422);
                        return;
                    }
                    $this->lotes->somar($idLote, -$quantidade);
                    $this->lotes->aplicarNoProduto((int) $produto['id_produto'], -$quantidade);
                } else {
                    if ($idLote === null || $this->acharLote($lotes, $idLote) === null) {
                        $idLote = $this->lotes->criar($produto, 'ESTORNO-' . $original['numero'], null, 0, null);
                    }
                    $this->lotes->somar($idLote, $quantidade);
                    $this->lotes->aplicarNoProduto((int) $produto['id_produto'], $quantidade);
                }
                $this->documentos->criarItem($idEstorno, [
                    'id_produto' => (int) $produto['id_produto'],
                    'id_lote' => $idLote,
                    'quantidade' => $quantidade,
                    'custo_unitario' => $item['custo_unitario'],
                ]);
                $this->documentos->movimentar(
                    $user['id_loja'], $user['id_filial'], (int) $produto['id_produto'], $idLote,
                    $user['id_usuario'], $idEstorno, $tipoContrario, $quantidade, 'estorno'
                );
            }
            $this->documentos->marcarEstornado((int) $original['id_documento']);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            error_log('[Hydra] Falha ao estornar documento ' . $id . ': ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível estornar. Nada foi alterado.'], 500);
            return;
        }

        Response::json(['documento' => $this->documentos->buscar($idEstorno, $user['id_filial'])], 201);
    }

    /* ================= Validação do cabeçalho ================= */

    /** @param array<string,mixed> $dados */
    private function validarCabecalhoEntrada(array $dados): array
    {
        $subtipo = (string) ($dados['subtipo'] ?? '');
        if (!isset(self::TIPOS_ENTRADA[$subtipo])) {
            return ['erro' => 'Escolha o tipo de entrada', 'campo' => 'subtipo'];
        }
        $motivo = (string) ($dados['motivo'] ?? '');
        if (!isset(self::MOTIVOS_ENTRADA[$motivo])) {
            return ['erro' => 'Escolha o motivo da entrada', 'campo' => 'motivo'];
        }
        $fornecedor = $this->texto($dados['fornecedor'] ?? '', 150);
        $nota = $this->texto($dados['nota_fiscal'] ?? '', 30);
        if ($subtipo === 'compra' && $fornecedor === '') {
            return ['erro' => 'Compra exige o fornecedor', 'campo' => 'fornecedor'];
        }
        if ($subtipo === 'compra' && $nota === '') {
            return ['erro' => 'Compra exige o número da nota fiscal', 'campo' => 'nota_fiscal'];
        }
        $data = (string) ($dados['data_documento'] ?? date('Y-m-d'));
        if (!$this->dataValida($data) || $data > date('Y-m-d')) {
            return ['erro' => 'Data de entrada inválida (não pode ser futura)', 'campo' => 'data_documento'];
        }
        return [
            'tipo' => 'entrada',
            'subtipo' => $subtipo,
            'motivo' => $motivo,
            'justificativa' => $this->texto($dados['justificativa'] ?? '', 500),
            'fornecedor' => $fornecedor !== '' ? $fornecedor : null,
            'nota_fiscal' => $nota !== '' ? $nota : null,
            'data_documento' => $data,
        ];
    }

    /** @param array<string,mixed> $dados */
    private function validarCabecalhoSaida(array $dados): array
    {
        $subtipo = (string) ($dados['subtipo'] ?? '');
        if (!isset(self::MOTIVOS_SAIDA[$subtipo])) {
            return ['erro' => 'Escolha o motivo da saída', 'campo' => 'subtipo'];
        }
        $justificativa = $this->texto($dados['justificativa'] ?? '', 500);
        if (mb_strlen($justificativa) < self::MIN_JUSTIFICATIVA) {
            return ['erro' => 'Descreva a saída em pelo menos 10 caracteres', 'campo' => 'justificativa'];
        }
        return [
            'tipo' => 'saida',
            'subtipo' => $subtipo,
            'motivo' => null,
            'justificativa' => $justificativa,
            'fornecedor' => null,
            'nota_fiscal' => null,
            'data_documento' => date('Y-m-d'),
        ];
    }

    /* ================= Gravação ================= */

    /**
     * @param array<string,mixed> $user
     * @param array<string,mixed> $cab
     * @param array<int,mixed> $itens
     */
    private function gravarEntrada(array $user, array $cab, array $itens, string $numero): array
    {
        $hoje = date('Y-m-d');
        $linhas = [];
        $vistos = [];
        $todosComObservacao = true;

        foreach ($itens as $i => $item) {
            $n = $i + 1;
            if (!is_array($item)) {
                return ['erro' => "Item $n inválido"];
            }
            $produto = $this->produtos->findInFilial((int) ($item['id_produto'] ?? 0), $user['id_filial']);
            if ($produto === null) {
                return ['erro' => "Item $n: produto não encontrado nesta filial"];
            }
            $nome = $produto['nome'];
            $quantidade = $this->numero($item['quantidade'] ?? null);
            if ($quantidade === null || $quantidade <= 0 || $quantidade > 999999) {
                return ['erro' => "\"$nome\": informe uma quantidade maior que zero"];
            }
            $custo = $this->numero($item['custo_unitario'] ?? null);
            if ($custo !== null && ($custo < 0 || $custo > 9999999)) {
                return ['erro' => "\"$nome\": custo unitário inválido"];
            }
            if ($cab['subtipo'] === 'compra' && $custo === null) {
                return ['erro' => "\"$nome\": compra exige o custo unitário"];
            }
            $codigo = $this->texto($item['lote'] ?? '', 50);
            if ($codigo === '') {
                $codigo = $numero; // sem lote informado: o lote leva o número do documento
            }
            $validade = (string) ($item['validade'] ?? '');
            if ($validade !== '' && !$this->dataValida($validade)) {
                return ['erro' => "\"$nome\": validade inválida"];
            }
            if ($validade !== '' && $validade < $hoje) {
                return ['erro' => "\"$nome\": a validade informada já passou"];
            }
            $chave = $produto['id_produto'] . '|' . mb_strtolower($codigo);
            if (isset($vistos[$chave])) {
                return ['erro' => "\"$nome\": o lote $codigo aparece duas vezes. Junte as quantidades numa linha."];
            }
            $vistos[$chave] = true;
            $observacao = $this->texto($item['observacao'] ?? '', 255);
            if ($observacao === '') {
                $todosComObservacao = false;
            }
            $linhas[] = compact('produto', 'quantidade', 'custo', 'codigo', 'validade', 'observacao');
        }

        $erroJustificativa = $this->erroJustificativaEntrada($cab, $todosComObservacao);
        if ($erroJustificativa !== null) {
            return $erroJustificativa;
        }

        $custoTotal = 0.0;
        foreach ($linhas as $linha) {
            $custoTotal += $linha['quantidade'] * ($linha['custo'] ?? 0);
        }
        $idDocumento = $this->documentos->criar($cab + [
            'id_loja' => $user['id_loja'],
            'id_filial' => $user['id_filial'],
            'numero' => $numero,
            'id_usuario' => $user['id_usuario'],
            'justificativa' => $cab['justificativa'] !== '' ? $cab['justificativa'] : null,
            'custo_total' => round($custoTotal, 2),
        ]);

        foreach ($linhas as $linha) {
            $produto = $linha['produto'];
            $lotes = $this->lotes->sincronizar($produto);
            $existente = null;
            foreach ($lotes as $lote) {
                if (mb_strtolower($lote['codigo']) === mb_strtolower($linha['codigo'])) {
                    $existente = $lote;
                    break;
                }
            }
            $validade = $linha['validade'] !== '' ? $linha['validade'] : null;
            if ($existente !== null) {
                if ($validade !== null && $existente['validade'] !== null && $existente['validade'] !== $validade) {
                    return ['erro' => sprintf(
                        '"%s": o lote %s já existe com validade %s. Use a mesma validade ou outro código de lote.',
                        $produto['nome'], $existente['codigo'], date('d/m/Y', strtotime($existente['validade']))
                    )];
                }
                $idLote = (int) $existente['id_lote'];
                $this->lotes->somar($idLote, $linha['quantidade']);
                if ($validade !== null && $existente['validade'] === null) {
                    db()->prepare('UPDATE lotes SET validade = :v WHERE id_lote = :id')->execute(['v' => $validade, 'id' => $idLote]);
                }
                if ($linha['custo'] !== null) {
                    $this->lotes->atualizarCusto($idLote, $linha['custo']);
                }
                $novo = false;
            } else {
                $idLote = $this->lotes->criar($produto, $linha['codigo'], $validade, $linha['quantidade'], $linha['custo']);
                $novo = true;
            }
            $this->lotes->aplicarNoProduto((int) $produto['id_produto'], $linha['quantidade']);
            $this->documentos->criarItem($idDocumento, [
                'id_produto' => (int) $produto['id_produto'],
                'id_lote' => $idLote,
                'quantidade' => $linha['quantidade'],
                'custo_unitario' => $linha['custo'],
                'observacao' => $linha['observacao'] !== '' ? $linha['observacao'] : null,
                'lote_novo' => $novo,
            ]);
            $this->documentos->movimentar(
                $user['id_loja'], $user['id_filial'], (int) $produto['id_produto'], $idLote,
                $user['id_usuario'], $idDocumento, 'entrada', $linha['quantidade'], 'documento'
            );
        }
        return ['id_documento' => $idDocumento];
    }

    /**
     * @param array<string,mixed> $user
     * @param array<string,mixed> $cab
     * @param array<int,mixed> $itens
     */
    private function gravarSaida(array $user, array $cab, array $itens, string $numero): array
    {
        $vistos = [];
        $plano = [];
        foreach ($itens as $i => $item) {
            $n = $i + 1;
            if (!is_array($item)) {
                return ['erro' => "Item $n inválido"];
            }
            $produto = $this->produtos->findInFilial((int) ($item['id_produto'] ?? 0), $user['id_filial']);
            if ($produto === null) {
                return ['erro' => "Item $n: produto não encontrado nesta filial"];
            }
            $nome = $produto['nome'];
            if (isset($vistos[$produto['id_produto']])) {
                return ['erro' => "\"$nome\" aparece duas vezes. Junte as quantidades num item só."];
            }
            $vistos[$produto['id_produto']] = true;
            $quantidade = $this->numero($item['quantidade'] ?? null);
            if ($quantidade === null || $quantidade <= 0) {
                return ['erro' => "\"$nome\": informe uma quantidade maior que zero"];
            }

            $lotes = $this->lotes->sincronizar($produto);
            $saldo = array_sum(array_map(static fn ($l) => (float) $l['quantidade'], $lotes));
            if ($quantidade > $saldo + 0.0005) {
                return ['erro' => sprintf('"%s": quantidade maior que o saldo (%s).', $nome, $this->qtd($saldo))];
            }

            $pedidas = is_array($item['alocacoes'] ?? null) ? $item['alocacoes'] : [];
            if ($pedidas === []) {
                $alocacoes = LoteRepository::alocarFefo($lotes, $quantidade) ?? [];
            } else {
                $alocacoes = [];
                $soma = 0.0;
                foreach ($pedidas as $pedida) {
                    $lote = $this->acharLote($lotes, (int) ($pedida['id_lote'] ?? 0));
                    $q = $this->numero($pedida['quantidade'] ?? null);
                    if ($lote === null) {
                        return ['erro' => "\"$nome\": lote escolhido não é deste produto"];
                    }
                    if ($q === null || $q < 0) {
                        return ['erro' => "\"$nome\": quantidade do lote {$lote['codigo']} inválida"];
                    }
                    if ($q > (float) $lote['quantidade'] + 0.0005) {
                        return ['erro' => sprintf('"%s": o lote %s tem só %s.', $nome, $lote['codigo'], $this->qtd($lote['quantidade']))];
                    }
                    if ($q > 0) {
                        $alocacoes[] = ['id_lote' => (int) $lote['id_lote'], 'quantidade' => $q, 'lote' => $lote];
                        $soma += $q;
                    }
                }
                if (abs($soma - $quantidade) > 0.0005) {
                    return ['erro' => sprintf('"%s": os lotes somam %s, mas a quantidade é %s.', $nome, $this->qtd($soma), $this->qtd($quantidade))];
                }
            }
            foreach ($alocacoes as &$alocacao) {
                $alocacao['lote'] = $alocacao['lote'] ?? $this->acharLote($lotes, $alocacao['id_lote']);
            }
            unset($alocacao);
            $plano[] = ['produto' => $produto, 'quantidade' => $quantidade, 'alocacoes' => $alocacoes];
        }

        $custoTotal = 0.0;
        foreach ($plano as $linha) {
            foreach ($linha['alocacoes'] as $a) {
                $custo = $a['lote']['custo_unitario'] ?? $linha['produto']['preco_custo'] ?? 0;
                $custoTotal += $a['quantidade'] * (float) $custo;
            }
        }
        $idDocumento = $this->documentos->criar($cab + [
            'id_loja' => $user['id_loja'],
            'id_filial' => $user['id_filial'],
            'numero' => $numero,
            'id_usuario' => $user['id_usuario'],
            'custo_total' => round($custoTotal, 2),
        ]);

        foreach ($plano as $linha) {
            $idProduto = (int) $linha['produto']['id_produto'];
            foreach ($linha['alocacoes'] as $a) {
                $this->lotes->somar($a['id_lote'], -$a['quantidade']);
                $custo = $a['lote']['custo_unitario'] ?? $linha['produto']['preco_custo'];
                $this->documentos->criarItem($idDocumento, [
                    'id_produto' => $idProduto,
                    'id_lote' => $a['id_lote'],
                    'quantidade' => $a['quantidade'],
                    'custo_unitario' => $custo !== null ? (float) $custo : null,
                ]);
                $this->documentos->movimentar(
                    $user['id_loja'], $user['id_filial'], $idProduto, $a['id_lote'],
                    $user['id_usuario'], $idDocumento, 'saida', $a['quantidade'], 'documento'
                );
            }
            $this->lotes->aplicarNoProduto($idProduto, -$linha['quantidade']);
        }
        return ['id_documento' => $idDocumento];
    }

    /** @param array<string,mixed> $cab */
    private function erroJustificativaEntrada(array $cab, bool $todosComObservacao): ?array
    {
        $tamanho = mb_strlen($cab['justificativa']);
        if ($tamanho > 0 && $tamanho < self::MIN_JUSTIFICATIVA && !$todosComObservacao) {
            return ['erro' => 'A descrição precisa de pelo menos 10 caracteres — ou preencha a observação de todos os itens.', 'campo' => 'justificativa'];
        }
        if (in_array($cab['subtipo'], self::ENTRADA_EXIGE_JUSTIFICATIVA, true)
            && $tamanho < self::MIN_JUSTIFICATIVA && !$todosComObservacao) {
            return ['erro' => self::TIPOS_ENTRADA[$cab['subtipo']] . ' exige justificativa: descrição com 10 caracteres ou observação em todos os itens.', 'campo' => 'justificativa'];
        }
        return null;
    }

    /* ================= Utilidades ================= */

    /** @param array<int,array<string,mixed>> $lotes */
    private function acharLote(array $lotes, ?int $idLote): ?array
    {
        foreach ($lotes as $lote) {
            if ((int) $lote['id_lote'] === $idLote) {
                return $lote;
            }
        }
        return null;
    }

    private function texto($valor, int $max): string
    {
        return mb_substr(trim((string) preg_replace('/\s+/u', ' ', (string) $valor)), 0, $max);
    }

    private function numero($valor): ?float
    {
        if ($valor === null || $valor === '') {
            return null;
        }
        if (is_string($valor)) {
            $valor = str_replace(',', '.', $valor);
        }
        return is_numeric($valor) ? round((float) $valor, 3) : null;
    }

    private function dataValida(string $data): bool
    {
        $d = \DateTime::createFromFormat('Y-m-d', $data);
        return $d !== false && $d->format('Y-m-d') === $data;
    }

    private function qtd($valor): string
    {
        return rtrim(rtrim(number_format((float) $valor, 3, ',', '.'), '0'), ',');
    }
}
