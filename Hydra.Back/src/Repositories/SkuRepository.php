<?php

namespace Hydra\Repositories;

use Hydra\Support\LimiteSkuException;
use Hydra\Support\Migracoes;

/**
 * SKU do produto, gerado automaticamente a partir da categoria.
 *
 * Formato: 2 primeiras letras da categoria (sem acento, maiúsculas) + "." +
 * número de 4 dígitos. Ex.: Padaria → PA.3001.
 *
 * Cada categoria tem uma FAIXA de 1.000 números, ou seja, até 1.000 SKUs:
 *   faixa 0 → 0001–1000, faixa 1 → 1001–2000, ... faixa N → N*1000+1 até (N+1)*1000.
 * As 9 categorias padrão têm faixas fixas, na ordem de CATEGORIAS_PADRAO
 * (Mercearia 0001–1000 ... Tabacaria 8001–9000). Uma categoria criada pela
 * loja ganha a próxima faixa livre a partir da 9 (9001–10000, depois
 * 10001–11000...), guardada em categoria_faixas_sku para nunca mudar.
 *
 * As faixas são da LOJA (a mesma categoria tem a mesma faixa em todas as
 * filiais); a numeração é da FILIAL, como o resto do catálogo. Como as
 * faixas não se sobrepõem, o número sozinho já é único na filial, e o
 * índice UNIQUE (id_filial, sku_numero) garante isso no banco.
 */
final class SkuRepository
{
    public const POR_CATEGORIA = 1000;

    /** Ordem fixa = faixa de cada categoria padrão (índice 0 = 0001–1000). */
    public const CATEGORIAS_PADRAO = [
        'Mercearia', 'Açougue', 'Hortifruti', 'Padaria', 'Bebidas',
        'Higiene e beleza', 'Limpeza', 'Pet', 'Tabacaria',
    ];

    public function __construct()
    {
        // DDL faz commit implícito: este construtor roda fora de transação
        // (é criado no construtor de ProdutoController).
        Migracoes::garantir('produtos_sku_v1', static function (): void {
            $colunaExiste = static function (string $coluna): bool {
                $stmt = db()->prepare(
                    'SELECT 1 FROM information_schema.COLUMNS
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'produtos\' AND COLUMN_NAME = :coluna'
                );
                $stmt->execute(['coluna' => $coluna]);
                return (bool) $stmt->fetchColumn();
            };
            if (!$colunaExiste('sku')) {
                db()->exec('ALTER TABLE produtos ADD COLUMN sku VARCHAR(12) NULL');
            }
            if (!$colunaExiste('sku_numero')) {
                db()->exec('ALTER TABLE produtos ADD COLUMN sku_numero INT UNSIGNED NULL');
            }
            $stmt = db()->prepare(
                'SELECT 1 FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'produtos\' AND INDEX_NAME = \'uq_produtos_filial_sku\''
            );
            $stmt->execute();
            if (!$stmt->fetchColumn()) {
                db()->exec('CREATE UNIQUE INDEX uq_produtos_filial_sku ON produtos (id_filial, sku_numero)');
            }
            db()->exec(
                'CREATE TABLE IF NOT EXISTS categoria_faixas_sku (
                    id_loja  INT NOT NULL,
                    chave    VARCHAR(60) NOT NULL,
                    faixa    SMALLINT UNSIGNED NOT NULL,
                    PRIMARY KEY (id_loja, chave),
                    UNIQUE INDEX uq_categoria_faixas_sku_faixa (id_loja, faixa),
                    FOREIGN KEY (id_loja) REFERENCES lojas(id_loja) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
        });
    }

    /** "Higiene e Beleza " → "higiene e beleza"; "Açougue" → "acougue". */
    public static function chave(string $categoria): string
    {
        $texto = mb_strtolower(trim(preg_replace('/\s+/u', ' ', $categoria) ?? ''), 'UTF-8');
        return mb_substr(self::semAcento($texto), 0, 60);
    }

    /** 2 primeiras letras, sem acento, maiúsculas. "Açougue" → "AC". */
    public static function prefixo(string $categoria): string
    {
        $letras = preg_replace('/[^A-Z]/', '', strtoupper(self::semAcento($categoria))) ?? '';
        return str_pad(substr($letras, 0, 2), 2, 'X');
    }

    public static function formatar(string $categoria, int $numero): string
    {
        return self::prefixo($categoria) . '.' . str_pad((string) $numero, 4, '0', STR_PAD_LEFT);
    }

    private static function semAcento(string $texto): string
    {
        return strtr($texto, [
            'á' => 'a', 'à' => 'a', 'â' => 'a', 'ã' => 'a', 'ä' => 'a',
            'é' => 'e', 'è' => 'e', 'ê' => 'e', 'ë' => 'e',
            'í' => 'i', 'ì' => 'i', 'î' => 'i', 'ï' => 'i',
            'ó' => 'o', 'ò' => 'o', 'ô' => 'o', 'õ' => 'o', 'ö' => 'o',
            'ú' => 'u', 'ù' => 'u', 'û' => 'u', 'ü' => 'u', 'ç' => 'c', 'ñ' => 'n',
            'Á' => 'A', 'À' => 'A', 'Â' => 'A', 'Ã' => 'A', 'Ä' => 'A',
            'É' => 'E', 'È' => 'E', 'Ê' => 'E', 'Ë' => 'E',
            'Í' => 'I', 'Ì' => 'I', 'Î' => 'I', 'Ï' => 'I',
            'Ó' => 'O', 'Ò' => 'O', 'Ô' => 'O', 'Õ' => 'O', 'Ö' => 'O',
            'Ú' => 'U', 'Ù' => 'U', 'Û' => 'U', 'Ü' => 'U', 'Ç' => 'C', 'Ñ' => 'N',
        ]);
    }

    /**
     * Faixa da categoria na loja. Com $reservar = false (prévia da tela)
     * uma categoria nova NÃO é gravada: devolve a faixa que ela ganharia.
     */
    public function faixa(int $idLoja, string $categoria, bool $reservar): int
    {
        $chave = self::chave($categoria);
        foreach (self::CATEGORIAS_PADRAO as $indice => $padrao) {
            if (self::chave($padrao) === $chave) {
                return $indice;
            }
        }

        $stmt = db()->prepare('SELECT faixa FROM categoria_faixas_sku WHERE id_loja = :id_loja AND chave = :chave');
        $stmt->execute(['id_loja' => $idLoja, 'chave' => $chave]);
        $faixa = $stmt->fetchColumn();
        if ($faixa !== false) {
            return (int) $faixa;
        }

        // Duas tentativas: outra requisição pode ter reservado a mesma faixa
        // no meio do caminho (o índice UNIQUE recusa a segunda).
        for ($tentativa = 0; $tentativa < 2; $tentativa++) {
            $stmt = db()->prepare(
                'SELECT GREATEST(:minima, COALESCE(MAX(faixa) + 1, 0)) FROM categoria_faixas_sku WHERE id_loja = :id_loja'
            );
            $stmt->execute(['minima' => count(self::CATEGORIAS_PADRAO), 'id_loja' => $idLoja]);
            $proxima = (int) $stmt->fetchColumn();
            if (!$reservar) {
                return $proxima;
            }
            try {
                db()->prepare('INSERT INTO categoria_faixas_sku (id_loja, chave, faixa) VALUES (:id_loja, :chave, :faixa)')
                    ->execute(['id_loja' => $idLoja, 'chave' => $chave, 'faixa' => $proxima]);
                return $proxima;
            } catch (\PDOException $e) {
                if ($e->getCode() !== '23000') {
                    throw $e;
                }
                // A mesma categoria pode ter sido reservada pela outra requisição.
                $stmt = db()->prepare('SELECT faixa FROM categoria_faixas_sku WHERE id_loja = :id_loja AND chave = :chave');
                $stmt->execute(['id_loja' => $idLoja, 'chave' => $chave]);
                $faixa = $stmt->fetchColumn();
                if ($faixa !== false) {
                    return (int) $faixa;
                }
            }
        }
        throw new \RuntimeException('Não foi possível reservar a faixa de SKU da categoria. Tente de novo.');
    }

    /**
     * Próximo SKU livre da categoria na filial.
     *
     * Com $reservar = true, quem chama está numa transação: o FOR UPDATE
     * trava a faixa da filial até o commit, para dois cadastros simultâneos
     * não pegarem o mesmo número (o índice UNIQUE é a última barreira).
     *
     * @return array{sku:string,numero:int}
     * @throws LimiteSkuException quando a categoria já tem 1.000 SKUs
     */
    public function proximo(int $idLoja, int $idFilial, string $categoria, bool $reservar): array
    {
        $faixa = $this->faixa($idLoja, $categoria, $reservar);
        $minimo = $faixa * self::POR_CATEGORIA + 1;
        $maximo = $minimo + self::POR_CATEGORIA - 1;

        $sql = 'SELECT MAX(sku_numero) FROM produtos
                 WHERE id_filial = :id_filial AND sku_numero BETWEEN :minimo AND :maximo';
        if ($reservar) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = db()->prepare($sql);
        $stmt->execute(['id_filial' => $idFilial, 'minimo' => $minimo, 'maximo' => $maximo]);
        $ultimo = $stmt->fetchColumn();
        $numero = $ultimo === null || $ultimo === false ? $minimo : (int) $ultimo + 1;

        // Fim da faixa alcançado: reaproveita o primeiro número livre (de um
        // produto excluído ou que mudou de categoria) antes de recusar.
        if ($numero > $maximo) {
            $stmt = db()->prepare(
                'SELECT MIN(n) FROM (
                    SELECT :minimo AS n
                    UNION ALL
                    SELECT p.sku_numero + 1 FROM produtos p
                     WHERE p.id_filial = :id_filial AND p.sku_numero BETWEEN :minimo2 AND :maximo
                 ) candidatos
                 WHERE n <= :maximo2
                   AND NOT EXISTS (SELECT 1 FROM produtos q WHERE q.id_filial = :id_filial2 AND q.sku_numero = candidatos.n)'
            );
            $stmt->execute([
                'minimo' => $minimo, 'minimo2' => $minimo, 'maximo' => $maximo, 'maximo2' => $maximo,
                'id_filial' => $idFilial, 'id_filial2' => $idFilial,
            ]);
            $livre = $stmt->fetchColumn();
            if ($livre !== null && $livre !== false) {
                $numero = (int) $livre;
            }
        }

        if ($numero > $maximo) {
            throw new LimiteSkuException(sprintf(
                'A categoria "%s" já tem %d produtos nesta filial, o limite de SKUs da categoria.',
                trim($categoria),
                self::POR_CATEGORIA
            ));
        }
        return ['sku' => self::formatar($categoria, $numero), 'numero' => $numero];
    }

    public function gravar(int $idProduto, string $sku, int $numero): void
    {
        db()->prepare('UPDATE produtos SET sku = :sku, sku_numero = :numero WHERE id_produto = :id')
            ->execute(['sku' => $sku, 'numero' => $numero, 'id' => $idProduto]);
    }

    /**
     * Dá SKU aos produtos da filial que ainda não têm: os cadastrados antes
     * do SKU existir e os importados do catálogo de hortifrúti (importação
     * em massa, sem SKU). Chamado pela listagem; não faz nada no caso normal.
     * Abre a própria transação: chame fora de transação.
     */
    public function preencherFaltantes(int $idLoja, int $idFilial): void
    {
        $stmt = db()->prepare('SELECT 1 FROM produtos WHERE id_filial = :id_filial AND sku_numero IS NULL LIMIT 1');
        $stmt->execute(['id_filial' => $idFilial]);
        if (!$stmt->fetchColumn()) {
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $stmt = db()->prepare(
                'SELECT id_produto, categoria FROM produtos
                  WHERE id_filial = :id_filial AND sku_numero IS NULL
                  ORDER BY id_produto
                  FOR UPDATE'
            );
            $stmt->execute(['id_filial' => $idFilial]);
            foreach ($stmt->fetchAll() as $produto) {
                try {
                    $proximo = $this->proximo($idLoja, $idFilial, (string) $produto['categoria'], true);
                } catch (LimiteSkuException $e) {
                    continue; // categoria cheia: o produto fica sem SKU
                }
                $this->gravar((int) $produto['id_produto'], $proximo['sku'], $proximo['numero']);
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            error_log('[Hydra] Falha ao preencher SKUs da filial ' . $idFilial . ': ' . $e->getMessage());
        }
    }
}
