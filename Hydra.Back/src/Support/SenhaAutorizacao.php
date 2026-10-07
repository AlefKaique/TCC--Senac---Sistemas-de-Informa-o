<?php

namespace Hydra\Support;

use Hydra\Repositories\UsuarioRepository;

/**
 * Senha de autorização do gerente/administrador: um PIN numérico, separado
 * da senha de login, que libera o cancelamento de venda na tela Vendas.
 * É cadastrada pelo administrador na tela Equipe, junto com o usuário.
 *
 * É separada da senha de login de propósito: o gerente digita o PIN no
 * terminal do caixa, na frente do operador, e um PIN visto por cima do
 * ombro não pode virar acesso à conta inteira.
 */
final class SenhaAutorizacao
{
    public const MIN_DIGITOS = 4;
    public const MAX_DIGITOS = 8;

    /** null se o formato é válido, ou a mensagem de erro. */
    public static function validarFormato(string $senha): ?string
    {
        if (!preg_match('/^\d{' . self::MIN_DIGITOS . ',' . self::MAX_DIGITOS . '}$/', $senha)) {
            return 'A senha de autorização deve ter de ' . self::MIN_DIGITOS . ' a ' . self::MAX_DIGITOS . ' números';
        }
        return null;
    }

    /**
     * Usuário ativo da loja dono desta senha, ou null. A tela pede só o PIN
     * (não o nome de quem autoriza), então a busca confere o hash de cada
     * candidato — poucos por loja. Por isso dois usuários da mesma loja não
     * podem ter o mesmo PIN (ver UsuarioController).
     *
     * @return array<string,mixed>|null
     */
    public static function encontrarAutorizador(int $idLoja, string $senha): ?array
    {
        foreach ((new UsuarioRepository())->listAutorizadoresDaLoja($idLoja) as $usuario) {
            if (password_verify($senha, (string) $usuario['senha_autorizacao'])) {
                return $usuario;
            }
        }
        return null;
    }
}
