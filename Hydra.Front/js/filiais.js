/**
 * Tela "Filiais" (Admin > Configuração Loja > Filiais). Mesma estrutura da
 * tela Equipe: cartões de resumo, barra de filtros e a listagem — aqui em
 * cartões de perfil (logo à esquerda, nome da filial ao lado) com o lucro
 * do mês de cada filial em destaque.
 *
 * Dados de GET /api/filiais. O "resumo_mes" de cada filial (vendas,
 * faturamento e lucro bruto do mês) só vem para quem tem a permissão de
 * Relatórios; sem ela os cartões aparecem sem os números.
 */
(function () {
    'use strict';

    const grid = document.getElementById('hydroFiliaisGrid');
    const mensagem = document.getElementById('hydroFiliaisMensagem');
    const busca = document.getElementById('hydroFiliaisBusca');
    const filtroSituacao = document.getElementById('hydroFiltroSituacao');
    if (!grid) return;

    const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
        'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

    // Cor do "logo" de cada filial: fixa por filial (depende do id), para a
    // mesma filial ter sempre a mesma cor em qualquer computador.
    const CORES_LOGO = ['#152e6d', '#149e52', '#b98523', '#5e81f4', '#c2410c', '#7c3aed', '#0e7490', '#be185d'];

    let filiais = [];
    let idFilialAtiva = null;
    let nomeMes = '';

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    function dinheiro(valor) {
        return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    let toastTimer = null;
    function showToast(texto) {
        const toast = document.getElementById('hydroToast');
        toast.textContent = texto;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 3000);
    }

    function mostrarMensagem(html) {
        mensagem.innerHTML = html || '';
        mensagem.hidden = !html;
    }

    /** Mensagem de falha da API, já dizendo o que fazer. */
    function mensagemDeErro(err, oQue) {
        if (!err || err.status === undefined) {
            return 'Não foi possível falar com o servidor. Confira a internet ou se o sistema está no ar e tente de novo.';
        }
        if (err.status === 401) {
            return 'Sua sessão terminou. <a href="login.html">Entre no sistema de novo</a>.';
        }
        if (err.status === 404) {
            return `Não foi possível carregar ${oQue} (erro 404). O servidor ainda não tem o módulo de filiais: avise o responsável pelo sistema.`;
        }
        return `Não foi possível carregar ${oQue}: ${escapeHtml(err.message)} (erro ${err.status}).`;
    }

    /* "Centro" → "CE"; "Vila Nova" → "VN". Substitui o logo enquanto ele não
       é guardado no servidor (ver cadastro-filial.js). */
    function iniciais(nome) {
        const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
        if (partes.length === 0) return '?';
        if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
        return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
    }

    function normalizar(texto) {
        return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    }

    function lucroHtml(f) {
        if (!f.resumo_mes) {
            return `
                <div class="hydro-filial-lucro">
                    <span class="hydro-filial-lucro-rotulo">Lucro do mês</span>
                    <span class="hydro-filial-lucro-sub">Seu cargo não tem acesso aos Relatórios, por isso os valores não aparecem.</span>
                </div>`;
        }
        const r = f.resumo_mes;
        const classe = r.lucro > 0 ? ' hydro-positivo' : (r.lucro < 0 ? ' hydro-negativo' : '');
        const vendas = r.vendas === 1 ? '1 venda' : `${r.vendas} vendas`;
        return `
                <div class="hydro-filial-lucro">
                    <span class="hydro-filial-lucro-rotulo">Lucro bruto de ${escapeHtml(nomeMes)}</span>
                    <strong class="hydro-filial-lucro-valor${classe}">${dinheiro(r.lucro)}</strong>
                    <span class="hydro-filial-lucro-sub">Faturamento ${dinheiro(r.faturamento)} · ${vendas}</span>
                </div>`;
    }

    function dadosHtml(f) {
        const linhas = [
            ['CNPJ', f.cnpj],
            ['Telefone', f.telefone],
            ['Endereço', f.endereco],
            ['CEP', f.cep],
        ].filter(([, valor]) => valor);
        if (linhas.length === 0) {
            return '<dl class="hydro-filial-dados"><dt>Dados</dt><dd>Não preenchidos — clique em "Editar".</dd></dl>';
        }
        return `<dl class="hydro-filial-dados">${linhas
            .map(([rotulo, valor]) => `<dt>${rotulo}</dt><dd>${escapeHtml(valor)}</dd>`)
            .join('')}</dl>`;
    }

    function cartaoHtml(f) {
        const ativa = f.status === 'ativa';
        const aqui = Number(f.id_filial) === Number(idFilialAtiva);
        const cor = CORES_LOGO[Number(f.id_filial) % CORES_LOGO.length];
        const local = [f.cidade, f.estado].filter(Boolean).join('/') || 'Cidade não informada';
        return `
            <li class="hydro-filial-card${ativa ? '' : ' hydro-filial-card-inativa'}">
                <div class="hydro-filial-perfil">
                    <div class="hydro-filial-logo" style="background:${cor}" aria-hidden="true">${escapeHtml(iniciais(f.nome))}</div>
                    <div class="hydro-filial-ident">
                        <h3 class="hydro-filial-nome" title="${escapeHtml(f.nome)}">${escapeHtml(f.nome)}</h3>
                        <span class="hydro-filial-local">${escapeHtml(local)}</span>
                        <span class="hydro-filial-selos">
                            <span class="hydro-badge ${ativa ? 'hydro-badge-ok' : 'hydro-badge-neutral'}">${ativa ? 'Ativa' : 'Desativada'}</span>
                            ${aqui ? '<span class="hydro-filial-aqui">Você está aqui</span>' : ''}
                        </span>
                    </div>
                </div>
                ${lucroHtml(f)}
                ${dadosHtml(f)}
                <div class="hydro-filial-acoes">
                    <a class="hydro-btn hydro-btn-outline hydro-btn-sm" href="cadastro-filial.html?id=${encodeURIComponent(f.id_filial)}"
                       aria-label="Editar a filial ${escapeHtml(f.nome)}"><i class="hydro-ic hydro-ic-pencil"></i> Editar</a>
                </div>
            </li>`;
    }

    function renderStats() {
        document.getElementById('hydroStatTotalFiliais').textContent = filiais.length;
        document.getElementById('hydroStatFiliaisAtivas').textContent = filiais.filter((f) => f.status === 'ativa').length;

        const comResumo = filiais.filter((f) => f.resumo_mes);
        const lucroTotal = comResumo.reduce((soma, f) => soma + Number(f.resumo_mes.lucro || 0), 0);
        document.getElementById('hydroStatLucroLabel').textContent = nomeMes
            ? `Lucro de ${nomeMes} (todas)`
            : 'Lucro do mês (todas)';
        document.getElementById('hydroStatLucroTotal').textContent = comResumo.length ? dinheiro(lucroTotal) : '—';
    }

    function render() {
        const termo = normalizar(busca.value.trim());
        const digitos = termo.replace(/\D/g, '');
        const situacao = filtroSituacao.value;

        const visiveis = filiais.filter((f) => {
            if (situacao && f.status !== situacao) return false;
            if (!termo) return true;
            return normalizar(f.nome).includes(termo)
                || normalizar(f.cidade).includes(termo)
                || (digitos !== '' && String(f.cnpj || '').replace(/\D/g, '').includes(digitos));
        });

        if (filiais.length === 0) {
            mostrarMensagem('Nenhuma filial cadastrada ainda. <a href="cadastro-filial.html">Cadastrar nova Filial</a>');
        } else if (visiveis.length === 0) {
            mostrarMensagem('Nenhuma filial encontrada com esses filtros.');
        } else {
            mostrarMensagem('');
        }

        grid.innerHTML = visiveis.map(cartaoHtml).join('');
    }

    busca.addEventListener('input', render);
    filtroSituacao.addEventListener('change', render);

    /* Aviso vindo do cadastro: filiais.html?ok=criada&nome=Centro */
    (function avisoDoCadastro() {
        const params = new URLSearchParams(window.location.search);
        const ok = params.get('ok');
        if (!ok) return;
        const nome = params.get('nome') || '';
        showToast(ok === 'criada' ? `Filial "${nome}" cadastrada` : `Filial "${nome}" atualizada`);
        // Tira o aviso da barra de endereço, para não repetir ao recarregar.
        window.history.replaceState(null, '', window.location.pathname);
    })();

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
        if (!window.hydraApi) {
            mostrarMensagem('Erro ao abrir a tela: o arquivo api.js não foi carregado.');
            return;
        }

        try {
            const { usuario } = await window.hydraApi('/auth/me');
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
            if (!window.hydraGuardaDeTela(usuario, ['loja.configurar'])) return;
        } catch (err) {
            // Antes toda falha virava "Entre no sistema", escondendo erro de
            // servidor ou de conexão. Agora a mensagem diz o que houve.
            console.error('[filiais] GET /api/auth/me falhou:', err && err.status, err && err.message);
            mostrarMensagem(mensagemDeErro(err, 'seus dados de acesso'));
            return;
        }

        try {
            const resposta = await window.hydraApi('/filiais');
            filiais = resposta.filiais || [];
            idFilialAtiva = resposta.id_filial_ativa;
            const [ano, mes] = String(resposta.mes_referencia || '').split('-');
            nomeMes = mes ? `${MESES[Number(mes) - 1]} de ${ano}` : '';
            renderStats();
            render();
        } catch (err) {
            console.error('[filiais] GET /api/filiais falhou:', err && err.status, err && err.message);
            mostrarMensagem(mensagemDeErro(err, 'as filiais'));
        }
    })();
})();
