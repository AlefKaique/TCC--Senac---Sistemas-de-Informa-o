/**
 * Tela "Cadastrar nova Filial" (Admin > Configuração Loja). Os mesmos campos
 * de Configurações da Loja, gravados por POST /api/filiais.
 *
 * Com ?id=N vira a edição dessa filial (botão "Editar" da tela Filiais),
 * gravada por PUT /api/filiais/N. As travas de situação ("não desative a
 * filial em que você está", "a loja precisa de uma filial ativa") são do
 * back-end; a tela só as antecipa, já explicando o motivo.
 */
(function () {
    'use strict';

    const form = document.getElementById('hydroFilialForm');
    if (!form) return;

    const idEdicao = Number(new URLSearchParams(window.location.search).get('id')) || null;

    const campos = {
        nome: document.getElementById('hydroFilialNome'),
        cnpj: document.getElementById('hydroFilialCnpj'),
        telefone: document.getElementById('hydroFilialTelefone'),
        cep: document.getElementById('hydroFilialCep'),
        endereco: document.getElementById('hydroFilialEndereco'),
        cidade: document.getElementById('hydroFilialCidade'),
        estado: document.getElementById('hydroFilialEstado'),
        status: document.getElementById('hydroFilialStatus'),
    };
    const erro = document.getElementById('hydroFilialFormErro');
    const dicaStatus = document.getElementById('hydroFilialStatusDica');
    const btnSalvar = document.getElementById('hydroBtnSalvar');
    const opcaoCatalogo = document.getElementById('hydroFilialCatalogOption');
    const importarHortifruti = document.getElementById('hydroFilialImportarHortifruti');
    const cnpjStatus = document.getElementById('hydroFilialCnpjBrasilApiStatus');
    let cnpjBrasilApiVerificado = null;

    function mostrarErro(texto) {
        erro.textContent = texto || '';
        erro.hidden = !texto;
        if (texto) erro.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function mascararCnpj(valor) {
        const cnpj = window.hydraCnpj.normalizar(valor).slice(0, 14);
        return cnpj
            .replace(/^(.{2})(.)/, '$1.$2')
            .replace(/^(.{2})\.(.{3})(.)/, '$1.$2.$3')
            .replace(/^(.{2})\.(.{3})\.(.{3})(.)/, '$1.$2.$3/$4')
            .replace(/^(.{2})\.(.{3})\.(.{3})\/(.{4})(.)/, '$1.$2.$3/$4-$5');
    }

    function atualizarStatusCnpj(texto, estado = '') {
        cnpjStatus.textContent = texto;
        if (estado) cnpjStatus.dataset.status = estado;
        else delete cnpjStatus.dataset.status;
    }

    async function verificarCnpjBrasilApi() {
        const cnpj = window.hydraCnpj.normalizar(campos.cnpj.value);
        if (!cnpj) {
            cnpjBrasilApiVerificado = null;
            atualizarStatusCnpj('');
            return;
        }
        if (!window.hydraCnpj.validoLocal(cnpj)) {
            throw new Error('CNPJ inválido. Confira os 14 caracteres e os dígitos verificadores.');
        }
        if (cnpjBrasilApiVerificado === cnpj) return;

        atualizarStatusCnpj('Consultando CNPJ na BrasilAPI…');
        const consulta = await window.hydraCnpj.consultarBrasilApi(cnpj);
        cnpjBrasilApiVerificado = cnpj;
        const situacao = consulta.situacao ? ` Situação cadastral: ${consulta.situacao}.` : '';
        atualizarStatusCnpj(
            consulta.consultado
                ? `CNPJ encontrado na BrasilAPI.${situacao}`
                : consulta.mensagem,
            'sucesso'
        );
    }

    campos.cnpj.addEventListener('input', () => {
        campos.cnpj.value = mascararCnpj(campos.cnpj.value);
        cnpjBrasilApiVerificado = null;
        atualizarStatusCnpj('');
    });
    campos.cnpj.addEventListener('blur', () => {
        verificarCnpjBrasilApi().catch((falha) => {
            cnpjBrasilApiVerificado = null;
            atualizarStatusCnpj(falha.message, 'erro');
        });
    });

    /* ================= Modo edição ================= */
    if (idEdicao) {
        opcaoCatalogo.hidden = true;
        document.title = 'Hydra · Editar filial';
        document.querySelector('.hydro-topbar h1').textContent = 'Editar filial';
        document.getElementById('hydroFilialIntro').textContent =
            'Altere os dados da filial. O estoque, as vendas e as promoções dela continuam como estão.';
        btnSalvar.textContent = 'Salvar alterações';
        // A situação (ativa/desativada) só existe na edição: filial nova nasce ativa.
        document.getElementById('hydroFilialSecaoSituacao').hidden = false;
    }

    function preencher(filial) {
        campos.nome.value = filial.nome || '';
        campos.cnpj.value = mascararCnpj(filial.cnpj || '');
        campos.telefone.value = filial.telefone || '';
        campos.cep.value = filial.cep || '';
        campos.endereco.value = filial.endereco || '';
        campos.cidade.value = filial.cidade || '';
        // Estado fora da lista curta do seletor (ex.: GO) ganha uma opção própria.
        if (filial.estado && !Array.from(campos.estado.options).some((o) => o.value === filial.estado)) {
            campos.estado.add(new Option(filial.estado, filial.estado));
        }
        campos.estado.value = filial.estado || '';
        campos.status.value = filial.status || 'ativa';
    }

    function travarStatusSePreciso(filial, filiais, idFilialAtiva) {
        let dica = '';
        if (filial.status === 'ativa') {
            const ativas = filiais.filter((f) => f.status === 'ativa').length;
            if (Number(filial.id_filial) === Number(idFilialAtiva)) {
                dica = 'Você está trabalhando nesta filial agora. Para desativá-la, troque de filial antes.';
            } else if (ativas <= 1) {
                dica = 'Esta é a única filial ativa da loja e não pode ser desativada.';
            }
        }
        campos.status.disabled = Boolean(dica);
        dicaStatus.textContent = dica;
        dicaStatus.hidden = !dica;
    }

    /* ================= Salvar ================= */
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        mostrarErro('');

        const nome = campos.nome.value.trim();
        if (!nome) {
            mostrarErro('Informe o nome da filial.');
            campos.nome.focus();
            return;
        }

        try {
            await verificarCnpjBrasilApi();
        } catch (falha) {
            atualizarStatusCnpj(falha.message, 'erro');
            mostrarErro(falha.message);
            campos.cnpj.focus();
            return;
        }

        const textoOriginal = btnSalvar.textContent;
        btnSalvar.disabled = true;
        btnSalvar.textContent = 'Salvando…';
        try {
            const resposta = await window.hydraApi(idEdicao ? `/filiais/${idEdicao}` : '/filiais', {
                method: idEdicao ? 'PUT' : 'POST',
                body: {
                    nome,
                    cnpj: campos.cnpj.value.trim(),
                    telefone: campos.telefone.value.trim(),
                    cep: campos.cep.value.trim(),
                    endereco: campos.endereco.value.trim(),
                    cidade: campos.cidade.value.trim(),
                    estado: campos.estado.value,
                    status: idEdicao ? campos.status.value : 'ativa',
                    importar_hortifruti: !idEdicao && importarHortifruti.checked,
                },
            });
            const quantidadeImportada = Number(resposta.hortifruti_importados) || 0;
            const importacao = quantidadeImportada > 0 ? `&hortifruti=${quantidadeImportada}` : '';
            window.location.href = `filiais.html?ok=${idEdicao ? 'editada' : 'criada'}&nome=${encodeURIComponent(nome)}${importacao}`;
        } catch (err) {
            btnSalvar.disabled = false;
            btnSalvar.textContent = textoOriginal;
            mostrarErro(err.status === undefined
                ? 'Não foi possível falar com o servidor. Confira a internet e tente de novo.'
                : err.message);
        }
    });

    /* ================= Mobile sidebar ================= */
    const sidebar = document.getElementById('hydroSidebar');
    const overlay = document.getElementById('hydroSidebarOverlay');
    document.getElementById('hydroMobileToggle').addEventListener('click', () => {
        sidebar.classList.add('hydro-open');
        overlay.classList.add('hydro-show');
    });
    overlay.addEventListener('click', () => {
        sidebar.classList.remove('hydro-open');
        overlay.classList.remove('hydro-show');
    });

    /* ================= Init ================= */
    (async function init() {
        if (!window.hydraApi) return;
        try {
            const { usuario } = await window.hydraSessao();
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
            opcaoCatalogo.hidden = Boolean(idEdicao) || !window.hydraPode(usuario, ['produtos.importar_catalogo']);
            // Mesma permissão que a API exige em POST/PUT /api/filiais.
            if (!window.hydraGuardaDeTela(usuario, ['loja.configurar'])) return;
        } catch (err) {
            return; // Visitante da demonstração pública.
        }

        if (!idEdicao) {
            campos.nome.focus();
            return;
        }

        // Edição: não há GET de uma filial só; a lista já traz todas.
        btnSalvar.disabled = true;
        try {
            const resposta = await window.hydraApi('/filiais');
            const filiais = resposta.filiais || [];
            const filial = filiais.find((f) => Number(f.id_filial) === idEdicao);
            if (!filial) {
                mostrarErro('Filial não encontrada. Volte para a lista de filiais e escolha de novo.');
                return;
            }
            preencher(filial);
            travarStatusSePreciso(filial, filiais, resposta.id_filial_ativa);
            btnSalvar.disabled = false;
        } catch (err) {
            mostrarErro(err.status === undefined
                ? 'Não foi possível falar com o servidor. Confira a internet e tente de novo.'
                : `Não foi possível carregar a filial: ${err.message}`);
        }
    })();
})();
