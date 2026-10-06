<?php

namespace Hydra\Repositories;

/**
 * Tela "Caixa" (PDV) — RF04, RF09, RF12, RF13.
 */
final class VendaRepository
{
    /**
     * Grava a venda e devolve o id_venda.
     *
     * O número do pedido (numero_venda) é calculado aqui, e não pelo
     * AUTO_INCREMENT: "id_venda" é global e compartilhado por todas as
     * lojas, então usá-lo na tela faria a primeira venda de uma loja nova
     * aparecer como "#28". A numeração é por FILIAL. O FOR UPDATE segura a
     * faixa de linhas da filial até o fim da transação — que
     * VendaController::store() já abriu — para que duas vendas simultâneas
     * não leiam o mesmo MAX. A garantia final é a UNIQUE KEY
     * uq_vendas_filial_numero: se ainda assim houver empate, o INSERT
     * estoura e o controller faz rollback.
     */
    public function create(int $idLoja, int $idFilial, int $idUsuario, ?int $idCliente, float $subtotal, float $desconto, float $valorTotal): int
    {
        $stmt = db()->prepare(
            'SELECT COALESCE(MAX(numero_venda), 0) + 1 FROM vendas WHERE id_filial = :id_filial FOR UPDATE'
        );
        $stmt->execute(['id_filial' => $idFilial]);
        $numeroVenda = (int) $stmt->fetchColumn();

        $stmt = db()->prepare(
            'INSERT INTO vendas (id_loja, id_filial, numero_venda, id_usuario, id_cliente, subtotal, desconto, valor_total)
             VALUES (:id_loja, :id_filial, :numero_venda, :id_usuario, :id_cliente, :subtotal, :desconto, :valor_total)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
            'numero_venda' => $numeroVenda,
            'id_usuario' => $idUsuario,
            'id_cliente' => $idCliente,
            'subtotal' => $subtotal,
            'desconto' => $desconto,
            'valor_total' => $valorTotal,
        ]);
        return (int) db()->lastInsertId();
    }

    /**
     * Número que a próxima venda da filial vai receber — é o que o
     * cabeçalho do Caixa mostra ("Pedido #7") antes de a venda existir. É
     * uma previsão, não uma reserva: se outro caixa finalizar primeiro, o
     * número efetivo é o que create() calcular dentro da transação.
     */
    public function proximoNumero(int $idFilial): int
    {
        $stmt = db()->prepare(
            'SELECT COALESCE(MAX(numero_venda), 0) + 1 FROM vendas WHERE id_filial = :id_filial'
        );
        $stmt->execute(['id_filial' => $idFilial]);
        return (int) $stmt->fetchColumn();
    }

    public function addItem(int $idVenda, int $idProduto, float $quantidade, float $precoUnitario): void
    {
        $stmt = db()->prepare(
            'INSERT INTO itens_venda (id_venda, id_produto, quantidade, preco_unitario)
             VALUES (:id_venda, :id_produto, :quantidade, :preco_unitario)'
        );
        $stmt->execute([
            'id_venda' => $idVenda,
            'id_produto' => $idProduto,
            'quantidade' => $quantidade,
            'preco_unitario' => $precoUnitario,
        ]);
    }

    public function addPagamento(int $idVenda, string $formaPagamento, float $valor): void
    {
        $stmt = db()->prepare(
            'INSERT INTO pagamentos (id_venda, forma_pagamento, valor) VALUES (:id_venda, :forma_pagamento, :valor)'
        );
        $stmt->execute([
            'id_venda' => $idVenda,
            'forma_pagamento' => $formaPagamento,
            'valor' => $valor,
        ]);
    }

    /* O histórico de vendas mostra quem operou o caixa, não o cliente:
       "v.*" (nunca "*") porque com o JOIN o asterisco despejaria
       usuarios.* inteiro no JSON da API — senha, e-mail e reset_token
       incluídos. LEFT JOIN por simetria com o histórico de
       movimentações, embora vendas.id_usuario seja NOT NULL. */
    private const SELECT_COM_USUARIO =
        'SELECT v.*, u.nome AS nome_usuario
           FROM vendas v
           LEFT JOIN usuarios u ON u.id_usuario = v.id_usuario';

    public function findInFilial(int $idVenda, int $idFilial): ?array
    {
        $stmt = db()->prepare(
            self::SELECT_COM_USUARIO . ' WHERE v.id_venda = :id AND v.id_filial = :id_filial'
        );
        $stmt->execute(['id' => $idVenda, 'id_filial' => $idFilial]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<int,array<string,mixed>> */
    public function listByFilial(int $idFilial): array
    {
        $stmt = db()->prepare(
            self::SELECT_COM_USUARIO . ' WHERE v.id_filial = :id_filial ORDER BY v.data_venda DESC'
        );
        $stmt->execute(['id_filial' => $idFilial]);
        return $stmt->fetchAll();
    }

    /**
     * Resumo de cada filial da loja no período [inicio, fim): quantidade de
     * vendas, faturamento e lucro bruto, para os cartões da tela Filiais.
     *
     * Lucro bruto com a MESMA regra do card "Lucro Bruto do Mês" do
     * Dashboard: valor da venda (já com desconto) menos o custo dos itens,
     * pelo preço de custo ATUAL do produto (itens_venda não guarda o custo
     * da época); produto sem preço de custo entra com custo 0.
     *
     * O custo é somado por venda numa subconsulta antes do JOIN; somado
     * direto no JOIN com itens_venda, o valor_total de cada venda seria
     * contado uma vez por item.
     *
     * @return array<int,array{vendas:int,faturamento:float,lucro:float}> id_filial => resumo
     */
    public function resumoPorFilial(int $idLoja, string $inicio, string $fim): array
    {
        $stmt = db()->prepare(
            'SELECT v.id_filial,
                    COUNT(*) AS vendas,
                    COALESCE(SUM(v.valor_total), 0) AS faturamento,
                    COALESCE(SUM(v.valor_total - COALESCE(c.custo, 0)), 0) AS lucro
               FROM vendas v
               LEFT JOIN (
                    SELECT iv.id_venda, SUM(iv.quantidade * COALESCE(p.preco_custo, 0)) AS custo
                      FROM itens_venda iv
                      JOIN vendas v2 ON v2.id_venda = iv.id_venda
                      JOIN produtos p ON p.id_produto = iv.id_produto
                     WHERE v2.id_loja = :id_loja2 AND v2.data_venda >= :inicio2 AND v2.data_venda < :fim2
                     GROUP BY iv.id_venda
               ) c ON c.id_venda = v.id_venda
              WHERE v.id_loja = :id_loja AND v.data_venda >= :inicio AND v.data_venda < :fim
              GROUP BY v.id_filial'
        );
        $stmt->execute([
            'id_loja' => $idLoja, 'inicio' => $inicio, 'fim' => $fim,
            'id_loja2' => $idLoja, 'inicio2' => $inicio, 'fim2' => $fim,
        ]);

        $porFilial = [];
        foreach ($stmt->fetchAll() as $row) {
            $porFilial[(int) $row['id_filial']] = [
                'vendas' => (int) $row['vendas'],
                'faturamento' => round((float) $row['faturamento'], 2),
                'lucro' => round((float) $row['lucro'], 2),
            ];
        }
        return $porFilial;
    }

    /* "custo_unitario" é o preço de custo ATUAL do produto (itens_venda não
       guarda o custo da época da venda) — é com ele que o Dashboard calcula
       o lucro bruto. */
    /** @return array<int,array<string,mixed>> */
    public function listItensByVenda(int $idVenda): array
    {
        $stmt = db()->prepare(
            'SELECT iv.*, p.nome AS nome_produto, p.preco_custo AS custo_unitario
             FROM itens_venda iv
             JOIN produtos p ON p.id_produto = iv.id_produto
             WHERE iv.id_venda = :id_venda'
        );
        $stmt->execute(['id_venda' => $idVenda]);
        return $stmt->fetchAll();
    }

    /** @return array<int,array<string,mixed>> */
    public function listPagamentosByVenda(int $idVenda): array
    {
        $stmt = db()->prepare('SELECT * FROM pagamentos WHERE id_venda = :id_venda');
        $stmt->execute(['id_venda' => $idVenda]);
        return $stmt->fetchAll();
    }
}
