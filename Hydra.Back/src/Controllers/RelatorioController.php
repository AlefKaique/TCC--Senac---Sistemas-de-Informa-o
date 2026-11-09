<?php

namespace Hydra\Controllers;

use Hydra\Repositories\RelatorioRepository;
use Hydra\Support\Auth;
use Hydra\Support\Response;

final class RelatorioController
{
    public function resumo(): void
    {
        $this->responderComPeriodo('resumo');
    }

    public function vendasPorDia(): void
    {
        $this->responderComPeriodo('vendasPorDia');
    }

    public function pagamentos(): void
    {
        $this->responderComPeriodo('pagamentos');
    }

    public function horarios(): void
    {
        $this->responderComPeriodo('horarios');
    }

    public function produtos(): void
    {
        $this->responderComPeriodo('produtos');
    }

    public function estoque(): void
    {
        $usuario = Auth::requirePermissionNaFilial('relatorios.visualizar');
        Response::json((new RelatorioRepository())->estoque((int) $usuario['id_filial']));
    }

    public function cancelamentos(): void
    {
        $this->responderComPeriodo('cancelamentos');
    }

    public function operadores(): void
    {
        $this->responderComPeriodo('operadores');
    }

    private function responderComPeriodo(string $metodo): void
    {
        $usuario = Auth::requirePermissionNaFilial('relatorios.visualizar');
        [$de, $ate] = $this->periodo();
        if ($de === null || $ate === null) {
            return;
        }
        $repositorio = new RelatorioRepository();
        Response::json($repositorio->{$metodo}((int) $usuario['id_filial'], $de, $ate));
    }

    /** @return array{0:?\DateTimeImmutable,1:?\DateTimeImmutable} */
    private function periodo(): array
    {
        $timezone = new \DateTimeZone('America/Sao_Paulo');
        $deEntrada = $_GET['de'] ?? null;
        $ateEntrada = $_GET['ate'] ?? null;
        if ($deEntrada === null && $ateEntrada === null) {
            $ate = new \DateTimeImmutable('today', $timezone);
            return [$ate->modify('-29 days'), $ate];
        }
        if (!is_string($deEntrada) || !is_string($ateEntrada)) {
            Response::json(['erro' => 'Informe as duas datas no formato AAAA-MM-DD.'], 422);
            return [null, null];
        }
        $de = $this->data($deEntrada, $timezone);
        $ate = $this->data($ateEntrada, $timezone);
        if ($de === null || $ate === null) {
            Response::json(['erro' => 'Data inválida. Use o formato AAAA-MM-DD.'], 422);
            return [null, null];
        }
        if ($de > $ate) {
            Response::json(['erro' => 'A data inicial não pode ser posterior à data final.'], 422);
            return [null, null];
        }
        if ((int) $de->diff($ate)->days + 1 > 366) {
            Response::json(['erro' => 'O período máximo permitido é de 366 dias.'], 422);
            return [null, null];
        }
        return [$de, $ate];
    }

    private function data(string $valor, \DateTimeZone $timezone): ?\DateTimeImmutable
    {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $valor)) {
            return null;
        }
        $data = \DateTimeImmutable::createFromFormat('!Y-m-d', $valor, $timezone);
        $erros = \DateTimeImmutable::getLastErrors();
        if ($data === false
            || ($erros !== false && ($erros['warning_count'] > 0 || $erros['error_count'] > 0))
            || $data->format('Y-m-d') !== $valor) {
            return null;
        }
        return $data;
    }
}
