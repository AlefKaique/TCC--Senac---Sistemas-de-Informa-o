(function () {
    'use strict';

    function normalizar(valor) {
        return String(valor || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    }

    function validoLocal(valor) {
        const cnpj = normalizar(valor);
        if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
        const valores = [...cnpj].map((caractere) => caractere.charCodeAt(0) - 48);
        const calcularDigito = (posicao) => {
            const pesos = posicao === 12
                ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
                : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
            const soma = pesos.reduce((total, peso, indice) => total + valores[indice] * peso, 0);
            const resto = soma % 11;
            return resto < 2 ? 0 : 11 - resto;
        };
        return calcularDigito(12) === valores[12] && calcularDigito(13) === valores[13];
    }

    async function consultarBrasilApi(valor) {
        const cnpj = normalizar(valor);
        if (!validoLocal(cnpj)) {
            throw new Error('CNPJ inválido. Confira os 14 caracteres e os dígitos verificadores.');
        }
        if (/[A-Z]/.test(cnpj)) {
            return {
                consultado: false,
                mensagem: 'CNPJ alfanumérico válido pelo cálculo dos dígitos. A BrasilAPI ainda consulta apenas CNPJs numéricos.',
            };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let resposta;
        try {
            resposta = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
        } catch (erro) {
            if (erro && erro.name === 'AbortError') {
                throw new Error('A consulta do CNPJ à BrasilAPI expirou. Tente novamente.');
            }
            throw new Error('Não foi possível consultar a BrasilAPI. Verifique a conexão e tente novamente.');
        } finally {
            clearTimeout(timeout);
        }

        if (resposta.status === 404) {
            throw new Error('CNPJ não encontrado na consulta da BrasilAPI.');
        }
        if (!resposta.ok) {
            throw new Error(`A BrasilAPI não conseguiu validar o CNPJ (HTTP ${resposta.status}). Tente novamente.`);
        }

        let dados;
        try {
            dados = await resposta.json();
        } catch {
            throw new Error('A BrasilAPI retornou uma resposta inválida. Tente novamente.');
        }
        if (!dados || normalizar(dados.cnpj) !== cnpj) {
            throw new Error('A BrasilAPI não confirmou o mesmo CNPJ consultado.');
        }
        return {
            consultado: true,
            situacao: String(dados.descricao_situacao_cadastral || '').trim(),
        };
    }

    /* Consultas em andamento, por CNPJ. Ao clicar em "Salvar" logo depois
       de digitar o CNPJ, o blur do campo e o submit do formulário pediam a
       mesma consulta ao mesmo tempo (até 8 s cada); agora os dois esperam a
       mesma requisição. A entrada sai do mapa quando a consulta termina. */
    const emAndamento = new Map();

    function consultarBrasilApiCompartilhado(valor) {
        const cnpj = normalizar(valor);
        if (emAndamento.has(cnpj)) return emAndamento.get(cnpj);
        const consulta = consultarBrasilApi(cnpj).finally(() => emAndamento.delete(cnpj));
        emAndamento.set(cnpj, consulta);
        return consulta;
    }

    window.hydraCnpj = { normalizar, validoLocal, consultarBrasilApi: consultarBrasilApiCompartilhado };
})();
