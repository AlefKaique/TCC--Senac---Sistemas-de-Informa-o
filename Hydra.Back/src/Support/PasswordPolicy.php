<?php

namespace Hydra\Support;

/**
 * Regra de senha forte exigida no Cadastro (Fig. 13) e no Cadastro de
 * Funcionário (tela Gerenciar Usuários): mínimo de 8 caracteres, com
 * letra maiúscula, minúscula, número e caractere especial. Complementa
 * a RN23 (mínimo de 6 caracteres), elevando a exigência para as telas
 * de criação de senha.
 *
 * As mesmas regras, na mesma ordem, são exibidas ao vivo no front-end
 * (checklist com ✓/✕) por Hydra.Front/js/password-rules.js — qualquer
 * alteração aqui deve ser replicada lá também.
 */
final class PasswordPolicy
{
    public const MIN_LENGTH = 8;

    /** Retorna null se a senha atende à política, ou a mensagem de erro caso contrário. */
    public static function validar(string $senha): ?string
    {
        if (!preg_match('/[A-Z]/', $senha)) {
            return 'A senha deve conter ao menos uma letra maiúscula';
        }
        if (!preg_match('/\d/', $senha)) {
            return 'A senha deve conter ao menos um número';
        }
        if (!preg_match('/[a-z]/', $senha)) {
            return 'A senha deve conter ao menos uma letra minúscula';
        }
        if (!preg_match('/[^A-Za-z0-9]/', $senha)) {
            return 'A senha deve conter ao menos um caractere especial (ex.: ! @ # $ %)';
        }
        if (strlen($senha) < self::MIN_LENGTH) {
            return 'A senha deve ter pelo menos ' . self::MIN_LENGTH . ' caracteres';
        }
        return null;
    }
}
