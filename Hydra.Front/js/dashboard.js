(function () {
    'use strict';

    HydroStore.seedHistoryIfNeeded();

    const products = HydroStore.getProducts();
    const sales = HydroStore.getSales();
    const movements = HydroStore.getMovements();

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
        return ((current - previous) / previous) * 100;
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

    const ticketHoje = salesToday.length ? vendasHoje / salesToday.length : 0;
    const ticketOntem = salesYesterday.length ? vendasOntem / salesYesterday.length : 0;

    const totalProdutos = products.length;
    const totalEstoque = products.reduce((sum, p) => sum + (p.quantity || 0), 0);

    const prevSnapshot = HydroStore.getPreviousSnapshot();

    const kpis = [
        {
            title: 'Vendas Hoje',
            icon: 'hydro-ic-cash',
            iconClass: 'hydro-icon-blue',
            value: money(vendasHoje),
            delta: pctChange(vendasHoje, salesYesterday.length ? vendasOntem : null),
        },
        {
            title: 'Ticket Médio',
            icon: 'hydro-ic-receipt',
            iconClass: 'hydro-icon-green',
            value: money(ticketHoje),
            delta: pctChange(ticketHoje, salesYesterday.length ? ticketOntem : null),
        },
        {
            title: 'Total produtos',
            icon: 'hydro-ic-box',
            iconClass: 'hydro-icon-blue',
            value: totalProdutos.toLocaleString('pt-BR'),
            delta: prevSnapshot ? pctChange(totalProdutos, prevSnapshot.totalProdutos) : null,
        },
        {
            title: 'Total estoque',
            icon: 'hydro-ic-inventory',
            iconClass: 'hydro-icon-amber',
            value: totalEstoque.toLocaleString('pt-BR'),
            delta: prevSnapshot ? pctChange(totalEstoque, prevSnapshot.totalEstoque) : null,
        },
    ];

    document.getElementById('hydroKpiGrid').innerHTML = kpis
        .map(
            (k) => `
        <article class="hydro-kpi-card">
            <div class="hydro-kpi-header">
                <span class="hydro-kpi-title">
                    <span class="hydro-kpi-icon ${k.iconClass}"><i class="hydro-ic ${k.icon}"></i></span>
                    ${k.title}
                </span>
                <span class="hydro-kpi-more">···</span>
            </div>
            <div class="hydro-kpi-value-row">
                <span class="hydro-kpi-value">${k.value}</span>
                ${deltaHtml(k.delta)}
            </div>
        </article>`
        )
        .join('');

    HydroStore.snapshotToday({ totalProdutos, totalEstoque });

    /* ================= Gráfico: Entradas x Saídas (últimos 30 dias) ================= */
    function buildDailySeries() {
        const days = [];
        for (let d = 29; d >= 0; d--) {
            const date = new Date();
            date.setDate(date.getDate() - d);
            days.push({ key: HydroStore.todayKey(date), date, entradas: 0, saidas: 0 });
        }
        const byKey = Object.fromEntries(days.map((d) => [d.key, d]));

        movements.forEach((m) => {
            const bucket = byKey[dateKey(m.date)];
            if (!bucket) return;
            if (m.type === 'entrada') bucket.entradas += m.qty;
            else bucket.saidas += m.qty;
        });

        return days;
    }

    function lineChartSvg(days) {
        const width = 720;
        const height = 230;
        const padding = { top: 16, right: 16, bottom: 26, left: 34 };
        const chartW = width - padding.left - padding.right;
        const chartH = height - padding.top - padding.bottom;

        const maxVal = Math.max(1, ...days.map((d) => Math.max(d.entradas, d.saidas)));
        const stepX = chartW / (days.length - 1);

        function pointsFor(key) {
            return days
                .map((d, i) => {
                    const x = padding.left + i * stepX;
                    const y = padding.top + chartH - (d[key] / maxVal) * chartH;
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(' ');
        }

        const gridLines = [0, 0.25, 0.5, 0.75, 1]
            .map((f) => {
                const y = padding.top + chartH * f;
                return `<line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1" />`;
            })
            .join('');

        const labelIdx = [0, 7, 14, 21, 29].filter((i) => i < days.length);
        const labels = labelIdx
            .map((i) => {
                const x = padding.left + i * stepX;
                const d = days[i].date;
                const label = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
                return `<text x="${x.toFixed(1)}" y="${height - 6}" font-size="10.5" fill="var(--muted-soft)" text-anchor="middle">${label}</text>`;
            })
            .join('');

        return `
        <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            ${gridLines}
            <polyline points="${pointsFor('entradas')}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
            <polyline points="${pointsFor('saidas')}" fill="none" stroke="var(--red)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
            ${labels}
        </svg>`;
    }

    const dailySeries = buildDailySeries();
    const hasFlowData = dailySeries.some((d) => d.entradas > 0 || d.saidas > 0);
    document.getElementById('hydroFlowChart').innerHTML = hasFlowData
        ? lineChartSvg(dailySeries)
        : '<p class="hydro-chart-empty">Ainda não há movimentações registradas nos últimos 30 dias.</p>';

    /* ================= Gráfico: Top produtos mais movimentados ================= */
    function buildTopProducts() {
        const totals = {};
        movements.forEach((m) => {
            totals[m.productId] = (totals[m.productId] || 0) + m.qty;
        });
        return Object.entries(totals)
            .map(([productId, qty]) => {
                const product = products.find((p) => p.id === productId);
                return { name: product ? product.name : 'Produto removido', qty };
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
                <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" font-weight="700" fill="var(--navy-900)" text-anchor="middle">${item.qty}</text>
                <text x="${(x + barW / 2).toFixed(1)}" y="${height - 20}" font-size="10" fill="var(--muted-soft)" text-anchor="middle">${shortName(item.name)}</text>`;
            })
            .join('');

        return `
        <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
            <line x1="${padding.left}" y1="${padding.top + chartH}" x2="${width - padding.right}" y2="${padding.top + chartH}" stroke="var(--border)" stroke-width="1" />
            ${bars}
        </svg>`;
    }

    const topProducts = buildTopProducts();
    document.getElementById('hydroTopChart').innerHTML = topProducts.length
        ? barChartSvg(topProducts)
        : '<p class="hydro-chart-empty">Ainda não há produtos movimentados nos últimos 30 dias.</p>';

    /* ================= Alertas de estoque ================= */
    const STATUS_META = {
        critical: { label: 'Crítico', badge: 'hydro-badge-critical', qty: 'hydro-alert-qty-critical' },
        warning: { label: 'Atenção', badge: 'hydro-badge-warning', qty: 'hydro-alert-qty-warning' },
        ok: { label: 'Em estoque', badge: 'hydro-badge-ok', qty: 'hydro-alert-qty-ok' },
    };

    const withStatus = products.map((p) => ({
        product: p,
        statusKey: HydroStore.stockStatus(p.quantity, p.minStock),
    }));

    const severityOrder = { critical: 0, warning: 1, ok: 2 };
    const alertRows = withStatus
        .sort((a, b) => severityOrder[a.statusKey] - severityOrder[b.statusKey] || a.product.quantity - b.product.quantity)
        .slice(0, 6);

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
                    <td class="hydro-alert-product">${product.name}</td>
                    <td class="hydro-alert-sku">${product.sku || '—'}</td>
                    <td><span class="hydro-alert-qty ${meta.qty}">${product.quantity}</span></td>
                    <td>${product.minStock}</td>
                    <td><span class="hydro-badge ${meta.badge}">${meta.label}</span></td>
                    <td><a class="hydro-view-link" href="controle-estoque.html?sku=${encodeURIComponent(product.sku || '')}">Ver produto</a></td>
                </tr>`;
            })
            .join('');
    }

    /* ================= Busca (atalho para Estoque) ================= */
    document.getElementById('hydroSearchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
            window.location.href = 'controle-estoque.html?sku=' + encodeURIComponent(e.target.value.trim());
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
