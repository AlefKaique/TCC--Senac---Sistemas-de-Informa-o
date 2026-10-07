<?php

namespace Hydra\Controllers;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\MovimentacaoEstoqueRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Repositories\PromocaoRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Repositories\VendaRepository;
use Hydra\Support\Auth;
use Hydra\Support\RateLimit;
use Hydra\Support\Request;
use Hydra\Support\Response;
use Hydra\Support\SenhaAutorizacao;

/**
 * Tela "Caixa" (PDV) — RF04, RF09, RF12, RF13, RN01, RN07-RN11, RN15.
 */
final class VendaController
{
    private const FORMAS_PAGAMENTO = ['pix', 'cartao_credito', 'cartao_debito', 'vale_refeicao', 'dinheiro'];

    private VendaRepository $vendas;
    private ProdutoRepository $produtos;
    private MovimentacaoEstoqueRepository $movimentacoes;
    private PromocaoRepository $promocoes;

    public function __construct()
    {
        $this->vendas = new VendaRepository();
        $this->produtos = new ProdutoRepository();
        $this->movimentacoes = new MovimentacaoEstoqueRepository();
        // Instanciado aqui, antes da transação de store(): o construtor pode
        // criar a tabela, e DDL no MySQL faz commit implícito.
        $this->promocoes = new PromocaoRepository();
    }

    /**
     * GET /api/vendas — histórico de vendas (RF10), com itens e pagamentos
     * embutidos.
     *
     * Aceita também "relatorios.visualizar" porque o Dashboard calcula o
     * faturamento a partir desta lista: um cargo criado só para acompanhar
     * os números da loja não deve levar 403 aqui, nem precisar da permissão
     * de abrir o histórico item a item.
     */
    public function index(): void
    {
        $user = Auth::requireAnyPermissionNaFilial(['vendas.historico', 'relatorios.visualizar']);
        $vendas = $this->vendas->listByFilial($user['id_filial']);
        foreach ($vendas as &$venda) {
            $venda['itens'] = $this->vendas->listItensByVenda((int) $venda['id_venda']);
            $venda['pagamentos'] = $this->vendas->listPagamentosByVenda((int) $venda['id_venda']);
        }
        unset($venda);

        // O Caixa precisa saber qual número a próxima venda vai receber
        // para montar o cabeçalho "Pedido #N" antes de a venda existir.
        Response::json([
            'vendas' => $vendas,
            'proximo_numero' => $this->vendas->proximoNumero($user['id_filial']),
        ]);
    }

    /**
     * POST /api/vendas
     * Finaliza uma venda (RF04): valida disponibilidade de estoque
     * (RN01/RN08) e forma(s) de pagamento (RN09/RN10), grava a venda
     * com seus itens e pagamentos, baixa o estoque de cada produto e
     * registra o movimento de saída correspondente (RF12/RN11) — tudo
     * em uma única transação.
     */
    public function store(): void
    {
        $user = Auth::requirePermissionNaFilial('vendas.operar');
        $dados = Request::json();

        $itensEntrada = $dados['itens'] ?? [];
        $pagamentosEntrada = $dados['pagamentos'] ?? [];
        $idCliente = isset($dados['id_cliente']) && $dados['id_cliente'] !== null ? (int) $dados['id_cliente'] : null;
        $descontoInformado = $dados['desconto'] ?? 0;

        if (!is_array($itensEntrada) || count($itensEntrada) === 0) {
            Response::json(['erro' => 'Adicione ao menos um item à venda'], 422);
            return;
        }
        if (!is_array($pagamentosEntrada) || count($pagamentosEntrada) === 0) {
            Response::json(['erro' => 'Selecione a forma de pagamento'], 422);
            return;
        }
        if (!is_numeric($descontoInformado) || (float) $descontoInformado < 0) {
            Response::json(['erro' => 'Desconto inválido'], 422);
            return;
        }
        // O desconto não tem permissão própria: "vendas.aplicar_desconto"
        // foi retirada do catálogo porque a tela do Caixa não oferece
        // campo de desconto. Quem pode registrar a venda informa o
        // desconto junto com ela, e o valor continua sendo validado acima.

        foreach ($pagamentosEntrada as $pagamento) {
            $forma = (string) ($pagamento['forma_pagamento'] ?? '');
            $valor = $pagamento['valor'] ?? null;
            if (!in_array($forma, self::FORMAS_PAGAMENTO, true)) {
                Response::json(['erro' => 'Forma de pagamento inválida'], 422);
                return;
            }
            if (!is_numeric($valor) || (float) $valor <= 0) {
                Response::json(['erro' => 'Valor de pagamento inválido'], 422);
                return;
            }
        }

        // Soma as linhas que repetem o mesmo produto ANTES de validar o
        // estoque. Sem isso, cada linha era conferida contra o saldo
        // inteiro: com 10 em estoque, duas linhas de 8 passavam as duas e
        // a venda baixava 16.
        $quantidadePorProduto = [];
        foreach ($itensEntrada as $item) {
            $idProduto = (int) ($item['id_produto'] ?? 0);
            $quantidade = $item['quantidade'] ?? null;
            if (!is_numeric($quantidade) || (float) $quantidade <= 0) {
                Response::json(['erro' => 'Quantidade inválida em um dos itens'], 422);
                return;
            }
            $quantidadePorProduto[$idProduto] = ($quantidadePorProduto[$idProduto] ?? 0.0) + (float) $quantidade;
        }

        // Recalcula os preços a partir do produto no banco — nunca confia no
        // preço enviado pelo cliente.
        $itensValidados = [];
        $subtotal = 0.0;
        foreach ($quantidadePorProduto as $idProduto => $quantidade) {
            $produto = $this->produtos->findInFilial($idProduto, $user['id_filial']);
            if ($produto === null || $produto['status'] !== 'ativo') {
                Response::json(['erro' => 'Produto indisponível para venda'], 422);
                return;
            }
            // RN01/RN08 — disponibilidade de estoque.
            if ($quantidade > (float) $produto['quantidade']) {
                Response::json(['erro' => "Quantidade em estoque insuficiente para \"{$produto['nome']}\""], 422);
                return;
            }

            // Promoção vigente hoje (tela Promoções) substitui o preço normal.
            $precoPromocional = $this->promocoes->precoVigente($idProduto, $user['id_filial']);
            $precoUnitario = $precoPromocional ?? (float) $produto['preco_venda'];
            $subtotal += $precoUnitario * $quantidade;
            $itensValidados[] = [
                'id_produto' => $idProduto,
                'quantidade' => $quantidade,
                'preco_unitario' => $precoUnitario,
            ];
        }

        $desconto = min((float) $descontoInformado, $subtotal);
        $valorTotal = round($subtotal - $desconto, 2);

        $somaPagamentos = array_reduce($pagamentosEntrada, fn ($soma, $p) => $soma + (float) $p['valor'], 0.0);
        // RN09 — a venda só é finalizada com pagamento(s) cuja soma cubra o total.
        if (abs($somaPagamentos - $valorTotal) > 0.01) {
            Response::json(['erro' => 'A soma dos pagamentos deve ser igual ao total da venda'], 422);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $idVenda = $this->vendas->create(
                $user['id_loja'],
                $user['id_filial'],
                $user['id_usuario'],
                $idCliente,
                round($subtotal, 2),
                round($desconto, 2),
                $valorTotal
            );

            foreach ($itensValidados as $item) {
                // A verificação acima serve para a mensagem de erro; a
                // garantia real vem deste UPDATE condicional, que impede
                // duas vendas simultâneas de zerarem o mesmo saldo.
                if (!$this->produtos->baixarQuantidadeSeHouver($item['id_produto'], $item['quantidade'])) {
                    throw new \RuntimeException('Estoque insuficiente para o produto ' . $item['id_produto']);
                }
                $this->vendas->addItem($idVenda, $item['id_produto'], $item['quantidade'], $item['preco_unitario']);
                $this->movimentacoes->create(
                    $user['id_loja'],
                    $user['id_filial'],
                    $item['id_produto'],
                    $user['id_usuario'],
                    $idVenda,
                    'saida',
                    (string) $item['quantidade'],
                    'venda'
                );
            }

            foreach ($pagamentosEntrada as $pagamento) {
                $this->vendas->addPagamento($idVenda, (string) $pagamento['forma_pagamento'], (float) $pagamento['valor']);
            }

            $pdo->commit();
        } catch (\RuntimeException $e) {
            // Estoque esgotado entre a validação e a baixa (outra venda
            // simultânea levou as últimas unidades).
            $pdo->rollBack();
            Response::json(['erro' => 'O estoque de um dos produtos acabou durante a finalização. Confira as quantidades e tente de novo.'], 409);
            return;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível registrar a venda'], 500);
            return;
        }

        $venda = $this->vendas->findInFilial($idVenda, $user['id_filial']);
        $venda['itens'] = $this->vendas->listItensByVenda($idVenda);
        $venda['pagamentos'] = $this->vendas->listPagamentosByVenda($idVenda);

        Response::json(['venda' => $venda], 201);
    }

    /* ================= Cancelamento de venda =================
       A aba "Cancelar Venda" da tela Vendas só abre depois que um gerente
       ou administrador digita a senha de autorização dele (PIN cadastrado
       na tela Equipe). A autorização fica na SESSÃO por alguns minutos —
       nunca é um id enviado pelo navegador — e vale só para a filial em
       que foi dada. */

    private const AUTORIZACAO_MINUTOS = 5;

    /**
     * POST /api/vendas/autorizar-cancelamento — { "senha": "1234" }
     * Confere o PIN e abre a janela de cancelamento.
     */
    public function autorizarCancelamento(): void
    {
        $user = Auth::requireAnyPermissionNaFilial(['vendas.operar', 'vendas.historico']);
        $senha = trim((string) (Request::json()['senha'] ?? ''));

        // Por operador logado: é quem está tentando os PINs.
        $chave = 'autorizacao_cancelamento:' . $user['id_usuario'];
        RateLimit::requireNaoBloqueado($chave);

        $autorizador = $senha === '' ? null : SenhaAutorizacao::encontrarAutorizador($user['id_loja'], $senha);
        if ($autorizador !== null && !$this->autorizadorAcessaFilial($autorizador, $user)) {
            $autorizador = null;
        }
        if ($autorizador === null) {
            RateLimit::registrarFalha($chave);
            Response::json(['erro' => 'Senha de autorização inválida'], 403);
            return;
        }
        RateLimit::limpar($chave);

        $_SESSION['cancelamento_autorizado'] = [
            'id_autorizador' => (int) $autorizador['id_usuario'],
            'id_filial' => $user['id_filial'],
            'expira' => time() + self::AUTORIZACAO_MINUTOS * 60,
        ];

        Response::json([
            'autorizador' => $autorizador['nome'],
            'expira_em_segundos' => self::AUTORIZACAO_MINUTOS * 60,
        ]);
    }

    /** POST /api/vendas/autorizar-cancelamento/encerrar — a tela saiu da aba de cancelamento. */
    public function encerrarAutorizacao(): void
    {
        Auth::requireLogin();
        unset($_SESSION['cancelamento_autorizado']);
        Response::json(['ok' => true]);
    }

    /**
     * POST /api/vendas/{id}/cancelar — { "motivo": "..." }
     * Exige a autorização aberta acima. Marca a venda como cancelada,
     * devolve ao estoque a quantidade de cada item e registra a entrada
     * (origem "cancelamento_venda") — tudo numa transação.
     */
    public function cancelar(int $idVenda): void
    {
        $user = Auth::requireAnyPermissionNaFilial(['vendas.operar', 'vendas.historico']);

        $autorizacao = $_SESSION['cancelamento_autorizado'] ?? null;
        $valida = is_array($autorizacao)
            && $autorizacao['expira'] > time()
            && (int) $autorizacao['id_filial'] === $user['id_filial'];
        // O autorizador pode ter sido inativado ou perdido o PIN depois
        // de digitá-lo: revalida a cada cancelamento.
        $autorizador = $valida ? $this->autorizadorAtivo($user['id_loja'], (int) $autorizacao['id_autorizador']) : null;
        if ($autorizador === null || !$this->autorizadorAcessaFilial($autorizador, $user)) {
            unset($_SESSION['cancelamento_autorizado']);
            Response::json([
                'erro' => 'A autorização expirou. Peça ao gerente ou administrador para digitar a senha de novo.',
                'codigo' => 'autorizacao_necessaria',
            ], 403);
            return;
        }

        $venda = $this->vendas->findInFilial($idVenda, $user['id_filial']);
        if ($venda === null) {
            Response::json(['erro' => 'Venda não encontrada'], 404);
            return;
        }
        if ($venda['status'] === 'cancelada') {
            Response::json(['erro' => 'Esta venda já foi cancelada'], 409);
            return;
        }

        $motivo = trim((string) (Request::json()['motivo'] ?? ''));
        $motivo = $motivo === '' ? null : mb_substr($motivo, 0, 255, 'UTF-8');
        $itens = $this->vendas->listItensByVenda($idVenda);

        $pdo = db();
        $pdo->beginTransaction();
        try {
            if (!$this->vendas->cancelar($idVenda, $user['id_filial'], $user['id_usuario'], (int) $autorizador['id_usuario'], $motivo)) {
                throw new \RuntimeException('Venda já cancelada');
            }
            foreach ($itens as $item) {
                $this->produtos->ajustarQuantidade((int) $item['id_produto'], (float) $item['quantidade']);
                $this->movimentacoes->create(
                    $user['id_loja'],
                    $user['id_filial'],
                    (int) $item['id_produto'],
                    $user['id_usuario'],
                    $idVenda,
                    'entrada',
                    (string) $item['quantidade'],
                    'cancelamento_venda'
                );
            }
            $pdo->commit();
        } catch (\RuntimeException $e) {
            // Outro terminal cancelou a mesma venda no meio do caminho.
            $pdo->rollBack();
            Response::json(['erro' => 'Esta venda já foi cancelada'], 409);
            return;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível cancelar a venda'], 500);
            return;
        }

        $venda = $this->vendas->findInFilial($idVenda, $user['id_filial']);
        $venda['itens'] = $this->vendas->listItensByVenda($idVenda);
        $venda['pagamentos'] = $this->vendas->listPagamentosByVenda($idVenda);
        Response::json(['venda' => $venda]);
    }

    /** @return array<string,mixed>|null */
    private function autorizadorAtivo(int $idLoja, int $idUsuario): ?array
    {
        foreach ((new UsuarioRepository())->listAutorizadoresDaLoja($idLoja) as $candidato) {
            if ((int) $candidato['id_usuario'] === $idUsuario) {
                return $candidato;
            }
        }
        return null;
    }

    /**
     * O gerente de outra filial não autoriza cancelamento nesta: mesmo
     * critério de acesso a filial do resto do sistema (o Administrador
     * acessa todas).
     *
     * @param array<string,mixed> $autorizador
     * @param array<string,mixed> $user
     */
    private function autorizadorAcessaFilial(array $autorizador, array $user): bool
    {
        $permissoes = $autorizador['id_cargo'] !== null
            ? (new CargoRepository())->permissoesDoCargo((int) $autorizador['id_cargo'])
            : [];
        return (new FilialRepository())->podeAcessar(
            (int) $autorizador['id_usuario'],
            $user['id_loja'],
            CargoRepository::nivelEquivalente($permissoes) === 'administrador',
            $user['id_filial']
        );
    }
}
