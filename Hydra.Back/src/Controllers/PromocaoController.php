<?php

namespace Hydra\Controllers;

use Hydra\Repositories\ProdutoRepository;
use Hydra\Repositories\PromocaoRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Tela "Promoções" (Admin): preço promocional para escoar produtos
 * prestes a vencer.
 *
 * Usa a permissão "produtos.editar_preco" e não uma nova: promoção é uma
 * alteração de preço, e a RN04 já reserva isso a quem tem essa permissão.
 * Um código novo também nasceria desmarcado em todos os cargos existentes,
 * deixando a tela invisível até alguém ir em Cargos marcá-lo.
 */
final class PromocaoController
{
    /** Janela de "prestes a vencer" — a mesma do alerta de validade do Dashboard. */
    private const DIAS_A_VENCER = 30;

    private PromocaoRepository $promocoes;
    private ProdutoRepository $produtos;

    public function __construct()
    {
        $this->promocoes = new PromocaoRepository();
        $this->produtos = new ProdutoRepository();
    }

    /** GET /api/promocoes — promoções da loja e produtos candidatos (a vencer). */
    public function index(): void
    {
        $user = Auth::requirePermissionNaFilial('produtos.editar_preco');
        Response::json([
            'promocoes' => $this->promocoes->listByFilial($user['id_filial']),
            'produtos_a_vencer' => $this->promocoes->produtosAVencer($user['id_filial'], self::DIAS_A_VENCER),
            'hoje' => date('Y-m-d'),
        ]);
    }

    /** POST /api/promocoes */
    public function store(): void
    {
        $user = Auth::requirePermissionNaFilial('produtos.editar_preco');
        $dados = Request::json();

        $idProduto = (int) ($dados['id_produto'] ?? 0);
        $preco = $dados['preco_promocional'] ?? null;
        $inicio = (string) ($dados['data_inicio'] ?? '');
        $fim = (string) ($dados['data_fim'] ?? '');

        $produto = $this->produtos->findInFilial($idProduto, $user['id_filial']);
        if ($produto === null || $produto['status'] !== 'ativo') {
            Response::json(['erro' => 'Produto não encontrado ou inativo'], 422);
            return;
        }

        if (!is_numeric($preco) || (float) $preco <= 0) {
            Response::json(['erro' => 'Informe um preço promocional válido'], 422);
            return;
        }
        $preco = round((float) $preco, 2);
        if ($preco >= (float) $produto['preco_venda']) {
            Response::json(['erro' => 'O preço promocional precisa ser menor que o preço normal'], 422);
            return;
        }

        if (!self::dataValida($inicio) || !self::dataValida($fim)) {
            Response::json(['erro' => 'Informe datas de início e fim válidas'], 422);
            return;
        }
        if ($fim < $inicio) {
            Response::json(['erro' => 'A data de fim não pode ser anterior à de início'], 422);
            return;
        }
        if ($fim < date('Y-m-d')) {
            Response::json(['erro' => 'A promoção precisa terminar hoje ou depois'], 422);
            return;
        }
        // Depois da validade o produto não pode ser vendido, nem em promoção.
        if ($produto['validade'] !== null && $fim > $produto['validade']) {
            Response::json(['erro' => 'A promoção não pode passar da validade do produto (' . self::dataBr($produto['validade']) . ')'], 422);
            return;
        }

        if ($this->promocoes->existeSobreposta($idProduto, $user['id_filial'], $inicio, $fim)) {
            Response::json(['erro' => 'Este produto já tem uma promoção ativa nesse período. Encerre a atual antes de criar outra.'], 409);
            return;
        }

        $id = $this->promocoes->create($user['id_loja'], $user['id_filial'], $idProduto, $user['id_usuario'], $preco, $inicio, $fim);
        Response::json(['promocao' => $this->promocoes->findInFilial($id, $user['id_filial'])], 201);
    }

    /** POST /api/promocoes/{id}/encerrar — encerra antes do prazo; o produto volta ao preço normal. */
    public function encerrar(int $id): void
    {
        $user = Auth::requirePermissionNaFilial('produtos.editar_preco');
        $promocao = $this->promocoes->findInFilial($id, $user['id_filial']);
        if ($promocao === null) {
            Response::json(['erro' => 'Promoção não encontrada'], 404);
            return;
        }
        $this->promocoes->encerrar($id);
        Response::json(['promocao' => $this->promocoes->findInFilial($id, $user['id_filial'])]);
    }

    private static function dataValida(string $data): bool
    {
        $d = \DateTimeImmutable::createFromFormat('!Y-m-d', $data);
        return $d !== false && $d->format('Y-m-d') === $data;
    }

    private static function dataBr(string $data): string
    {
        [$a, $m, $d] = explode('-', $data);
        return "$d/$m/$a";
    }
}
