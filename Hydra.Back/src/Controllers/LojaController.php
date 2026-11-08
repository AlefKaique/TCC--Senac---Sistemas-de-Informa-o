<?php

namespace Hydra\Controllers;

use Hydra\Repositories\LojaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Migracoes;
use Hydra\Support\Request;
use Hydra\Support\Response;
use Hydra\Support\Validacao;

/**
 * Tela "Configurações da Loja" — RN04: somente Administrador.
 * Separada do onboarding (Fig. 13): aqui ficam os dados que crescem
 * com o tempo (endereço, CNPJ, telefone, logo).
 */
final class LojaController
{
    private LojaRepository $lojas;

    /** Logo guardada como data URL: ~256 px já redimensionados pela tela. */
    private const LOGO_MAX_BYTES = 700 * 1024;

    public function __construct()
    {
        // Coluna da logo em bancos já em uso (uma vez por banco).
        Migracoes::garantir('loja_logo_v1', static function (): void {
            $existe = db()->query(
                "SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lojas' AND COLUMN_NAME = 'logo'"
            )->fetchColumn();
            if (!$existe) {
                db()->exec('ALTER TABLE lojas ADD COLUMN logo MEDIUMTEXT NULL');
            }
        });
        $this->lojas = new LojaRepository();
    }

    /** GET /api/loja */
    public function show(): void
    {
        $admin = Auth::requirePermission('loja.configurar');
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
        $admin = Auth::requirePermission('loja.configurar');
        $dados = Request::json();

        $nomeLoja = trim((string) ($dados['nome_loja'] ?? ''));
        if ($nomeLoja === '') {
            Response::json(['erro' => 'Informe o nome da loja', 'campo' => 'nome_loja'], 422);
            return;
        }

        /* CNPJ, telefone e CEP são opcionais, mas se vierem precisam ser
           válidos. Antes qualquer texto era gravado (QA 005: "3ee3ee3e3s@@@"
           como CNPJ). O banco guarda só a forma normalizada, sem máscara. */
        $cnpj = trim((string) ($dados['cnpj'] ?? ''));
        $telefone = trim((string) ($dados['telefone'] ?? ''));
        $cep = trim((string) ($dados['cep'] ?? ''));
        $estado = strtoupper(trim((string) ($dados['estado'] ?? '')));

        if ($cnpj !== '' && !Validacao::cnpjValido($cnpj)) {
            Response::json(['erro' => 'CNPJ inválido. Confira os 14 caracteres e os dígitos verificadores.', 'campo' => 'cnpj'], 422);
            return;
        }
        // RN25: CNPJ único entre lojas. Conferido ANTES de gravar, como em
        // FilialController. Antes só o índice UNIQUE barrava, e a exceção
        // virava "Erro interno no servidor" (500). A comparação ignora a
        // máscara: bancos antigos guardam o CNPJ com e sem pontuação, e o
        // índice sozinho não pegaria "11222333000181" x "11.222.333/0001-81".
        if ($cnpj !== '' && $this->lojas->cnpjEmUsoPorOutraLoja(Validacao::normalizarCnpj($cnpj), $admin['id_loja'])) {
            Response::json(['erro' => 'Este CNPJ já está cadastrado em outra loja.', 'campo' => 'cnpj'], 409);
            return;
        }
        if ($telefone !== '' && (!Validacao::soMascaraNumerica($telefone) || !Validacao::telefoneValido($telefone))) {
            Response::json(['erro' => 'Telefone inválido. Use DDD + número, ex.: (11) 99999-8888.', 'campo' => 'telefone'], 422);
            return;
        }
        if ($cep !== '' && (!Validacao::soMascaraNumerica($cep) || !Validacao::cepValido($cep))) {
            Response::json(['erro' => 'CEP inválido. Use 8 números, ex.: 01310-100.', 'campo' => 'cep'], 422);
            return;
        }
        if ($estado !== '' && !preg_match('/^[A-Z]{2}$/', $estado)) {
            Response::json(['erro' => 'Estado inválido', 'campo' => 'estado'], 422);
            return;
        }

        // Logo: chave ausente = não mexe; null/"" = remove; data URL = troca.
        $mudarLogo = array_key_exists('logo', $dados);
        $logo = $mudarLogo ? (string) ($dados['logo'] ?? '') : '';
        if ($logo !== '') {
            if (!preg_match('#^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$#', $logo)) {
                Response::json(['erro' => 'Logo inválida: envie uma imagem PNG, JPG ou WEBP.', 'campo' => 'logo'], 422);
                return;
            }
            if (strlen($logo) > self::LOGO_MAX_BYTES) {
                Response::json(['erro' => 'A logo ficou grande demais. Use uma imagem menor.', 'campo' => 'logo'], 422);
                return;
            }
        }

        try {
            $this->lojas->update($admin['id_loja'], [
                'nome_loja' => $nomeLoja,
                'cnpj' => $cnpj !== '' ? Validacao::formatarCnpj($cnpj) : '',
                'telefone' => $telefone !== '' ? Validacao::soDigitos($telefone) : '',
                'endereco' => trim((string) ($dados['endereco'] ?? '')),
                'cidade' => trim((string) ($dados['cidade'] ?? '')),
                'estado' => $estado,
                'cep' => $cep !== '' ? Validacao::soDigitos($cep) : '',
            ]);
            if ($mudarLogo) {
                $this->lojas->atualizarLogo($admin['id_loja'], $logo !== '' ? $logo : null);
            }
        } catch (\PDOException $e) {
            // Rede de segurança para a corrida entre duas lojas salvando o
            // mesmo CNPJ ao mesmo tempo: a checagem acima passa para as duas,
            // o índice UNIQUE barra a segunda.
            if ($e->getCode() === '23000') {
                Response::json(['erro' => 'Este CNPJ já está cadastrado em outra loja.', 'campo' => 'cnpj'], 409);
                return;
            }
            throw $e;
        }

        Response::json(['loja' => $this->lojas->find($admin['id_loja'])]);
    }
}
