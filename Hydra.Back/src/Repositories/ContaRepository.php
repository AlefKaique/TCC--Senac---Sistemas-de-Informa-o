<?php

namespace Hydra\Repositories;

use Hydra\Support\Migracoes;

/**
 * "Cancelar Conta" na tela Privacidade (só o titular): desativa a loja e
 * anonimiza os dados pessoais, mantendo vendas, estoque e movimentações.
 *
 * O que muda, numa transação só:
 *   - todos os usuários da loja ficam inativos, com nome e e-mail trocados
 *     por valores genéricos e senha aleatória — ninguém entra mais, e o
 *     e-mail do titular fica livre para um cadastro novo;
 *   - loja e filiais perdem nome, CNPJ, telefone, endereço e logo, e ficam
 *     inativas (a equipe Hydra não consegue reativar: "reativar" só vale
 *     para mercado suspenso);
 *   - clientes perdem nome, CPF, e-mail e telefone;
 *   - saem os telefones dos alertas, a conexão Mercado Pago do mercado e o
 *     histórico de tentativas de login pelos e-mails da loja;
 *   - cobranças Pix e checkouts de assinatura pendentes são cancelados.
 *
 * Vendas, itens, pagamentos e movimentações continuam no banco, agora
 * apontando para usuários anonimizados.
 */
final class ContaRepository
{
    public function __construct()
    {
        // Tabelas e colunas tocadas por encerrar(), em bancos já em uso.
        // Antes da transação: DDL faz commit implícito.
        Migracoes::garantirAssinaturas();
        Migracoes::garantirCancelamentoDeVendas(); // usuarios.senha_autorizacao
        Migracoes::garantirAlertasWhatsApp();      // telefones dos alertas
        Migracoes::garantirAdminsPlataforma();     // lojas.motivo_status, auditoria_plataforma
        new MercadoPagoRepository();                // mercadopago_contas, pagamentos_pix_pendentes
    }

    public function encerrar(int $idLoja, int $idTitular): void
    {
        // Colunas/tabelas que bancos muito antigos podem não ter.
        $temLogo = $this->colunaExiste('lojas', 'logo');
        $temClientes = $this->tabelaExiste('clientes');
        $senhaInutilizavel = password_hash(bin2hex(random_bytes(32)), PASSWORD_BCRYPT);

        $pdo = db();
        $pdo->beginTransaction();
        try {
            $pdo->prepare('SELECT id_loja FROM lojas WHERE id_loja = :id_loja FOR UPDATE')
                ->execute(['id_loja' => $idLoja]);

            // Contadores de tentativa de login/código/recuperação ficam
            // guardados pelo e-mail ("login:fulano@loja.com").
            $stmt = $pdo->prepare('SELECT email FROM usuarios WHERE id_loja = :id_loja');
            $stmt->execute(['id_loja' => $idLoja]);
            $chaves = ['encerrar:' . $idTitular];
            foreach ($stmt->fetchAll(\PDO::FETCH_COLUMN) as $email) {
                foreach (['login', 'envio', 'codigo', 'reset'] as $acao) {
                    $chaves[] = $acao . ':' . strtolower((string) $email);
                }
            }
            $marcadores = implode(',', array_fill(0, count($chaves), '?'));
            $pdo->prepare("DELETE FROM tentativas_acesso WHERE chave IN ($marcadores)")->execute($chaves);

            $pdo->prepare('DELETE FROM destinatarios_alerta WHERE id_loja = :id_loja')
                ->execute(['id_loja' => $idLoja]);
            $pdo->prepare(
                'DELETE p FROM preferencias_alerta p
                   JOIN usuarios u ON u.id_usuario = p.id_usuario
                  WHERE u.id_loja = :id_loja'
            )->execute(['id_loja' => $idLoja]);
            $pdo->prepare(
                'DELETE l FROM limites_testes_alertas l
                   JOIN usuarios u ON u.id_usuario = l.id_usuario
                  WHERE u.id_loja = :id_loja'
            )->execute(['id_loja' => $idLoja]);

            $pdo->prepare('DELETE FROM mercadopago_contas WHERE id_loja = :id_loja')
                ->execute(['id_loja' => $idLoja]);
            $pdo->prepare(
                "UPDATE pagamentos_pix_pendentes
                    SET status = 'cancelado', qr_code = NULL, qr_code_base64 = NULL, ticket_url = NULL
                  WHERE id_loja = :id_loja AND status IN ('criando', 'pendente')"
            )->execute(['id_loja' => $idLoja]);
            $pdo->prepare(
                "UPDATE assinatura_pagamentos
                    SET status = 'cancelado'
                  WHERE id_loja = :id_loja AND status IN ('criando', 'pendente')"
            )->execute(['id_loja' => $idLoja]);

            if ($temClientes) {
                $pdo->prepare(
                    "UPDATE clientes
                        SET nome = 'Cliente removido', cpf = NULL, email = NULL, telefone = NULL,
                            consentimento_cpf = 0
                      WHERE id_loja = :id_loja"
                )->execute(['id_loja' => $idLoja]);
            }

            // O e-mail é UNIQUE: o id do usuário mantém cada valor único.
            $pdo->prepare(
                "UPDATE usuarios
                    SET nome = 'Usuário removido',
                        email = CONCAT('removido-', id_usuario, '@conta-encerrada.invalid'),
                        senha = :senha,
                        status = 'inativo',
                        reset_token = NULL, reset_token_expira_em = NULL,
                        codigo_acesso = NULL, codigo_acesso_expira_em = NULL,
                        senha_autorizacao = NULL
                  WHERE id_loja = :id_loja"
            )->execute(['senha' => $senhaInutilizavel, 'id_loja' => $idLoja]);

            // (id_loja, nome) é UNIQUE: o sufixo com o id evita colisão com
            // uma filial que já se chamasse, por acaso, "Filial 3".
            $pdo->prepare(
                "UPDATE filiais
                    SET nome = CONCAT('Filial encerrada #', id_filial),
                        cnpj = NULL, telefone = NULL, endereco = NULL,
                        cidade = NULL, estado = NULL, cep = NULL,
                        status = 'inativa'
                  WHERE id_loja = :id_loja"
            )->execute(['id_loja' => $idLoja]);

            $pdo->prepare(
                "UPDATE lojas
                    SET nome_loja = CONCAT('Conta encerrada #', id_loja),
                        cnpj = NULL, telefone = NULL, endereco = NULL,
                        cidade = NULL, estado = NULL, cep = NULL,"
                . ($temLogo ? ' logo = NULL,' : '') . "
                        status = 'inativa',
                        motivo_status = 'Conta encerrada pelo titular',
                        status_alterado_em = NOW(),
                        conta_encerrada_em = NOW(),
                        assinatura_cancelada_em = IF(plano <> 'start' AND assinatura_cancelada_em IS NULL,
                                                     NOW(), assinatura_cancelada_em)
                  WHERE id_loja = :id_loja"
            )->execute(['id_loja' => $idLoja]);

            $pdo->prepare(
                "INSERT INTO auditoria_plataforma (id_admin, acao, id_loja, detalhe, ip)
                 VALUES (NULL, 'conta_encerrada_titular', :id_loja, :detalhe, :ip)"
            )->execute([
                'id_loja' => $idLoja,
                'detalhe' => 'Conta encerrada pelo titular; dados pessoais anonimizados e acessos bloqueados',
                'ip' => $_SERVER['REMOTE_ADDR'] ?? null,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    private function colunaExiste(string $tabela, string $coluna): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela AND COLUMN_NAME = :coluna'
        );
        $stmt->execute(['tabela' => $tabela, 'coluna' => $coluna]);
        return (bool) $stmt->fetchColumn();
    }

    private function tabelaExiste(string $tabela): bool
    {
        $stmt = db()->prepare(
            'SELECT 1 FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tabela'
        );
        $stmt->execute(['tabela' => $tabela]);
        return (bool) $stmt->fetchColumn();
    }
}
