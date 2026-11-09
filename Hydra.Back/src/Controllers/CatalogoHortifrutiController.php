<?php

namespace Hydra\Controllers;

use Hydra\Repositories\CatalogoHortifrutiRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Support\Auth;
use Hydra\Support\Response;

final class CatalogoHortifrutiController
{
    private CatalogoHortifrutiRepository $catalogo;

    public function __construct()
    {
        $this->catalogo = new CatalogoHortifrutiRepository();
    }

    /** GET /api/catalogo-hortifruti — catálogo de referência, sem dados de lojas. */
    public function index(): void
    {
        Response::json(['itens' => $this->catalogo->listar()]);
    }

    /** POST /api/catalogo-hortifruti/importar — importa na filial ativa, sem sobrescrever códigos. */
    public function importar(): void
    {
        $user = Auth::requirePermissionNaFilial('produtos.importar_catalogo');
        new ProdutoRepository();
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $quantidade = $this->catalogo->importar($user['id_loja'], $user['id_filial']);
            $pdo->commit();
        } catch (\RuntimeException $e) {
            $pdo->rollBack();
            Response::json(['erro' => $e->getMessage()], 422);
            return;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            error_log('[Hydra] Falha ao importar catálogo hortifrúti: ' . $e->getMessage());
            Response::json(['erro' => 'Não foi possível importar o catálogo. Nenhum item foi alterado.'], 500);
            return;
        }

        Response::json(['importados' => $quantidade]);
    }
}
