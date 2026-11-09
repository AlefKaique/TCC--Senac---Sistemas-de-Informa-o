<?php

if (PHP_SAPI !== 'cli') {
    exit;
}

use Hydra\Repositories\AdminPlataformaRepository;
use Hydra\Support\PasswordPolicy;

$appRoot = dirname(__DIR__);
spl_autoload_register(static function (string $class) use ($appRoot): void {
    $prefix = 'Hydra\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = substr($class, strlen($prefix));
    $path = $appRoot . DIRECTORY_SEPARATOR . 'src' . DIRECTORY_SEPARATOR
        . str_replace('\\', DIRECTORY_SEPARATOR, $relative) . '.php';
    if (is_file($path)) {
        require $path;
    }
});
require $appRoot . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'database.php';

function lerLinha(string $rotulo): string
{
    fwrite(STDOUT, $rotulo);
    return trim((string) fgets(STDIN));
}

function lerSenha(string $rotulo): string
{
    if (PHP_OS_FAMILY === 'Windows' && function_exists('proc_open')) {
        $prompt = str_replace("'", "''", $rotulo);
        $script = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '
            . '$segredo = Read-Host -Prompt \'' . $prompt . '\' -AsSecureString; '
            . '$ponteiro = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($segredo); '
            . 'try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ponteiro)) } '
            . 'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ponteiro) }';
        $processo = @proc_open(
            ['powershell.exe', '-NoProfile', '-Command', $script],
            [0 => STDIN, 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        if (is_resource($processo)) {
            $senha = stream_get_contents($pipes[1]);
            $erro = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $codigoSaida = proc_close($processo);
            if ($codigoSaida === 0) {
                return rtrim((string) $senha, "\r\n");
            }
            if ($erro !== '') {
                fwrite(STDERR, trim($erro) . PHP_EOL);
            }
        }
    }

    fwrite(STDOUT, $rotulo);
    if (PHP_OS_FAMILY !== 'Windows') {
        $estadoTerminal = shell_exec('stty -g 2>/dev/null');
        if (is_string($estadoTerminal) && trim($estadoTerminal) !== '') {
            shell_exec('stty -echo');
            try {
                $senha = trim((string) fgets(STDIN));
            } finally {
                shell_exec('stty ' . escapeshellarg(trim($estadoTerminal)));
                fwrite(STDOUT, PHP_EOL);
            }
            return $senha;
        }
    }

    // Em consoles sem suporte a entrada oculta, a leitura segue o stdin.
    fwrite(STDERR, 'Aviso: este console pode exibir a senha enquanto você digita.' . PHP_EOL);
    return trim((string) fgets(STDIN));
}

$nome = trim((string) ($argv[1] ?? ''));
$email = trim(strtolower((string) ($argv[2] ?? '')));
if ($nome === '' || mb_strlen($nome, 'UTF-8') > 100 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    fwrite(STDERR, "Uso: php bin/criar-admin-plataforma.php \"Nome\" email@dominio.com\n");
    exit(1);
}

$admins = new AdminPlataformaRepository();
$existente = $admins->findByEmail($email);
if ($existente !== null) {
    $resposta = strtolower(lerLinha("O e-mail já existe. Redefinir a senha? [s/N] "));
    if (!in_array($resposta, ['s', 'sim'], true)) {
        fwrite(STDOUT, "Operação cancelada.\n");
        exit(0);
    }
} else {
    $existente = null;
}

$senha = lerSenha('Senha: ');
$confirmacao = lerSenha('Confirme a senha: ');
if (!hash_equals($senha, $confirmacao)) {
    fwrite(STDERR, "As senhas não conferem.\n");
    exit(1);
}

$erroSenha = PasswordPolicy::validar($senha);
if ($erroSenha !== null) {
    fwrite(STDERR, $erroSenha . ".\n");
    exit(1);
}

$senhaHash = password_hash($senha, PASSWORD_BCRYPT);
if ($senhaHash === false) {
    fwrite(STDERR, "Não foi possível gerar o hash da senha.\n");
    exit(1);
}

if ($existente !== null) {
    $admins->redefinirSenha((int) $existente['id_admin'], $senhaHash);
    db()->prepare(
        "UPDATE admins_plataforma SET nivel = 'proprietario', status = 'ativo', senha_definida = 1
          WHERE id_admin = :id_admin"
    )->execute(['id_admin' => (int) $existente['id_admin']]);
    fwrite(STDOUT, "Senha do administrador da plataforma redefinida.\n");
} else {
    db()->prepare(
        "INSERT INTO admins_plataforma (nome, email, senha, nivel, senha_definida, status)
         VALUES (:nome, :email, :senha, 'proprietario', 1, 'ativo')"
    )->execute(['nome' => $nome, 'email' => $email, 'senha' => $senhaHash]);
    fwrite(STDOUT, "Administrador da plataforma criado.\n");
}
