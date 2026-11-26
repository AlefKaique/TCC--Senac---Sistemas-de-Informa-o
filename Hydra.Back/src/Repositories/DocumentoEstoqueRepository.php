<?php

namespace Hydra\Repositories;

/**
 * Documentos de entrada e saída de estoque (cabeçalho + itens).
 *
 * Um documento confirmado não é editado nem excluído: só estornado, o que
 * gera um documento contrário (subtipo "estorno") e marca o original como
 * "estornado". As tabelas são criadas por LoteRepository::migrar().
 */
final class DocumentoEstoqueRepository
{
    /**
     * Próximo número do tipo na loja: ENT-2026-00001, SAI-2026-00001.
     * Com $travar = true (dentro da transação do cadastro), trava os
     * documentos do ano até o commit; o índice UNIQUE é a última barreira.
     */
    public function proximoNumero(int $idLoja, string $tipo, bool $travar): string
    {
        $prefixo = ($tipo === 'entrada' ? 'ENT' : 'SAI') . '-' . date('Y') . '-';
        $sql = 'SELECT MAX(CAST(SUBSTRING(numero, :inicio) AS UNSIGNED))
                  FROM documentos_estoque WHERE id_loja = :id_loja AND numero LIKE :prefixo';
        if ($travar) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = db()->prepare($sql);
        $stmt->execute(['inicio' => strlen($prefixo) + 1, 'id_loja' => $idLoja, 'prefixo' => $prefixo . '%']);
        $ultimo = (int) $stmt->fetchColumn();
        return $prefixo . str_pad((string) ($ultimo + 1), 5, '0', STR_PAD_LEFT);
    }

    /** @param array<string,mixed> $dados */
    public function criar(array $dados): int
    {
        db()->prepare(
            'INSERT INTO documentos_estoque
                (id_loja, id_filial, numero, tipo, subtipo, motivo, justificativa, fornecedor, nota_fiscal,
                 data_documento, id_usuario, id_documento_estornado, custo_total)
             VALUES
                (:id_loja, :id_filial, :numero, :tipo, :subtipo, :motivo, :justificativa, :fornecedor, :nota_fiscal,
                 :data_documento, :id_usuario, :id_documento_estornado, :custo_total)'
        )->execute([
            'id_loja' => $dados['id_loja'],
            'id_filial' => $dados['id_filial'],
            'numero' => $dados['numero'],
            'tipo' => $dados['tipo'],
            'subtipo' => $dados['subtipo'],
            'motivo' => $dados['motivo'] ?? null,
            'justificativa' => $dados['justificativa'] ?? null,
            'fornecedor' => $dados['fornecedor'] ?? null,
            'nota_fiscal' => $dados['nota_fiscal'] ?? null,
            'data_documento' => $dados['data_documento'],
            'id_usuario' => $dados['id_usuario'] ?? null,
            'id_documento_estornado' => $dados['id_documento_estornado'] ?? null,
            'custo_total' => $dados['custo_total'] ?? 0,
        ]);
        return (int) db()->lastInsertId();
    }

    /** @param array<string,mixed> $item */
    public function criarItem(int $idDocumento, array $item): void
    {
        db()->prepare(
            'INSERT INTO documento_estoque_itens
                (id_documento, id_produto, id_lote, quantidade, custo_unitario, observacao, lote_novo)
             VALUES (:id_documento, :id_produto, :id_lote, :quantidade, :custo_unitario, :observacao, :lote_novo)'
        )->execute([
            'id_documento' => $idDocumento,
            'id_produto' => $item['id_produto'],
            'id_lote' => $item['id_lote'],
            'quantidade' => $item['quantidade'],
            'custo_unitario' => $item['custo_unitario'] ?? null,
            'observacao' => $item['observacao'] ?? null,
            'lote_novo' => !empty($item['lote_novo']) ? 1 : 0,
        ]);
    }

    public function movimentar(
        int $idLoja,
        int $idFilial,
        int $idProduto,
        int $idLote,
        ?int $idUsuario,
        int $idDocumento,
        string $tipo,
        float $quantidade,
        string $origem
    ): void {
        db()->prepare(
            'INSERT INTO movimentacoes_estoque
                (id_loja, id_filial, id_produto, id_usuario, id_venda, tipo, quantidade, origem, id_documento, id_lote)
             VALUES (:id_loja, :id_filial, :id_produto, :id_usuario, NULL, :tipo, :quantidade, :origem, :id_documento, :id_lote)'
        )->execute([
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
            'id_produto' => $idProduto,
            'id_usuario' => $idUsuario,
            'tipo' => $tipo,
            'quantidade' => $quantidade,
            'origem' => $origem,
            'id_documento' => $idDocumento,
            'id_lote' => $idLote,
        ]);
    }

    /** Documento da filial com os itens; null se não existir ou for de outra filial. */
    public function buscar(int $idDocumento, int $idFilial, bool $travar = false): ?array
    {
        $sql = 'SELECT d.*, u.nome AS nome_usuario FROM documentos_estoque d
                  LEFT JOIN usuarios u ON u.id_usuario = d.id_usuario
                 WHERE d.id_documento = :id AND d.id_filial = :id_filial';
        if ($travar) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = db()->prepare($sql);
        $stmt->execute(['id' => $idDocumento, 'id_filial' => $idFilial]);
        $documento = $stmt->fetch();
        if (!$documento) {
            return null;
        }
        $stmt = db()->prepare(
            'SELECT i.*, p.nome AS nome_produto, p.sku, p.unidade, l.codigo AS codigo_lote, l.validade
               FROM documento_estoque_itens i
               JOIN produtos p ON p.id_produto = i.id_produto
               LEFT JOIN lotes l ON l.id_lote = i.id_lote
              WHERE i.id_documento = :id ORDER BY i.id_item'
        );
        $stmt->execute(['id' => $idDocumento]);
        $documento['itens'] = $stmt->fetchAll();
        return $documento;
    }

    /** @return array<int,array<string,mixed>> últimos documentos da filial */
    public function listar(int $idFilial, int $limite = 30): array
    {
        $stmt = db()->prepare(
            'SELECT d.id_documento, d.numero, d.tipo, d.subtipo, d.status, d.custo_total, d.data_documento,
                    d.data_criacao, d.id_documento_estornado, u.nome AS nome_usuario,
                    (SELECT COUNT(*) FROM documento_estoque_itens i WHERE i.id_documento = d.id_documento) AS itens
               FROM documentos_estoque d
               LEFT JOIN usuarios u ON u.id_usuario = d.id_usuario
              WHERE d.id_filial = :id_filial
              ORDER BY d.id_documento DESC
              LIMIT ' . max(1, min(100, $limite))
        );
        $stmt->execute(['id_filial' => $idFilial]);
        return $stmt->fetchAll();
    }

    public function marcarEstornado(int $idDocumento): void
    {
        db()->prepare("UPDATE documentos_estoque SET status = 'estornado' WHERE id_documento = :id")
            ->execute(['id' => $idDocumento]);
    }
}
