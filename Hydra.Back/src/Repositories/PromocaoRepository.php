<?php

namespace Hydra\Repositories;

/**
 * Tela "Promoções" (Admin) — preço promocional temporário, pensado para
 * escoar produtos prestes a vencer antes que virem perda.
 *
 * Uma promoção vale para UM produto, num intervalo de datas. Ela está
 * "vigente" quando status = 'ativa' e hoje está entre data_inicio e
 * data_fim; é esse preço que o Caixa mostra e que VendaController cobra.
 * "Encerrar" não apaga a linha: muda o status, para o histórico continuar
 * mostrando o que foi feito.
 *
 * Por filial, como o catálogo: a promoção é do produto de UMA filial.
 */
final class PromocaoRepository
{
    private static bool $tabelaGarantida = false;

    public function __construct()
    {
        $this->garantirTabela();
    }

    /**
     * Cria a tabela em bancos que ainda não a têm — a mesma estratégia de
     * migração preguiçosa de CargoRepository::ensureDefaults(): o schema.sql
     * só roda quando reaplicado à mão, e sem a tabela o catálogo de produtos
     * (que consulta as promoções vigentes) pararia de carregar.
     *
     * Roda uma vez por requisição. O construtor é chamado antes de qualquer
     * transação abrir (VendaController abre a dela só em store()), o que
     * importa porque DDL no MySQL faz commit implícito.
     *
     * Depois do módulo de Filiais, o banco precisa ter passado por
     * sql/migracao_filiais.sql (que já cria esta tabela); a estrutura abaixo
     * é a final, igual à do schema.sql.
     */
    private function garantirTabela(): void
    {
        if (self::$tabelaGarantida) {
            return;
        }
        db()->exec(
            "CREATE TABLE IF NOT EXISTS promocoes (
                id_promocao       INT AUTO_INCREMENT PRIMARY KEY,
                id_loja           INT NOT NULL,
                id_filial         INT NOT NULL,
                id_produto        INT NOT NULL,
                id_usuario        INT NULL,
                preco_promocional DECIMAL(10,2) NOT NULL,
                data_inicio       DATE NOT NULL,
                data_fim          DATE NOT NULL,
                status            ENUM('ativa', 'encerrada') NOT NULL DEFAULT 'ativa',
                data_criacao      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE,
                FOREIGN KEY (id_produto) REFERENCES produtos(id_produto) ON DELETE CASCADE,
                FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE SET NULL,
                INDEX idx_promocoes_loja_produto (id_loja, id_produto),
                INDEX idx_promocoes_periodo (data_inicio, data_fim),
                INDEX idx_promocoes_loja_filial (id_loja, id_filial),
                CONSTRAINT fk_promocoes_filial
                    FOREIGN KEY (id_loja, id_filial) REFERENCES filiais(id_loja, id_filial) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        );
        self::$tabelaGarantida = true;
    }

    /** @return array<int,array<string,mixed>> todas as promoções da filial, com os dados do produto */
    public function listByFilial(int $idFilial): array
    {
        $stmt = db()->prepare(
            "SELECT pr.*, p.nome AS nome_produto, p.preco_venda, p.preco_custo, p.validade,
                    p.quantidade, p.unidade, u.nome AS nome_usuario
               FROM promocoes pr
               JOIN produtos p ON p.id_produto = pr.id_produto
               LEFT JOIN usuarios u ON u.id_usuario = pr.id_usuario
              WHERE pr.id_filial = :id_filial
              ORDER BY pr.status = 'ativa' DESC, pr.data_fim DESC, pr.id_promocao DESC"
        );
        $stmt->execute(['id_filial' => $idFilial]);
        return $stmt->fetchAll();
    }

    public function findInFilial(int $idPromocao, int $idFilial): ?array
    {
        $stmt = db()->prepare('SELECT * FROM promocoes WHERE id_promocao = :id AND id_filial = :id_filial');
        $stmt->execute(['id' => $idPromocao, 'id_filial' => $idFilial]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /**
     * Preço promocional vigente HOJE de cada produto da filial, indexado por
     * id_produto. Se houver mais de uma (não deveria: store() recusa
     * sobreposição), vale a criada por último.
     *
     * @return array<int,array{preco_promocional:float,data_fim:string}>
     */
    public function vigentesPorProduto(int $idFilial): array
    {
        $stmt = db()->prepare(
            "SELECT id_produto, preco_promocional, data_fim
               FROM promocoes
              WHERE id_filial = :id_filial AND status = 'ativa'
                AND data_inicio <= :hoje AND data_fim >= :hoje2
              ORDER BY id_promocao ASC"
        );
        $hoje = date('Y-m-d');
        $stmt->execute(['id_filial' => $idFilial, 'hoje' => $hoje, 'hoje2' => $hoje]);

        $porProduto = [];
        foreach ($stmt->fetchAll() as $row) {
            $porProduto[(int) $row['id_produto']] = [
                'preco_promocional' => (float) $row['preco_promocional'],
                'data_fim' => $row['data_fim'],
            ];
        }
        return $porProduto;
    }

    public function precoVigente(int $idProduto, int $idFilial): ?float
    {
        $stmt = db()->prepare(
            "SELECT preco_promocional
               FROM promocoes
              WHERE id_produto = :id_produto AND id_filial = :id_filial AND status = 'ativa'
                AND data_inicio <= :hoje AND data_fim >= :hoje2
              ORDER BY id_promocao DESC
              LIMIT 1"
        );
        $hoje = date('Y-m-d');
        $stmt->execute(['id_produto' => $idProduto, 'id_filial' => $idFilial, 'hoje' => $hoje, 'hoje2' => $hoje]);
        $preco = $stmt->fetchColumn();
        return $preco === false ? null : (float) $preco;
    }

    /** Existe outra promoção ativa do mesmo produto cujo período cruza com o informado? */
    public function existeSobreposta(int $idProduto, int $idFilial, string $inicio, string $fim): bool
    {
        $stmt = db()->prepare(
            "SELECT 1 FROM promocoes
              WHERE id_produto = :id_produto AND id_filial = :id_filial AND status = 'ativa'
                AND data_inicio <= :fim AND data_fim >= :inicio
              LIMIT 1"
        );
        $stmt->execute(['id_produto' => $idProduto, 'id_filial' => $idFilial, 'fim' => $fim, 'inicio' => $inicio]);
        return (bool) $stmt->fetchColumn();
    }

    public function create(int $idLoja, int $idFilial, int $idProduto, int $idUsuario, float $preco, string $inicio, string $fim): int
    {
        $stmt = db()->prepare(
            'INSERT INTO promocoes (id_loja, id_filial, id_produto, id_usuario, preco_promocional, data_inicio, data_fim)
             VALUES (:id_loja, :id_filial, :id_produto, :id_usuario, :preco, :inicio, :fim)'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
            'id_produto' => $idProduto,
            'id_usuario' => $idUsuario,
            'preco' => $preco,
            'inicio' => $inicio,
            'fim' => $fim,
        ]);
        return (int) db()->lastInsertId();
    }

    public function encerrar(int $idPromocao): void
    {
        $stmt = db()->prepare("UPDATE promocoes SET status = 'encerrada' WHERE id_promocao = :id");
        $stmt->execute(['id' => $idPromocao]);
    }

    /**
     * Produtos ativos, com saldo, que vencem de hoje até $dias dias — os
     * candidatos a promoção. Vencidos ficam de fora: produto vencido não
     * pode ser vendido, nem com desconto.
     *
     * @return array<int,array<string,mixed>>
     */
    public function produtosAVencer(int $idFilial, int $dias): array
    {
        $hoje = new \DateTimeImmutable('today');
        $stmt = db()->prepare(
            "SELECT id_produto, nome, categoria, preco_venda, preco_custo, quantidade, unidade, validade
               FROM produtos
              WHERE id_filial = :id_filial AND status = 'ativo' AND quantidade > 0
                AND validade IS NOT NULL AND validade >= :hoje AND validade <= :limite
              ORDER BY validade ASC, nome ASC"
        );
        $stmt->execute([
            'id_filial' => $idFilial,
            'hoje' => $hoje->format('Y-m-d'),
            'limite' => $hoje->modify("+{$dias} days")->format('Y-m-d'),
        ]);
        return $stmt->fetchAll();
    }
}
