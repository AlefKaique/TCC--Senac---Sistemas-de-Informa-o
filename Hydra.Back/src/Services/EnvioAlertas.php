<?php

namespace Hydra\Services;

use Hydra\Repositories\AlertaEnviadoRepository;
use Hydra\Repositories\FilialRepository;
use Hydra\Repositories\PreferenciaAlertaRepository;
use Hydra\Support\Env;
use Hydra\Support\Mailer;
use Hydra\Support\WhatsApp;
use InvalidArgumentException;

final class EnvioAlertas
{
    private PreferenciaAlertaRepository $preferencias;
    private AlertaEnviadoRepository $enviados;
    private ResumoAlertas $resumo;

    public function __construct()
    {
        $this->preferencias = new PreferenciaAlertaRepository();
        $this->enviados = new AlertaEnviadoRepository();
        $this->resumo = new ResumoAlertas();
    }

    /** @return array{data_referencia:string,enviados:int,pulados:int,falhas:int} */
    public function executar(?string $data = null): array
    {
        $timezone = new \DateTimeZone('America/Sao_Paulo');
        $data ??= (new \DateTimeImmutable('now', $timezone))->format('Y-m-d');
        $dataObjeto = \DateTimeImmutable::createFromFormat('!Y-m-d', $data, $timezone);
        if (!$dataObjeto || $dataObjeto->format('Y-m-d') !== $data) {
            throw new InvalidArgumentException('A data deve estar no formato AAAA-MM-DD.');
        }

        $resultado = ['data_referencia' => $data, 'enviados' => 0, 'pulados' => 0, 'falhas' => 0];
        foreach ($this->preferencias->listarAptosParaEnvio() as $destinatario) {
            $resumo = $this->resumo->porFilial(
                (int) $destinatario['id_filial'],
                $data,
                (int) $destinatario['dias_validade'],
                (bool) $destinatario['alerta_estoque'],
                (bool) $destinatario['alerta_validade']
            );
            if ($resumo['qtd_estoque'] === 0 && $resumo['qtd_validade'] === 0) {
                $resultado['pulados']++;
                continue;
            }

            $canal = (string) $destinatario['canal'];
            $querWhatsapp = in_array($canal, ['whatsapp', 'ambos'], true);
            $querEmail = in_array($canal, ['email', 'ambos'], true);
            $whatsappAtivo = Env::get('WHATSAPP_ENABLED', 'false') === 'true';
            $falhouWhatsapp = false;

            if ($querWhatsapp && $whatsappAtivo) {
                $contatos = $this->preferencias->listarDestinatariosAptos((int) $destinatario['id_usuario']);
                if ($contatos === []) {
                    $resultado['pulados']++;
                    $falhouWhatsapp = true;
                } else {
                    $enviouContato = false;
                    foreach ($contatos as $contato) {
                        $envio = $this->enviarWhatsappDiario($destinatario, $resumo, $data, $contato);
                        if ($envio === 'enviado') {
                            $resultado['enviados']++;
                            $enviouContato = true;
                        } elseif ($envio === 'falhou') {
                            $resultado['falhas']++;
                            $falhouWhatsapp = true;
                        }
                    }
                    if (!$enviouContato && !$falhouWhatsapp) {
                        $resultado['pulados']++;
                    }
                }
            } elseif ($querWhatsapp) {
                // Com a integração desligada, não há chamada à Meta; o resumo
                // segue pelo canal alternativo previsto para desenvolvimento.
                $falhouWhatsapp = true;
            }

            if ($querEmail || ($querWhatsapp && (!$whatsappAtivo || $falhouWhatsapp))) {
                $envioEmail = $this->enviarEmailDiario($destinatario, $resumo, $data);
                if ($envioEmail === 'enviado') {
                    $resultado['enviados']++;
                } elseif ($envioEmail === 'falhou') {
                    $resultado['falhas']++;
                } else {
                    $resultado['pulados']++;
                }
            }

            if (!$querWhatsapp && !$querEmail) {
                $resultado['pulados']++;
            }
        }
        return $resultado;
    }

    /**
     * Dispara um teste sem gravar no histórico diário. O chamador já aplicou
     * a permissão, a filial ativa e o limite de frequência.
     *
     * @param array<string,mixed> $usuario
     * @param array<string,mixed> $preferencia
     * @param array<int,array<string,mixed>> $destinatarios
     * @return array{whatsapp:bool,email:bool}
     */
    public function enviarTeste(array $usuario, int $idFilial, array $preferencia, array $destinatarios): array
    {
        $filial = (new FilialRepository())->findInLoja($idFilial, (int) $usuario['id_loja']);
        if ($filial === null || $filial['status'] !== 'ativa') {
            throw new InvalidArgumentException('A filial ativa não está disponível.');
        }
        $data = (new \DateTimeImmutable('now', new \DateTimeZone('America/Sao_Paulo')))->format('Y-m-d');
        $resumo = $this->resumo->porFilial(
            $idFilial,
            $data,
            (int) $preferencia['dias_validade'],
            (bool) $preferencia['alerta_estoque'],
            (bool) $preferencia['alerta_validade']
        );
        $canal = (string) $preferencia['canal'];
        $whatsapp = false;
        $email = false;
        $querWhatsapp = in_array($canal, ['whatsapp', 'ambos'], true)
            && Env::get('WHATSAPP_ENABLED', 'false') === 'true';
        $querEmail = in_array($canal, ['email', 'ambos'], true);

        if ($querWhatsapp) {
            foreach ($destinatarios as $destinatario) {
                $resultado = WhatsApp::enviarTemplate(
                    (string) $destinatario['telefone_whatsapp'],
                    (string) Env::get('WHATSAPP_TEMPLATE_RESUMO', 'hydra_resumo_diario'),
                    $this->variaveisTemplate($usuario, $filial['nome'], $resumo)
                );
                $whatsapp = $resultado['ok'] || $whatsapp;
            }
        }
        if ($querEmail || (!$whatsapp && in_array($canal, ['whatsapp', 'ambos'], true))) {
            $email = $this->enviarEmail($usuario, $filial['nome'], $resumo);
        }
        return ['whatsapp' => $whatsapp, 'email' => $email];
    }

    /** @param array<string,mixed> $destinatario
     *  @param array<string,mixed> $resumo
     */
    private function enviarWhatsappDiario(
        array $destinatario,
        array $resumo,
        string $data,
        array $contato
    ): string {
        $idDestinatario = (int) $contato['id_destinatario'];
        $dados = $this->dadosRegistro($destinatario, $resumo, $data, 'whatsapp', $idDestinatario);
        if (!$this->enviados->registrar($dados)) {
            return 'pulado';
        }
        $resultado = WhatsApp::enviarTemplate(
            (string) $contato['telefone_whatsapp'],
            (string) Env::get('WHATSAPP_TEMPLATE_RESUMO', 'hydra_resumo_diario'),
            $this->variaveisTemplate($destinatario, (string) $destinatario['nome_filial'], $resumo)
        );
        $this->enviados->atualizarResultado(
            (int) $destinatario['id_usuario'],
            (int) $destinatario['id_filial'],
            $data,
            'whatsapp',
            $idDestinatario,
            $resultado['ok'] ? 'enviado' : 'falhou',
            $resultado['id_mensagem'],
            $resultado['erro']
        );
        return $resultado['ok'] ? 'enviado' : 'falhou';
    }

    /** @param array<string,mixed> $destinatario
     *  @param array<string,mixed> $resumo
     */
    private function enviarEmailDiario(array $destinatario, array $resumo, string $data): string
    {
        $dados = $this->dadosRegistro($destinatario, $resumo, $data, 'email');
        if (!$this->enviados->registrar($dados)) {
            return 'pulado';
        }
        $ok = $this->enviarEmail($destinatario, (string) $destinatario['nome_filial'], $resumo);
        $this->enviados->atualizarResultado(
            (int) $destinatario['id_usuario'],
            (int) $destinatario['id_filial'],
            $data,
            'email',
            0,
            $ok ? 'enviado' : 'falhou',
            null,
            $ok ? null : 'Não foi possível enviar o e-mail.'
        );
        return $ok ? 'enviado' : 'falhou';
    }

    /** @param array<string,mixed> $destinatario
     *  @param array<string,mixed> $resumo
     *  @return array<string,int|string>
     */
    private function dadosRegistro(
        array $destinatario,
        array $resumo,
        string $data,
        string $canal,
        int $idDestinatario = 0
    ): array
    {
        return [
            'id_usuario' => (int) $destinatario['id_usuario'],
            'id_loja' => (int) $destinatario['id_loja'],
            'id_filial' => (int) $destinatario['id_filial'],
            'data' => $data,
            'canal' => $canal,
            'id_destinatario_alerta' => $idDestinatario,
            'qtd_estoque' => $resumo['qtd_estoque'],
            'qtd_validade' => $resumo['qtd_validade'],
        ];
    }

    /** @param array<string,mixed> $usuario
     *  @param array<string,mixed> $resumo
     *  @return array<int,string|int>
     */
    private function variaveisTemplate(array $usuario, string $nomeFilial, array $resumo): array
    {
        return [
            (string) $usuario['nome'],
            $nomeFilial,
            (int) $resumo['qtd_estoque'],
            (int) $resumo['qtd_validade'],
            $this->linkEstoque(),
        ];
    }

    /** @param array<string,mixed> $usuario
     *  @param array<string,mixed> $resumo
     */
    private function enviarEmail(array $usuario, string $nomeFilial, array $resumo): bool
    {
        $escape = static fn (string $valor): string => htmlspecialchars($valor, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $lista = static function (array $nomes) use ($escape): string {
            if ($nomes === []) {
                return '<li>Nenhum produto.</li>';
            }
            return implode('', array_map(
                static fn ($nome): string => '<li>' . $escape((string) $nome) . '</li>',
                $nomes
            ));
        };
        $url = $escape($this->linkEstoque());
        $html = '<p>Olá, ' . $escape((string) $usuario['nome']) . '.</p>'
            . '<p>Resumo da filial <strong>' . $escape($nomeFilial) . '</strong>:</p>'
            . '<h3>Estoque abaixo do mínimo (' . (int) $resumo['qtd_estoque'] . ')</h3><ul>'
            . $lista($resumo['nomes_estoque']) . '</ul>'
            . '<h3>Produtos vencendo ou vencidos (' . (int) $resumo['qtd_validade'] . ')</h3><ul>'
            . $lista($resumo['nomes_validade']) . '</ul>'
            . '<p><a href="' . $url . '">Abrir controle de estoque</a></p>';
        $assunto = 'Resumo diário de estoque e validade — ' . $nomeFilial;
        return Mailer::send((string) $usuario['email'], $assunto, $html);
    }

    private function linkEstoque(): string
    {
        return rtrim((string) Env::get('APP_URL', 'http://localhost:5500/Hydra.Front'), '/')
            . '/pages/controle-estoque.html';
    }
}
