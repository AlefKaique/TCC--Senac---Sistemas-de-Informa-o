(function () {
    'use strict';

    const form = document.getElementById('hydroSettingsForm');
    if (!form) return;

    /* ================= Toast ================= */
    let toastTimer = null;
    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        // Leitores de tela anunciam a confirmação/erro sem tirar o foco (QA 004).
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.textContent = message;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 2600);
    }

    const mercadoPagoStatus = document.getElementById('hydroMercadoPagoStatus');
    const mercadoPagoConnect = document.getElementById('hydroMercadoPagoConnect');
    const mercadoPagoDisconnect = document.getElementById('hydroMercadoPagoDisconnect');

    async function carregarContaMercadoPago() {
        const conta = await window.hydraApi('/pix/mercadopago/conta');
        if (!conta.configurado) {
            mercadoPagoStatus.textContent = 'Integração indisponível: o administrador do servidor precisa configurar as credenciais Mercado Pago e a chave de criptografia.';
            mercadoPagoConnect.disabled = true;
            mercadoPagoDisconnect.hidden = true;
            return;
        }
        mercadoPagoStatus.textContent = conta.conectada
            ? `Conta Mercado Pago conectada (ID ${conta.mp_user_id}).`
            : 'Nenhuma conta Mercado Pago conectada para esta loja.';
        mercadoPagoConnect.textContent = conta.conectada ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago';
        mercadoPagoConnect.disabled = false;
        mercadoPagoDisconnect.hidden = !conta.conectada;
    }

    mercadoPagoConnect.addEventListener('click', async () => {
        mercadoPagoConnect.disabled = true;
        try {
            const { authorization_url: authorizationUrl } = await window.hydraApi('/pix/mercadopago/conectar', {
                method: 'POST',
                body: {},
            });
            window.location.assign(authorizationUrl);
        } catch (error) {
            showToast(error.message);
            mercadoPagoConnect.disabled = false;
        }
    });

    mercadoPagoDisconnect.addEventListener('click', async () => {
        if (!confirm('Desconectar a conta Mercado Pago desta loja? Cobranças Pix pendentes deixarão de ser consultadas.')) return;
        mercadoPagoDisconnect.disabled = true;
        try {
            await window.hydraApi('/pix/mercadopago/conta', { method: 'DELETE' });
            await carregarContaMercadoPago();
            showToast('Conta Mercado Pago desconectada.');
        } catch (error) {
            showToast(error.message);
        } finally {
            mercadoPagoDisconnect.disabled = false;
        }
    });

    /* ================= Alertas de estoque e validade ================= */
    const alertasCard = document.getElementById('alertas');
    const alertasPreview = document.getElementById('hydroAlertasPreview');
    const alertasTelefoneNovo = document.getElementById('hydroAlertasTelefoneNovo');
    const alertasConsentimentoNovo = document.getElementById('hydroAlertasConsentimentoNovo');
    const alertasAdicionar = document.getElementById('hydroAlertasAdicionar');
    const alertasDestinatarios = document.getElementById('hydroAlertasDestinatarios');
    const alertasSemDestinatarios = document.getElementById('hydroAlertasSemDestinatarios');
    const alertasCanal = document.getElementById('hydroAlertasCanal');
    const alertaEstoque = document.getElementById('hydroAlertaEstoque');
    const alertaValidade = document.getElementById('hydroAlertaValidade');
    const diasValidade = document.getElementById('hydroDiasValidade');
    const alertasSalvar = document.getElementById('hydroAlertasSalvar');
    const alertasTeste = document.getElementById('hydroAlertasTeste');
    const alertasStatus = document.getElementById('hydroAlertasStatus');
    const alertasEnvios = document.getElementById('hydroAlertasEnvios');
    const alertasSemEnvios = document.getElementById('hydroAlertasSemEnvios');
    let preferenciasAlertasSalvas = null;

    function formatarTelefoneAlertas(valor) {
        let digitos = valor.replace(/\D/g, '');
        if (digitos.length === 13 && digitos.startsWith('55')) digitos = digitos.slice(2);
        digitos = digitos.slice(0, 11);
        if (digitos.length <= 2) return digitos ? `(${digitos}` : '';
        if (digitos.length <= 7) return `(${digitos.slice(0, 2)}) ${digitos.slice(2)}`;
        return `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
    }

    function atualizarStatusAlertas(preferencias) {
        const canaisEmail = ['email', 'ambos'].includes(preferencias.canal);
        const canaisWhatsapp = ['whatsapp', 'ambos'].includes(preferencias.canal);
        const temDestinatarios = (preferencias.destinatarios || []).length > 0;
        const ativo = (Boolean(Number(preferencias.alerta_estoque)) || Boolean(Number(preferencias.alerta_validade)))
            && (canaisEmail || (canaisWhatsapp && temDestinatarios));
        alertasStatus.textContent = ativo
            ? 'Alertas ativos – próximo resumo amanhã às 7h.'
            : 'Alertas desligados.';
    }

    function renderizarDestinatarios(destinatarios) {
        alertasDestinatarios.replaceChildren();
        alertasSemDestinatarios.hidden = destinatarios.length > 0;
        destinatarios.forEach((destinatario) => {
            const item = document.createElement('li');
            item.className = 'hydro-alerta-destinatario';
            const contato = document.createElement('div');
            contato.className = 'hydro-alerta-destinatario-info';
            const telefone = document.createElement('strong');
            telefone.textContent = formatarTelefoneAlertas(destinatario.telefone_whatsapp);
            const consentimento = document.createElement('small');
            const data = destinatario.consentimento_em
                ? new Date(String(destinatario.consentimento_em).replace(' ', 'T')).toLocaleString('pt-BR')
                : 'Autorização registrada';
            consentimento.textContent = `Autorizado em ${data}`;
            contato.append(telefone, consentimento);

            const remover = document.createElement('button');
            remover.type = 'button';
            remover.className = 'hydro-btn hydro-btn-outline hydro-btn-sm';
            remover.textContent = 'Remover';
            remover.setAttribute('aria-label', `Remover telefone ${formatarTelefoneAlertas(destinatario.telefone_whatsapp)}`);
            remover.addEventListener('click', async () => {
                remover.disabled = true;
                try {
                    await window.hydraApi(`/alertas/destinatarios/${destinatario.id_destinatario}`, {
                        method: 'DELETE',
                    });
                    await carregarPreferenciasAlertas();
                    showToast('Telefone removido dos alertas.');
                } catch (error) {
                    showToast(error.message);
                    remover.disabled = false;
                }
            });
            item.append(contato, remover);
            alertasDestinatarios.appendChild(item);
        });
    }

    function renderizarEnviosAlertas(envios) {
        alertasEnvios.replaceChildren();
        alertasSemEnvios.hidden = envios.length > 0;
        envios.forEach((envio) => {
            const item = document.createElement('li');
            item.className = 'hydro-alerta-envio';
            const resumo = document.createElement('span');
            const data = String(envio.data_referencia || '').slice(0, 10);
            const canal = envio.canal === 'whatsapp' ? 'WhatsApp' : 'E-mail';
            resumo.textContent = `${data} · ${envio.nome_filial} · ${canal}`;
            const status = document.createElement('span');
            status.className = `hydro-alerta-envio-status hydro-alerta-envio-status--${envio.status}`;
            const nomesStatus = {
                enviado: 'Enviado',
                entregue: 'Entregue',
                lido: 'Lido',
                falhou: 'Falhou',
            };
            status.textContent = nomesStatus[envio.status] || 'Enviado';
            item.append(resumo, status);
            alertasEnvios.appendChild(item);
        });
    }

    function atualizarBotaoTesteAlertas() {
        if (!preferenciasAlertasSalvas) {
            alertasTeste.disabled = true;
            return;
        }
        const formularioSalvo = alertasCanal.value === preferenciasAlertasSalvas.canal
            && alertaEstoque.checked === Boolean(Number(preferenciasAlertasSalvas.alerta_estoque))
            && alertaValidade.checked === Boolean(Number(preferenciasAlertasSalvas.alerta_validade))
            && Number(diasValidade.value) === Number(preferenciasAlertasSalvas.dias_validade);
        const precisaDestinatarioWhatsapp = ['whatsapp', 'ambos'].includes(preferenciasAlertasSalvas.canal);
        alertasTeste.disabled = !formularioSalvo
            || (precisaDestinatarioWhatsapp
                && (!preferenciasAlertasSalvas.destinatarios
                    || preferenciasAlertasSalvas.destinatarios.length === 0));
    }

    async function carregarPreferenciasAlertas() {
        const resposta = await window.hydraApi('/alertas/preferencias');
        const preferencias = resposta.preferencias;
        preferencias.destinatarios = resposta.destinatarios || [];
        preferenciasAlertasSalvas = preferencias;
        alertasCanal.value = preferencias.canal || 'whatsapp';
        alertaEstoque.checked = Boolean(Number(preferencias.alerta_estoque));
        alertaValidade.checked = Boolean(Number(preferencias.alerta_validade));
        diasValidade.value = String(preferencias.dias_validade || 7);
        atualizarBotaoTesteAlertas();
        atualizarStatusAlertas(preferencias);
        renderizarDestinatarios(preferencias.destinatarios);
        renderizarEnviosAlertas(resposta.ultimos_envios || []);
    }

    alertasTelefoneNovo.addEventListener('input', () => {
        alertasTelefoneNovo.value = formatarTelefoneAlertas(alertasTelefoneNovo.value);
    });
    alertasTelefoneNovo.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            alertasAdicionar.click();
        }
    });
    alertasAdicionar.addEventListener('click', async () => {
        if (!alertasConsentimentoNovo.checked) {
            showToast('Confirme que a pessoa autorizou receber mensagens antes de adicionar o número.');
            alertasConsentimentoNovo.focus();
            return;
        }
        alertasAdicionar.disabled = true;
        try {
            await window.hydraApi('/alertas/destinatarios', {
                method: 'POST',
                body: {
                    telefone: alertasTelefoneNovo.value,
                    consentimento: alertasConsentimentoNovo.checked,
                },
            });
            alertasTelefoneNovo.value = '';
            alertasConsentimentoNovo.checked = false;
            await carregarPreferenciasAlertas();
            showToast('Telefone autorizado adicionado.');
        } catch (error) {
            showToast(error.message);
        } finally {
            alertasAdicionar.disabled = false;
        }
    });
    [alertasCanal, alertaEstoque, alertaValidade, diasValidade]
        .forEach((campo) => campo.addEventListener('change', atualizarBotaoTesteAlertas));

    alertasSalvar.addEventListener('click', async () => {
        alertasSalvar.disabled = true;
        try {
            await window.hydraApi('/alertas/preferencias', {
                method: 'PUT',
                body: {
                    canal: alertasCanal.value,
                    alerta_estoque: alertaEstoque.checked,
                    alerta_validade: alertaValidade.checked,
                    dias_validade: Number(diasValidade.value),
                },
            });
            await carregarPreferenciasAlertas();
            showToast('Preferências de alertas salvas.');
        } catch (error) {
            showToast(error.message);
        } finally {
            alertasSalvar.disabled = false;
        }
    });

    alertasTeste.addEventListener('click', async () => {
        alertasTeste.disabled = true;
        try {
            const resposta = await window.hydraApi('/alertas/teste', { method: 'POST', body: {} });
            showToast(resposta.mensagem || 'Mensagem de teste enviada.');
            await carregarPreferenciasAlertas();
        } catch (error) {
            showToast(error.message);
        } finally {
            atualizarBotaoTesteAlertas();
        }
    });

    const retornoMercadoPago = new URLSearchParams(window.location.search).get('mercadopago');
    if (retornoMercadoPago) {
        const mensagens = {
            conectada: 'Conta Mercado Pago conectada com sucesso.',
            cancelada: 'Conexão Mercado Pago cancelada.',
            erro: 'Não foi possível conectar a conta Mercado Pago.',
        };
        showToast(mensagens[retornoMercadoPago] || 'Retorno da conexão Mercado Pago recebido.');
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    /* ================= Filial ativa (somente leitura) =================
       As seções Identidade, Dados cadastrais e Endereço mostram a filial em
       que o usuário está trabalhando (a da sessão, de /filiais/minhas), não
       os dados gerais da loja, e não são editáveis aqui: a edição fica em
       Configurações > Filiais > Editar. A logo continua sendo a da loja.

       "Tempo real": relê a filial a cada 30 s enquanto a aba está visível e
       sempre que o usuário volta para ela. Trocar de filial recarrega a
       página (trocar-filial.js), então a troca aparece na hora. */
    const ESTADOS = {
        AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
        DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão',
        MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará',
        PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro',
        RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
        SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
    };
    const INTERVALO_ATUALIZACAO_MS = 30000;
    const NAO_INFORMADO = 'Não informado';

    const logoPreview = document.getElementById('hydroLogoPreview');
    const logoPreviewOriginal = logoPreview.innerHTML;
    const nomeFilialIntro = document.getElementById('hydroFilialAtualNome');
    const linkEditarFilial = document.getElementById('hydroLinkEditarFilial');
    const camposFilial = {
        nome: document.getElementById('hydroNomeLoja'),
        cnpj: document.getElementById('hydroCnpj'),
        telefone: document.getElementById('hydroTelefone'),
        cep: document.getElementById('hydroCep'),
        endereco: document.getElementById('hydroEndereco'),
        cidade: document.getElementById('hydroCidade'),
        estado: document.getElementById('hydroEstado'),
    };

    // CNPJ alfanumérico (2026): 12 posições 0-9/A-Z + 2 dígitos verificadores.
    function mascaraCnpj(v) {
        const c = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14);
        return c
            .replace(/^(.{2})(.)/, '$1.$2')
            .replace(/^(.{2})\.(.{3})(.)/, '$1.$2.$3')
            .replace(/^(.{2})\.(.{3})\.(.{3})(.)/, '$1.$2.$3/$4')
            .replace(/^(.{2})\.(.{3})\.(.{3})\/(.{4})(.)/, '$1.$2.$3/$4-$5');
    }
    function mascaraTelefone(v) {
        const d = String(v || '').replace(/\D/g, '').slice(0, 11);
        if (d.length <= 2) return d ? `(${d}` : '';
        if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
        if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
        return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    }
    function mascaraCep(v) {
        const d = String(v || '').replace(/\D/g, '').slice(0, 8);
        return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    }

    function mostrarLogo(dataUrl) {
        if (dataUrl) {
            logoPreview.innerHTML = '';
            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = 'Logo da loja';
            logoPreview.appendChild(img);
        } else {
            logoPreview.innerHTML = logoPreviewOriginal;
        }
    }

    /** Campo vazio mostra "Não informado" como placeholder, sem valor. */
    function preencherCampo(input, valor) {
        input.value = valor || '';
        input.placeholder = valor ? '' : NAO_INFORMADO;
    }

    function mostrarFilial(filial) {
        if (!filial) {
            nomeFilialIntro.textContent = 'nenhuma filial selecionada';
            Object.values(camposFilial).forEach((input) => preencherCampo(input, ''));
            linkEditarFilial.href = 'filiais.html';
            return;
        }
        nomeFilialIntro.textContent = filial.nome || NAO_INFORMADO;
        preencherCampo(camposFilial.nome, filial.nome);
        preencherCampo(camposFilial.cnpj, mascaraCnpj(filial.cnpj));
        preencherCampo(camposFilial.telefone, mascaraTelefone(filial.telefone));
        preencherCampo(camposFilial.cep, mascaraCep(filial.cep));
        preencherCampo(camposFilial.endereco, filial.endereco);
        preencherCampo(camposFilial.cidade, filial.cidade);
        preencherCampo(camposFilial.estado, filial.estado ? (ESTADOS[filial.estado] || filial.estado) : '');
        linkEditarFilial.href = `cadastro-filial.html?id=${encodeURIComponent(filial.id_filial)}`;
    }

    async function carregarFilialAtiva() {
        const resposta = await window.hydraApi('/filiais/minhas');
        mostrarFilial(resposta.filial_ativa || null);
    }

    let timerAtualizacao = null;
    function iniciarAtualizacaoAutomatica() {
        const atualizar = () => carregarFilialAtiva().catch(() => { /* mantém o que já está na tela */ });
        const agendar = () => {
            clearInterval(timerAtualizacao);
            timerAtualizacao = document.hidden ? null : setInterval(atualizar, INTERVALO_ATUALIZACAO_MS);
        };
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) atualizar();
            agendar();
        });
        agendar();
    }

    // Nada neste formulário é salvo pelo "submit" (Mercado Pago e alertas
    // têm botões próprios); Enter num campo não pode recarregar a página.
    form.addEventListener('submit', (e) => e.preventDefault());

    /* ================= Sidebar nav (cosmético, demo de página única) ================= */
    document.querySelectorAll('.hydro-menu a[data-view]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            if (link.dataset.view === 'sair') {
                window.hydraApi('/auth/logout', { method: 'POST' }).finally(() => {
                    window.location.href = 'login.html';
                });
                return;
            }
            document.querySelectorAll('.hydro-menu a').forEach((a) => a.classList.remove('hydro-active'));
            link.classList.add('hydro-active');
            closeSidebar();
            if (link.dataset.view !== 'configuracoes') {
                showToast('Esta é uma demonstração — apenas as telas de Estoque, Equipe e Configurações estão implementadas');
            }
        });
    });

    /* ================= Mobile sidebar ================= */
    // Abrir/fechar, fundo escuro, Esc e aria-expanded ficam em
    // window.hydraMenuLateral (api.js), igual em todas as telas.
    function closeSidebar() {
        if (window.hydraMenuLateral) window.hydraMenuLateral().fechar();
    }

    /* ================= Init ================= */
    (async function init() {
        if (!window.hydraApi) return;
        try {
            const { usuario } = await window.hydraSessao();
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
            const podeConfigurarLoja = window.hydraPode(usuario, ['loja.configurar']);
            if (!window.hydraGuardaDeTela(usuario, ['loja.configurar', 'relatorios.visualizar'])) return;
            form.style.display = '';
            form.querySelectorAll('[data-hydro-config-admin]').forEach((element) => {
                element.hidden = !podeConfigurarLoja;
            });
            const badgeAdmin = document.getElementById('hydroConfigAdminBadge');
            if (badgeAdmin) badgeAdmin.hidden = !podeConfigurarLoja;
            alertasCard.hidden = !podeConfigurarLoja;
            if (podeConfigurarLoja && window.location.hash === '#alertas') {
                alertasCard.scrollIntoView({ block: 'start' });
            }

            if (!podeConfigurarLoja) return;
        } catch (err) {
            alertasPreview.hidden = false;
            nomeFilialIntro.textContent = 'demonstração';
            // A prévia pública exibe apenas campos vazios e desativados.
            return;
        }

        /* As três cargas são independentes e saem juntas. Antes iam uma
           depois da outra (alertas -> loja -> Mercado Pago), somando o tempo
           de resposta das três antes de a tela ficar completa. */
        const alertas = carregarPreferenciasAlertas().catch((error) => showToast(error.message));
        const dadosLoja = Promise.all([
            carregarFilialAtiva(),
            window.hydraApi('/loja').then(({ loja }) => mostrarLogo(loja.logo || null)),
        ]);
        iniciarAtualizacaoAutomatica();
        const contaMp = carregarContaMercadoPago();
        await alertas;
        try {
            await dadosLoja;
            await contaMp;
        } catch (err) {
            showToast(err.message);
        }
        // Evita "unhandled rejection" se a loja falhou e a conta também.
        contaMp.catch(() => {});
    })();
})();
