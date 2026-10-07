(function () {
    'use strict';

    /* Todo texto vindo do banco (nome/descricao de produto, por exemplo)
       passa por aqui antes de ir para innerHTML. Sem isso, um produto
       cadastrado com HTML no nome executaria script na sessao de quem
       abrisse esta tela. Mesma funcao usada em controle-estoque.js. */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : str;
        return div.innerHTML;
    }

    // RN16/RN17 — o painel mostra faturamento e indicadores financeiros, e
    // por isso tem permissao propria ("relatorios.visualizar"). Antes ele
    // exigia "vendas.operar": quem operava o caixa via os numeros da loja de
    // brinde, e nao havia como dar o painel a alguem sem dar tambem o PDV.
    // Visitante da demo publica continua vendo a tela (sem dados reais, ver
    // init() abaixo).
    (async function guardRelatorios() {
        if (!window.hydraApi) return;
        try {
            const { usuario } = await window.hydraApi('/auth/me');
            window.hydraAplicarMenuPorPermissao(usuario);
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraGuardaDeTela(usuario, ['relatorios.visualizar']);
        } catch (err) {
            // Visitante não autenticado (demo pública): mantém a tela visível.
        }
    })();

    HydroStore.seedHistoryIfNeeded();

    /* Conversores do formato retornado pela API real (produtos/vendas/
       movimentacoes_estoque do schema.sql) para o formato usado pelas
       funções de renderização deste dashboard — o mesmo já usado pelo
       catálogo de demonstração do HydroStore. Os ids viram string para
       continuar batendo com as chaves de objeto usadas em buildTopProducts
       (toda chave de objeto em JS é string, então productId precisa ser
       comparado como string também). */
    function mapApiProduct(p) {
        return {
            id: String(p.id_produto),
            name: p.nome,
            quantity: Number(p.quantidade),
            minStock: Number(p.estoque_minimo),
            validade: p.validade,
            costPrice: p.preco_custo == null ? null : Number(p.preco_custo),
        };
    }

    function mapApiVenda(v) {
        return {
            date: v.data_venda,
            total: Number(v.valor_total),
            items: (v.itens || []).map((i) => ({
                productId: String(i.id_produto),
                name: i.nome_produto,
                qty: Number(i.quantidade),
                cost: i.custo_unitario == null ? null : Number(i.custo_unitario),
            })),
        };
    }

    function mapApiMovimentacao(m) {
        return {
            date: m.data_movimentacao,
            type: m.tipo,
            qty: Number(m.quantidade),
            productId: String(m.id_produto),
        };
    }

    /* Produtos que precisam de reposição (Esgotado, Crítico, Atenção), já
       ordenados por gravidade. Preenchido por renderDashboard e usado pelo
       botão "Imprimir lista de compras". */
    let purchaseList = [];

    /* Produtos vencidos ou a vencer, já ordenados (vencidos primeiro, depois
       pela data de validade). Usado pelo botão "Imprimir relatório de validade". */
    let expiryList = [];

    /* Período escolhido no filtro ({ from, to } em YYYY-MM-DD, qualquer um
       dos dois pode ser vazio) ou null quando não há filtro. Só afeta o que
       depende de data de venda: KPIs e top produtos. Os alertas de estoque e
       de validade são sempre a situação de agora. */
    let period = null;

    /* Últimos dados carregados, para redesenhar o painel quando o período
       muda sem buscar tudo de novo na API. */
    let lastData = null;

    /* Dia LOCAL em YYYY-MM-DD, igual ao valor de um <input type="date">.
       HydroStore.todayKey usa toISOString (UTC): depois das 21h em UTC-3 ele
       já devolve o dia seguinte, e "Hoje" no filtro apontaria para amanhã. */
    function localKey(d) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    function keyToDate(key) {
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    function formatKey(key) {
        const [y, m, d] = key.split('-');
        return `${d}/${m}/${y}`;
    }

    function periodLabel(p) {
        if (p.from && p.to) return p.from === p.to ? formatKey(p.from) : `${formatKey(p.from)} a ${formatKey(p.to)}`;
        if (p.from) return `A partir de ${formatKey(p.from)}`;
        return `Até ${formatKey(p.to)}`;
    }

    /* Texto do ícone de informação (passar o mouse para ler). */
    function infoHtml(text) {
        return `<span class="hydro-info" tabindex="0" role="img" aria-label="Ajuda" data-tip="${escapeHtml(text).replace(/"/g, '&quot;')}">i</span>`;
    }

    /**
     * Renderiza todo o dashboard (KPIs, gráficos e tabelas de alerta) a
     * partir de listas de produtos/vendas/movimentações já no formato
     * interno — vindas da API real (usuário autenticado) ou do catálogo
     * de demonstração local (visitante da demo pública).
     */
    function renderDashboard(products, sales, movements) {
        function money(value) {
            return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        }

        function dateKey(iso) {
            return iso.slice(0, 10);
        }

        const today = HydroStore.todayKey();
        const yesterdayDate = new Date();
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        const yesterday = HydroStore.todayKey(yesterdayDate);

        /* ================= KPIs ================= */
        function pctChange(current, previous) {
            if (previous === null || previous === undefined) return null;
            if (previous === 0) return current > 0 ? 100 : null;
            // Math.abs: com base negativa (mês anterior no prejuízo) o sinal sairia invertido.
            return ((current - previous) / Math.abs(previous)) * 100;
        }

        function deltaHtml(pct) {
            if (pct === null) {
                return `<span class="hydro-kpi-delta hydro-kpi-delta-neutral">sem comparativo</span>`;
            }
            const up = pct >= 0;
            const icon = up ? 'hydro-ic-trending-up' : 'hydro-ic-trending-down';
            const cls = up ? 'hydro-kpi-delta-up' : 'hydro-kpi-delta-down';
            return `<span class="hydro-kpi-delta ${cls}"><i class="hydro-ic ${icon}"></i>${up ? '+' : ''}${pct.toFixed(1)}%</span>`;
        }

        const salesToday = sales.filter((s) => dateKey(s.date) === today);
        const salesYesterday = sales.filter((s) => dateKey(s.date) === yesterday);

        const vendasHoje = salesToday.reduce((sum, s) => sum + s.total, 0);
        const vendasOntem = salesYesterday.reduce((sum, s) => sum + s.total, 0);

        /* Vendas do mês: do dia 1 até hoje. O comparativo é com o mesmo
           trecho do mês anterior (dia 1 até o mesmo dia), e não com o mês
           anterior inteiro — senão todo começo de mês pareceria uma queda. */
        const now = new Date();
        const monthStart = HydroStore.todayKey(new Date(now.getFullYear(), now.getMonth(), 1));
        const prevMonthStart = HydroStore.todayKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        const prevMonthLastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
        const prevMonthSameDay = HydroStore.todayKey(
            new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), prevMonthLastDay))
        );

        const salesMonth = sales.filter((s) => dateKey(s.date) >= monthStart && dateKey(s.date) <= today);
        const salesPrevMonth = sales.filter((s) => dateKey(s.date) >= prevMonthStart && dateKey(s.date) <= prevMonthSameDay);

        const vendasMes = salesMonth.reduce((sum, s) => sum + s.total, 0);
        const vendasMesAnterior = salesPrevMonth.reduce((sum, s) => sum + s.total, 0);

        /* Lucro bruto = valor da venda (já com desconto) − custo dos itens
           vendidos. O custo vem do item (API) ou, na demonstração, do
           cadastro do produto; produto sem preço de custo entra com custo 0. */
        const costByProduct = Object.fromEntries(products.map((p) => [String(p.id), p.costPrice]));
        function grossProfit(list) {
            return list.reduce((sum, s) => {
                const custo = (s.items || []).reduce((c, it) => {
                    const unit = it.cost != null ? it.cost : costByProduct[String(it.productId)];
                    return c + it.qty * (Number(unit) || 0);
                }, 0);
                return sum + s.total - custo;
            }, 0);
        }
        /* Vendas do mês passado: o mês anterior INTEIRO (fechado), comparado
           com o mês retrasado também inteiro. */
        const prevMonthEnd = HydroStore.todayKey(new Date(now.getFullYear(), now.getMonth(), 0));
        const prev2MonthStart = HydroStore.todayKey(new Date(now.getFullYear(), now.getMonth() - 2, 1));
        const prev2MonthEnd = HydroStore.todayKey(new Date(now.getFullYear(), now.getMonth() - 1, 0));
        const salesLastMonth = sales.filter((s) => dateKey(s.date) >= prevMonthStart && dateKey(s.date) <= prevMonthEnd);
        const salesMonthBefore = sales.filter((s) => dateKey(s.date) >= prev2MonthStart && dateKey(s.date) <= prev2MonthEnd);
        const vendasMesPassado = salesLastMonth.reduce((sum, s) => sum + s.total, 0);
        const vendasMesRetrasado = salesMonthBefore.reduce((sum, s) => sum + s.total, 0);

        const lucroMes = grossProfit(salesMonth);
        const lucroMesAnterior = grossProfit(salesPrevMonth);

        let kpis = [
            {
                title: 'Vendas Hoje',
                icon: 'hydro-ic-cash',
                iconClass: 'hydro-icon-blue',
                value: money(vendasHoje),
                delta: pctChange(vendasHoje, salesYesterday.length ? vendasOntem : null),
                info: 'Total vendido hoje. A porcentagem compara com o total vendido ontem.',
            },
            {
                title: 'Vendas do Mês',
                icon: 'hydro-ic-receipt',
                iconClass: 'hydro-icon-green',
                value: money(vendasMes),
                delta: pctChange(vendasMes, salesPrevMonth.length ? vendasMesAnterior : null),
                info: 'Total vendido do dia 1 até hoje. A porcentagem compara com o mesmo trecho do mês anterior.',
            },
            {
                title: 'Lucro Bruto do Mês',
                icon: 'hydro-ic-cash',
                iconClass: 'hydro-icon-green',
                value: money(lucroMes),
                delta: pctChange(lucroMes, salesPrevMonth.length ? lucroMesAnterior : null),
                info: 'Valor das vendas do mês menos o preço de custo dos produtos vendidos. Produto sem preço de custo entra com custo zero.',
            },
            {
                title: 'Vendas Mês Passado',
                icon: 'hydro-ic-receipt',
                iconClass: 'hydro-icon-amber',
                value: money(vendasMesPassado),
                delta: pctChange(vendasMesPassado, salesMonthBefore.length ? vendasMesRetrasado : null),
                info: 'Total vendido no mês anterior inteiro. A porcentagem compara com o mês retrasado inteiro.',
            },
        ];

        /* Com filtro de período, os KPIs passam a ser do período escolhido.
           O comparativo é com o período imediatamente anterior de mesmo
           tamanho (ex.: 10 dias contra os 10 dias antes deles) — só existe
           quando as duas datas foram preenchidas. */
        if (period) {
            const from = period.from || '0000-01-01';
            const to = period.to || '9999-12-31';
            const salesPeriod = sales.filter((s) => dateKey(s.date) >= from && dateKey(s.date) <= to);

            let salesBefore = null;
            if (period.from && period.to) {
                const days = Math.round((keyToDate(period.to) - keyToDate(period.from)) / 86400000) + 1;
                const beforeEnd = keyToDate(period.from);
                beforeEnd.setDate(beforeEnd.getDate() - 1);
                const beforeStart = new Date(beforeEnd);
                beforeStart.setDate(beforeStart.getDate() - (days - 1));
                const bs = localKey(beforeStart);
                const be = localKey(beforeEnd);
                salesBefore = sales.filter((s) => dateKey(s.date) >= bs && dateKey(s.date) <= be);
            }
            const compare = (cur, fn) => pctChange(cur, salesBefore && salesBefore.length ? fn(salesBefore) : null);
            const total = (list) => list.reduce((sum, s) => sum + s.total, 0);
            const ticket = (list) => (list.length ? total(list) / list.length : 0);

            const totalPeriodo = total(salesPeriod);
            const lucroPeriodo = grossProfit(salesPeriod);
            const ticketPeriodo = ticket(salesPeriod);
            const comparativo = period.from && period.to
                ? ' A porcentagem compara com o período anterior de mesmo tamanho.'
                : ' Preencha as duas datas para ver o comparativo.';

            kpis = [
                {
                    title: 'Vendas no Período',
                    icon: 'hydro-ic-cash',
                    iconClass: 'hydro-icon-blue',
                    value: money(totalPeriodo),
                    delta: compare(totalPeriodo, total),
                    info: 'Total vendido no período escolhido.' + comparativo,
                },
                {
                    title: 'Lucro Bruto no Período',
                    icon: 'hydro-ic-cash',
                    iconClass: 'hydro-icon-green',
                    value: money(lucroPeriodo),
                    delta: compare(lucroPeriodo, grossProfit),
                    info: 'Valor das vendas do período menos o preço de custo dos produtos vendidos.' + comparativo,
                },
                {
                    title: 'Nº de Vendas',
                    icon: 'hydro-ic-receipt',
                    iconClass: 'hydro-icon-amber',
                    value: salesPeriod.length.toLocaleString('pt-BR'),
                    delta: compare(salesPeriod.length, (list) => list.length),
                    info: 'Quantidade de vendas finalizadas no período escolhido.' + comparativo,
                },
                {
                    title: 'Ticket Médio',
                    icon: 'hydro-ic-receipt',
                    iconClass: 'hydro-icon-green',
                    value: money(ticketPeriodo),
                    delta: compare(ticketPeriodo, ticket),
                    info: 'Valor médio de cada venda no período (total vendido ÷ número de vendas).' + comparativo,
                },
            ];
        }

        document.getElementById('hydroKpiGrid').innerHTML = kpis
            .map(
                (k) => `
        <article class="hydro-kpi-card">
            <div class="hydro-kpi-header">
                <span class="hydro-kpi-title">
                    <span class="hydro-kpi-icon ${k.iconClass}"><i class="hydro-ic ${k.icon}"></i></span>
                    ${k.title}
                </span>
                ${infoHtml(k.info)}
            </div>
            <div class="hydro-kpi-value-row">
                <span class="hydro-kpi-value">${k.value}</span>
                ${deltaHtml(k.delta)}
            </div>
        </article>`
            )
            .join('');

        /* ================= Gráfico: Produtos prestes a vencer (próximos 30 dias) ================= */
        /* Só os que ainda não venceram (os vencidos ficam na tabela de
           validade): ainda dá tempo de vender com promoção. A barra enche
           conforme o vencimento se aproxima; até 7 dias fica vermelha. */
        const EXPIRING_WINDOW = 30;
        const EXPIRING_URGENT = 7;
        const EXPIRING_MAX_ROWS = 6;

        function daysUntil(validade) {
            const todayDate = new Date();
            todayDate.setHours(0, 0, 0, 0);
            return Math.round((new Date(validade + 'T00:00:00') - todayDate) / 86400000);
        }

        const expiring = products
            .filter((p) => p.validade && p.quantity > 0)
            .map((p) => ({ product: p, days: daysUntil(p.validade) }))
            .filter(({ days }) => days >= 0 && days <= EXPIRING_WINDOW)
            .sort((a, b) => a.days - b.days);

        function expiringDaysLabel(days) {
            if (days === 0) return 'Hoje';
            return `${days} ${days === 1 ? 'dia' : 'dias'}`;
        }

        function expiringListHtml(items) {
            const rows = items
                .slice(0, EXPIRING_MAX_ROWS)
                .map(({ product, days }) => {
                    const urgent = days <= EXPIRING_URGENT ? ' hydro-expiring-urgent' : '';
                    const fill = Math.max(8, Math.round(((EXPIRING_WINDOW - days) / EXPIRING_WINDOW) * 100));
                    return `
                <a class="hydro-expiring-row" href="promocoes.html?produto=${encodeURIComponent(product.id)}" title="Criar promoção para ${escapeHtml(product.name)}">
                    <span class="hydro-expiring-name">${escapeHtml(product.name)}</span>
                    <span class="hydro-expiring-bar"><span class="hydro-expiring-fill${urgent}" style="width:${fill}%"></span></span>
                    <span class="hydro-expiring-days${urgent}">${expiringDaysLabel(days)}</span>
                </a>`;
                })
                .join('');
            const rest = items.length - EXPIRING_MAX_ROWS;
            const more = rest > 0
                ? `<p class="hydro-expiring-more">+ ${rest} ${rest === 1 ? 'produto' : 'produtos'} vencendo nos próximos 30 dias</p>`
                : '';
            return `<div class="hydro-expiring-list">${rows}${more}</div>`;
        }

        document.getElementById('hydroExpiringChart').innerHTML = expiring.length
            ? expiringListHtml(expiring)
            : '<p class="hydro-chart-empty">Nenhum produto vencendo nos próximos 30 dias.</p>';
        const expiringCta = document.getElementById('hydroExpiringCta');
        if (expiringCta) expiringCta.hidden = !expiring.length;

        /* ================= Gráfico: Top produtos mais vendidos ================= */
        /* Soma a quantidade vendida de cada produto nos itens das vendas dos
           últimos 30 dias (não as movimentações de estoque, que misturam
           entradas, ajustes e perdas com as vendas). */
        function buildTopProducts() {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - 29);
            // Com filtro, usa o período escolhido no lugar dos últimos 30 dias.
            const from = period ? period.from || '0000-01-01' : HydroStore.todayKey(cutoffDate);
            const to = period ? period.to || '9999-12-31' : '9999-12-31';

            const totals = {};
            sales
                .filter((s) => dateKey(s.date) >= from && dateKey(s.date) <= to)
                .forEach((s) => {
                    (s.items || []).forEach((it) => {
                        const id = String(it.productId);
                        if (!totals[id]) totals[id] = { qty: 0, name: it.name };
                        totals[id].qty += Number(it.qty) || 0;
                    });
                });
            return Object.entries(totals)
                .map(([productId, t]) => {
                    const product = products.find((p) => String(p.id) === productId);
                    // Arredonda para não exibir "2.4999999" em produtos vendidos por kg.
                    return { name: product ? product.name : t.name || 'Produto removido', qty: Math.round(t.qty * 1000) / 1000 };
                })
                .sort((a, b) => b.qty - a.qty)
                .slice(0, 8);
        }

        function shortName(name) {
            return name.length > 12 ? name.slice(0, 11) + '…' : name;
        }

        function barChartSvg(items) {
            const width = 720;
            const height = 230;
            const padding = { top: 16, right: 16, bottom: 40, left: 30 };
            const chartW = width - padding.left - padding.right;
            const chartH = height - padding.top - padding.bottom;
            const maxVal = Math.max(1, ...items.map((i) => i.qty));
            const barGap = 14;
            const barW = (chartW - barGap * (items.length - 1)) / items.length;

            const bars = items
                .map((item, i) => {
                    const x = padding.left + i * (barW + barGap);
                    const barH = (item.qty / maxVal) * chartH;
                    const y = padding.top + chartH - barH;
                    const isTop = i === 0;
                    const fill = isTop ? 'var(--navy-active)' : 'var(--muted-soft)';
                    const opacity = isTop ? '1' : '.35';
                    return `
                <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="5" fill="${fill}" fill-opacity="${opacity}" />
                <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" font-weight="700" fill="var(--navy-900)" text-anchor="middle">${item.qty.toLocaleString('pt-BR')}</text>
                <text x="${(x + barW / 2).toFixed(1)}" y="${height - 20}" font-size="10" fill="var(--muted-soft)" text-anchor="middle">${escapeHtml(shortName(item.name))}</text>`;
                })
                .join('');

            return `
        <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <line x1="${padding.left}" y1="${padding.top + chartH}" x2="${width - padding.right}" y2="${padding.top + chartH}" stroke="var(--border)" stroke-width="1" />
            ${bars}
        </svg>`;
        }

        const topProducts = buildTopProducts();
        document.getElementById('hydroTopPeriod').textContent = period ? periodLabel(period) : 'Últimos 30 dias';
        document.getElementById('hydroTopChart').innerHTML = topProducts.length
            ? barChartSvg(topProducts)
            : `<p class="hydro-chart-empty">${period ? 'Nenhum produto vendido no período escolhido.' : 'Ainda não há produtos vendidos nos últimos 30 dias.'}</p>`;

        /* ================= Alertas de estoque ================= */
        /* "Esgotado" compartilha o vermelho de "Crítico" (os dois pedem
           reposição), mas vem primeiro na ordenação: é o que já parou de
           vender. */
        const STATUS_META = {
            empty: { label: 'Esgotado', badge: 'hydro-badge-critical', qty: 'hydro-alert-qty-critical' },
            critical: { label: 'Crítico', badge: 'hydro-badge-critical', qty: 'hydro-alert-qty-critical' },
            warning: { label: 'Atenção', badge: 'hydro-badge-warning', qty: 'hydro-alert-qty-warning' },
            ok: { label: 'Em estoque', badge: 'hydro-badge-ok', qty: 'hydro-alert-qty-ok' },
        };

        const withStatus = products.map((p) => ({
            product: p,
            statusKey: HydroStore.stockStatus(p.quantity, p.minStock),
        }));

        const severityOrder = { empty: 0, critical: 1, warning: 2, ok: 3 };
        withStatus.sort((a, b) => severityOrder[a.statusKey] - severityOrder[b.statusKey] || a.product.quantity - b.product.quantity);
        const alertRows = withStatus.slice(0, 6);

        // A tabela mostra só os 6 piores; a lista de compras impressa leva
        // todos os que precisam de reposição, na mesma ordem de gravidade.
        purchaseList = withStatus
            .filter(({ statusKey }) => statusKey !== 'ok')
            .map(({ product, statusKey }) => ({ product, statusKey, label: STATUS_META[statusKey].label }));

        const alertsBody = document.getElementById('hydroAlertsBody');
        const alertsEmpty = document.getElementById('hydroAlertsEmpty');

        if (!alertRows.length) {
            alertsEmpty.hidden = false;
        } else {
            alertsBody.innerHTML = alertRows
                .map(({ product, statusKey }) => {
                    const meta = STATUS_META[statusKey];
                    return `
                <tr>
                    <td class="hydro-alert-product">${escapeHtml(product.name)}</td>
                    <td><span class="hydro-alert-qty ${meta.qty}">${product.quantity}</span></td>
                    <td>${product.minStock}</td>
                    <td><span class="hydro-badge ${meta.badge}">${meta.label}</span></td>
                    <td><a class="hydro-view-link" href="controle-estoque.html?busca=${encodeURIComponent(product.name)}">Ver produto</a></td>
                </tr>`;
                })
                .join('');
        }

        /* ================= Alertas de validade ================= */
        const EXPIRY_STATUS_META = {
            expired: { label: 'Vencido', badge: 'hydro-badge-critical', qty: 'hydro-alert-qty-critical' },
            warning: { label: 'Vence em breve', badge: 'hydro-badge-warning', qty: 'hydro-alert-qty-warning' },
        };

        function formatDate(isoDate) {
            const [y, m, d] = isoDate.split('-');
            return `${d}/${m}/${y}`;
        }

        const expirySeverity = { expired: 0, warning: 1 };
        const allExpiryRows = products
            .map((p) => ({ product: p, statusKey: HydroStore.expiryStatus(p.validade) }))
            .filter(({ statusKey }) => statusKey === 'expired' || statusKey === 'warning')
            .sort((a, b) => expirySeverity[a.statusKey] - expirySeverity[b.statusKey] || a.product.validade.localeCompare(b.product.validade));
        const expiryRows = allExpiryRows.slice(0, 6);

        // Mesma ideia da lista de compras: a tabela mostra 6, o relatório impresso leva todos.
        expiryList = allExpiryRows.map(({ product, statusKey }) => ({
            product,
            statusKey,
            label: EXPIRY_STATUS_META[statusKey].label,
            validadeFmt: formatDate(product.validade),
        }));

        const expiryBody = document.getElementById('hydroExpiryBody');
        const expiryEmpty = document.getElementById('hydroExpiryEmpty');

        if (!expiryRows.length) {
            expiryEmpty.hidden = false;
        } else {
            expiryBody.innerHTML = expiryRows
                .map(({ product, statusKey }) => {
                    const meta = EXPIRY_STATUS_META[statusKey];
                    return `
                <tr>
                    <td class="hydro-alert-product">${escapeHtml(product.name)}</td>
                    <td><span class="hydro-alert-qty ${meta.qty}">${product.quantity}</span></td>
                    <td>${formatDate(product.validade)}</td>
                    <td><span class="hydro-badge ${meta.badge}">${meta.label}</span></td>
                    <td><a class="hydro-view-link" href="controle-estoque.html?busca=${encodeURIComponent(product.name)}">Ver produto</a></td>
                </tr>`;
                })
                .join('');
        }
    }

    /* ================= Carga de dados: API real (autenticado) ou catálogo de demonstração ================= */
    (async function init() {
        if (window.hydraApi) {
            try {
                await window.hydraApi('/auth/me');
                /* allSettled, e não all: as três chamadas têm permissões
                   distintas, e um cargo pode ter umas e não outras — por
                   exemplo, "relatorios.visualizar" sem "estoque.consultar"
                   leva 403 em GET /api/estoque/movimentacoes. Com
                   Promise.all esse 403 derrubava as três chamadas e o painel
                   inteiro passava a mostrar números de DEMONSTRAÇÃO, sem
                   avisar — o dono olharia um faturamento inventado. Agora
                   cada parte que o cargo pode ver é real, e o gráfico de
                   movimentações simplesmente fica vazio. */
                const [produtosRes, vendasRes, movRes] = await Promise.allSettled([
                    window.hydraApi('/produtos'),
                    window.hydraApi('/vendas'),
                    window.hydraApi('/estoque/movimentacoes'),
                ]);

                // Se nem produtos nem vendas vieram, não há painel a montar:
                // cai para a demonstração (visitante ou cargo sem acesso).
                if (produtosRes.status === 'rejected' && vendasRes.status === 'rejected') {
                    throw produtosRes.reason;
                }

                lastData = [
                    produtosRes.status === 'fulfilled' ? produtosRes.value.produtos.map(mapApiProduct) : [],
                    vendasRes.status === 'fulfilled' ? vendasRes.value.vendas.filter((v) => v.status !== 'cancelada').map(mapApiVenda) : [],
                    movRes.status === 'fulfilled' ? movRes.value.movimentacoes.map(mapApiMovimentacao) : [],
                ];
                renderDashboard(...lastData);
                return;
            } catch (err) {
                // Visitante não autenticado, ou cargo sem acesso nem a Produtos
                // nem a Vendas — mostra o catálogo de demonstração local.
            }
        }
        lastData = [HydroStore.getProducts(), HydroStore.getSales(), HydroStore.getMovements()];
        renderDashboard(...lastData);
    })();

    /* ================= Filtro de período ================= */
    const periodFrom = document.getElementById('hydroPeriodFrom');
    const periodTo = document.getElementById('hydroPeriodTo');
    const periodClear = document.getElementById('hydroPeriodClear');
    const presetButtons = Array.from(document.querySelectorAll('#hydroPeriodPresets [data-preset]'));

    function presetRange(preset) {
        const now = new Date();
        const today = localKey(now);
        if (preset === 'hoje') return { from: today, to: today };
        if (preset === '7' || preset === '30') {
            const start = new Date(now);
            start.setDate(start.getDate() - (Number(preset) - 1));
            return { from: localKey(start), to: today };
        }
        if (preset === 'mes') {
            return { from: localKey(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
        }
        // mes-passado
        return {
            from: localKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
            to: localKey(new Date(now.getFullYear(), now.getMonth(), 0)),
        };
    }

    function applyPeriod(activePreset) {
        const from = periodFrom.value;
        const to = periodTo.value;
        if (from && to && from > to) {
            showToast('A data inicial não pode ser depois da data final.');
            return;
        }
        period = from || to ? { from, to } : null;
        periodClear.hidden = !period;
        presetButtons.forEach((b) => b.classList.toggle('hydro-active', b.dataset.preset === activePreset));
        if (lastData) renderDashboard(...lastData);
    }

    presetButtons.forEach((button) => {
        button.addEventListener('click', () => {
            const range = presetRange(button.dataset.preset);
            periodFrom.value = range.from;
            periodTo.value = range.to;
            applyPeriod(button.dataset.preset);
        });
    });

    [periodFrom, periodTo].forEach((input) => input.addEventListener('change', () => applyPeriod(null)));

    periodClear.addEventListener('click', () => {
        periodFrom.value = '';
        periodTo.value = '';
        applyPeriod(null);
    });

    /* ================= Relatórios impressos (lista de compras e validade) ================= */

    /* Documento comum aos dois relatórios: cabeçalho com título e data de
       emissão, as seções por status e uma nota de rodapé. */
    function reportDocument({ title, summary, sections, footer }) {
        const now = new Date();
        const emitido = now.toLocaleDateString('pt-BR') + ' às ' +
            now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>${title} - ${now.toLocaleDateString('pt-BR')}</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 24px; font-size: 12px; }
    header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #152e6d; padding-bottom: 8px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0; color: #152e6d; }
    .meta { font-size: 11px; color: #555; text-align: right; }
    h2 { font-size: 14px; margin: 18px 0 6px; color: #152e6d; }
    h2 small { font-weight: normal; color: #555; }
    table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
    tr { page-break-inside: avoid; }
    th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: left; }
    th { background: #eef1f7; font-size: 11px; text-transform: uppercase; }
    .num { text-align: right; white-space: nowrap; }
    .strong { font-weight: bold; }
    .check { width: 28px; text-align: center; font-size: 14px; }
    footer { margin-top: 18px; font-size: 10.5px; color: #555; }
    @page { margin: 14mm; }
</style>
</head>
<body>
    <header>
        <h1>${title}</h1>
        <div class="meta">Emitido em ${emitido}<br>${summary}</div>
    </header>
    ${sections}
    <footer>${footer}</footer>
</body>
</html>`;
    }

    function sectionHtml(title, count, headCells, bodyRows) {
        return `
                <h2>${title} <small>(${count} ${count === 1 ? 'item' : 'itens'})</small></h2>
                <table>
                    <thead><tr><th class="check"></th>${headCells}</tr></thead>
                    <tbody>${bodyRows}</tbody>
                </table>`;
    }

    function buildPurchaseReportHtml(items) {
        const groups = [
            { title: 'Esgotado', key: 'empty' },
            { title: 'Crítico', key: 'critical' },
            { title: 'Atenção', key: 'warning' },
        ];

        const sections = groups
            .map((g) => {
                const rows = items.filter((i) => i.statusKey === g.key);
                if (!rows.length) return '';
                const body = rows
                    .map(({ product, label }) => {
                        const comprar = Math.max(product.minStock - product.quantity, 0);
                        return `
                    <tr>
                        <td class="check">&#9744;</td>
                        <td>${escapeHtml(product.name)}</td>
                        <td>${label}</td>
                        <td class="num">${product.quantity}</td>
                        <td class="num">${product.minStock}</td>
                        <td class="num strong">${comprar}</td>
                    </tr>`;
                    })
                    .join('');
                return sectionHtml(
                    g.title,
                    rows.length,
                    '<th>Produto</th><th>Status</th><th class="num">Estoque atual</th><th class="num">Estoque mínimo</th><th class="num">Comprar (mín.)</th>',
                    body
                );
            })
            .join('');

        return reportDocument({
            title: 'Lista de compras',
            summary: `${items.length} ${items.length === 1 ? 'produto' : 'produtos'} para repor`,
            sections,
            footer: '"Comprar (mín.)" é a quantidade que falta para o produto voltar ao estoque mínimo.',
        });
    }

    /* "Vencido há 3 dias", "Vence hoje", "Vence em 12 dias" — mesma conta de
       dias usada por HydroStore.expiryStatus. */
    function expiryDaysText(validade) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const days = Math.round((new Date(validade + 'T00:00:00') - today) / 86400000);
        if (days < 0) return `Vencido há ${-days} ${days === -1 ? 'dia' : 'dias'}`;
        if (days === 0) return 'Vence hoje';
        return `Vence em ${days} ${days === 1 ? 'dia' : 'dias'}`;
    }

    function buildExpiryReportHtml(items) {
        const groups = [
            { title: 'Vencidos', key: 'expired' },
            { title: 'Vencem em breve', key: 'warning' },
        ];

        const sections = groups
            .map((g) => {
                const rows = items.filter((i) => i.statusKey === g.key);
                if (!rows.length) return '';
                const body = rows
                    .map(({ product, label, validadeFmt }) => `
                    <tr>
                        <td class="check">&#9744;</td>
                        <td>${escapeHtml(product.name)}</td>
                        <td>${label}</td>
                        <td class="num">${product.quantity}</td>
                        <td class="num">${validadeFmt}</td>
                        <td class="strong">${expiryDaysText(product.validade)}</td>
                    </tr>`)
                    .join('');
                return sectionHtml(
                    g.title,
                    rows.length,
                    '<th>Produto</th><th>Status</th><th class="num">Quantidade</th><th class="num">Validade</th><th>Situação</th>',
                    body
                );
            })
            .join('');

        return reportDocument({
            title: 'Produtos vencidos ou a vencer',
            summary: `${items.length} ${items.length === 1 ? 'produto' : 'produtos'} para conferir`,
            sections,
            footer: `"Vencem em breve" são os produtos com validade nos próximos 30 dias. Vencidos devem ser retirados da venda.`,
        });
    }

    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('hydro-show');
        setTimeout(() => toast.classList.remove('hydro-show'), 3000);
    }

    // Iframe oculto em vez de window.open: não é barrado por bloqueador de pop-up.
    function printHtml(html) {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.appendChild(frame);
        const doc = frame.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();
        frame.contentWindow.onafterprint = () => frame.remove();
        frame.contentWindow.focus();
        frame.contentWindow.print();
    }

    /* Liga um botão de impressão às caixas de status ao lado dele. A escolha
       das caixas fica salva só neste navegador, para o dono não precisar
       desmarcar tudo de novo toda vez. */
    function setupPrintButton({ buttonId, filterId, storageKey, getItems, buildHtml, noneSelectedMsg, emptyMsg }) {
        const button = document.getElementById(buttonId);
        const boxes = Array.from(document.querySelectorAll(`#${filterId} input[type="checkbox"]`));
        if (!button) return;

        const selectedValues = () => boxes.filter((b) => b.checked).map((b) => b.value);

        try {
            const saved = JSON.parse(localStorage.getItem(storageKey));
            if (Array.isArray(saved)) {
                boxes.forEach((box) => { box.checked = saved.includes(box.value); });
            }
        } catch (err) {
            // Sem localStorage (aba anônima, etc.): fica com todas marcadas.
        }

        boxes.forEach((box) => {
            box.addEventListener('change', () => {
                try {
                    localStorage.setItem(storageKey, JSON.stringify(selectedValues()));
                } catch (err) { /* ignora */ }
            });
        });

        button.addEventListener('click', () => {
            const selected = selectedValues();
            if (!selected.length) {
                showToast(noneSelectedMsg);
                return;
            }
            const items = getItems().filter((i) => selected.includes(i.statusKey));
            if (!items.length) {
                showToast(emptyMsg);
                return;
            }
            printHtml(buildHtml(items));
        });
    }

    setupPrintButton({
        buttonId: 'hydroPrintPurchase',
        filterId: 'hydroPrintFilter',
        storageKey: 'hydra.listaCompras.status',
        getItems: () => purchaseList,
        buildHtml: buildPurchaseReportHtml,
        noneSelectedMsg: 'Marque pelo menos um status (Esgotado, Crítico ou Atenção).',
        emptyMsg: 'Nenhum produto nos status marcados — não há o que comprar.',
    });

    setupPrintButton({
        buttonId: 'hydroPrintExpiry',
        filterId: 'hydroPrintExpiryFilter',
        storageKey: 'hydra.relatorioValidade.status',
        getItems: () => expiryList,
        buildHtml: buildExpiryReportHtml,
        noneSelectedMsg: 'Marque pelo menos um status (Vencido ou Vence em breve).',
        emptyMsg: 'Nenhum produto nos status marcados.',
    });

    /* ================= Busca (atalho para Estoque) ================= */
    document.getElementById('hydroSearchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
            window.location.href = 'controle-estoque.html?busca=' + encodeURIComponent(e.target.value.trim());
        }
    });

    /* ================= Mobile sidebar ================= */
    const sidebar = document.getElementById('hydroSidebar');
    const overlay = document.getElementById('hydroSidebarOverlay');
    const mobileToggle = document.getElementById('hydroMobileToggle');
    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            sidebar.classList.add('hydro-open');
            overlay.classList.add('hydro-show');
        });
        overlay.addEventListener('click', () => {
            sidebar.classList.remove('hydro-open');
            overlay.classList.remove('hydro-show');
        });
    }
})();
