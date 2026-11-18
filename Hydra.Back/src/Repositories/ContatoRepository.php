<?php

namespace Hydra\Repositories;

/**
 * Mensagens do formulário "Entre em Contato" da página inicial.
 *
 * Diferente das tabelas criadas por Migracoes, a tabela "contatos" NÃO é
 * criada sozinha: o script fica em sql/criar_tabela_contatos.sql para ser
 * revisado e executado à mão. Sem ela, os métodos daqui lançam
 * PDOException com SQLSTATE 42S02, e o ContatoController responde com uma
 * mensagem amigável.
 */
final class ContatoRepository
{
    /** Valores do campo "Tipo de comércio" (ENUM da coluna tipo_comercio). */
    public const TIPOS_COMERCIO = ['mercado', 'padaria', 'hortifruti', 'outro'];

    /** Valores do campo "Plano de interesse"; "nao_sei" = "Ainda não sei". */
    public const PLANOS = ['nao_sei', 'start', 'flex', 'premium'];

    /** Contatos recebidos nos últimos $minutos: de um e-mail ou, sem e-mail, de todos. */
    public function enviosRecentes(int $minutos, ?string $email = null): int
    {
        $minutos = max(1, $minutos);
        $sql = "SELECT COUNT(*) FROM contatos WHERE criado_em > DATE_SUB(NOW(), INTERVAL {$minutos} MINUTE)";
        $params = [];
        if ($email !== null) {
            $sql .= ' AND email = :email';
            $params['email'] = $email;
        }

        $stmt = db()->prepare($sql);
        $stmt->execute($params);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Grava um contato já validado pelo controller. aceite_lgpd é sempre 1:
     * o controller recusa o envio sem o aceite.
     *
     * @param array{nome:string,email:string,telefone:?string,estabelecimento:?string,
     *              tipo_comercio:?string,plano_interesse:string,mensagem:?string} $contato
     */
    public function criar(array $contato): int
    {
        $stmt = db()->prepare(
            'INSERT INTO contatos
                (nome, email, telefone, estabelecimento, tipo_comercio, plano_interesse, mensagem, aceite_lgpd)
             VALUES
                (:nome, :email, :telefone, :estabelecimento, :tipo_comercio, :plano_interesse, :mensagem, 1)'
        );
        $stmt->execute([
            'nome' => $contato['nome'],
            'email' => $contato['email'],
            'telefone' => $contato['telefone'],
            'estabelecimento' => $contato['estabelecimento'],
            'tipo_comercio' => $contato['tipo_comercio'],
            'plano_interesse' => $contato['plano_interesse'],
            'mensagem' => $contato['mensagem'],
        ]);
        return (int) db()->lastInsertId();
    }
}
