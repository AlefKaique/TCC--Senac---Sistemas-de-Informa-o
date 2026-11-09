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

    function mostrarErro(texto) {
        erro.textContent = texto || '';
        erro.hidden = !texto;
        if (texto) erro.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    /* ================= Modo edição ================= */
    if (idEdicao) {
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
        campos.cnpj.value = filial.cnpj || '';
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

        const textoOriginal = btnSalvar.textContent;
        btnSalvar.disabled = true;
        btnSalvar.textContent = 'Salvando…';
        try {
            await window.hydraApi(idEdicao ? `/filiais/${idEdicao}` : '/filiais', {
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
                },
            });
            window.location.href = `filiais.html?ok=${idEdicao ? 'editada' : 'criada'}&nome=${encodeURIComponent(nome)}`;
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
