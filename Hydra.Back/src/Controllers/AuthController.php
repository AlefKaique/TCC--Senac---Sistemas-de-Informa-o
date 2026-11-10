<?php

namespace Hydra\Controllers;

use Hydra\Repositories\CadastroPendenteRepository;
use Hydra\Repositories\CatalogoHortifrutiRepository;
use Hydra\Repositories\CargoRepository;
use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\LojaRepository;
use Hydra\Repositories\ProdutoRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\Mailer;
use Hydra\Support\PasswordPolicy;
use Hydra\Support\RateLimit;
use Hydra\Support\Request;
use Hydra\Support\Response;
use Hydra\Support\Validacao;

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
     * Primeira etapa do Cadastro (Fig. 13): valida os dados, guarda-os como
     * cadastro PENDENTE e envia o código ao e-mail. Nada é criado em lojas,
     * filiais, cargos ou usuarios aqui — a conta só nasce em verificarEmail(),
     * com o código certo. Assim quem desiste na tela do código não deixa
     * conta no sistema, e ninguém ocupa o e-mail de outra pessoa.
     */
    public function registro(): void
    {
        // Esta rota não grava na sessão: solta o lock já no início.
        Auth::liberarSessao();
        $dados = Request::json();
        $nome = trim((string) ($dados['nome'] ?? ''));
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $senha = (string) ($dados['senha'] ?? '');
        $nomeLoja = trim((string) ($dados['nome_loja'] ?? ''));
        $importarHortifruti = ($dados['importar_hortifruti'] ?? false) === true;

        // Um erro por campo, com "campo" na resposta, para a tela marcar o
        // input certo em vez de um alerta genérico (QA 002).
        $erroNome = Validacao::erroNomePessoa($nome);
        if ($erroNome !== null) {
            Response::json(['erro' => $erroNome, 'campo' => 'nome'], 422);
            return;
        }
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 100) {
            Response::json(['erro' => $email === '' ? 'Informe o e-mail.' : 'E-mail inválido', 'campo' => 'email'], 422);
            return;
        }
        if ($nomeLoja === '') {
            Response::json(['erro' => 'Informe o nome da loja.', 'campo' => 'nome_loja'], 422);
            return;
        }
        if (mb_strlen($nomeLoja) > 120) {
            Response::json(['erro' => 'O nome da loja pode ter no máximo 120 caracteres.', 'campo' => 'nome_loja'], 422);
            return;
        }
        $erroSenha = PasswordPolicy::validar($senha);
        if ($erroSenha !== null) {
            Response::json(['erro' => $erroSenha, 'campo' => 'senha'], 422);
            return;
        }
        if ($importarHortifruti && !(new CatalogoHortifrutiRepository())->estaCompleto()) {
            Response::json([
                'erro' => 'O catálogo padrão não tem os 120 itens. Desmarque a opção para continuar sem importar.',
            ], 503);
            return;
        }

        $existente = $this->usuarios->findByEmail($email);
        if ($existente !== null && !$this->removerContaAbandonada($existente)) {
            Response::json(['erro' => 'Já existe uma conta com este e-mail', 'campo' => 'email'], 409);
            return;
        }

        // Cada "Criar conta" dispara um e-mail: sem o limite, o formulário
        // viraria um disparador de mensagens para a caixa de outra pessoa.
        $chaveEnvio = 'envio:' . $email;
        RateLimit::requireNaoBloqueado($chaveEnvio);
        RateLimit::registrarFalha($chaveEnvio);

        $pendentes = new CadastroPendenteRepository();
        $pendentes->limparExpirados();

        $codigo = $this->novoCodigo();
        $pendentes->salvar(
            $email,
            $nome,
            $nomeLoja,
            password_hash($senha, PASSWORD_BCRYPT),
            $codigo,
            $this->expiracaoCodigo(),
            $importarHortifruti
        );

        $extra = $this->despacharEmailCodigo(
            $email,
            $nome,
            $codigo,
            'Confirme seu e-mail — Hydra PDV',
            'Confirme seu e-mail',
            'Use o código abaixo para confirmar o e-mail e concluir a criação da sua conta no Hydra PDV.'
        );

        Response::json(['requer_verificacao' => true, 'email' => $email] + $extra, 201);
    }

    /**
     * Conta criada pelo Cadastro ANTES dos cadastros pendentes e nunca
     * confirmada: e-mail não verificado, nenhum acesso e sozinha na loja.
     * Ela não tem dado nenhum (só a loja, a Matriz e os cargos padrão
     * criados automaticamente), então é apagada para o e-mail poder ser
     * cadastrado de novo. Devolve false se a conta for de verdade.
     *
     * @param array<string,mixed> $usuario linha de "usuarios"
     */
    private function removerContaAbandonada(array $usuario): bool
    {
        if ((int) $usuario['email_verificado'] === 1 || $usuario['ultimo_acesso'] !== null) {
            return false;
        }
        if ($this->usuarios->countByLoja((int) $usuario['id_loja']) !== 1) {
            return false;
        }
        // ON DELETE CASCADE leva usuário, filial, cargos e vínculos juntos.
        $this->lojas->remover((int) $usuario['id_loja']);
        return true;
    }

    /**
     * Cria loja, filial Matriz, cargos de sistema e o Administrador, numa
     * transação. Chamado só depois do código de confirmação conferido.
     * Devolve null se o e-mail tiver sido cadastrado no meio do caminho.
     */
    private function criarConta(
        string $nome,
        string $email,
        string $senhaHash,
        string $nomeLoja,
        bool $importarHortifruti = false
    ): ?int {
        // Fora da transação: dentro dela a migração do catálogo não pode ser
        // registrada (DDL faz commit implícito) e rodaria em todo cadastro.
        $this->cargos->garantirCatalogoGlobal();
        $catalogo = $importarHortifruti ? new CatalogoHortifrutiRepository() : null;
        if ($importarHortifruti) {
            new ProdutoRepository();
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $idLoja = $this->lojas->create($nomeLoja);
            // Toda loja nasce com uma filial; as demais são criadas depois
            // em Configurações da Loja > Filiais.
            $idFilial = $this->filiais->create($idLoja, ['nome' => 'Matriz']);
            if ($catalogo !== null) {
                $catalogo->importar($idLoja, $idFilial);
            }
            // Cria os 3 cargos de sistema da loja (Administrador, Operador
            // de Caixa, Estoquista) antes do primeiro usuário, para já
            // vinculá-lo ao cargo Administrador.
            $this->cargos->ensureDefaults($idLoja);
            // Busca direta: listByLoja() traria também as permissões e a
            // contagem de usuários de cada cargo, 7 consultas sem uso aqui.
            $idCargoAdmin = $this->cargos->idCargoSistema($idLoja, 'Administrador');
            // O e-mail já foi confirmado pelo código: a conta nasce verificada.
            $idUsuario = $this->usuarios->create($idLoja, $nome, $email, $senhaHash, 'administrador', $idCargoAdmin, true);
            // O Administrador não precisa do vínculo (acessa todas as
            // filiais), mas o mantém caso um dia deixe de ser Administrador
            // — o mesmo que sql/migracao_filiais.sql faz.
            $this->filiais->vincular($idUsuario, $idFilial);
            $this->usuarios->updateUltimaFilial($idUsuario, $idFilial);
            $pdo->commit();
            return $idUsuario;
        } catch (\PDOException $e) {
            $pdo->rollBack();
            // 23000: o índice UNIQUE de usuarios.email barrou um cadastro
            // simultâneo com o mesmo e-mail.
            if ($e->getCode() === '23000') {
                return null;
            }
            throw $e;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * POST /api/auth/verificar-email
     * Segunda etapa do Cadastro: confere o código e só então cria a conta.
     * Também confirma o e-mail de contas antigas, criadas antes dos
     * cadastros pendentes. Não abre sessão: o fluxo segue para o Login.
     */
    public function verificarEmail(): void
    {
        // Esta rota não grava na sessão: solta o lock já no início.
        Auth::liberarSessao();
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));
        $codigo = trim((string) ($dados['codigo'] ?? ''));

        if ($email === '' || $codigo === '') {
            Response::json(['erro' => 'Preencha o código recebido'], 422);
            return;
        }

        $chaveLimite = 'codigo:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        $pendentes = new CadastroPendenteRepository();
        $pendente = $pendentes->buscar($email);
        if ($pendente !== null) {
            $codigoConfere = (int) $pendente['codigo_valido'] === 1
                && hash_equals((string) $pendente['codigo_hash'], CadastroPendenteRepository::hashCodigo($codigo));
            if (!$codigoConfere) {
                RateLimit::registrarFalha($chaveLimite);
                Response::json(['erro' => 'Código inválido ou expirado'], 400);
                return;
            }

            $importarHortifruti = (bool) ($pendente['importar_hortifruti'] ?? false);
            if ($importarHortifruti && !(new CatalogoHortifrutiRepository())->estaCompleto()) {
                Response::json([
                    'erro' => 'O catálogo padrão não está disponível. Tente novamente mais tarde ou conclua o cadastro sem importar.',
                ], 503);
                return;
            }

            $idUsuario = $this->usuarios->emailExists($email)
                ? null
                : $this->criarConta(
                    (string) $pendente['nome'],
                    $email,
                    (string) $pendente['senha_hash'],
                    (string) $pendente['nome_loja'],
                    $importarHortifruti
                );
            $pendentes->remover($email);
            RateLimit::limpar($chaveLimite, 'envio:' . $email);

            if ($idUsuario === null) {
                Response::json(['erro' => 'Já existe uma conta com este e-mail. Faça login.'], 409);
                return;
            }
            Response::json(['ok' => true]);
            return;
        }

        // Conta antiga, criada antes dos cadastros pendentes.
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
        RateLimit::limpar($chaveLimite, 'envio:' . $email);

        Response::json(['ok' => true]);
    }

    /**
     * POST /api/auth/reenviar-verificacao
     * Reenvia o código de confirmação de e-mail. Resposta sempre genérica.
     */
    public function reenviarVerificacao(): void
    {
        // Esta rota não grava na sessão: solta o lock já no início.
        Auth::liberarSessao();
        $dados = Request::json();
        $email = trim(strtolower((string) ($dados['email'] ?? '')));

        // Conta os envios, para que o botão "Reenviar" não vire um disparador
        // ilimitado de e-mails para a caixa de outra pessoa.
        $chaveLimite = 'envio:' . $email;
        RateLimit::requireNaoBloqueado($chaveLimite);

        $pendentes = new CadastroPendenteRepository();
        $pendente = $email !== '' ? $pendentes->buscar($email) : null;
        if ($pendente !== null) {
            RateLimit::registrarFalha($chaveLimite);
            $codigo = $this->novoCodigo();
            $pendentes->atualizarCodigo($email, $codigo, $this->expiracaoCodigo());
            $extra = $this->despacharEmailCodigo(
                $email,
                (string) $pendente['nome'],
                $codigo,
                'Confirme seu e-mail — Hydra PDV',
                'Confirme seu e-mail',
                'Use o código abaixo para confirmar o e-mail e concluir a criação da sua conta no Hydra PDV.'
            );
            Response::json(['ok' => true] + $extra);
            return;
        }

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
        // A sessão compartilhada pelo navegador nunca pode manter ao mesmo
        // tempo uma conta da loja e uma conta da equipe Hydra.
        unset($_SESSION['admin_plataforma'], $_SESSION['login_pendente_plataforma']);
        // Grava o unset acima e solta o lock: a verificação da senha (bcrypt)
        // e as consultas abaixo não podem segurar as outras requisições do
        // navegador. Quem grava na sessão daqui em diante a reabre antes
        // (Auth::login() e o bloco do login_pendente).
        Auth::liberarSessao();
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
        if ($this->lojaEstaSuspensa((int) $usuario['id_loja'])) {
            Response::json([
                'erro' => 'O acesso deste mercado está suspenso. Entre em contato com o suporte Hydra.',
                'codigo' => 'loja_suspensa',
            ], 403);
            return;
        }

        RateLimit::limpar($chaveLimite);

        // Lojas criadas antes do módulo de Cargos ainda não têm cargos —
        // cria os 3 de sistema e associa quem estiver sem cargo (ver
        // CargoRepository::ensureDefaults). Idempotente: nas próximas
        // chamadas não faz nada.
        // Quem já tem cargo está numa loja que já tem os cargos de sistema:
        // aí basta conferir o catálogo global (um file_exists no caso normal)
        // e o login poupa duas consultas.
        if ($usuario['id_cargo'] === null) {
            $this->cargos->ensureDefaults((int) $usuario['id_loja']);
            $usuario = $this->usuarios->findByEmail($email);
        } else {
            $this->cargos->garantirCatalogoGlobal();
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
            Auth::reabrirSessao();
            if (session_status() === PHP_SESSION_ACTIVE) {
                session_regenerate_id(true);
            }
            $_SESSION['login_pendente'] = [
                'id_usuario' => (int) $usuario['id_usuario'],
                'expira' => time() + self::MINUTOS_CODIGO * 60,
            ];
            // Solta de novo antes do envio do e-mail (síncrono em local).
            Auth::liberarSessao();

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
        if ($this->lojaEstaSuspensa((int) $usuario['id_loja'])) {
            unset($_SESSION['login_pendente']);
            Response::json([
                'erro' => 'O acesso deste mercado está suspenso. Entre em contato com o suporte Hydra.',
                'codigo' => 'loja_suspensa',
            ], 403);
            return;
        }
        // Os vínculos podem ter sido retirados enquanto o código era digitado.
        $semFilial = $this->bloqueioSemFilial($usuario);
        if ($semFilial !== null) {
            unset($_SESSION['login_pendente']);
            Response::json(['erro' => $semFilial, 'codigo' => 'sem_filial'], 403);
            return;
        }

        $this->usuarios->concluirLoginComCodigo((int) $usuario['id_usuario']);
        unset($_SESSION['login_pendente']);
        RateLimit::limpar($chaveLimite, 'envio:' . $usuario['email']);

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

    private function lojaEstaSuspensa(int $idLoja): bool
    {
        $stmt = db()->prepare("SELECT status = 'suspensa' FROM lojas WHERE id_loja = :id_loja");
        $stmt->execute(['id_loja' => $idLoja]);
        return (int) $stmt->fetchColumn() === 1;
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
            // Só grava se mudou: no login de todo dia é a mesma filial.
            if ((int) $escolhida['id_filial'] !== (int) ($usuario['id_ultima_filial'] ?? 0)) {
                $this->usuarios->updateUltimaFilial((int) $usuario['id_usuario'], (int) $escolhida['id_filial']);
            }
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
        // Esta rota não grava na sessão: solta o lock já no início.
        Auth::liberarSessao();
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

        $assunto = 'Código de recuperação de senha — Hydra PDV';
        $html = $this->emailCodigoHtml(
            (string) $usuario['nome'],
            $codigo,
            'Recuperação de senha',
            'Use o código abaixo para redefinir sua senha no Hydra PDV. Ele expira em 15 minutos.',
            'Se você não solicitou essa recuperação, pode ignorar este e-mail.'
        );

        $resposta = ['ok' => true];
        // O código só volta na resposta em ambiente de desenvolvimento,
        // declarado explicitamente em APP_ENV. Antes isso dependia apenas
        // de o envio ter falhado - e como BREVO_API_KEY precisa ser
        // preenchida à mão no provedor, esquecer disso em produção fazia
        // a API entregar o código de qualquer conta a qualquer um.
        if (Env::get('APP_ENV', 'production') === 'local') {
            // Em desenvolvimento a resposta depende do resultado do envio.
            if (!Mailer::send($email, $assunto, $html)) {
                $resposta['codigo_dev'] = $codigo;
            }
        } else {
            // Em produção o e-mail sai DEPOIS da resposta, como em
            // despacharEmailCodigo(): a tela não espera a chamada ao Brevo
            // (até 10 s), e o tempo de resposta deixa de denunciar se o
            // e-mail informado tem conta (o caso sem conta responde na hora).
            Response::depoisDaResposta(static fn () => Mailer::send($email, $assunto, $html));
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
        // Esta rota não grava na sessão: solta o lock já no início.
        Auth::liberarSessao();
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
        // Esta rota não grava na sessão: solta o lock já no início.
        Auth::liberarSessao();
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
        $codigo = $this->novoCodigo();
        $this->usuarios->setCodigoAcesso((int) $usuario['id_usuario'], $codigo, $this->expiracaoCodigo());

        return $this->despacharEmailCodigo(
            (string) $usuario['email'],
            (string) $usuario['nome'],
            $codigo,
            $assunto,
            $titulo,
            $texto
        );
    }

    private function novoCodigo(): string
    {
        return str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    }

    private function expiracaoCodigo(): string
    {
        return (new \DateTimeImmutable('+' . self::MINUTOS_CODIGO . ' minutes'))->format('Y-m-d H:i:s');
    }

    /**
     * Envia o e-mail com o código. Devolve o que acrescentar à resposta:
     * o código só volta nela em desenvolvimento (APP_ENV=local) quando o
     * e-mail não pôde ser enviado.
     *
     * @return array<string,string>
     */
    private function despacharEmailCodigo(string $destino, string $nome, string $codigo, string $assunto, string $titulo, string $texto): array
    {
        $html = $this->emailCodigoHtml(
            $nome,
            $codigo,
            $titulo,
            $texto . ' Ele expira em ' . self::MINUTOS_CODIGO . ' minutos.',
            'Se não foi você, ignore este e-mail e considere trocar sua senha.'
        );

        // Em desenvolvimento a resposta depende do resultado do envio
        // (codigo_dev), então ele continua síncrono.
        if (Env::get('APP_ENV', 'production') === 'local') {
            return Mailer::send($destino, $assunto, $html) ? [] : ['codigo_dev' => $codigo];
        }

        // Em produção a resposta é a mesma com ou sem sucesso no envio: o
        // e-mail sai DEPOIS que a tela recebe a resposta, em vez de a tela
        // esperar a chamada ao Brevo — a tela do código abre na hora.
        Response::depoisDaResposta(static fn () => Mailer::send($destino, $assunto, $html));
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
