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

    /* ================= Logo da loja =================
       Antes era só pré-visualização local e sumia ao recarregar (QA 006).
       Agora a imagem é reduzida aqui (até 256 px, para não pesar no banco)
       e vai como data URL no mesmo PUT /api/loja dos demais campos. */
    const logoInput = document.getElementById('hydroLogoInput');
    const logoPreview = document.getElementById('hydroLogoPreview');
    const logoPreviewOriginal = logoPreview.innerHTML;
    const LOGO_LADO_MAX = 256;
    // undefined = logo não mexida (o PUT não manda a chave); string = nova logo.
    let logoPendente;

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

    function reduzirImagem(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const escala = Math.min(1, LOGO_LADO_MAX / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * escala));
                canvas.height = Math.max(1, Math.round(img.height * escala));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                // PNG preserva transparência, comum em logos.
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('Não foi possível ler a imagem'));
            img.src = dataUrl;
        });
    }

    logoInput.addEventListener('change', () => {
        const file = logoInput.files && logoInput.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showToast('Selecione um arquivo de imagem');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            showToast('A imagem deve ter até 2MB');
            return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
            try {
                logoPendente = await reduzirImagem(reader.result);
                mostrarLogo(logoPendente);
                showToast('Logo selecionada. Clique em "Salvar alterações" para gravar.');
            } catch (err) {
                showToast(err.message);
            }
        };
        reader.readAsDataURL(file);
    });

    /* ================= Máscaras e validação (QA 005) =================
       Mesmas regras de Hydra\Support\Validacao no back-end, que é quem
       decide; aqui é para o usuário ver o erro no campo antes de enviar. */
    const cnpjInput = document.getElementById('hydroCnpj');
    const cnpjBrasilApiStatus = document.getElementById('hydroCnpjBrasilApiStatus');
    const telefoneInput = document.getElementById('hydroTelefone');
    const cepInput = document.getElementById('hydroCep');
    let cnpjBrasilApiVerificado = null;

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

    function atualizarStatusCnpj(texto, estado = '') {
        cnpjBrasilApiStatus.textContent = texto;
        if (estado) cnpjBrasilApiStatus.dataset.status = estado;
        else delete cnpjBrasilApiStatus.dataset.status;
    }

    async function verificarCnpjBrasilApi() {
        const cnpj = window.hydraCnpj.normalizar(cnpjInput.value);
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
    const telefoneValido = (v) => /^[1-9][1-9](?:[2-8]\d{7}|9\d{8})$/.test(String(v).replace(/\D/g, ''));
    const cepValido = (v) => String(v).replace(/\D/g, '').length === 8;

    [[cnpjInput, mascaraCnpj], [telefoneInput, mascaraTelefone], [cepInput, mascaraCep]].forEach(([input, mascara]) => {
        input.addEventListener('input', () => {
            input.value = mascara(input.value);
            limparErroCampo(input);
            if (input === cnpjInput) {
                cnpjBrasilApiVerificado = null;
                atualizarStatusCnpj('');
            }
        });
    });

    cnpjInput.addEventListener('blur', () => {
        verificarCnpjBrasilApi().catch((erro) => {
            cnpjBrasilApiVerificado = null;
            atualizarStatusCnpj(erro.message, 'erro');
        });
    });

    function limparErroCampo(input) {
        input.removeAttribute('aria-invalid');
        input.style.borderColor = '';
        const msg = document.getElementById(input.id + 'Erro');
        if (msg) msg.remove();
        if (input === cnpjInput) input.setAttribute('aria-describedby', cnpjBrasilApiStatus.id);
    }
    function marcarErroCampo(input, mensagem) {
        limparErroCampo(input);
        input.setAttribute('aria-invalid', 'true');
        input.style.borderColor = '#d93636';
        const msg = document.createElement('small');
        msg.id = input.id + 'Erro';
        msg.style.cssText = 'display:block;color:#d93636;margin-top:4px;font-size:12px;';
        msg.textContent = mensagem;
        input.setAttribute('aria-describedby', msg.id);
        input.insertAdjacentElement('afterend', msg);
    }

    const CAMPO_API_PARA_INPUT = {
        nome_loja: 'hydroNomeLoja',
        cnpj: 'hydroCnpj',
        telefone: 'hydroTelefone',
        cep: 'hydroCep',
        estado: 'hydroEstado',
        logo: 'hydroLogoInput',
    };

    /* ================= Carregar dados atuais da loja ================= */
    function fillForm(loja) {
        document.getElementById('hydroNomeLoja').value = loja.nome_loja || '';
        cnpjInput.value = mascaraCnpj(loja.cnpj);
        // O CNPJ que já está gravado foi conferido quando foi salvo: sem
        // isto, o primeiro "Salvar" consultava a BrasilAPI (até 8 s) mesmo
        // sem o CNPJ ter mudado. Se o usuário trocar o CNPJ, a consulta volta.
        cnpjBrasilApiVerificado = loja.cnpj ? window.hydraCnpj.normalizar(loja.cnpj) || null : null;
        telefoneInput.value = mascaraTelefone(loja.telefone);
        cepInput.value = mascaraCep(loja.cep);
        document.getElementById('hydroEndereco').value = loja.endereco || '';
        document.getElementById('hydroCidade').value = loja.cidade || '';
        document.getElementById('hydroEstado').value = loja.estado || '';
        logoPendente = undefined;
        mostrarLogo(loja.logo || null);
        [cnpjInput, telefoneInput, cepInput].forEach(limparErroCampo);
    }

    let lojaAtual = null;

    /* ================= Salvar / cancelar ================= */
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const nomeInput = document.getElementById('hydroNomeLoja');
        const nome_loja = nomeInput.value.trim();
        const erros = [];
        if (!nome_loja) erros.push([nomeInput, 'Informe o nome da loja']);
        if (cnpjInput.value.trim() && !window.hydraCnpj.validoLocal(cnpjInput.value)) {
            erros.push([cnpjInput, 'CNPJ inválido. Confira os 14 caracteres e os dígitos verificadores.']);
        }
        if (telefoneInput.value.trim() && !telefoneValido(telefoneInput.value)) {
            erros.push([telefoneInput, 'Telefone inválido. Use DDD + número, ex.: (11) 99999-8888.']);
        }
        if (cepInput.value.trim() && !cepValido(cepInput.value)) {
            erros.push([cepInput, 'CEP inválido. Use 8 números, ex.: 01310-100.']);
        }
        [nomeInput, cnpjInput, telefoneInput, cepInput].forEach(limparErroCampo);
        if (erros.length) {
            erros.forEach(([input, msg]) => marcarErroCampo(input, msg));
            erros[0][0].focus();
            showToast(erros[0][1]);
            return;
        }

        try {
            await verificarCnpjBrasilApi();
        } catch (erro) {
            marcarErroCampo(cnpjInput, erro.message);
            atualizarStatusCnpj(erro.message, 'erro');
            cnpjInput.focus();
            return;
        }

        const btn = document.getElementById('hydroBtnSalvar');
        btn.disabled = true;

        try {
            const { loja } = await window.hydraApi('/loja', {
                method: 'PUT',
                body: {
                    nome_loja,
                    cnpj: cnpjInput.value.trim(),
                    telefone: telefoneInput.value.trim(),
                    cep: cepInput.value.trim(),
                    endereco: document.getElementById('hydroEndereco').value.trim(),
                    cidade: document.getElementById('hydroCidade').value.trim(),
                    estado: document.getElementById('hydroEstado').value,
                    // Só manda a chave quando a logo mudou: o back-end trata
                    // ausência como "não mexer".
                    ...(logoPendente !== undefined ? { logo: logoPendente } : {}),
                },
            });
            lojaAtual = loja;
            fillForm(loja);

            // Uma confirmação só. Antes apareciam "Alterações salvas" no
            // rodapé E o toast, discretos e redundantes (QA 004).
            showToast('Configurações da loja salvas com sucesso');
        } catch (err) {
            const input = document.getElementById(CAMPO_API_PARA_INPUT[err.data && err.data.campo]);
            if (input && input.type !== 'file') {
                marcarErroCampo(input, err.message);
                input.focus();
            }
            showToast(err.message);
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('hydroBtnCancelar').addEventListener('click', () => {
        if (lojaAtual) fillForm(lojaAtual);
        showToast('Alterações descartadas');
    });

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
            // A prévia pública exibe apenas campos vazios e desativados.
            return;
        }

        /* As três cargas são independentes e saem juntas. Antes iam uma
           depois da outra (alertas -> loja -> Mercado Pago), somando o tempo
           de resposta das três antes de a tela ficar completa. */
        const alertas = carregarPreferenciasAlertas().catch((error) => showToast(error.message));
        const dadosLoja = window.hydraApi('/loja')
            .then(({ loja }) => {
                lojaAtual = loja;
                fillForm(loja);
            });
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
