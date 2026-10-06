<?php

namespace Hydra\Controllers;

use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\UsuarioRepository;
use Hydra\Repositories\VendaRepository;
use Hydra\Support\Auth;
use Hydra\Support\Request;
use Hydra\Support\Response;

/**
 * Filiais: o botão "Trocar Filial" (todas as telas) e a seção "Filiais"
 * de Configurações da Loja.
 *
 * Toda decisão de acesso é tomada aqui, no servidor: o front-end só mostra
 * as filiais que /minhas devolve, mas /trocar confere de novo, porque
 * esconder um botão não impede ninguém de chamar a API direto.
 */
final class FilialController
{
    private FilialRepository $filiais;

    public function __construct()
    {
        $this->filiais = new FilialRepository();
    }

    /**
     * GET /api/filiais/minhas
     * Filiais ativas que o usuário logado pode acessar e qual está ativa na
     * sessão. Não exige filial escolhida: é justamente o que a janela de
     * escolha chama quando ainda não há uma.
     */
    public function minhas(): void
    {
        $user = Auth::requireLogin();
        $administrador = Auth::ehAdministrador();
        $permitidas = $this->filiais->permitidas($user['id_usuario'], $user['id_loja'], $administrador);

        // Só informa como ativa a filial da sessão que continua permitida
        // (pode ter sido inativada ou desvinculada desde o login).
        $ativa = null;
        foreach ($permitidas as $filial) {
            if ((int) $filial['id_filial'] === (int) ($user['id_filial'] ?? 0)) {
                $ativa = self::publica($filial);
                break;
            }
        }

        Response::json([
            'filiais' => array_map(fn ($f) => self::publica($f), $permitidas),
            'filial_ativa' => $ativa,
            'administrador' => $administrador,
        ]);
    }

    /**
     * POST /api/filiais/trocar   { "id_filial": 3 }
     * Valida o acesso, grava a filial na sessão e a lembra como a última
     * usada (o próximo login volta para ela).
     */
    public function trocar(): void
    {
        $user = Auth::requireLogin();
        $idFilial = (int) (Request::json()['id_filial'] ?? 0);

        // Filial de outra loja recebe a mesma resposta que uma inexistente.
        $filial = $this->filiais->findInLoja($idFilial, $user['id_loja']);
        if ($filial === null) {
            Response::json(['erro' => 'Filial não encontrada'], 404);
            return;
        }
        if (!Auth::ehAdministrador() && !$this->filiais->usuarioVinculado($user['id_usuario'], $idFilial)) {
            Response::json(['erro' => 'Você não tem acesso a esta filial. Solicite ao administrador.'], 403);
            return;
        }
        if ($filial['status'] !== 'ativa') {
            Response::json(['erro' => 'Esta filial está desativada e não pode ser usada.'], 422);
            return;
        }

        Auth::definirFilial($idFilial);
        (new UsuarioRepository())->updateUltimaFilial($user['id_usuario'], $idFilial);

        Response::json(['filial' => self::publica($filial)]);
    }

    /**
     * GET /api/filiais — todas as filiais da loja, em qualquer status.
     * Serve à seção Filiais (loja.configurar) e às caixas de seleção da
     * tela Equipe (equipe.gerenciar): as duas permissões são as que fazem
     * de um cargo Administrador (CargoRepository::nivelEquivalente).
     */
    public function index(): void
    {
        $admin = Auth::requireAnyPermission(['loja.configurar', 'equipe.gerenciar']);
        $filiais = array_map(fn ($f) => self::publica($f), $this->filiais->listByLoja($admin['id_loja']));

        // Lucro do mês de cada filial (cartões da tela Filiais). É dado
        // financeiro: só vai para quem tem "relatorios.visualizar", a mesma
        // permissão do Dashboard (RN16/RN17). Sem ela, "resumo_mes" é null e
        // a tela mostra o cartão sem os números.
        $mostrarResumo = Auth::can('relatorios.visualizar');
        $inicio = date('Y-m-01 00:00:00');
        $fim = date('Y-m-01 00:00:00', strtotime('first day of next month'));
        $resumos = $mostrarResumo
            ? (new VendaRepository())->resumoPorFilial($admin['id_loja'], $inicio, $fim)
            : [];
        foreach ($filiais as &$filial) {
            $filial['resumo_mes'] = $mostrarResumo
                ? ($resumos[$filial['id_filial']] ?? ['vendas' => 0, 'faturamento' => 0.0, 'lucro' => 0.0])
                : null;
        }
        unset($filial);

        Response::json([
            'filiais' => $filiais,
            'id_filial_ativa' => $admin['id_filial'],
            'mes_referencia' => date('Y-m'),
        ]);
    }

    /** POST /api/filiais */
    public function store(): void
    {
        $admin = Auth::requirePermission('loja.configurar');
        $validado = $this->validar(Request::json(), $admin['id_loja'], null);
        if (isset($validado['erro'])) {
            Response::json(['erro' => $validado['erro']], $validado['status']);
            return;
        }
        $campos = $validado['campos'];

        $id = $this->filiais->create($admin['id_loja'], $campos);
        Response::json(['filial' => self::publica($this->filiais->findInLoja($id, $admin['id_loja']))], 201);
    }

    /** PUT /api/filiais/{id} */
    public function update(int $id): void
    {
        $admin = Auth::requirePermission('loja.configurar');
        $filial = $this->filiais->findInLoja($id, $admin['id_loja']);
        if ($filial === null) {
            Response::json(['erro' => 'Filial não encontrada'], 404);
            return;
        }

        $validado = $this->validar(Request::json(), $admin['id_loja'], $id);
        if (isset($validado['erro'])) {
            Response::json(['erro' => $validado['erro']], $validado['status']);
            return;
        }
        $campos = $validado['campos'];
        $inativando = $filial['status'] === 'ativa' && $campos['status'] === 'inativa';

        // Desativar a filial em que se está trabalhando derrubaria a
        // própria sessão na requisição seguinte (Auth::requireFilial).
        if ($inativando && $id === (int) ($admin['id_filial'] ?? 0)) {
            Response::json([
                'erro' => 'Você não pode desativar a filial em que está trabalhando agora. Troque de filial antes.',
            ], 422);
            return;
        }

        $pdo = db();
        $pdo->beginTransaction();
        try {
            // Contagem com FOR UPDATE dentro da transação: dois
            // administradores desativando ao mesmo tempo as duas últimas
            // filiais não passam os dois por esta verificação.
            if ($inativando && $this->filiais->countAtivas($admin['id_loja'], true) <= 1) {
                $pdo->rollBack();
                Response::json(['erro' => 'A loja precisa ter pelo menos uma filial ativa.'], 422);
                return;
            }
            $this->filiais->update($id, $campos);
            $pdo->commit();
        } catch (\Throwable $e) {
            $pdo->rollBack();
            Response::json(['erro' => 'Não foi possível salvar a filial'], 500);
            return;
        }

        Response::json(['filial' => self::publica($this->filiais->findInLoja($id, $admin['id_loja']))]);
    }

    /**
     * @param array<string,mixed> $dados
     * Mesmos campos da tela Configurações da Loja (lojas), com os mesmos
     * limites das colunas — sem eles o MySQL truncaria ou estouraria.
     *
     * @return array{campos:array<string,?string>}|array{erro:string,status:int}
     */
    private function validar(array $dados, int $idLoja, ?int $idFilial): array
    {
        $nome = trim((string) preg_replace('/\s+/u', ' ', (string) ($dados['nome'] ?? '')));
        $cnpj = trim((string) ($dados['cnpj'] ?? ''));
        $status = (string) ($dados['status'] ?? 'ativa');

        $limites = [
            'telefone' => [15, 'Telefone'],
            'endereco' => [150, 'Endereço'],
            'cidade' => [60, 'Cidade'],
            'cep' => [10, 'CEP'],
        ];
        $opcionais = [];
        foreach ($limites as $campo => [$maximo, $rotulo]) {
            $valor = trim((string) ($dados[$campo] ?? ''));
            if (mb_strlen($valor) > $maximo) {
                return ['erro' => "$rotulo muito longo (máximo $maximo caracteres)", 'status' => 422];
            }
            $opcionais[$campo] = $valor !== '' ? $valor : null;
        }

        $estado = strtoupper(trim((string) ($dados['estado'] ?? '')));
        if ($estado !== '' && !preg_match('/^[A-Z]{2}$/', $estado)) {
            return ['erro' => 'Estado inválido: use a sigla com 2 letras (ex.: SP)', 'status' => 422];
        }
        $opcionais['estado'] = $estado !== '' ? $estado : null;

        if ($nome === '') {
            return ['erro' => 'Informe o nome da filial', 'status' => 422];
        }
        if (mb_strlen($nome) > 120) {
            return ['erro' => 'Nome muito longo (máximo 120 caracteres)', 'status' => 422];
        }
        if (!in_array($status, ['ativa', 'inativa'], true)) {
            return ['erro' => 'Status inválido', 'status' => 422];
        }

        // O CNPJ é gravado sempre no mesmo formato, para que a checagem de
        // duplicidade não seja driblada digitando com ou sem pontuação.
        if ($cnpj !== '') {
            $digitos = preg_replace('/\D/', '', $cnpj);
            if (strlen($digitos) !== 14) {
                return ['erro' => 'CNPJ inválido: ele precisa ter 14 números', 'status' => 422];
            }
            $cnpj = vsprintf('%s%s.%s%s%s.%s%s%s/%s%s%s%s-%s%s', str_split($digitos));
            if ($this->filiais->cnpjEmUso($cnpj, $idFilial)) {
                return ['erro' => 'Já existe uma filial com este CNPJ', 'status' => 409];
            }
        }

        if ($this->filiais->nomeEmUso($idLoja, $nome, $idFilial)) {
            return ['erro' => 'Já existe uma filial com este nome', 'status' => 409];
        }

        return [
            'campos' => [
                'nome' => $nome,
                'cnpj' => $cnpj !== '' ? $cnpj : null,
                'status' => $status,
            ] + $opcionais,
        ];
    }

    /** @param array<string,mixed> $filial */
    private static function publica(array $filial): array
    {
        return [
            'id_filial' => (int) $filial['id_filial'],
            'nome' => $filial['nome'],
            'cnpj' => $filial['cnpj'],
            'telefone' => $filial['telefone'],
            'endereco' => $filial['endereco'],
            'cidade' => $filial['cidade'],
            'estado' => $filial['estado'],
            'cep' => $filial['cep'],
            'status' => $filial['status'],
        ];
    }
}
