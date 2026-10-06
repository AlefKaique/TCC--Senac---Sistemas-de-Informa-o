(function () {
    'use strict';

    /* Todo texto vindo do banco passa por aqui antes de ir para innerHTML
       (mesma função de controle-estoque.js e dashboard.js). */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : str;
        return div.innerHTML;
    }

    function money(value) {
        return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function formatDate(iso) {
        const [y, m, d] = String(iso).slice(0, 10).split('-');
        return `${d}/${m}/${y}`;
    }

    /* Diferença em dias entre duas datas "AAAA-MM-DD". Feita em UTC para o
       horário de verão não transformar um dia em 23 ou 25 horas. */
    function daysBetween(fromIso, toIso) {
        const [y1, m1, d1] = fromIso.split('-').map(Number);
        const [y2, m2, d2] = toIso.split('-').map(Number);
        return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
    }

    function stockLabel(qty, unit) {
        const n = Number(qty);
        if (unit === 'kg') return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg`;
        return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${unit || 'un'}`;
    }

    function perUnit(unit) {
        return unit === 'kg' ? '/kg' : '';
    }

    /* ================= Toast ================= */
    let toastTimer = null;
    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        toast.textContent = message;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 3000);
    }

    /* ================= Estado ================= */
    // "hoje" vem do servidor, para a tela concordar com a regra que o
    // back-end usa ao decidir se a promoção está valendo.
    let hoje = new Date().toISOString().slice(0, 10);
    let produtosAVencer = [];
    let promocoes = [];

    /* Promoção ainda valendo ou agendada (não encerrada e não terminada). */
    function promoEmAberto(p) {
        return p.status === 'ativa' && p.data_fim >= hoje;
    }

    /* ================= Tabela: produtos prestes a vencer ================= */
    function renderExpiring() {
        const body = document.getElementById('hydroExpiringBody');
        const empty = document.getElementById('hydroExpiringEmpty');
        empty.classList.toggle('hydro-is-visible', produtosAVencer.length === 0);

        const comPromo = new Set(promocoes.filter(promoEmAberto).map((p) => String(p.id_produto)));

        body.innerHTML = produtosAVencer
            .map((p) => {
                const dias = daysBetween(hoje, p.validade);
                const diasTexto = dias === 0 ? 'Vence hoje' : dias === 1 ? 'Vence amanhã' : `Vence em ${dias} dias`;
                const acao = comPromo.has(String(p.id_produto))
                    ? '<span class="hydro-badge hydro-badge-ok">Em promoção</span>'
                    : `<button type="button" class="hydro-btn hydro-btn-primary hydro-btn-sm" data-criar="${p.id_produto}">Criar promoção</button>`;
                return `
                <tr>
                    <td>
                        <p class="hydro-product-name">${escapeHtml(p.nome)}</p>
                        <p class="hydro-product-desc">${escapeHtml(p.categoria || '')}</p>
                    </td>
                    <td>
                        <div class="hydro-expiry-cell">
                            <span class="hydro-expiry-date">${formatDate(p.validade)}</span>
                            <span class="hydro-promo-days${dias <= 7 ? ' hydro-promo-days-urgent' : ''}">${diasTexto}</span>
                        </div>
                    </td>
                    <td class="hydro-qty">${stockLabel(p.quantidade, p.unidade)}</td>
                    <td>${money(p.preco_venda)}${perUnit(p.unidade)}</td>
                    <td>${p.preco_custo != null ? money(p.preco_custo) + perUnit(p.unidade) : '<span class="hydro-text-muted">—</span>'}</td>
                    <td><div class="hydro-row-actions">${acao}</div></td>
                </tr>`;
            })
            .join('');
    }

    /* ================= Tabela: promoções ================= */
    function situacao(p) {
        if (p.status === 'encerrada') return { label: 'Encerrada', badge: 'hydro-badge-neutral' };
        if (p.data_fim < hoje) return { label: 'Finalizada', badge: 'hydro-badge-neutral' };
        if (p.data_inicio > hoje) return { label: 'Agendada', badge: 'hydro-badge-attention' };
        return { label: 'Em andamento', badge: 'hydro-badge-ok' };
    }

    function renderPromos() {
        const body = document.getElementById('hydroPromoBody');
        const empty = document.getElementById('hydroPromoEmpty');
        empty.classList.toggle('hydro-is-visible', promocoes.length === 0);

        body.innerHTML = promocoes
            .map((p) => {
                const normal = Number(p.preco_venda);
                const promo = Number(p.preco_promocional);
                const desconto = normal > 0 ? Math.round((1 - promo / normal) * 100) : 0;
                const sit = situacao(p);
                const periodo = p.data_inicio === p.data_fim
                    ? formatDate(p.data_inicio)
                    : `${formatDate(p.data_inicio)} a ${formatDate(p.data_fim)}`;
                const acao = promoEmAberto(p)
                    ? `<button type="button" class="hydro-promo-link" data-encerrar="${p.id_promocao}">Encerrar</button>`
                    : '';
                return `
                <tr>
                    <td><p class="hydro-product-name">${escapeHtml(p.nome_produto)}</p></td>
                    <td>
                        <div class="hydro-promo-price">
                            <s>${money(normal)}${perUnit(p.unidade)}</s>
                            <strong>${money(promo)}${perUnit(p.unidade)}</strong>
                        </div>
                    </td>
                    <td>${desconto}%</td>
                    <td>${periodo}</td>
                    <td><span class="hydro-badge ${sit.badge}">${sit.label}</span></td>
                    <td>${escapeHtml(p.nome_usuario || '—')}</td>
                    <td><div class="hydro-row-actions">${acao}</div></td>
                </tr>`;
            })
            .join('');
    }

    function renderAll() {
        renderExpiring();
        renderPromos();
    }

    async function load() {
        const data = await window.hydraApi('/promocoes');
        hoje = data.hoje || hoje;
        produtosAVencer = data.produtos_a_vencer || [];
        promocoes = data.promocoes || [];
        renderAll();
    }

    /* ================= Modal: criar promoção ================= */
    const modal = document.getElementById('hydroPromoModal');
    const form = document.getElementById('hydroPromoForm');
    const descontoEl = document.getElementById('hydroPromoDesconto');
    const precoEl = document.getElementById('hydroPromoPreco');
    const inicioEl = document.getElementById('hydroPromoInicio');
    const fimEl = document.getElementById('hydroPromoFim');
    const marginEl = document.getElementById('hydroPromoMargin');
    let produtoSelecionado = null;

    function updateMargin() {
        const p = produtoSelecionado;
        const preco = parseFloat(precoEl.value);
        marginEl.classList.remove('hydro-promo-margin-loss');
        if (!p || !(preco > 0)) {
            marginEl.textContent = '';
            return;
        }
        if (p.preco_custo == null) {
            marginEl.textContent = 'Produto sem preço de custo cadastrado: não dá para calcular o lucro.';
            return;
        }
        const lucro = preco - Number(p.preco_custo);
        if (lucro < 0) {
            marginEl.classList.add('hydro-promo-margin-loss');
            marginEl.textContent = `Abaixo do custo: prejuízo de ${money(-lucro)} por ${p.unidade === 'kg' ? 'kg' : 'unidade'}. Ainda pode valer a pena se o produto for virar perda.`;
        } else {
            marginEl.textContent = `Lucro de ${money(lucro)} por ${p.unidade === 'kg' ? 'kg' : 'unidade'}.`;
        }
    }

    // Desconto e preço andam juntos: mudar um recalcula o outro.
    descontoEl.addEventListener('input', () => {
        const pct = parseFloat(descontoEl.value);
        if (produtoSelecionado && pct > 0 && pct < 100) {
            precoEl.value = (Number(produtoSelecionado.preco_venda) * (1 - pct / 100)).toFixed(2);
        }
        updateMargin();
    });

    precoEl.addEventListener('input', () => {
        const preco = parseFloat(precoEl.value);
        const normal = produtoSelecionado ? Number(produtoSelecionado.preco_venda) : 0;
        descontoEl.value = preco > 0 && normal > 0 ? Math.round((1 - preco / normal) * 100) : '';
        updateMargin();
    });

    function openModal(idProduto) {
        const p = produtosAVencer.find((x) => String(x.id_produto) === String(idProduto));
        if (!p) return;
        produtoSelecionado = p;

        document.getElementById('hydroPromoProductName').textContent = p.nome;
        const custo = p.preco_custo != null ? ` · Custo ${money(p.preco_custo)}${perUnit(p.unidade)}` : '';
        document.getElementById('hydroPromoProductInfo').textContent =
            `Preço normal ${money(p.preco_venda)}${perUnit(p.unidade)}${custo} · Vence em ${formatDate(p.validade)} · ${stockLabel(p.quantidade, p.unidade)} em estoque`;

        // Sugestão inicial: 30% de desconto, de hoje até a validade.
        descontoEl.value = 30;
        precoEl.value = (Number(p.preco_venda) * 0.7).toFixed(2);
        precoEl.max = (Number(p.preco_venda) - 0.01).toFixed(2);
        inicioEl.value = hoje;
        inicioEl.min = hoje;
        inicioEl.max = p.validade;
        fimEl.value = p.validade;
        fimEl.min = hoje;
        fimEl.max = p.validade;
        updateMargin();

        modal.classList.add('hydro-show');
        precoEl.focus();
    }

    function closeModal() {
        modal.classList.remove('hydro-show');
        produtoSelecionado = null;
    }

    document.getElementById('hydroPromoCancel').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('hydro-show')) closeModal();
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const p = produtoSelecionado;
        if (!p) return;

        const preco = parseFloat(precoEl.value);
        if (!(preco > 0)) {
            showToast('Informe o preço promocional');
            return;
        }
        if (preco >= Number(p.preco_venda)) {
            showToast('O preço promocional precisa ser menor que o preço normal');
            return;
        }
        if (!inicioEl.value || !fimEl.value) {
            showToast('Informe as datas de início e fim');
            return;
        }
        if (fimEl.value < inicioEl.value) {
            showToast('A data de fim não pode ser anterior à de início');
            return;
        }

        const btn = document.getElementById('hydroPromoSave');
        btn.disabled = true;
        try {
            await window.hydraApi('/promocoes', {
                method: 'POST',
                body: {
                    id_produto: Number(p.id_produto),
                    preco_promocional: preco,
                    data_inicio: inicioEl.value,
                    data_fim: fimEl.value,
                },
            });
            closeModal();
            showToast('Promoção criada. O novo preço já vale no Caixa durante o período.');
            await load();
        } catch (err) {
            showToast(err.message);
        } finally {
            btn.disabled = false;
        }
    });

    /* ================= Ações das tabelas ================= */
    document.getElementById('hydroExpiringBody').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-criar]');
        if (btn) openModal(btn.dataset.criar);
    });

    document.getElementById('hydroPromoBody').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-encerrar]');
        if (!btn) return;
        const promo = promocoes.find((p) => String(p.id_promocao) === btn.dataset.encerrar);
        const nome = promo ? promo.nome_produto : 'este produto';
        if (!window.confirm(`Encerrar a promoção de "${nome}"? O produto volta ao preço normal no Caixa.`)) return;

        btn.disabled = true;
        try {
            await window.hydraApi(`/promocoes/${btn.dataset.encerrar}/encerrar`, { method: 'POST' });
            showToast('Promoção encerrada');
            await load();
        } catch (err) {
            showToast(err.message);
            btn.disabled = false;
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
            const { usuario } = await window.hydraApi('/auth/me');
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
            // Mesma permissão que a API exige em /api/promocoes.
            if (!window.hydraGuardaDeTela(usuario, ['produtos.editar_preco'])) return;
        } catch (err) {
            // Visitante não autenticado (demo pública): tela vazia, sem dados reais.
            renderAll();
            return;
        }

        try {
            await load();
            // Vindo do Relatório com ?produto=ID: já abre a promoção daquele produto.
            const idProduto = new URLSearchParams(window.location.search).get('produto');
            if (idProduto) openModal(idProduto);
        } catch (err) {
            showToast(err.message);
        }
    })();
})();
