<?php

namespace Hydra\Support;

/** Integração mínima com a WhatsApp Cloud API oficial da Meta. */
final class WhatsApp
{
    /** @param array<int,string|int> $variaveis
     *  @return array{ok:bool,id_mensagem:?string,erro:?string}
     */
    public static function enviarTemplate(string $telefone, string $template, array $variaveis): array
    {
        $parametros = array_map(
            static fn ($valor): array => ['type' => 'text', 'text' => (string) $valor],
            array_values($variaveis)
        );
        return self::enviar($telefone, [
            'messaging_product' => 'whatsapp',
            'type' => 'template',
            'template' => [
                'name' => $template,
                'language' => ['code' => (string) Env::get('WHATSAPP_TEMPLATE_IDIOMA', 'pt_BR')],
                'components' => [[
                    'type' => 'body',
                    'parameters' => $parametros,
                ]],
            ],
        ]);
    }

    /** @return array{ok:bool,id_mensagem:?string,erro:?string} */
    public static function enviarTexto(string $telefone, string $texto): array
    {
        return self::enviar($telefone, [
            'messaging_product' => 'whatsapp',
            'type' => 'text',
            'text' => ['body' => $texto],
        ]);
    }

    public static function validarAssinatura(string $corpoBruto, ?string $cabecalho): bool
    {
        $segredo = Env::get('WHATSAPP_APP_SECRET');
        if ($segredo === null || $segredo === '' || $cabecalho === null
            || !preg_match('/^sha256=([a-f0-9]{64})$/i', $cabecalho, $matches)) {
            return false;
        }
        return hash_equals(hash_hmac('sha256', $corpoBruto, $segredo), strtolower($matches[1]));
    }

    /** Aceita celular brasileiro com DDD e retorna E.164 sem o sinal de +. */
    public static function normalizarTelefone(string $entrada): ?string
    {
        if (!preg_match('/^\+?[\d\s().-]+$/', trim($entrada))) {
            return null;
        }
        $digitos = preg_replace('/\D+/', '', $entrada);
        if (!is_string($digitos)) {
            return null;
        }
        if (strlen($digitos) === 13 && str_starts_with($digitos, '55')) {
            $digitos = substr($digitos, 2);
        }
        $ddd = substr($digitos, 0, 2);
        $dddsValidos = [
            '11', '12', '13', '14', '15', '16', '17', '18', '19',
            '21', '22', '24', '27', '28',
            '31', '32', '33', '34', '35', '37', '38',
            '41', '42', '43', '44', '45', '46', '47', '48', '49',
            '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68', '69',
            '71', '73', '74', '75', '77', '79',
            '81', '82', '83', '84', '85', '86', '87', '88', '89',
            '91', '92', '93', '94', '95', '96', '97', '98', '99',
        ];
        if (strlen($digitos) !== 11 || !in_array($ddd, $dddsValidos, true)
            || !preg_match('/^[0-9]{2}9[0-9]{8}$/', $digitos)) {
            return null;
        }
        return '55' . $digitos;
    }

    /** @param array<string,mixed> $payload
     *  @return array{ok:bool,id_mensagem:?string,erro:?string}
     */
    private static function enviar(string $telefone, array $payload): array
    {
        if (Env::get('WHATSAPP_ENABLED', 'false') !== 'true') {
            return self::falha('O envio por WhatsApp está desligado.');
        }
        $numero = self::normalizarTelefone($telefone);
        $versao = (string) Env::get('WHATSAPP_API_VERSION', 'v21.0');
        $phoneNumberId = (string) Env::get('WHATSAPP_PHONE_NUMBER_ID', '');
        $token = (string) Env::get('WHATSAPP_ACCESS_TOKEN', '');
        if ($numero === null) {
            return self::falha('O telefone precisa ser um celular brasileiro válido com DDD.');
        }
        if (!function_exists('curl_init')
            || !preg_match('/^v[0-9]+\.[0-9]+$/', $versao)
            || !preg_match('/^[0-9]+$/', $phoneNumberId)
            || $token === '') {
            return self::falha('A integração oficial do WhatsApp não está configurada.');
        }

        $payload['to'] = $numero;
        try {
            $corpo = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
            $curl = curl_init("https://graph.facebook.com/{$versao}/{$phoneNumberId}/messages");
            if ($curl === false) {
                return self::falha('Não foi possível iniciar o envio pelo WhatsApp.');
            }
            curl_setopt_array($curl, [
                CURLOPT_POST => true,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HTTPHEADER => [
                    'Authorization: Bearer ' . $token,
                    'Content-Type: application/json',
                    'Accept: application/json',
                ],
                CURLOPT_POSTFIELDS => $corpo,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT => 10,
            ]);
            $resposta = curl_exec($curl);
            $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            curl_close($curl);

            if (!is_string($resposta) || $status < 200 || $status >= 300) {
                return self::falha('A Meta não aceitou o envio da mensagem.');
            }
            $dados = json_decode($resposta, true);
            $idMensagem = is_array($dados) ? ($dados['messages'][0]['id'] ?? null) : null;
            if (!is_string($idMensagem) || $idMensagem === '') {
                return self::falha('A Meta não confirmou o envio da mensagem.');
            }
            return ['ok' => true, 'id_mensagem' => $idMensagem, 'erro' => null];
        } catch (\Throwable) {
            return self::falha('Não foi possível enviar a mensagem pelo WhatsApp.');
        }
    }

    /** @return array{ok:false,id_mensagem:null,erro:string} */
    private static function falha(string $erro): array
    {
        return ['ok' => false, 'id_mensagem' => null, 'erro' => $erro];
    }
}
