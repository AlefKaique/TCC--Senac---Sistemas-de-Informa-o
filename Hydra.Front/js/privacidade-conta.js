/**
 * Tela "Privacidade" — exclusiva do titular da conta (quem cadastrou a loja).
 *
 *   - Sua assinatura: plano em uso, validade e pagamento em andamento.
 *   - Cancelar assinatura: o plano continua até o fim do período pago.
 *   - Fazer upgrade: abre o Checkout Pro do Mercado Pago. Na volta, o
 *     Mercado Pago acrescenta à URL "external_reference" e "payment_id", e a
 *     tela pede ao back-end para conferir o pagamento.
 *   - Cancelar conta: desativa a loja e anonimiza os dados (senha + ENCERRAR).
 *   - Suporte: telefone e WhatsApp (11) 95820-6969.
 *
 * API: GET /api/conta/assinatura e as rotas POST /api/conta/... (ContaController).
 */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const el = {
        alerta: $('hydroPrivAlerta'),
        carregando: $('hydroPrivCarregando'),
        conteudo: $('hydroPrivConteudo'),
        planoAtual: $('hydroPrivPlanoAtual'),
        precoAtual: $('hydroPrivPrecoAtual'),
        situacao: $('hydroPrivSituacao'),
        resumoTexto: $('hydroPrivResumoTexto'),
        pendente: $('hydroPrivPendente'),
        pendenteTexto: $('hydroPrivPendenteTexto'),
        btnVerificar: $('hydroBtnVerificarPagamento'),
        cancelarTexto: $('hydroPrivCancelarTexto'),
        btnCancelar: $('hydroBtnCancelarAssinatura'),
        btnReativar: $('hydroBtnReativarAssinatura'),
        pagamentoIndisponivel: $('hydroPrivPagamentoIndisponivel'),
        planos: $('hydroPrivPlanos'),
        btnEncerrar: $('hydroBtnEncerrarConta'),
        modalCancelar: $('hydroModalCancelarAssinatura'),
        modalCancelarTexto: $('hydroModalCancelarTexto'),
        modalCancelarErro: $('hydroModalCancelarErro'),
        btnConfirmarCancelamento: $('hydroBtnConfirmarCancelamento'),
        modalEncerrar: $('hydroModalEncerrar'),
        formEncerrar: $('hydroFormEncerrar'),
        encerrarSenha: $('hydroEncerrarSenha'),
        encerrarConfirmacao: $('hydroEncerrarConfirmacao'),
        modalEncerrarErro: $('hydroModalEncerrarErro'),
        btnConfirmarEncerrar: $('hydroBtnConfirmarEncerrar'),
    };
    if (!el.conteudo) return;

    /* Itens de cada plano: os mesmos da seção "Planos" da página inicial. */
    const RECURSOS = {
        flex: [
            'Cadastro ilimitado de produtos',
            'Controle completo de estoque',
            'Relatórios completos',
            'Cadastro de até 5 usuários',
            'Backup de informações',
        ],
        premium: [
            'Tudo do Hydra Flex',
            'Cadastro de até 20 funcionários',
            'Relatórios avançados e completos',
            'Prioridade no suporte técnico',
            'Recursos futuros liberados automaticamente',
        ],
    };

    const SITUACOES = {
        gratuito: { rotulo: 'Plano gratuito', classe: 'neutro' },
        ativa: { rotulo: 'Ativa', classe: 'ok' },
        cancelada: { rotulo: 'Cancelada', classe: 'atencao' },
        atrasada: { rotulo: 'Pagamento em atraso', classe: 'erro' },
        finalizada: { rotulo: 'Encerrada', classe: 'neutro' },
    };

    let dados = null;       // última resposta de GET /api/conta/assinatura
    let focoAnterior = null;

    /* ================= Utilidades ================= */

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function dinheiro(valor) {
        return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    /** "2026-12-17 10:30:00" → "17/12/2026". */
    function dataBR(valor) {
        if (!valor) return '—';
        const [data] = String(valor).split(' ');
        const [ano, mes, dia] = data.split('-');
        return dia && mes && ano ? `${dia}/${mes}/${ano}` : String(valor);
    }

    function precoComPeriodo(plano) {
        if (!plano || !plano.valor) return 'Gratuito';
        return `${dinheiro(plano.valor)} ${plano.meses === 12 ? '/ano' : '/mês'}`;
    }

    let toastTimer = null;
    function showToast(texto) {
        const toast = $('hydroToast');
        if (!toast) return;
        toast.textContent = texto;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 3500);
    }

    /** Aviso no topo da tela. tipo: 'sucesso' | 'info' | 'erro'. */
    function mostrarAlerta(html, tipo = 'info') {
        el.alerta.className = `hydro-priv-alerta hydro-priv-alerta--${tipo}`;
        el.alerta.innerHTML = html || '';
        el.alerta.hidden = !html;
        if (html) el.alerta.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function mensagemDeErro(err) {
        if (!err || err.status === undefined) {
            return 'Não foi possível falar com o servidor. Confira a internet e tente de novo.';
        }
        if (err.status === 401) {
            return 'Sua sessão terminou. <a href="login.html">Entre no sistema de novo</a>.';
        }
        return escapeHtml(err.message || 'Não foi possível concluir a operação.');
    }

    function definirOcupado(botao, ocupado, textoOcupado) {
        if (!botao) return;
        if (ocupado) {
            botao.dataset.textoOriginal = botao.textContent.trim();
            botao.textContent = textoOcupado;
            botao.disabled = true;
        } else {
            if (botao.dataset.textoOriginal) botao.textContent = botao.dataset.textoOriginal;
            botao.disabled = false;
        }
    }

    function planoPorCodigo(codigo) {
        return (dados && dados.planos || []).find((p) => p.codigo === codigo) || null;
    }

    /* ================= Desenho da tela ================= */

    function renderizar(resposta) {
        dados = resposta;
        const a = resposta.assinatura;
        const situacao = SITUACOES[a.situacao] || SITUACOES.gratuito;

        // ---- Sua assinatura ----
        el.planoAtual.textContent = a.nome_plano;
        el.precoAtual.textContent = a.plano === 'start' ? 'Gratuito' : precoComPeriodo(planoPorCodigo(a.plano));
        el.situacao.textContent = situacao.rotulo;
        el.situacao.className = `hydro-priv-badge hydro-priv-badge--${situacao.classe}`;

        const ate = dataBR(a.valido_ate);
        const textos = {
            gratuito: 'Sua loja está no Hydra Start, o plano gratuito. Faça o upgrade abaixo para liberar todos os recursos.',
            ativa: `O ${escapeHtml(a.nome_plano)} vale até <strong>${ate}</strong>. Não há cobrança automática: para continuar depois `
                + 'dessa data, renove na seção "Fazer upgrade de assinatura".',
            cancelada: `Assinatura cancelada em ${dataBR(a.cancelada_em)}. Você continua com o ${escapeHtml(a.nome_plano_contratado)} `
                + `até <strong>${ate}</strong>; depois disso a loja volta ao Hydra Start (gratuito).`,
            atrasada: `O ${escapeHtml(a.nome_plano_contratado)} venceu em <strong>${ate}</strong> e o pagamento está em atraso. `
                + 'Até a renovação, a loja usa o Hydra Start (gratuito). Renove abaixo ou fale com o suporte para regularizar.',
            finalizada: `A assinatura do ${escapeHtml(a.nome_plano_contratado)} foi cancelada e terminou em <strong>${ate}</strong>. `
                + 'A loja está no Hydra Start (gratuito); assine um plano abaixo para voltar a ter todos os recursos.',
        };
        el.resumoTexto.innerHTML = textos[a.situacao] || textos.gratuito;

        const pendente = resposta.pagamento_pendente;
        el.pendente.hidden = !pendente;
        if (pendente) {
            el.pendenteTexto.innerHTML = `Você iniciou o pagamento do <strong>${escapeHtml(pendente.nome_plano)}</strong> `
                + `(${dinheiro(pendente.valor)}) em ${dataBR(pendente.criado_em)}. Se já pagou, confirme aqui — PIX `
                + 'costuma ser confirmado em minutos e boleto em até 3 dias úteis.';
            el.btnVerificar.dataset.idPagamento = pendente.id;
        }

        // ---- Cancelar assinatura ----
        el.btnCancelar.hidden = a.situacao !== 'ativa' && a.situacao !== 'atrasada';
        el.btnReativar.hidden = a.situacao !== 'cancelada';
        if (a.situacao === 'atrasada') {
            el.cancelarTexto.innerHTML = `Seu ${escapeHtml(a.nome_plano_contratado)} venceu em <strong>${ate}</strong>. `
                + 'Se não quiser renovar, cancele: a cobrança em atraso é encerrada e a loja continua no Hydra Start (gratuito).';
        } else if (a.situacao === 'ativa') {
            el.cancelarTexto.innerHTML = `Ao cancelar, você continua com o ${escapeHtml(a.nome_plano)} até <strong>${ate}</strong>. `
                + 'Depois disso a loja volta ao Hydra Start (gratuito) e nenhum valor novo é cobrado.';
        } else if (a.situacao === 'cancelada') {
            el.cancelarTexto.innerHTML = `Sua assinatura já está cancelada. O ${escapeHtml(a.nome_plano_contratado)} vale até `
                + `<strong>${ate}</strong>. Mudou de ideia? Você pode mantê-la.`;
        } else {
            el.cancelarTexto.textContent = 'Sua loja está no plano gratuito, então não há assinatura para cancelar.';
        }

        // ---- Fazer upgrade ----
        el.pagamentoIndisponivel.hidden = Boolean(resposta.pagamento_online);
        el.planos.innerHTML = (resposta.planos || []).map((p) => {
            let rotulo = p.renovacao ? 'Renovar com Mercado Pago' : 'Assinar com Mercado Pago';
            let desabilitado = false;
            let observacao = '';
            if (!p.pode_contratar) {
                rotulo = 'Seu plano atual é superior';
                desabilitado = true;
                observacao = `Disponível depois de ${ate}.`;
            } else if (!resposta.pagamento_online) {
                rotulo = 'Pagamento indisponível';
                desabilitado = true;
            }
            if (p.renovacao && p.pode_contratar) {
                observacao = p.inicio
                    ? `O novo período começa em ${dataBR(p.inicio)}, sem perder os dias que faltam.`
                    : 'O novo período começa no dia em que o pagamento for confirmado.';
            }
            const recursos = (RECURSOS[p.codigo] || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
            return `
                <li class="hydro-priv-plano${p.renovacao ? ' hydro-priv-plano--atual' : ''}">
                    <div class="hydro-priv-plano-topo">
                        <h3>${escapeHtml(p.nome)}</h3>
                        ${p.renovacao ? '<span class="hydro-priv-badge hydro-priv-badge--ok">Seu plano atual</span>'
                            : `<span class="hydro-priv-plano-periodo">${escapeHtml(p.periodo)}</span>`}
                    </div>
                    <p class="hydro-priv-plano-preco">${precoComPeriodo(p)}</p>
                    ${p.meses === 12 ? '<p class="hydro-priv-plano-nota">Equivale a R$ 83,33 por mês</p>' : '<p class="hydro-priv-plano-nota">Sem fidelidade</p>'}
                    <ul class="hydro-priv-recursos">${recursos}</ul>
                    <button type="button" class="hydro-btn hydro-btn-primary hydro-priv-plano-btn" data-contratar="${escapeHtml(p.codigo)}"
                        ${desabilitado ? 'disabled' : ''}>${rotulo}</button>
                    ${observacao ? `<p class="hydro-priv-plano-obs">${escapeHtml(observacao)}</p>` : ''}
                </li>`;
        }).join('');

        el.carregando.hidden = true;
        el.conteudo.hidden = false;
    }

    /* ================= Ações ================= */

    async function contratar(botao, plano) {
        definirOcupado(botao, true, 'Abrindo o Mercado Pago…');
        mostrarAlerta('');
        try {
            const resposta = await window.hydraApi('/conta/assinatura/checkout', {
                method: 'POST',
                body: { plano, retorno: window.location.origin + window.location.pathname },
            });
            window.location.href = resposta.checkout_url;
        } catch (err) {
            definirOcupado(botao, false);
            mostrarAlerta(mensagemDeErro(err), 'erro');
        }
    }

    /**
     * Pede ao back-end para conferir o pagamento no Mercado Pago.
     * statusRetorno: o "status" que o Mercado Pago pôs na URL de volta.
     */
    async function verificarPagamento(idPagamento, paymentId, statusRetorno) {
        definirOcupado(el.btnVerificar, true, 'Verificando…');
        try {
            const resposta = await window.hydraApi(`/conta/assinatura/pagamentos/${encodeURIComponent(idPagamento)}/verificar`, {
                method: 'POST',
                body: paymentId ? { payment_id: paymentId } : {},
            });
            renderizar(resposta);
            const a = resposta.assinatura;
            const mensagens = {
                aprovado: [`<strong>Pagamento confirmado!</strong> O ${escapeHtml(a.nome_plano)} está ativo até ${dataBR(a.valido_ate)}.`, 'sucesso'],
                pendente: ['O Mercado Pago ainda está processando o pagamento. PIX costuma levar poucos minutos e boleto até 3 dias úteis. '
                    + 'Volte aqui depois e clique em "Verificar pagamento".', 'info'],
                rejeitado: ['O pagamento não foi aprovado pelo Mercado Pago. Tente de novo com outra forma de pagamento.', 'erro'],
                nao_encontrado: [statusRetorno === 'null'
                    ? 'Você voltou do Mercado Pago sem concluir o pagamento. Nada foi cobrado.'
                    : 'Ainda não encontramos um pagamento para este pedido. Se acabou de pagar, aguarde um instante e verifique de novo.', 'info'],
            };
            const [texto, tipo] = mensagens[resposta.status] || mensagens.nao_encontrado;
            mostrarAlerta(texto, tipo);
        } catch (err) {
            mostrarAlerta(mensagemDeErro(err), 'erro');
        } finally {
            definirOcupado(el.btnVerificar, false);
        }
    }

    async function reativar() {
        definirOcupado(el.btnReativar, true, 'Salvando…');
        try {
            const resposta = await window.hydraApi('/conta/assinatura/reativar', { method: 'POST' });
            renderizar(resposta);
            mostrarAlerta('');
            showToast('Pronto! Sua assinatura foi mantida.');
        } catch (err) {
            mostrarAlerta(mensagemDeErro(err), 'erro');
        } finally {
            definirOcupado(el.btnReativar, false);
        }
    }

    async function confirmarCancelamento() {
        definirOcupado(el.btnConfirmarCancelamento, true, 'Cancelando…');
        el.modalCancelarErro.hidden = true;
        try {
            const resposta = await window.hydraApi('/conta/assinatura/cancelar', { method: 'POST' });
            fecharModal(el.modalCancelar);
            renderizar(resposta);
            const a = resposta.assinatura;
            mostrarAlerta(a.situacao === 'finalizada'
                ? 'Assinatura cancelada. A cobrança em atraso foi encerrada e a loja continua no Hydra Start (gratuito).'
                : `Assinatura cancelada. Você continua com o ${escapeHtml(a.nome_plano_contratado)} até ${dataBR(a.valido_ate)}.`,
            'sucesso');
        } catch (err) {
            el.modalCancelarErro.innerHTML = mensagemDeErro(err);
            el.modalCancelarErro.hidden = false;
        } finally {
            definirOcupado(el.btnConfirmarCancelamento, false);
        }
    }

    function atualizarBotaoEncerrar() {
        const confirmado = el.encerrarConfirmacao.value.trim().toUpperCase() === 'ENCERRAR';
        el.btnConfirmarEncerrar.disabled = !(confirmado && el.encerrarSenha.value !== '');
    }

    async function encerrarConta(event) {
        event.preventDefault();
        atualizarBotaoEncerrar();
        if (el.btnConfirmarEncerrar.disabled) return;

        definirOcupado(el.btnConfirmarEncerrar, true, 'Encerrando…');
        el.modalEncerrarErro.hidden = true;
        try {
            await window.hydraApi('/conta/encerrar', {
                method: 'POST',
                body: {
                    senha: el.encerrarSenha.value,
                    confirmacao: el.encerrarConfirmacao.value.trim(),
                },
            });
            if (window.hydraSessao && window.hydraSessao.limpar) window.hydraSessao.limpar();
            el.formEncerrar.querySelector('.hydro-modal-body').innerHTML = '<p class="hydro-priv-texto">'
                + '<strong>Sua conta foi encerrada.</strong> Obrigado por ter usado o Hydra. Você será levado à página inicial.</p>';
            el.formEncerrar.querySelector('.hydro-modal-footer').hidden = true;
            setTimeout(() => { window.location.href = 'index.html'; }, 3000);
        } catch (err) {
            definirOcupado(el.btnConfirmarEncerrar, false);
            el.modalEncerrarErro.innerHTML = mensagemDeErro(err);
            el.modalEncerrarErro.hidden = false;
            const campo = err && err.data && err.data.campo;
            if (campo === 'senha') {
                el.encerrarSenha.value = '';
                el.encerrarSenha.focus();
            } else if (campo === 'confirmacao') {
                el.encerrarConfirmacao.focus();
            }
            atualizarBotaoEncerrar();
        }
    }

    /* ================= Janelas (modais) ================= */

    function abrirModal(modal, foco) {
        focoAnterior = document.activeElement;
        modal.classList.add('hydro-show');
        if (foco) foco.focus();
    }

    function fecharModal(modal) {
        if (!modal.classList.contains('hydro-show')) return;
        modal.classList.remove('hydro-show');
        if (focoAnterior && typeof focoAnterior.focus === 'function') focoAnterior.focus();
    }

    [el.modalCancelar, el.modalEncerrar].forEach((modal) => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('[data-fechar-modal]')) fecharModal(modal);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        fecharModal(el.modalCancelar);
        fecharModal(el.modalEncerrar);
    });

    el.btnCancelar.addEventListener('click', () => {
        const a = dados && dados.assinatura;
        if (!a) {
            el.modalCancelarTexto.innerHTML = '';
        } else if (a.situacao === 'atrasada') {
            el.modalCancelarTexto.innerHTML = `A assinatura do ${escapeHtml(a.nome_plano_contratado)}, vencida em `
                + `<strong>${dataBR(a.valido_ate)}</strong>, será encerrada e a loja continua no Hydra Start (gratuito). `
                + 'Para voltar a um plano pago, é só assinar de novo.';
        } else {
            el.modalCancelarTexto.innerHTML = `Você continua com o ${escapeHtml(a.nome_plano)} até <strong>${dataBR(a.valido_ate)}</strong>. Depois disso a loja `
                + 'volta ao Hydra Start (gratuito). Até lá, você pode desfazer o cancelamento.';
        }
        el.modalCancelarErro.hidden = true;
        abrirModal(el.modalCancelar, el.btnConfirmarCancelamento);
    });
    el.btnConfirmarCancelamento.addEventListener('click', confirmarCancelamento);
    el.btnReativar.addEventListener('click', reativar);

    el.btnEncerrar.addEventListener('click', () => {
        el.encerrarSenha.value = '';
        el.encerrarConfirmacao.value = '';
        el.modalEncerrarErro.hidden = true;
        atualizarBotaoEncerrar();
        abrirModal(el.modalEncerrar, el.encerrarSenha);
    });
    el.encerrarSenha.addEventListener('input', atualizarBotaoEncerrar);
    el.encerrarConfirmacao.addEventListener('input', atualizarBotaoEncerrar);
    el.formEncerrar.addEventListener('submit', encerrarConta);

    el.planos.addEventListener('click', (e) => {
        const botao = e.target.closest('[data-contratar]');
        if (botao && !botao.disabled) contratar(botao, botao.dataset.contratar);
    });
    el.btnVerificar.addEventListener('click', () => {
        const id = el.btnVerificar.dataset.idPagamento;
        if (id) verificarPagamento(id, '', '');
    });

    /* Volta do Mercado Pago: ?external_reference=<id>&payment_id=...&status=... */
    function tratarRetornoDoMercadoPago() {
        const params = new URLSearchParams(window.location.search);
        const referencia = params.get('external_reference');
        if (!referencia) return;
        // Tira os parâmetros da barra de endereço, para não conferir de novo ao recarregar.
        window.history.replaceState(null, '', window.location.pathname);
        if (!/^[a-f0-9-]{36}$/i.test(referencia)) return;

        let paymentId = params.get('payment_id') || params.get('collection_id') || '';
        if (!/^\d+$/.test(paymentId)) paymentId = '';
        const status = params.get('status') || params.get('collection_status') || '';
        verificarPagamento(referencia, paymentId, status);
    }

    /* ================= Início ================= */
    (async function init() {
        if (!window.hydraApi) {
            el.carregando.textContent = 'Erro ao abrir a tela: o arquivo api.js não foi carregado.';
            return;
        }

        const pedido = window.hydraApi('/conta/assinatura');
        pedido.catch(() => {});

        let usuario = null;
        try {
            ({ usuario } = await window.hydraSessao());
            const nome = $('hydroUserName');
            if (nome) nome.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
            // Funcionário criado na tela Equipe: volta para a tela dele.
            if (!usuario.titular) {
                window.location.href = window.hydraHomePorPermissao(usuario);
                return;
            }
        } catch (err) {
            el.carregando.innerHTML = mensagemDeErro(err);
            return;
        }

        try {
            renderizar(await pedido);
        } catch (err) {
            // 403: deixou de ser titular entre o /auth/me e esta chamada.
            if (err && err.status === 403) {
                window.location.href = window.hydraHomePorPermissao(usuario);
                return;
            }
            el.carregando.innerHTML = `Não foi possível carregar sua assinatura: ${mensagemDeErro(err)}`;
            return;
        }

        tratarRetornoDoMercadoPago();
    })();
})();
