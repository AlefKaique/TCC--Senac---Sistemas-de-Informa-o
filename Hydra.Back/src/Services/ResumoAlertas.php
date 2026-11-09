<?php

namespace Hydra\Services;

use Hydra\Repositories\ProdutoRepository;

final class ResumoAlertas
{
    public function __construct(private ?ProdutoRepository $produtos = null)
    {
        $this->produtos ??= new ProdutoRepository();
    }

    /** @return array{qtd_estoque:int,nomes_estoque:array<int,string>,qtd_validade:int,nomes_validade:array<int,string>} */
    public function porFilial(
        int $idFilial,
        string $data,
        int $diasValidade,
        bool $alertaEstoque = true,
        bool $alertaValidade = true
    ): array {
        $estoque = $alertaEstoque
            ? $this->produtos->resumoAbaixoDoMinimo($idFilial)
            : ['quantidade' => 0, 'nomes' => []];
        $validade = $alertaValidade
            ? $this->produtos->resumoValidades($idFilial, $data, $diasValidade)
            : ['quantidade' => 0, 'nomes' => []];

        return [
            'qtd_estoque' => $estoque['quantidade'],
            'nomes_estoque' => $estoque['nomes'],
            'qtd_validade' => $validade['quantidade'],
            'nomes_validade' => $validade['nomes'],
        ];
    }
}
