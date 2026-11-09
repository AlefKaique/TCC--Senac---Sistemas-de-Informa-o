<?php

namespace Hydra\Controllers;

use Hydra\Repositories\AlertaEnviadoRepository;
use Hydra\Repositories\PreferenciaAlertaRepository;
use Hydra\Services\EnvioAlertas;
use Hydra\Support\Auth;
use Hydra\Support\Env;
use Hydra\Support\RateLimit;
use Hydra\Support\Request;
use Hydra\Support\Response;
use Hydra\Support\WhatsApp;
use InvalidArgumentException;

final class AlertaController
{
    public function preferencias(): void
    {
        $usuario = Auth::requirePermission('loja.configurar');
        $preferencia = (new PreferenciaAlertaRepository())->buscar((int) $usuario['id_usuario']);
        Response::json([
            'preferencias' => $preferencia ?? [
                'telefone_whatsapp' => null,
                'canal' => 'whatsapp',
                'consentimento' => 0,
                'consentimento_em' => null,
                'alerta_estoque' => 1,
                'alerta_validade' => 1,
                'dias_validade' => 7,
            ],
            'destinatarios' => (new PreferenciaAlertaRepository())->listarDestinatarios(
                (int) $usuario['id_usuario']
            ),
            'ultimos_envios' => (new AlertaEnviadoRepository())->ultimosDoUsuario((int) $usuario['id_usuario']),
        ]);
    }

    public function salvarPreferencias(): void
    {
        $usuario = Auth::requirePermission('loja.configurar');
        $dados = Request::json();
        $canal = $dados['canal'] ?? null;
        if (!is_string($canal) || !in_array($canal, ['whatsapp', 'email', 'ambos'], true)) {
            Response::json(['erro' => 'Escolha WhatsApp, e-mail ou os dois canais.'], 422);
            return;
        }

        $telefoneEntrada = $dados['telefone'] ?? '';
        if (!is_string($telefoneEntrada)) {
            Response::json(['erro' => 'Informe um telefone celular brasileiro válido com DDD.'], 422);
            return;
        }
        $telefoneEntrada = trim($telefoneEntrada);
        $telefone = $telefoneEntrada === '' ? null : WhatsApp::normalizarTelefone($telefoneEntrada);
        if ($telefoneEntrada !== '' && $telefone === null) {
            Response::json(['erro' => 'Telefone inválido. Use um celular brasileiro com DDD, como (11) 99999-8888.'], 422);
            return;
        }

        $consentimento = $this->booleano($dados['consentimento'] ?? false);
        $alertaEstoque = $this->booleano($dados['alerta_estoque'] ?? null);
        $alertaValidade = $this->booleano($dados['alerta_validade'] ?? null);
        if ($consentimento === null || $alertaEstoque === null || $alertaValidade === null) {
            Response::json(['erro' => 'Confira as opções de consentimento e os tipos de alerta.'], 422);
            return;
        }
        if ($consentimento && $telefone === null) {
            Response::json(['erro' => 'Informe um celular válido antes de aceitar os alertas por WhatsApp.'], 422);
            return;
        }
        $dias = filter_var($dados['dias_validade'] ?? null, FILTER_VALIDATE_INT);
        if (!in_array($dias, [3, 7, 15], true)) {
            Response::json(['erro' => 'Escolha o aviso de validade para 3, 7 ou 15 dias.'], 422);
            return;
        }

        (new PreferenciaAlertaRepository())->salvar((int) $usuario['id_usuario'], [
            'telefone' => $telefone,
            'canal' => $canal,
            'consentimento' => (int) $consentimento,
            'alerta_estoque' => (int) $alertaEstoque,
            'alerta_validade' => (int) $alertaValidade,
            'dias_validade' => $dias,
        ]);
        Response::json(['mensagem' => 'Preferências de alertas salvas.']);
    }

    public function teste(): void
    {
        $usuario = Auth::requirePermissionNaFilial('loja.configurar');
        RateLimit::requireDentroDaJanela((int) $usuario['id_usuario'], 3, 1);
        $preferenciaRepository = new PreferenciaAlertaRepository();
        $preferencia = $preferenciaRepository->buscar((int) $usuario['id_usuario']);
        if ($preferencia === null) {
            Response::json(['erro' => 'Salve as preferências de alertas antes de enviar o teste.'], 422);
            return;
        }
        $destinatarios = $preferenciaRepository->listarDestinatariosAptos((int) $usuario['id_usuario']);
        if (in_array($preferencia['canal'], ['whatsapp', 'ambos'], true) && $destinatarios === []) {
            Response::json(['erro' => 'Adicione ao menos um telefone com consentimento antes de testar o WhatsApp.'], 422);
            return;
        }

        try {
            $resultado = (new EnvioAlertas())->enviarTeste(
                $usuario,
                (int) $usuario['id_filial'],
                $preferencia,
                $destinatarios
            );
        } catch (InvalidArgumentException $e) {
            Response::json(['erro' => $e->getMessage()], 422);
            return;
        }
        if (!$resultado['whatsapp'] && !$resultado['email']) {
            Response::json(['erro' => 'Não foi possível enviar o teste por nenhum canal. Confira a configuração do WhatsApp ou do e-mail.'], 502);
            return;
        }
        Response::json([
            'mensagem' => $resultado['whatsapp']
                ? 'Mensagem de teste enviada pelo WhatsApp.'
                : 'Teste enviado por e-mail. O WhatsApp está indisponível ou não aceitou o envio.',
            'resultado' => $resultado,
        ]);
    }

    public function adicionarDestinatario(): void
    {
        $usuario = Auth::requirePermission('loja.configurar');
        $dados = Request::json();
        $telefoneEntrada = $dados['telefone'] ?? null;
        $consentimento = $this->booleano($dados['consentimento'] ?? null);
        if (!is_string($telefoneEntrada) || $consentimento !== true) {
            Response::json([
                'erro' => 'Informe o celular e confirme que a pessoa autorizou receber os alertas.',
            ], 422);
            return;
        }
        $telefone = WhatsApp::normalizarTelefone($telefoneEntrada);
        if ($telefone === null) {
            Response::json([
                'erro' => 'Telefone inválido. Use um celular brasileiro com DDD, como (11) 99999-8888.',
            ], 422);
            return;
        }

        $repositorio = new PreferenciaAlertaRepository();
        $repositorio->adicionarDestinatario(
            (int) $usuario['id_usuario'],
            (int) $usuario['id_loja'],
            $telefone
        );
        Response::json([
            'mensagem' => 'Telefone adicionado aos alertas.',
            'destinatarios' => $repositorio->listarDestinatarios((int) $usuario['id_usuario']),
        ], 201);
    }

    public function removerDestinatario(int $id): void
    {
        $usuario = Auth::requirePermission('loja.configurar');
        if ($id < 1) {
            Response::json(['erro' => 'Telefone de alerta inválido.'], 422);
            return;
        }
        $repositorio = new PreferenciaAlertaRepository();
        if (!$repositorio->removerDestinatario((int) $usuario['id_usuario'], $id)) {
            Response::json(['erro' => 'Esse telefone não foi encontrado na sua lista de alertas.'], 404);
            return;
        }
        Response::json([
            'mensagem' => 'Telefone removido dos alertas.',
            'destinatarios' => $repositorio->listarDestinatarios((int) $usuario['id_usuario']),
        ]);
    }

    public function disparar(): void
    {
        $esperado = Env::get('ALERTAS_CRON_TOKEN');
        $recebido = $_SERVER['HTTP_X_CRON_TOKEN'] ?? '';
        if ($esperado === null || $esperado === '' || !is_string($recebido)
            || !hash_equals($esperado, $recebido)) {
            Response::json(['erro' => 'Não autorizado.'], 401);
            return;
        }

        $dados = Request::json();
        $data = $dados['data'] ?? null;
        if ($data !== null && !is_string($data)) {
            Response::json(['erro' => 'A data deve estar no formato AAAA-MM-DD.'], 422);
            return;
        }
        try {
            Response::json((new EnvioAlertas())->executar($data));
        } catch (InvalidArgumentException $e) {
            Response::json(['erro' => $e->getMessage()], 422);
        }
    }

    public function verificarWebhook(): void
    {
        $modo = $_GET['hub.mode'] ?? $_GET['hub_mode'] ?? '';
        $token = $_GET['hub.verify_token'] ?? $_GET['hub_verify_token'] ?? '';
        $desafio = $_GET['hub.challenge'] ?? $_GET['hub_challenge'] ?? '';
        $esperado = Env::get('WHATSAPP_VERIFY_TOKEN');
        if ($modo !== 'subscribe' || !is_string($token) || $esperado === null || $esperado === ''
            || !hash_equals($esperado, $token) || !is_string($desafio)) {
            http_response_code(403);
            header('Content-Type: text/plain; charset=utf-8');
            echo 'Forbidden';
            return;
        }
        http_response_code(200);
        header('Content-Type: text/plain; charset=utf-8');
        echo $desafio;
    }

    public function webhook(): void
    {
        $corpoBruto = file_get_contents('php://input') ?: '';
        if (!WhatsApp::validarAssinatura($corpoBruto, $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? null)) {
            Response::json(['erro' => 'Assinatura do webhook inválida.'], 401);
            return;
        }
        $payload = json_decode($corpoBruto, true);
        if (!is_array($payload)) {
            Response::json(['status' => 'ok']);
            return;
        }
        Response::depoisDaResposta(function () use ($payload): void {
            $repositorio = new AlertaEnviadoRepository();
            foreach (($payload['entry'] ?? []) as $entrada) {
                foreach (($entrada['changes'] ?? []) as $mudanca) {
                    $valor = $mudanca['value'] ?? [];
                    foreach (($valor['statuses'] ?? []) as $status) {
                        $mapeamento = [
                            'delivered' => 'entregue',
                            'read' => 'lido',
                            'failed' => 'falhou',
                        ];
                        $id = $status['id'] ?? null;
                        $novoStatus = $mapeamento[$status['status'] ?? ''] ?? null;
                        if (is_string($id) && $novoStatus !== null) {
                            $repositorio->atualizarStatusPorMensagem($id, $novoStatus);
                        }
                    }
                    foreach (($valor['messages'] ?? []) as $mensagem) {
                        $texto = $mensagem['text']['body'] ?? '';
                        $telefone = WhatsApp::normalizarTelefone((string) ($mensagem['from'] ?? ''));
                        if (!is_string($texto) || $telefone === null || !$this->ehSair($texto)) {
                            continue;
                        }
                        (new PreferenciaAlertaRepository())->desativarPorTelefone($telefone);
                        WhatsApp::enviarTexto(
                            $telefone,
                            'Pronto, você não vai mais receber alertas do Hydra por aqui. Para voltar, ative em Configurações da Loja.'
                        );
                    }
                }
            }
        });
        Response::json(['status' => 'ok']);
    }

    private function ehSair(string $texto): bool
    {
        $texto = trim($texto);
        $semAcento = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $texto);
        return is_string($semAcento) && strtolower($semAcento) === 'sair';
    }

    private function booleano(mixed $valor): ?bool
    {
        if (is_bool($valor)) {
            return $valor;
        }
        if ($valor === 0 || $valor === 1) {
            return $valor === 1;
        }
        return null;
    }
}
