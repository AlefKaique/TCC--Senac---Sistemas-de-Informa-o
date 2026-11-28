/**
 * Assistente da primeira filial (pages/primeira-filial.html).
 *
 * A conta nasce sem filial. Enquanto a loja não tiver nenhuma, o login do
 * Administrador responde "configurar_filial" (login.js manda para cá) e
 * qualquer tela do sistema também redireciona para cá (trocar-filial.js).
 *
 * As etapas são <section data-etapa> mostradas uma por vez. A filial só é
 * gravada no fim (POST /api/filiais), e o back-end já a deixa ativa na
 * sessão, então o botão final leva direto para o sistema.
 */
(function () {
    'use strict';

    const form = document.getElementById('pfForm');
    if (!form) return;

    const $ = (id) => document.getElementById(id);
    const campos = {
        nome: $('pfNome'),
        cnpj: $('pfCnpj'),
        telefone: $('pfTelefone'),
        cep: $('pfCep'),
        endereco: $('pfEndereco'),
        cidade: $('pfCidade'),
        estado: $('pfEstado'),
        importar: $('pfImportarHortifruti'),
    };
    const el = {
        carregando: $('pfCarregando'),
        progresso: $('pfProgresso'),
        progressoTexto: $('pfProgressoTexto'),
        progressoBarra: document.querySelector('.pf-progresso__barra'),
        progressoPreenchido: $('pfProgressoPreenchido'),
        erro: $('pfErro'),
        acoes: $('pfAcoes'),
        voltar: $('pfVoltar'),
        avancar: $('pfAvancar'),
        resumo: $('pfResumo'),
        cnpjStatus: $('pfCnpjStatus'),
    };

    // Etapas que contam no "Etapa X de N" (boas-vindas, revisão e pronto ficam de fora).
    const ETAPAS_COM_DADOS = ['nome', 'dados', 'endereco', 'catalogo'];

    let etapas = [];          // ordem efetiva (sem "catalogo" se faltar permissão)
    let atual = 0;
    let usuario = null;
    let enviando = false;
    let cnpjVerificado = null;

    /* ================= Utilidades ================= */

    function mostrarErro(texto) {
        el.erro.textContent = texto || '';
        el.erro.hidden = !texto;
    }

    function mensagemDeFalha(err) {
        return err && err.status !== undefined
            ? err.message
            : 'Não foi possível falar com o servidor. Confira a internet e tente de novo.';
    }

    function soDigitos(valor) {
        return String(valor || '').replace(/\D/g, '');
    }

    function mascararTelefone(valor) {
        const d = soDigitos(valor).slice(0, 11);
        if (d.length <= 2) return d.length ? `(${d}` : '';
        if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
        if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
        return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    }

    function mascararCep(valor) {
        const d = soDigitos(valor).slice(0, 8);
        return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    }

    function mascararCnpj(valor) {
        const cnpj = window.hydraCnpj.normalizar(valor).slice(0, 14);
        return cnpj
            .replace(/^(.{2})(.)/, '$1.$2')
            .replace(/^(.{2})\.(.{3})(.)/, '$1.$2.$3')
            .replace(/^(.{2})\.(.{3})\.(.{3})(.)/, '$1.$2.$3/$4')
            .replace(/^(.{2})\.(.{3})\.(.{3})\/(.{4})(.)/, '$1.$2.$3/$4-$5');
    }

    function statusCnpj(texto, estado) {
        el.cnpjStatus.textContent = texto || '';
        if (estado) el.cnpjStatus.dataset.status = estado;
        else delete el.cnpjStatus.dataset.status;
    }

    function marcarInvalido(input, invalido) {
        if (invalido) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    }

    /* ================= Máscaras ================= */

    campos.telefone.addEventListener('input', () => {
        campos.telefone.value = mascararTelefone(campos.telefone.value);
        marcarInvalido(campos.telefone, false);
    });
    campos.cep.addEventListener('input', () => {
        campos.cep.value = mascararCep(campos.cep.value);
        marcarInvalido(campos.cep, false);
    });
    campos.cnpj.addEventListener('input', () => {
        campos.cnpj.value = mascararCnpj(campos.cnpj.value);
        cnpjVerificado = null;
        marcarInvalido(campos.cnpj, false);
        statusCnpj('');
    });
    campos.nome.addEventListener('input', () => marcarInvalido(campos.nome, false));
    // Os botões de sugestão ("Matriz", "Loja 1", "Centro") saíram: o nome
    // desta filial vira o nome da loja, e "Matriz" não serve para isso.

    /* ================= Validação por etapa ================= */

    async function verificarCnpj() {
        const cnpj = window.hydraCnpj.normalizar(campos.cnpj.value);
        if (!cnpj) {
            cnpjVerificado = null;
            statusCnpj('');
            return;
        }
        if (!window.hydraCnpj.validoLocal(cnpj)) {
            throw new Error('CNPJ inválido. Confira os 14 caracteres e os dígitos verificadores.');
        }
        if (cnpjVerificado === cnpj) return;
        statusCnpj('Consultando CNPJ na BrasilAPI…');
        const consulta = await window.hydraCnpj.consultarBrasilApi(cnpj);
        cnpjVerificado = cnpj;
        const situacao = consulta.situacao ? ` Situação cadastral: ${consulta.situacao}.` : '';
        statusCnpj(consulta.consultado ? `CNPJ encontrado na BrasilAPI.${situacao}` : consulta.mensagem, 'sucesso');
    }

    /** Devolve true se a etapa atual pode avançar; senão mostra o erro e foca o campo. */
    async function validarEtapa(nome) {
        const falhar = (input, mensagem) => {
            mostrarErro(mensagem);
            marcarInvalido(input, true);
            input.focus();
            return false;
        };

        if (nome === 'nome') {
            const valor = campos.nome.value.trim();
            if (!valor) return falhar(campos.nome, 'Informe o nome da filial.');
            if (valor.length > 120) return falhar(campos.nome, 'O nome pode ter no máximo 120 caracteres.');
        }

        if (nome === 'dados') {
            try {
                await verificarCnpj();
            } catch (err) {
                statusCnpj(err.message, 'erro');
                return falhar(campos.cnpj, err.message);
            }
            const tel = soDigitos(campos.telefone.value);
            if (tel && !/^[1-9][1-9](?:[2-8]\d{7}|9\d{8})$/.test(tel)) {
                return falhar(campos.telefone, 'Telefone inválido. Use DDD + número, ex.: (11) 99999-8888.');
            }
        }

        if (nome === 'endereco') {
            const cep = soDigitos(campos.cep.value);
            if (cep && cep.length !== 8) return falhar(campos.cep, 'CEP inválido. Use 8 números, ex.: 01310-100.');
        }

        return true;
    }

    /* ================= Navegação ================= */

    function montarResumo() {
        const linhas = [
            ['Filial', campos.nome.value.trim()],
            ['CNPJ', campos.cnpj.value.trim()],
            ['Telefone', campos.telefone.value.trim()],
            ['Endereço', [
                campos.endereco.value.trim(),
                [campos.cidade.value.trim(), campos.estado.value].filter(Boolean).join(' - '),
                campos.cep.value.trim(),
            ].filter(Boolean).join(', ')],
        ];
        if (etapas.includes('catalogo')) {
            linhas.push(['Hortifrúti', campos.importar.checked ? 'Importar os 120 códigos padrão' : 'Não importar']);
        }

        el.resumo.replaceChildren(...linhas.map(([rotulo, valor]) => {
            const linha = document.createElement('div');
            const dt = document.createElement('dt');
            const dd = document.createElement('dd');
            dt.textContent = rotulo;
            if (valor) {
                dd.textContent = valor;
            } else {
                dd.textContent = 'Usar os dados da loja';
                dd.className = 'pf-vazio';
            }
            linha.append(dt, dd);
            return linha;
        }));
    }

    function irPara(indice) {
        atual = indice;
        const nome = etapas[atual];
        mostrarErro('');

        form.querySelectorAll('.pf-etapa').forEach((secao) => {
            secao.hidden = secao.dataset.etapa !== nome;
        });

        // Progresso só nas etapas de dados.
        const posicao = ETAPAS_COM_DADOS.filter((e) => etapas.includes(e)).indexOf(nome);
        const total = ETAPAS_COM_DADOS.filter((e) => etapas.includes(e)).length;
        el.progresso.hidden = posicao < 0;
        if (posicao >= 0) {
            const pct = Math.round(((posicao + 1) / total) * 100);
            el.progressoTexto.textContent = `Etapa ${posicao + 1} de ${total}`;
            el.progressoPreenchido.style.width = `${pct}%`;
            el.progressoBarra.setAttribute('aria-valuenow', String(pct));
        }

        el.voltar.hidden = nome === 'boas-vindas' || nome === 'pronto';
        el.avancar.textContent = {
            'boas-vindas': 'Começar',
            revisao: 'Criar filial',
            pronto: 'Começar a usar o Hydra',
        }[nome] || 'Continuar';

        if (nome === 'revisao') montarResumo();

        // Foco no campo da etapa (ou no título), para teclado e leitor de tela.
        const secao = form.querySelector(`.pf-etapa[data-etapa="${nome}"]`);
        const alvo = secao.querySelector('input:not([type="checkbox"]), select') || secao.querySelector('h1');
        alvo.focus();
    }

    async function criarFilial() {
        enviando = true;
        el.avancar.disabled = true;
        el.voltar.disabled = true;
        el.avancar.textContent = 'Criando filial…';
        try {
            const resposta = await window.hydraApi('/filiais', {
                method: 'POST',
                body: {
                    nome: campos.nome.value.trim(),
                    cnpj: campos.cnpj.value.trim(),
                    telefone: campos.telefone.value.trim(),
                    cep: campos.cep.value.trim(),
                    endereco: campos.endereco.value.trim(),
                    cidade: campos.cidade.value.trim(),
                    estado: campos.estado.value,
                    status: 'ativa',
                    importar_hortifruti: etapas.includes('catalogo') && campos.importar.checked,
                },
            });
            const importados = Number(resposta.hortifruti_importados) || 0;
            $('pfMensagemPronto').textContent = `A filial "${campos.nome.value.trim()}" foi criada e você já está trabalhando nela.`
                + (importados > 0 ? ` ${importados} produtos de hortifrúti foram importados (sem preço).` : '');
            el.avancar.disabled = false;
            el.voltar.disabled = false;
            irPara(etapas.indexOf('pronto'));
        } catch (err) {
            el.avancar.disabled = false;
            el.voltar.disabled = false;
            el.avancar.textContent = 'Criar filial';
            if (err && err.status === 401) {
                mostrarErro('Sua sessão terminou. Entre no sistema de novo.');
                setTimeout(() => { window.location.href = 'login.html'; }, 2000);
                return;
            }
            mostrarErro(mensagemDeFalha(err));
        } finally {
            enviando = false;
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (enviando) return;
        const nome = etapas[atual];

        if (nome === 'pronto') {
            window.location.href = window.hydraHomePorPermissao(usuario);
            return;
        }
        if (nome === 'revisao') {
            await criarFilial();
            return;
        }

        el.avancar.disabled = true;
        const ok = await validarEtapa(nome);
        el.avancar.disabled = false;
        if (ok) irPara(atual + 1);
    });

    el.voltar.addEventListener('click', () => {
        if (atual > 0 && !enviando) irPara(atual - 1);
    });

    $('pfSair').addEventListener('click', (e) => {
        e.preventDefault();
        window.hydraApi('/auth/logout', { method: 'POST' })
            .catch(() => {})
            .finally(() => { window.location.href = 'login.html'; });
    });

    /* ================= Início ================= */
    (async function iniciar() {
        try {
            ({ usuario } = await window.hydraSessao());
        } catch (err) {
            window.location.href = 'login.html';
            return;
        }

        // Só quem pode criar filial (a mesma permissão de POST /api/filiais).
        if (!window.hydraPode(usuario, ['loja.configurar'])) {
            window.location.href = window.hydraHomePorPermissao(usuario);
            return;
        }

        try {
            // A loja já tem filial? Então o assistente não tem o que fazer.
            /* O nome da loja não é mais buscado: o Cadastro deixou de pedi-lo
               e, até esta filial existir, ele é só um nome provisório. O
               nome escolhido aqui passa a ser o nome da loja. */
            const minhas = await window.hydraApi('/filiais/minhas');
            if ((minhas.filiais || []).length > 0) {
                window.location.href = window.hydraHomePorPermissao(usuario);
                return;
            }
        } catch (err) {
            el.carregando.textContent = mensagemDeFalha(err);
            return;
        }

        const primeiroNome = (usuario.nome || '').trim().split(/\s+/)[0];
        if (primeiroNome) $('pfNomeUsuario').textContent = `, ${primeiroNome}`;

        const podeCatalogo = window.hydraPode(usuario, ['produtos.importar_catalogo']);
        document.querySelectorAll('.pf-lista-passos [data-requer-catalogo]').forEach((li) => {
            li.hidden = !podeCatalogo;
        });
        etapas = ['boas-vindas', 'nome', 'dados', 'endereco']
            .concat(podeCatalogo ? ['catalogo'] : [], ['revisao', 'pronto']);

        el.carregando.hidden = true;
        el.acoes.hidden = false;
        irPara(0);
    })();
})();
