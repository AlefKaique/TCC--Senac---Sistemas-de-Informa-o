<?php

namespace Hydra\Support;

final class Response
{
    /** @var callable[] Tarefas que rodam depois que o navegador recebe a resposta. */
    private static array $depoisDaResposta = [];

    /**
     * Agenda uma tarefa lenta (ex.: envio de e-mail pelo Brevo) para DEPOIS
     * da resposta. Antes o cadastro e o login esperavam a chamada HTTP ao
     * Brevo terminar (até 10 s) para só então devolver a resposta à tela.
     */
    public static function depoisDaResposta(callable $tarefa): void
    {
        self::$depoisDaResposta[] = $tarefa;
    }

    public static function json(array $data, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        $corpo = (string) json_encode($data, JSON_UNESCAPED_UNICODE);

        if (self::$depoisDaResposta === []) {
            echo $corpo;
            return;
        }

        self::encerrarConexao($corpo);

        $tarefas = self::$depoisDaResposta;
        self::$depoisDaResposta = [];
        foreach ($tarefas as $tarefa) {
            try {
                $tarefa();
            } catch (\Throwable $e) {
                error_log('[Response] Tarefa após a resposta falhou: ' . $e->getMessage());
            }
        }
    }

    /**
     * Entrega a resposta completa e fecha a conexão, deixando o script
     * continuar rodando. Content-Length diz ao navegador (e ao proxy do
     * Render) onde a resposta termina; sem ele, o navegador esperaria o
     * script inteiro acabar.
     */
    private static function encerrarConexao(string $corpo): void
    {
        ignore_user_abort(true);
        // A sessão não é mais escrita depois daqui; liberar a trava evita
        // segurar outras requisições do mesmo navegador durante a tarefa.
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        // mod_deflate do Apache comprimiria o corpo e descartaria o
        // Content-Length, e o navegador voltaria a esperar o fim do script.
        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        header('Content-Length: ' . strlen($corpo));
        header('Connection: close');
        echo $corpo;
        flush();
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        }
    }
}
