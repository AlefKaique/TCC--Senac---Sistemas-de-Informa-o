<?php

namespace Hydra\Controllers;

use Hydra\Repositories\AdminPlataformaRepository;
use Hydra\Repositories\AuditoriaPlataformaRepository;
use Hydra\Repositories\PlataformaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/** Endpoints de consulta e status dos mercados, sem acesso a dados operacionais. */
final class PlataformaController
{
    private PlataformaRepository $plataforma;
    private AuditoriaPlataformaRepository $auditoria;

    public function __construct()
    {
        $this->plataforma = new PlataformaRepository();
        $this->auditoria = new AuditoriaPlataformaRepository();
    }

    public function resumo(): void
    {
        Auth::requirePlataforma();
        Response::json($this->plataforma->resumo());
    }

    public function rendimento(): void
    {
        Auth::requirePlataforma();
        $dias = (int) ($_GET['dias'] ?? 30);
        if (!in_array($dias, [7, 30, 90, 365], true)) {
            Response::json(['erro' => 'Selecione um período válido.'], 422);
            return;
        }
        Response::json($this->plataforma->rendimento($dias));
    }

    public function lojas(): void
    {
        Auth::requirePlataforma();
        $status = trim((string) ($_GET['status'] ?? ''));
        if ($status !== '' && !in_array($status, ['ativo', 'novo', 'ocioso', 'inativo', 'suspenso'], true)) {
            Response::json(['erro' => 'Filtro de status inválido.'], 422);
            return;
        }
        $ordem = trim((string) ($_GET['ordem'] ?? 'recentes'));
        if (!in_array($ordem, ['recentes', 'acesso', 'nome'], true)) {
            $ordem = 'recentes';
        }
        $pagina = max(1, min(100000, (int) ($_GET['pagina'] ?? 1)));
        $resultado = $this->plataforma->listarLojas([
            'status' => $status,
            'busca' => mb_substr(trim((string) ($_GET['busca'] ?? '')), 0, 100),
            'uf' => mb_substr(trim((string) ($_GET['uf'] ?? '')), 0, 2),
            'ordem' => $ordem,
        ], $pagina);
        Response::json($resultado);
    }

    public function detalheLoja(int $idLoja): void
    {
        Auth::requirePlataforma();
        $resultado = $this->plataforma->detalheLoja($idLoja);
        if ($resultado === null) {
            Response::json(['erro' => 'Mercado não encontrado.'], 404);
            return;
        }
        Response::json($resultado);
    }

    public function suspender(int $idLoja): void
    {
        $admin = Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $this->alterarStatus($idLoja, 'suspensa', 'mercado_suspenso', $admin['id']);
    }

    public function reativar(int $idLoja): void
    {
        $admin = Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $this->alterarStatus($idLoja, 'ativa', 'mercado_reativado', $admin['id']);
    }

    public function cadastrosPendentes(): void
    {
        Auth::requirePlataforma();
        Response::json(['cadastros' => $this->plataforma->cadastrosPendentes()]);
    }

    public function auditoria(): void
    {
        Auth::requirePlataformaNivel(AdminPlataformaRepository::GESTAO);
        $pagina = max(1, min(100000, (int) ($_GET['pagina'] ?? 1)));
        $de = trim((string) ($_GET['de'] ?? ''));
        $ate = trim((string) ($_GET['ate'] ?? ''));
        foreach (['de' => $de, 'ate' => $ate] as $campo => $data) {
            if ($data !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $data)) {
                Response::json(['erro' => 'Informe um período válido.'], 422);
                return;
            }
        }
        Response::json($this->plataforma->auditoria([
            'acao' => trim((string) ($_GET['acao'] ?? '')),
            'id_admin' => max(0, (int) ($_GET['id_admin'] ?? 0)),
            'de' => $de,
            'ate' => $ate,
        ], $pagina));
    }

    private function alterarStatus(int $idLoja, string $novoStatus, string $acao, int $idAdmin): void
    {
        $dados = Request::json();
        $motivo = trim((string) ($dados['motivo'] ?? ''));
        if (mb_strlen($motivo, 'UTF-8') < 10 || mb_strlen($motivo, 'UTF-8') > 255) {
            Response::json(['erro' => 'Explique o motivo com pelo menos 10 caracteres.'], 422);
            return;
        }
        $statusAtual = $this->plataforma->statusLoja($idLoja);
        if ($statusAtual === null) {
            Response::json(['erro' => 'Mercado não encontrado.'], 404);
            return;
        }
        if (($novoStatus === 'suspensa' && $statusAtual === 'suspensa')
            || ($novoStatus === 'ativa' && $statusAtual !== 'suspensa')) {
            Response::json(['erro' => 'O mercado já está com esse status.'], 409);
            return;
        }
        db()->beginTransaction();
        try {
            if (!$this->plataforma->alterarStatusLoja($idLoja, $novoStatus, $motivo)) {
                db()->rollBack();
                Response::json(['erro' => 'O status do mercado foi alterado por outra pessoa. Atualize a página.'], 409);
                return;
            }
            $this->auditoria->registrar($idAdmin, $acao, $idLoja, $motivo);
            db()->commit();
        } catch (\Throwable $e) {
            if (db()->inTransaction()) {
                db()->rollBack();
            }
            throw $e;
        }
        Response::json(['ok' => true, 'status' => $novoStatus]);
    }
}
