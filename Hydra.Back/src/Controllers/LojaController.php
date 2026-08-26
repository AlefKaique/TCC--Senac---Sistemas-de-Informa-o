<?php

namespace Hydra\Controllers;

use Hydra\Repositories\LojaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Tela "Configurações da Loja" — RN04: somente Administrador.
 * Separada do onboarding (Fig. 13): aqui ficam os dados que crescem
 * com o tempo (endereço, CNPJ, telefone, logo).
 */
final class LojaController
{
    private LojaRepository $lojas;

    public function __construct()
    {
        $this->lojas = new LojaRepository();
    }

    /** GET /api/loja */
    public function show(): void
    {
        $admin = Auth::requireAdmin();
        $loja = $this->lojas->find($admin['id_loja']);
        if ($loja === null) {
            Response::json(['erro' => 'Loja não encontrada'], 404);
            return;
        }
        Response::json(['loja' => $loja]);
    }

    /** PUT /api/loja */
    public function update(): void
    {
        $admin = Auth::requireAdmin();
        $dados = Request::json();

        $nomeLoja = trim((string) ($dados['nome_loja'] ?? ''));
        if ($nomeLoja === '') {
            Response::json(['erro' => 'Informe o nome da loja'], 422);
            return;
        }

        $this->lojas->update($admin['id_loja'], [
            'nome_loja' => $nomeLoja,
            'cnpj' => trim((string) ($dados['cnpj'] ?? '')),
            'telefone' => trim((string) ($dados['telefone'] ?? '')),
            'endereco' => trim((string) ($dados['endereco'] ?? '')),
            'cidade' => trim((string) ($dados['cidade'] ?? '')),
            'estado' => trim((string) ($dados['estado'] ?? '')),
            'cep' => trim((string) ($dados['cep'] ?? '')),
        ]);

        Response::json(['loja' => $this->lojas->find($admin['id_loja'])]);
    }
}
