<?php

namespace Hydra\Support;

/**
 * Regras de formato de dados cadastrais, usadas pelos controllers.
 *
 * Antes não havia nenhuma: o cadastro aceitava "122323" como nome de
 * pessoa e a tela da loja gravava CNPJ, telefone e CEP com letras e
 * símbolos (relatório de QA de 07/11/2026, achados 003 e 005).
 *
 * As funções de documento recebem o valor como digitado (com ou sem
 * máscara) e o banco guarda só a forma normalizada (ver normalizar*).
 * A checagem matemática de CPF/CNPJ prova que o número é bem formado, não
 * que ele existe na Receita.
 */
final class Validacao
{
    /**
     * Nome de pessoa: ao menos duas letras (qualquer alfabeto, com acento)
     * e só letras, espaços, apóstrofo, hífen e ponto — cobre "Ana", "D'Ávila",
     * "Maria-Clara" e "J. Silva", e recusa "122323" ou "@@@".
     *
     * @return string|null mensagem de erro, ou null se o nome for válido
     */
    public static function erroNomePessoa(string $nome): ?string
    {
        $nome = trim($nome);
        if ($nome === '') {
            return 'Informe o nome.';
        }
        if (mb_strlen($nome) > 100) {
            return 'O nome pode ter no máximo 100 caracteres.';
        }
        if (!preg_match("/^[\\p{L}\\p{M}\\s'’.-]+$/u", $nome)) {
            return 'O nome deve conter apenas letras, espaços, apóstrofo e hífen.';
        }
        if (preg_match_all('/\p{L}/u', $nome) < 2) {
            return 'Informe um nome com pelo menos duas letras.';
        }
        return null;
    }

    /** Só os dígitos. */
    public static function soDigitos(string $valor): string
    {
        return (string) preg_replace('/\D/', '', $valor);
    }

    /**
     * CNPJ numérico ou alfanumérico (formato da Receita a partir de 2026):
     * 12 posições de 0-9/A-Z e 2 dígitos verificadores numéricos. Cada
     * caractere vale o código ASCII menos 48, o que mantém o cálculo
     * idêntico ao antigo para CNPJs só com números.
     */
    public static function normalizarCnpj(string $valor): string
    {
        return (string) preg_replace('/[^0-9A-Z]/', '', strtoupper($valor));
    }

    /** "12.ABC.345/01DE-35": formato gravado no banco (cabe em VARCHAR(18)). */
    public static function formatarCnpj(string $valor): string
    {
        $c = self::normalizarCnpj($valor);
        if (strlen($c) !== 14) {
            return $c;
        }
        return substr($c, 0, 2) . '.' . substr($c, 2, 3) . '.' . substr($c, 5, 3) . '/'
            . substr($c, 8, 4) . '-' . substr($c, 12, 2);
    }

    public static function cnpjValido(string $valor): bool
    {
        $cnpj = self::normalizarCnpj($valor);
        if (!preg_match('/^[0-9A-Z]{12}[0-9]{2}$/', $cnpj)) {
            return false;
        }
        if (preg_match('/^(\d)\1{13}$/', $cnpj)) {
            return false; // 00000000000000, 11111111111111...
        }

        $valores = array_map(static fn ($c) => ord($c) - 48, str_split($cnpj));
        foreach ([12, 13] as $posicao) {
            $pesos = $posicao === 12
                ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
                : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
            $soma = 0;
            foreach ($pesos as $i => $peso) {
                $soma += $valores[$i] * $peso;
            }
            $resto = $soma % 11;
            $dv = $resto < 2 ? 0 : 11 - $resto;
            if ($valores[$posicao] !== $dv) {
                return false;
            }
        }
        return true;
    }

    public static function cpfValido(string $valor): bool
    {
        $cpf = self::soDigitos($valor);
        if (strlen($cpf) !== 11 || preg_match('/^(\d)\1{10}$/', $cpf)) {
            return false;
        }
        foreach ([9, 10] as $posicao) {
            $soma = 0;
            for ($i = 0; $i < $posicao; $i++) {
                $soma += (int) $cpf[$i] * ($posicao + 1 - $i);
            }
            $dv = ($soma * 10) % 11 % 10;
            if ((int) $cpf[$posicao] !== $dv) {
                return false;
            }
        }
        return true;
    }

    /** DDD válido (11 a 99, sem zero) + 8 dígitos (fixo) ou 9 começando com 9 (celular). */
    public static function telefoneValido(string $valor): bool
    {
        $tel = self::soDigitos($valor);
        return (bool) preg_match('/^[1-9][1-9](?:[2-8]\d{7}|9\d{8})$/', $tel);
    }

    public static function cepValido(string $valor): bool
    {
        return strlen(self::soDigitos($valor)) === 8;
    }

    /**
     * Valor digitado só com dígitos e a pontuação da máscara? Usado antes de
     * normalizar, para não "aprovar" "dwdw11999998888" tirando as letras.
     */
    public static function soMascaraNumerica(string $valor): bool
    {
        return (bool) preg_match('/^[\d\s().\/-]*$/', $valor);
    }
}
