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
     * aparecer como "#28". O FOR UPDATE segura a faixa de linhas da loja
     * até o fim da transação — que VendaController::store() já abriu —
     * para que duas vendas simultâneas não leiam o mesmo MAX. A garantia
     * final é a UNIQUE KEY uq_vendas_loja_numero: se ainda assim houver
     * empate, o INSERT estoura e o controller faz rollback.
     */
    public function create(int $idLoja, int $idUsuario, ?int $idCliente, float $subtotal, float $desconto, float $valorTotal): int
    {
        $stmt = db()->prepare(
            'SELECT COALESCE(MAX(numero_venda), 0) + 1 FROM vendas WHERE id_loja = :id_loja FOR UPDATE'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        $numeroVenda = (int) $stmt->fetchColumn();

        $stmt = db()->prepare(
            'INSERT INTO vendas (id_loja, numero_venda, id_usuario, id_cliente, subtotal, desconto, valor_total)
             VALUES (:id_loja, :numero_venda, :id_usuario, :id_cliente, :subtotal, :desconto, :valor_total)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
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
     * Número que a próxima venda da loja vai receber — é o que o cabeçalho
     * do Caixa mostra ("Pedido #7") antes de a venda existir. É uma
     * previsão, não uma reserva: se outro caixa finalizar primeiro, o
     * número efetivo é o que create() calcular dentro da transação.
     */
    public function proximoNumero(int $idLoja): int
    {
        $stmt = db()->prepare(
            'SELECT COALESCE(MAX(numero_venda), 0) + 1 FROM vendas WHERE id_loja = :id_loja'
        );
        $stmt->execute(['id_loja' => $idLoja]);
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

    public function findInLoja(int $idVenda, int $idLoja): ?array
    {
        $stmt = db()->prepare(
            self::SELECT_COM_USUARIO . ' WHERE v.id_venda = :id AND v.id_loja = :id_loja'
        );
        $stmt->execute(['id' => $idVenda, 'id_loja' => $idLoja]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<int,array<string,mixed>> */
    public function listByLoja(int $idLoja): array
    {
        $stmt = db()->prepare(
            self::SELECT_COM_USUARIO . ' WHERE v.id_loja = :id_loja ORDER BY v.data_venda DESC'
        );
        $stmt->execute(['id_loja' => $idLoja]);
        return $stmt->fetchAll();
    }

    /** @return array<int,array<string,mixed>> */
    public function listItensByVenda(int $idVenda): array
    {
        $stmt = db()->prepare(
            'SELECT iv.*, p.nome AS nome_produto
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
