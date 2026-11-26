<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

final class CatalogoHortifrutiRepository
{
    private const TOTAL_ITENS = 120;

    public function __construct()
    {
        Migracoes::garantir('catalogo_hortifruti_v1', static function (): void {
            db()->exec(
                'CREATE TABLE IF NOT EXISTS catalogo_hortifruti (
                    codigo      SMALLINT UNSIGNED PRIMARY KEY,
                    nome        VARCHAR(150) NOT NULL,
                    categoria  VARCHAR(60) NOT NULL,
                    unidade     VARCHAR(10) NOT NULL,
                    plu         CHAR(4) NULL,
                    INDEX idx_catalogo_hortifruti_categoria (categoria, codigo)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
        });
        $this->garantirItens();
    }

    /**
     * Preenche o catálogo com os 120 itens padrão se ele estiver incompleto.
     *
     * Antes os itens só entravam rodando sql/seed_catalogo_hortifruti.sql à
     * mão; num banco novo (ex.: o do Render) a tabela ficava vazia e toda
     * importação falhava com "o catálogo não tem os 120 itens". O arquivo
     * continua sendo a fonte única dos dados (o Dockerfile o copia para
     * /var/www/app/sql). O INSERT dele é idempotente (ON DUPLICATE KEY
     * UPDATE), então rodar de novo só corrige itens faltando ou alterados.
     *
     * Quem cria este repositório o faz FORA de transação (ver os
     * construtores de CatalogoHortifrutiController e FilialController::store).
     */
    private function garantirItens(): void
    {
        if ($this->estaCompleto()) {
            return;
        }

        $arquivo = dirname(__DIR__, 2) . '/sql/seed_catalogo_hortifruti.sql';
        $sql = is_file($arquivo) ? (string) file_get_contents($arquivo) : '';
        $inicio = stripos($sql, 'INSERT INTO catalogo_hortifruti');
        if ($inicio === false) {
            error_log('[Hydra] Catálogo hortifrúti incompleto e arquivo de carga ausente: ' . $arquivo);
            return; // importar() continua recusando com a mensagem de catálogo incompleto.
        }

        try {
            db()->exec(rtrim(substr($sql, $inicio), " \t\r\n;"));
        } catch (\PDOException $e) {
            error_log('[Hydra] Falha ao carregar o catálogo hortifrúti padrão: ' . $e->getMessage());
        }
    }

    /** @return array<int,array<string,mixed>> */
    public function listar(): array
    {
        return db()->query(
            'SELECT codigo, nome, categoria, unidade, plu
               FROM catalogo_hortifruti
              ORDER BY CASE categoria
                    WHEN \'FRUTAS\' THEN 1
                    WHEN \'LEGUMES\' THEN 2
                    WHEN \'VERDURAS\' THEN 3
                    WHEN \'TEMPEROS\' THEN 4
                    WHEN \'RAIZES\' THEN 5
                    ELSE 6
                  END, codigo'
        )->fetchAll();
    }

    public function estaCompleto(): bool
    {
        return (int) db()->query('SELECT COUNT(*) FROM catalogo_hortifruti')->fetchColumn() === self::TOTAL_ITENS;
    }

    /**
     * Copia somente códigos ainda ausentes na filial. O índice UNIQUE
     * composto protege também contra duas importações simultâneas.
     */
    public function importar(int $idLoja, int $idFilial): int
    {
        if (!$this->estaCompleto()) {
            throw new \RuntimeException('O catálogo padrão de hortifrúti não está disponível no momento. Desmarque a importação para continuar e tente importar depois.');
        }

        $stmt = db()->prepare(
            'INSERT INTO produtos
                (id_loja, id_filial, nome, descricao, categoria, preco_custo, preco_venda,
                 codigo, plu, quantidade, estoque_minimo, unidade, lote, validade, status)
             SELECT :id_loja, :id_filial, c.nome, NULL, c.categoria, NULL, NULL,
                    c.codigo, c.plu, 0, 0, c.unidade, NULL, NULL, \'ativo\'
               FROM catalogo_hortifruti c
               LEFT JOIN produtos p
                 ON p.id_filial = :filial_existente AND p.codigo = c.codigo
              WHERE p.id_produto IS NULL
              ORDER BY c.codigo'
        );
        $stmt->execute([
            'id_loja' => $idLoja,
            'id_filial' => $idFilial,
            'filial_existente' => $idFilial,
        ]);
        return $stmt->rowCount();
    }
}
