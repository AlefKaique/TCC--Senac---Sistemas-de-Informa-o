<?php

namespace Hydra\Controllers;

use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\LojaRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\Mailer;
use Hydra\Support\PasswordPolicy;
use Hydra\Support\RateLimit;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Cadastro (Fig. 13), Login (Fig. 14) e Recuperação de senha (Fig. 15).
 */
final class AuthController
{
    /** Validade do código de confirmação de e-mail / login do administrador. */
    private const MINUTOS_CODIGO = 10;

    private UsuarioRepository $usuarios;
    private LojaRepository $lojas;
    private CargoRepository $cargos;
    private FilialRepository $filiais;

    public function __construct()
    {
        $this->usuarios = new UsuarioRepository();
        $this->lojas = new LojaRepository();
        $this->cargos = new CargoRepository();
        $this->filiais = new FilialRepository();
    }

    /**
     * POST /api/auth/registro
     * Onboarding: cria a loja + o primeiro usuário (perfil administrador),
     * em uma única transação. Corresponde à Figura 13 — só nome, e-mail,
     * senha e nome da loja; nada de dados que crescem com o tempo (RN22 —
     * esses ficam na tela de Configurações da Loja).
     */
    public function registro(): void
    {
        $dados = Request::json();
        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');
        $nomeLoja = trim((string) ($dados['nome_loja'] ?? ''));

        if ($nome === '' || $email === '' || $nomeLoja === '') {
            Response::json(['erro' => 'Preencha nome, e-mail e nome da loja'], 422);
            return;
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            Response::json(['erro' => 'E-mail inválido'], 422);
            return;
        }
        $erroSenha = PasswordPolicy::validar($senha);
        if ($erroSenha !== null) {
            Response::json(['erro' => $erroSenha], 422);
            return;
        }
        if ($this->usuarios->emailExists($email)) {
            Response::json(['erro' => 'Já existe uma conta com este e-mail'], 409);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $idLoja = $this->lojas->create($nomeLoja);
            // Toda loja nasce com uma filial; as demais são criadas depois
            // em Configurações da Loja > Filiais.
            $idFilial = $this->filiais->create($idLoja, ['nome' => 'Matriz']);
            // Cria os 3 cargos de sistema da loja (Administrador, Operador
            // de Caixa, Estoquista) antes do primeiro usuário, para já
            // vinculá-lo ao cargo Administrador.
            $this->cargos->ensureDefaults($idLoja);
            $idCargoAdmin = null;
            foreach ($this->cargos->listByLoja($idLoja) as $cargo) {
                if ($cargo['nome'] === 'Administrador') {
                    $idCargoAdmin = (int) $cargo['id_cargo'];
                    break;
                }
            }
            $idUsuario = $this->usuarios->create(
                $idLoja,
                $nome,
                $email,
                password_hash($senha, PASSWORD_BCRYPT),
                'administrador',
                $idCargoAdmin,
                false
            );
            // O Administrador não precisa do vínculo (acessa todas as
            // filiais), mas o mantém caso um dia deixe de ser Administrador
            // — o mesmo que sql/migracao_filiais.sql faz.
            $this->filiais->vincular($idUsuario, $idFilial);
            $this->usuarios->updateUltimaFilial($idUsuario, $idFilial);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível concluir o cadastro'], 500);
            return;
        }

        // Não autentica automaticamente: depois do cadastro o usuário
        // confirma o e-mail com o código enviado e só então é levado à tela
        // de Login para entrar com o e-mail e a senha que acabou de definir.
        // Deixar a sessão aberta aqui deixava a conta logada em um navegador
        // que nunca digitou a senha e pulava a confirmação de que ela foi
        // memorizada corretamente.
        $usuario = $this->usuarios->find($idUsuario);

        RateLimit::registrarFalha('envio:' . $email);
        $extra = $this->enviarCodigoAcesso(
            $usuario,
            'Confirme seu e-mail — Hydra PDV',
            'Confirme seu e-mail',
            'Use o código abaixo para confirmar o e-mail da sua conta no Hydra PDV.'
        );

        Response::json(
            ['usuario' => $this->publicUser($usuario), 'requer_verificacao' => true] + $extra,
            201
        );
    }

    /**
     * POST /api/auth/verificar-email
     * Confirma o e-mail da conta criada no Cadastro com o código enviado.
     * Não abre sessão: o fluxo segue para a tela de Login.
     */
    public function verificarEmail(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $codigo = trim((string) ($dados['codigo'] ?? ''));

        if ($email === '' || $codigo === '') {
            Response::json(['erro' => 'Preencha o código recebido'], 422);
            return;
        }

        $chaveLimite = 'codigo:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        $usuario = $this->usuarios->findByEmail($email);
        $valido = $usuario !== null
            ? $this->usuarios->findByValidCodigoAcesso((int) $usuario['id_usuario'], $codigo)
            : null;
        if ($valido === null) {
            RateLimit::registrarFalha($chaveLimite);
            Response::json(['erro' => 'Código inválido ou expirado'], 400);
            return;
        }

        $this->usuarios->marcarEmailVerificadoELimparCodigo((int) $usuario['id_usuario']);
        RateLimit::limpar($chaveLimite);
        RateLimit::limpar('envio:' . $email);

        Response::json(['ok' => true]);
    }

    /**
     * POST /api/auth/reenviar-verificacao
     * Reenvia o código de confirmação de e-mail. Resposta sempre genérica.
     */
    public function reenviarVerificacao(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));

        // Conta os envios, para que o botão "Reenviar" não vire um disparador
        // ilimitado de e-mails para a caixa de outra pessoa.
        $chaveLimite = 'envio:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        $usuario = $email !== '' ? $this->usuarios->findByEmail($email) : null;
        if ($usuario === null || (int) $usuario['email_verificado'] === 1) {
            Response::json(['ok' => true]);
            return;
        }

        RateLimit::registrarFalha($chaveLimite);
        $extra = $this->enviarCodigoAcesso(
            $usuario,
            'Confirme seu e-mail — Hydra PDV',
            'Confirme seu e-mail',
            'Use o código abaixo para confirmar o e-mail da sua conta no Hydra PDV.'
        );

        Response::json(['ok' => true] + $extra);
    }

    /**
     * POST /api/auth/login
     * SELECT em usuarios por e-mail + verificação de senha + UPDATE ultimo_acesso.
     */
    public function login(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');

        $chaveLimite = 'login:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        $usuario = $email !== '' ? $this->usuarios->findByEmail($email) : null;

        if ($usuario === null || !password_verify($senha, $usuario['senha'])) {
            RateLimit::registrarFalha($chaveLimite);
            Response::json(['erro' => 'E-mail ou senha inválidos'], 401);
            return;
        }
        if ($usuario['status'] !== 'ativo') {
            // Mensagem específica de propósito: ela revela que o e-mail
            // existe, mas /api/auth/registro já revela o mesmo ao recusar
            // um e-mail duplicado, então esconder aqui não fecharia a
            // enumeração e deixaria o funcionário desativado sem saber o
            // motivo. O limite de tentativas acima é que impede varredura.
            Response::json(['erro' => 'Este usuário está inativo. Fale com o administrador da loja.'], 403);
            return;
        }

        RateLimit::limpar($chaveLimite);

        // Lojas criadas antes do módulo de Cargos ainda não têm cargos —
        // cria os 3 de sistema e associa quem estiver sem cargo (ver
        // CargoRepository::ensureDefaults). Idempotente: nas próximas
        // chamadas não faz nada.
        $this->cargos->ensureDefaults((int) $usuario['id_loja']);
        if ($usuario['id_cargo'] === null) {
            $usuario = $this->usuarios->findByEmail($email);
        }

        // Antes do código por e-mail: não faz sentido mandar o código a
        // quem não vai conseguir entrar em filial nenhuma.
        $semFilial = $this->bloqueioSemFilial($usuario);
        if ($semFilial !== null) {
            Response::json(['erro' => $semFilial, 'codigo' => 'sem_filial'], 403);
            return;
        }

        // Segunda etapa por código no e-mail: obrigatória para quem ainda
        // não confirmou o e-mail e para o Administrador, que controla a
        // equipe, os preços e os dados da loja. Operador de Caixa e
        // Estoquista entram só com a senha — eles entram várias vezes ao dia
        // em um terminal compartilhado, muitas vezes sem acesso ao e-mail.
        $emailVerificado = (int) $usuario['email_verificado'] === 1;
        if (!$emailVerificado || $usuario['perfil'] === 'administrador') {
            $chaveEnvio = 'envio:' . $email;
            RateLimit::requireNaoBloqueado($chaveEnvio);
            RateLimit::registrarFalha($chaveEnvio);

            // A senha já foi conferida; a sessão guarda só QUEM está na
            // metade do login. Auth::login() acontece em loginCodigo().
            if (session_status() === PHP_SESSION_ACTIVE) {
                session_regenerate_id(true);
            }
            $_SESSION['login_pendente'] = [
                'id_usuario' => (int) $usuario['id_usuario'],
                'expira' => time() + self::MINUTOS_CODIGO * 60,
            ];

            $extra = $emailVerificado
                ? $this->enviarCodigoAcesso(
                    $usuario,
                    'Código de acesso — Hydra PDV',
                    'Código de acesso',
                    'Use o código abaixo para concluir o login de administrador no Hydra PDV.'
                )
                : $this->enviarCodigoAcesso(
                    $usuario,
                    'Confirme seu e-mail — Hydra PDV',
                    'Confirme seu e-mail',
                    'Use o código abaixo para confirmar o e-mail da sua conta e entrar no Hydra PDV.'
                );

            Response::json([
                'requer_codigo' => true,
                'email' => $usuario['email'],
                'motivo' => $emailVerificado ? 'admin' : 'verificacao',
            ] + $extra);
            return;
        }

        $this->usuarios->updateUltimoAcesso((int) $usuario['id_usuario']);
        Auth::login($usuario);

        Response::json($this->respostaDeLogin($usuario));
    }

    /**
     * POST /api/auth/login/codigo
     * Segunda etapa do login: valida o código enviado ao e-mail do usuário
     * que passou pela senha em login() e só então abre a sessão.
     */
    public function loginCodigo(): void
    {
        $usuario = $this->usuarioLoginPendente();
        if ($usuario === null) {
            Response::json(['erro' => 'Sua verificação expirou. Faça login novamente.'], 401);
            return;
        }

        $dados = Request::json();
        $codigo = trim((string) ($dados['codigo'] ?? ''));
        $chaveLimite = 'codigo:' . $usuario['email'];
        RateLimit::requireNaoBloqueado($chaveLimite);

        if ($codigo === '' || $this->usuarios->findByValidCodigoAcesso((int) $usuario['id_usuario'], $codigo) === null) {
            RateLimit::registrarFalha($chaveLimite);
            Response::json(['erro' => 'Código inválido ou expirado'], 400);
            return;
        }

        // A conta pode ter sido desativada entre a senha e o código.
        if ($usuario['status'] !== 'ativo') {
            unset($_SESSION['login_pendente']);
            Response::json(['erro' => 'Este usuário está inativo. Fale com o administrador da loja.'], 403);
            return;
        }
        // Os vínculos podem ter sido retirados enquanto o código era digitado.
        $semFilial = $this->bloqueioSemFilial($usuario);
        if ($semFilial !== null) {
            unset($_SESSION['login_pendente']);
            Response::json(['erro' => $semFilial, 'codigo' => 'sem_filial'], 403);
            return;
        }

        $this->usuarios->marcarEmailVerificadoELimparCodigo((int) $usuario['id_usuario']);
        unset($_SESSION['login_pendente']);
        RateLimit::limpar($chaveLimite);
        RateLimit::limpar('envio:' . $usuario['email']);

        $this->usuarios->updateUltimoAcesso((int) $usuario['id_usuario']);
        Auth::login($usuario);

        Response::json($this->respostaDeLogin($usuario));
    }

    /**
     * Mensagem de bloqueio quando o usuário não tem nenhuma filial ativa
     * para entrar, ou null se puder seguir com o login. O Administrador
     * (mesmo critério do cargo, CargoRepository::nivelEquivalente) não
     * precisa de vínculo, mas a loja precisa ter ao menos uma filial ativa.
     *
     * @param array<string,mixed> $usuario linha de "usuarios"
     */
    private function bloqueioSemFilial(array $usuario): ?string
    {
        $administrador = $this->ehAdministrador($usuario);
        $permitidas = $this->filiais->permitidas((int) $usuario['id_usuario'], (int) $usuario['id_loja'], $administrador);
        if ($permitidas !== []) {
            return null;
        }
        return $administrador
            ? 'A loja não tem nenhuma filial ativa. Verifique a instalação do sistema.'
            : 'Usuário sem filial vinculada. Procure o administrador.';
    }

    /** @param array<string,mixed> $usuario linha de "usuarios" */
    private function ehAdministrador(array $usuario): bool
    {
        $permissoes = !empty($usuario['id_cargo'])
            ? $this->cargos->permissoesDoCargo((int) $usuario['id_cargo'])
            : [];
        return CargoRepository::nivelEquivalente($permissoes) === 'administrador';
    }

    /**
     * Resposta do login concluído (depois de Auth::login()), já escolhendo
     * a filial quando dá:
     *   - uma filial só: entra nela;
     *   - várias: volta para a última usada, se ela ainda estiver liberada;
     *   - senão: "escolher_filial" = true e o front-end abre a janela de
     *     escolha (até lá, os endpoints de dados respondem 409).
     *
     * @param array<string,mixed> $usuario linha de "usuarios"
     */
    private function respostaDeLogin(array $usuario): array
    {
        $permitidas = $this->filiais->permitidas(
            (int) $usuario['id_usuario'],
            (int) $usuario['id_loja'],
            Auth::ehAdministrador()
        );

        $escolhida = null;
        if (count($permitidas) === 1) {
            $escolhida = $permitidas[0];
        } else {
            foreach ($permitidas as $filial) {
                if ((int) $filial['id_filial'] === (int) ($usuario['id_ultima_filial'] ?? 0)) {
                    $escolhida = $filial;
                    break;
                }
            }
        }

        if ($escolhida !== null) {
            Auth::definirFilial((int) $escolhida['id_filial']);
            $this->usuarios->updateUltimaFilial((int) $usuario['id_usuario'], (int) $escolhida['id_filial']);
        }

        return [
            'usuario' => $this->publicUser($usuario),
            'filial' => $escolhida !== null
                ? ['id_filial' => (int) $escolhida['id_filial'], 'nome' => $escolhida['nome']]
                : null,
            'escolher_filial' => $escolhida === null,
        ];
    }

    /** POST /api/auth/login/reenviar — reenvia o código da segunda etapa do login. */
    public function loginReenviar(): void
    {
        $usuario = $this->usuarioLoginPendente();
        if ($usuario === null) {
            Response::json(['erro' => 'Sua verificação expirou. Faça login novamente.'], 401);
            return;
        }

        $chaveEnvio = 'envio:' . $usuario['email'];
        RateLimit::requireNaoBloqueado($chaveEnvio);
        RateLimit::registrarFalha($chaveEnvio);

        $_SESSION['login_pendente']['expira'] = time() + self::MINUTOS_CODIGO * 60;
        $extra = $this->enviarCodigoAcesso(
            $usuario,
            'Código de acesso — Hydra PDV',
            'Código de acesso',
            'Use o código abaixo para concluir seu login no Hydra PDV.'
        );

        Response::json(['ok' => true] + $extra);
    }

    /** Usuário que passou pela senha e aguarda o código, ou null se não houver / tiver expirado. */
    private function usuarioLoginPendente(): ?array
    {
        $pendente = $_SESSION['login_pendente'] ?? null;
        if (!is_array($pendente) || ($pendente['expira'] ?? 0) < time()) {
            unset($_SESSION['login_pendente']);
            return null;
        }
        return $this->usuarios->find((int) $pendente['id_usuario']);
    }

    /** POST /api/auth/logout */
    public function logout(): void
    {
        Auth::logout();
        Response::json(['ok' => true]);
    }

    /** GET /api/auth/me — retorna o usuário autenticado (ou 401). */
    public function me(): void
    {
        $user = Auth::requireLogin();
        Response::json(['usuario' => $user]);
    }

    /**
     * POST /api/auth/esqueci-senha
     * Gera um código numérico de 6 dígitos com validade de 15 minutos
     * (RN05) e envia por e-mail (Mailer, via API do Brevo). Se o Brevo
     * não estiver configurado no ambiente (BREVO_API_KEY vazio), o
     * código volta na própria resposta para viabilizar o fluxo de
     * teste/demonstração local, já que não há como entregá-lo por
     * e-mail nesse caso.
     */
    public function esqueciSenha(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        // Conta também os pedidos, não só as tentativas de código: sem isso
        // um atacante geraria códigos novos indefinidamente para ampliar a
        // janela de ataque.
        $chaveLimite = 'reset:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        $usuario = $email !== '' ? $this->usuarios->findByEmail($email) : null;

        // Resposta genérica mesmo se o e-mail não existir, para não vazar
        // quais e-mails estão cadastrados na base.
        if ($usuario === null) {
            Response::json(['ok' => true]);
            return;
        }

        RateLimit::registrarFalha($chaveLimite);

        $codigo = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $expiraEm = (new \DateTimeImmutable('+15 minutes'))->format('Y-m-d H:i:s');
        $this->usuarios->setResetToken((int) $usuario['id_usuario'], $codigo, $expiraEm);

        $enviado = Mailer::send(
            $email,
            'Código de recuperação de senha — Hydra PDV',
            $this->emailCodigoHtml(
                (string) $usuario['nome'],
                $codigo,
                'Recuperação de senha',
                'Use o código abaixo para redefinir sua senha no Hydra PDV. Ele expira em 15 minutos.',
                'Se você não solicitou essa recuperação, pode ignorar este e-mail.'
            )
        );

        $resposta = ['ok' => true];
        // O código só volta na resposta em ambiente de desenvolvimento,
        // declarado explicitamente em APP_ENV. Antes isso dependia apenas
        // de o envio ter falhado - e como BREVO_API_KEY precisa ser
        // preenchida à mão no provedor, esquecer disso em produção fazia
        // a API entregar o código de qualquer conta a qualquer um.
        if (!$enviado && Env::get('APP_ENV', 'production') === 'local') {
            $resposta['codigo_dev'] = $codigo;
        }

        Response::json($resposta);
    }

    /**
     * POST /api/auth/verificar-codigo-recuperacao
     * Primeira metade da redefinição: confere o código antes de a tela
     * mostrar os campos de nova senha. NÃO consome o código —
     * redefinirSenha() o valida de novo, porque pular esta etapa pelo
     * navegador não pode bastar para trocar a senha.
     */
    public function verificarCodigoRecuperacao(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $codigo = trim((string) ($dados['codigo'] ?? ''));

        if ($email === '' || $codigo === '') {
            Response::json(['erro' => 'Preencha o código recebido'], 422);
            return;
        }

        // Mesma chave de redefinirSenha(): as tentativas das duas etapas
        // somam no mesmo limite.
        $chaveLimite = 'reset:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        if ($this->usuarios->findByValidResetCode($email, $codigo) === null) {
            RateLimit::registrarFalha($chaveLimite);
            Response::json(['erro' => 'Código inválido ou expirado'], 400);
            return;
        }

        Response::json(['ok' => true]);
    }

    /** POST /api/auth/redefinir-senha */
    public function redefinirSenha(): void
    {
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $codigo = trim((string) ($dados['codigo'] ?? ''));
        $senha = (string) ($dados['senha'] ?? '');

        if ($email === '' || $codigo === '') {
            Response::json(['erro' => 'Preencha o código recebido'], 422);
            return;
        }
        // Mesma política do cadastro: antes aqui bastavam 6 caracteres, o
        // que permitia contornar a exigência de senha forte pelo fluxo de
        // "Esqueci minha senha".
        $erroSenha = PasswordPolicy::validar($senha);
        if ($erroSenha !== null) {
            Response::json(['erro' => $erroSenha], 422);
            return;
        }

        $chaveLimite = 'reset:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        $usuario = $this->usuarios->findByValidResetCode($email, $codigo);
        if ($usuario === null) {
            RateLimit::registrarFalha($chaveLimite);
            Response::json(['erro' => 'Código inválido ou expirado'], 400);
            return;
        }

        $this->usuarios->updatePasswordAndClearResetToken(
            (int) $usuario['id_usuario'],
            password_hash($senha, PASSWORD_BCRYPT)
        );
        RateLimit::limpar($chaveLimite);

        Response::json(['ok' => true]);
    }

    /**
     * Gera e envia o código de confirmação de e-mail / login do
     * administrador. Devolve o que deve ser acrescentado à resposta: o
     * código só volta nela em desenvolvimento (APP_ENV=local) quando o
     * e-mail não pôde ser enviado — a mesma regra de esqueciSenha().
     *
     * @param array<string,mixed> $usuario
     * @return array<string,string>
     */
    private function enviarCodigoAcesso(array $usuario, string $assunto, string $titulo, string $texto): array
    {
        $codigo = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $expiraEm = (new \DateTimeImmutable('+' . self::MINUTOS_CODIGO . ' minutes'))->format('Y-m-d H:i:s');
        $this->usuarios->setCodigoAcesso((int) $usuario['id_usuario'], $codigo, $expiraEm);

        $enviado = Mailer::send(
            (string) $usuario['email'],
            $assunto,
            $this->emailCodigoHtml(
                (string) $usuario['nome'],
                $codigo,
                $titulo,
                $texto . ' Ele expira em ' . self::MINUTOS_CODIGO . ' minutos.',
                'Se não foi você, ignore este e-mail e considere trocar sua senha.'
            )
        );

        if (!$enviado && Env::get('APP_ENV', 'production') === 'local') {
            return ['codigo_dev' => $codigo];
        }
        return [];
    }

    private function emailCodigoHtml(string $nome, string $codigo, string $titulo, string $texto, string $rodape): string
    {
        $primeiroNome = htmlspecialchars(explode(' ', trim($nome))[0] ?? '', ENT_QUOTES, 'UTF-8');
        $titulo = htmlspecialchars($titulo, ENT_QUOTES, 'UTF-8');
        $texto = htmlspecialchars($texto, ENT_QUOTES, 'UTF-8');
        $rodape = htmlspecialchars($rodape, ENT_QUOTES, 'UTF-8');
        return <<<HTML
            <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1B2A63;">
                <h2 style="margin-bottom: 8px;">{$titulo}</h2>
                <p>Olá, {$primeiroNome}!</p>
                <p>{$texto}</p>
                <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; background: #F4F5F9; padding: 16px 24px; border-radius: 8px; text-align: center;">{$codigo}</p>
                <p>{$rodape}</p>
            </div>
            HTML;
    }

    /** @param array<string,mixed> $usuario */
    private function publicUser(array $usuario): array
    {
        return [
            'id_usuario' => (int) $usuario['id_usuario'],
            'id_loja' => (int) $usuario['id_loja'],
            'nome' => $usuario['nome'],
            'email' => $usuario['email'],
            'perfil' => $usuario['perfil'],
            'id_cargo' => isset($usuario['id_cargo']) ? (int) $usuario['id_cargo'] : null,
            'permissoes' => !empty($usuario['id_cargo'])
                ? $this->cargos->permissoesDoCargo((int) $usuario['id_cargo'])
                : [],
        ];
    }
}
