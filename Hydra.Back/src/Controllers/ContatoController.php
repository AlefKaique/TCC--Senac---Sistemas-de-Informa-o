<?php

namespace Hydra\Controllers;

use Hydra\Repositories\ContatoRepository;
use Hydra\Support\Request;
use Hydra\Support\Response;
use Hydra\Support\Validacao;
use PDOException;

/**
 * POST /api/contato — formulário "Entre em Contato" da página inicial.
 *
 * Rota pública: quem preenche ainda não tem conta. Tudo o que a tela valida
 * é validado de novo aqui, e os erros saem um por vez, com "campo", no mesmo
 * formato do cadastro, para a tela marcar o campo certo.
 *
 * Proteção contra abuso, sem depender do IP: atrás do proxy do Render o
 * Apache enxerga o IP do proxy, e não o do visitante (não há mod_remoteip),
 * então um limite por IP valeria para o site inteiro. No lugar dele:
 *   - campo-isca "site", invisível para pessoas: robôs que preenchem tudo
 *     recebem a resposta de sucesso, mas nada é gravado;
 *   - no máximo MAX_POR_EMAIL_HORA envios do mesmo e-mail por hora;
 *   - no máximo MAX_TOTAL_HORA envios por hora no total, um teto contra
 *     inundação da tabela.
 */
final class ContatoController
{
    private const MAX_POR_EMAIL_HORA = 3;
    private const MAX_TOTAL_HORA = 60;
    private const MAX_MENSAGEM = 1000;
    private const CONTATO_EQUIPE = 'Fale com a gente pelo WhatsApp (11) 95820-6969 ou pelo e-mail hydra.pdv@gmail.com.';

    public function enviar(): void
    {
        $dados = Request::json();

        if (self::texto($dados, 'site') !== '') {
            Response::json(['ok' => true], 201);
            return;
        }

        $nome = self::espacos(self::texto($dados, 'nome'));
        $email = mb_strtolower(self::texto($dados, 'email'));
        $telefone = self::texto($dados, 'telefone');
        $estabelecimento = self::espacos(self::texto($dados, 'estabelecimento'));
        $tipoComercio = self::texto($dados, 'tipo_comercio');
        $plano = self::texto($dados, 'plano_interesse');
        // Mantém as quebras de linha da mensagem, mas tira caracteres de
        // controle (que não aparecem na tela e só servem para confundir).
        $mensagem = (string) preg_replace(
            '/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/',
            '',
            str_replace("\r\n", "\n", self::texto($dados, 'mensagem'))
        );
        $aceite = ($dados['aceite_lgpd'] ?? false) === true;

        $erroNome = Validacao::erroNomePessoa($nome);
        if ($erroNome !== null) {
            self::erro($erroNome, 'nome');
            return;
        }
        if ($email === '') {
            self::erro('Informe o e-mail.', 'email');
            return;
        }
        if (mb_strlen($email) > 100 || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            self::erro('Informe um e-mail válido, por exemplo nome@email.com.', 'email');
            return;
        }

        $telefoneDigitos = null;
        if ($telefone !== '') {
            if (!Validacao::soMascaraNumerica($telefone) || !Validacao::telefoneValido($telefone)) {
                self::erro('Informe um telefone válido com DDD, por exemplo (11) 91234-5678.', 'telefone');
                return;
            }
            $telefoneDigitos = Validacao::soDigitos($telefone);
        }

        if (mb_strlen($estabelecimento) > 120) {
            self::erro('O nome do estabelecimento pode ter no máximo 120 caracteres.', 'estabelecimento');
            return;
        }
        if ($tipoComercio !== '' && !in_array($tipoComercio, ContatoRepository::TIPOS_COMERCIO, true)) {
            self::erro('Escolha um tipo de comércio da lista.', 'tipo_comercio');
            return;
        }
        if ($plano === '') {
            $plano = 'nao_sei';
        }
        if (!in_array($plano, ContatoRepository::PLANOS, true)) {
            self::erro('Escolha um plano da lista.', 'plano_interesse');
            return;
        }
        if (mb_strlen($mensagem) > self::MAX_MENSAGEM) {
            self::erro('A mensagem pode ter no máximo ' . self::MAX_MENSAGEM . ' caracteres.', 'mensagem');
            return;
        }
        if (!$aceite) {
            self::erro('Para enviar, marque que concorda com a Política de Privacidade.', 'aceite_lgpd');
            return;
        }

        $contatos = new ContatoRepository();
        try {
            if ($contatos->enviosRecentes(60, $email) >= self::MAX_POR_EMAIL_HORA) {
                Response::json([
                    'erro' => 'Já recebemos algumas mensagens deste e-mail na última hora. '
                        . 'Nossa equipe vai responder em breve. ' . self::CONTATO_EQUIPE,
                ], 429);
                return;
            }
            if ($contatos->enviosRecentes(60) >= self::MAX_TOTAL_HORA) {
                Response::json([
                    'erro' => 'Recebemos muitas mensagens agora. Tente de novo em alguns minutos. '
                        . self::CONTATO_EQUIPE,
                ], 429);
                return;
            }

            $contatos->criar([
                'nome' => $nome,
                'email' => $email,
                'telefone' => $telefoneDigitos,
                'estabelecimento' => $estabelecimento !== '' ? $estabelecimento : null,
                'tipo_comercio' => $tipoComercio !== '' ? $tipoComercio : null,
                'plano_interesse' => $plano,
                'mensagem' => $mensagem !== '' ? $mensagem : null,
            ]);
        } catch (PDOException $e) {
            if (self::tabelaInexistente($e)) {
                error_log('[Contato] A tabela "contatos" não existe. Rode Hydra.Back/sql/criar_tabela_contatos.sql.');
                Response::json([
                    'erro' => 'O formulário está temporariamente indisponível. ' . self::CONTATO_EQUIPE,
                    'codigo' => 'contato_indisponivel',
                ], 503);
                return;
            }
            throw $e;
        }

        Response::json(['ok' => true], 201);
    }

    private static function erro(string $mensagem, string $campo): void
    {
        Response::json(['erro' => $mensagem, 'campo' => $campo], 422);
    }

    /** Valor de texto do JSON, sem espaços nas pontas; qualquer outro tipo vira ''. */
    private static function texto(array $dados, string $campo): string
    {
        $valor = $dados[$campo] ?? '';
        return is_string($valor) ? trim($valor) : '';
    }

    /** Junta espaços repetidos (inclusive quebras de linha) em um só. */
    private static function espacos(string $valor): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', $valor));
    }

    /** SQLSTATE 42S02 = tabela não encontrada (o script SQL ainda não foi rodado). */
    private static function tabelaInexistente(PDOException $e): bool
    {
        return ($e->errorInfo[0] ?? null) === '42S02' || (string) $e->getCode() === '42S02';
    }
}
