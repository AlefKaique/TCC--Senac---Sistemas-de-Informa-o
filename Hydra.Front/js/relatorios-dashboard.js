(function () {
    'use strict';

    const state = { payloads: {}, productTab: 'top_faturamento', periodRequest: 0 };
    const endpointKeys = ['resumo', 'vendas-por-dia', 'pagamentos', 'horarios', 'produtos', 'cancelamentos', 'operadores'];
    const endpointNames = {
        resumo: 'summary', 'vendas-por-dia': 'daily', pagamentos: 'payments',
        horarios: 'hours', produtos: 'products', cancelamentos: 'cancellations', operadores: 'operators',
    };
    const today = localDateKey(new Date());
    const periodFrom = document.getElementById('hydroPeriodFrom');
    const periodTo = document.getElementById('hydroPeriodTo');
    const periodClear = document.getElementById('hydroPeriodClear');

    function localDateKey(date) {
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    function dateDays(offset, base) {
        const value = new Date(`${base || today}T12:00:00`);
        value.setDate(value.getDate() + offset);
        return localDateKey(value);
    }

    function escapeHtml(value) {
        const node = document.createElement('span');
        node.textContent = value == null ? '' : String(value);
        return node.innerHTML;
    }

    function money(value) {
        return value == null ? '—' : Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function number(value, digits) {
        return Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: digits === undefined ? 2 : digits });
    }

    function setSection(id, status, message) {
        const section = document.querySelector(`[data-report-section="${id}"]`);
        const stateNode = section && section.querySelector('[data-report-state]');
        if (!stateNode) return;
        stateNode.textContent = message || '';
        stateNode.hidden = !message;
        stateNode.classList.toggle('is-error', status === 'error');
        stateNode.classList.toggle('is-loading', status === 'loading');
        if (status !== 'error') stateNode.querySelector('.report-retry')?.remove();
    }

    function table(headers, rows, emptyMessage) {
        if (!rows.length) return `<p class="report-empty">${escapeHtml(emptyMessage || 'Sem dados para este período.')}</p>`;
        return `<div class="report-table-wrap"><table class="report-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    }

    function metric(label, value, note) {
        return `<article class="report-metric"><span>${escapeHtml(label)}</span><strong>${value}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</article>`;
    }

    function renderSummary(data) {
        const prior = data.anterior || {};
        const cards = [
            metric('Faturamento', money(data.faturamento), variation(data.faturamento, prior.faturamento)),
            metric('Lucro bruto', money(data.lucro), variation(data.lucro, prior.lucro)),
            metric(
                'Margem',
                data.margem == null ? '—' : `${number(data.margem)}%`,
                data.margem == null || prior.margem == null ? '' : `${number(Number(data.margem) - Number(prior.margem))} p.p. vs. período anterior`
            ),
            metric('Vendas', number(data.num_vendas, 0), variation(data.num_vendas, prior.num_vendas)),
            metric('Ticket médio', money(data.ticket_medio)),
            metric('Descontos', money(data.descontos)),
        ];
        document.getElementById('reportKpiContent').innerHTML = cards.join('');
        const unknown = data.produtos_sem_custo || {};
        const warnings = [];
        if (unknown.quantidade) warnings.push(`${number(unknown.quantidade, 0)} produtos sem custo cadastrado; lucro pode estar superestimado em ${money(unknown.faturamento)}.`);
        if (data.vendas_custo_estimado) warnings.push(`O custo de ${number(data.vendas_custo_estimado, 0)} vendas antigas foi estimado com base no cadastro atual.`);
        document.getElementById('reportWarnings').innerHTML = warnings.map((text) => `<p class="report-warning">${escapeHtml(text)}</p>`).join('');
        const current = data.hoje || {};
        const previous = data.mesmo_dia_semana_passada || {};
        const diff = (Number(current.faturamento) || 0) - (Number(previous.faturamento) || 0);
        const relation = Number(previous.faturamento) > 0
            ? `${diff >= 0 ? 'Acima' : 'Abaixo'} ${money(Math.abs(diff))} em relação ao mesmo dia da semana passada.`
            : 'Ainda não há vendas no mesmo dia da semana passada para comparar.';
        document.getElementById('reportTodayContent').innerHTML = `<strong>${money(current.faturamento)}</strong><span>${number(current.num_vendas, 0)} vendas hoje</span><p>${escapeHtml(relation)}</p>`;
        setSection('summary', 'ok');
        setSection('today', 'ok');
    }

    function variation(current, previous) {
        if (previous == null || Number(previous) === 0) return '';
        const percent = ((Number(current || 0) - Number(previous)) / Math.abs(Number(previous))) * 100;
        return `${percent >= 0 ? '+' : ''}${number(percent)}% vs. período anterior`;
    }

    function renderDaily(data) {
        const rows = data.atual || [];
        const previousRows = data.anterior || [];
        const max = Math.max(1, ...rows.map((row) => Number(row.faturamento) || 0), ...previousRows.map((row) => Number(row.faturamento) || 0));
        document.getElementById('reportDailyChart').innerHTML = rows.length
            ? `<div class="report-chart-legend"><span>Período selecionado</span><span>Período anterior</span></div><div class="report-bars">${rows.map((row, index) => {
                const previous = previousRows[index] || { faturamento: 0 };
                const currentHeight = Math.max(2, (Number(row.faturamento) / max) * 100);
                const previousHeight = Math.max(2, (Number(previous.faturamento) / max) * 100);
                return `<div class="report-bar-column" title="${escapeHtml(row.data)}: ${money(row.faturamento)}; período anterior: ${money(previous.faturamento)}"><span>${money(row.faturamento)}</span><div class="report-bar-pair"><i style="height:${currentHeight}%"></i><i style="height:${previousHeight}%"></i></div><small>${escapeHtml(row.data.slice(5).split('-').reverse().join('/'))}</small></div>`;
            }).join('')}</div>`
            : '<p class="report-empty">Sem vendas no período.</p>';
        setSection('daily', 'ok');
    }

    function renderPayments(rows) {
        const content = (rows || []).map((row) => metric(row.forma || 'Não informado', money(row.valor), `${number(row.percentual)}% · ${number(row.num_vendas, 0)} vendas`)).join('');
        document.getElementById('reportPaymentsContent').innerHTML = content || '<p class="report-empty">Sem pagamentos neste período.</p>';
        setSection('payments', 'ok');
    }

    function renderHours(data) {
        const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
        const values = new Map((data.matriz || []).map((item) => [`${item.dia_semana}:${item.hora}`, item]));
        const maximum = Math.max(1, ...(data.matriz || []).map((item) => Number(item.num_vendas) || 0));
        document.getElementById('reportHeatmap').innerHTML = `<div class="report-heatmap-grid"><span></span>${Array.from({ length: 24 }, (_, hour) => `<small>${String(hour).padStart(2, '0')}</small>`).join('')}${days.map((day, weekday) => `<strong>${day}</strong>${Array.from({ length: 24 }, (_, hour) => {
            const item = values.get(`${weekday}:${hour}`);
            const intensity = item ? Math.round((Number(item.num_vendas) / maximum) * 100) : 0;
            return `<i title="${day}, ${String(hour).padStart(2, '0')}h: ${number(item && item.num_vendas)} vendas" style="--report-intensity:${intensity}%"></i>`;
        }).join('')}`).join('')}</div>`;
        const peak = data.pico;
        document.getElementById('reportPeak').textContent = peak
            ? `Pico: ${days[peak.dia_semana]} às ${String(peak.hora).padStart(2, '0')}h (${number(peak.num_vendas)} vendas/dia em média).`
            : 'Sem vendas no período para identificar um pico.';
        setSection('hours', 'ok');
    }

    function renderProducts(data) {
        const rows = data[state.productTab] || [];
        document.getElementById('reportAbcSummary').textContent = `Curva ABC: ${(data.totais_curva_abc || {}).A || 0} produtos A, ${(data.totais_curva_abc || {}).B || 0} produtos B e ${(data.totais_curva_abc || {}).C || 0} produtos C.`;
        document.getElementById('reportProductsContent').innerHTML = table(
            ['Produto', 'Quantidade', 'Faturamento', 'Lucro bruto', 'Margem', 'ABC'],
            rows.map((row) => `<tr><td>${escapeHtml(row.nome)}</td><td>${number(row.quantidade, 3)} ${escapeHtml(row.unidade || '')}</td><td>${money(row.faturamento)}</td><td>${row.sem_custo ? 'Custo não cadastrado' : money(row.lucro)}</td><td>${row.margem == null ? '—' : `${number(row.margem)}%`}</td><td>${escapeHtml((data.curva_abc || []).find((item) => item.id_produto === row.id_produto)?.classe || '—')}</td></tr>`),
            'Nenhum produto vendido neste período.'
        );
        setSection('products', 'ok');
    }

    function renderStock(data) {
        state.stock = data;
        document.getElementById('reportRuptureContent').innerHTML = table(
            ['Produto', 'Estoque', 'Consumo médio/dia', 'Dias restantes', 'Previsão'],
            (data.ruptura || []).map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${number(item.quantidade, 3)} ${escapeHtml(item.unidade)}</td><td>${number(item.media_diaria, 3)}</td><td>${number(item.dias_restantes, 0)}</td><td>${escapeHtml(item.data_prevista || '—')}</td></tr>`),
            'Nenhum produto com risco de ruptura estimado para os próximos 7 dias.'
        );
        document.getElementById('reportStockTotals').innerHTML = [
            metric('Estoque a custo', money(data.valor_estoque_custo)),
            metric('Estoque a preço de venda', money(data.valor_estoque_venda)),
            metric('Produtos sem custo', number(data.produtos_sem_custo, 0)),
        ].join('');
        document.getElementById('reportStagnantContent').innerHTML = table(
            ['Produto', 'Quantidade', 'Valor parado a custo', 'Última venda'],
            (data.parados || []).map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${number(item.quantidade, 3)} ${escapeHtml(item.unidade)}</td><td>${money(item.valor_parado_custo)}</td><td>${escapeHtml(item.ultima_venda || 'Nunca vendido')}</td></tr>`),
            'Nenhum produto com estoque sem venda nos últimos 30 dias.'
        );
        document.getElementById('reportInventoryContent').innerHTML = `<h3>Estoque mínimo</h3>${table(['Produto', 'Estoque atual', 'Mínimo', 'Situação'], (data.alertas_estoque || []).map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${number(item.quantidade, 3)} ${escapeHtml(item.unidade)}</td><td>${number(item.estoque_minimo, 3)}</td><td>${statusLabel(item.status)}</td></tr>`))}<h3>Validade</h3>${table(['Produto', 'Quantidade', 'Validade', 'Situação'], (data.alertas_validade || []).map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${number(item.quantidade, 3)} ${escapeHtml(item.unidade)}</td><td>${escapeHtml(item.validade)}</td><td>${statusLabel(item.status)}</td></tr>`))}`;
        setSection('rupture', 'ok');
        setSection('stock', 'ok');
        setSection('inventory', 'ok');
    }

    function statusLabel(status) {
        return ({ empty: 'Esgotado', critical: 'Crítico', warning: 'Atenção', expired: 'Vencido', ok: 'Normal' })[status] || status;
    }

    function renderCancellations(data) {
        document.getElementById('reportCancellationSummary').textContent = `${number(data.quantidade, 0)} cancelamentos · ${money(data.valor_total)} · ${number(data.percentual_sobre_vendas)}% do faturamento concluído + cancelado`;
        document.getElementById('reportCancelByOperator').innerHTML = `<h3>Por operador</h3>${table(['Operador', 'Quantidade', 'Valor'], (data.por_operador || []).map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${number(item.quantidade, 0)}</td><td>${money(item.valor)}</td></tr>`))}`;
        document.getElementById('reportCancelByAuthorizer').innerHTML = `<h3>Por autorizador</h3>${table(['Autorizador', 'Quantidade', 'Valor'], (data.por_autorizador || []).map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${number(item.quantidade, 0)}</td><td>${money(item.valor)}</td></tr>`))}`;
        document.getElementById('reportCancellationTable').innerHTML = table(
            ['Venda', 'Data', 'Valor', 'Operador', 'Autorizador', 'Motivo'],
            (data.ultimos || []).map((item) => `<tr><td>${number(item.numero_venda, 0)}</td><td>${escapeHtml(item.data)}</td><td>${money(item.valor)}</td><td>${escapeHtml(item.operador)}</td><td>${escapeHtml(item.autorizador)}</td><td>${escapeHtml(item.motivo || '—')}</td></tr>`),
            'Nenhum cancelamento no período.'
        );
        setSection('cancellations', 'ok');
    }

    function renderOperators(rows) {
        document.getElementById('reportOperatorsContent').innerHTML = table(
            ['Operador', 'Vendas', 'Faturamento', 'Ticket médio', 'Cancelamentos'],
            (rows || []).map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${number(item.num_vendas, 0)}</td><td>${money(item.faturamento)}</td><td>${money(item.ticket_medio)}</td><td>${number(item.cancelamentos, 0)}</td></tr>`),
            'Sem vendas registradas no período.'
        );
        setSection('operators', 'ok');
    }

    async function loadPeriodReports() {
        const requestId = ++state.periodRequest;
        const query = `?de=${encodeURIComponent(periodFrom.value)}&ate=${encodeURIComponent(periodTo.value)}`;
        endpointKeys.forEach((key) => setSection(endpointNames[key], 'loading', 'Carregando…'));
        const results = await Promise.allSettled(endpointKeys.map((key) => window.hydraApi(`/relatorios/${key}${query}`)));
        if (requestId !== state.periodRequest) return;
        results.forEach((result, index) => {
            const key = endpointKeys[index];
            const section = endpointNames[key];
            if (result.status === 'rejected') {
                state.payloads[key] = null;
                setSection(section, 'error', result.reason && result.reason.status === 422
                    ? result.reason.message
                    : 'Não foi possível carregar este relatório. Verifique a conexão e tente novamente.');
                appendRetry(section, loadPeriodReports);
                return;
            }
            state.payloads[key] = result.value;
            if (key === 'resumo') renderSummary(result.value);
            if (key === 'vendas-por-dia') renderDaily(result.value);
            if (key === 'pagamentos') renderPayments(result.value);
            if (key === 'horarios') renderHours(result.value);
            if (key === 'produtos') renderProducts(result.value);
            if (key === 'cancelamentos') renderCancellations(result.value);
            if (key === 'operadores') renderOperators(result.value);
        });
    }

    function appendRetry(section, retry) {
        const node = document.querySelector(`[data-report-section="${section}"] [data-report-state]`);
        if (!node || node.querySelector('button')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hydro-btn hydro-btn-outline hydro-btn-sm report-retry';
        button.textContent = 'Tentar novamente';
        button.addEventListener('click', retry || loadPeriodReports);
        node.append(' ', button);
    }

    async function loadStock() {
        setSection('rupture', 'loading', 'Carregando…');
        setSection('stock', 'loading', 'Carregando…');
        setSection('inventory', 'loading', 'Carregando…');
        try {
            renderStock(await window.hydraApi('/relatorios/estoque'));
        } catch (error) {
            ['rupture', 'stock', 'inventory'].forEach((section) => {
                setSection(section, 'error', 'Não foi possível carregar este relatório. Verifique a conexão e tente novamente.');
                appendRetry(section, loadStock);
            });
        }
    }

    function setPreset(preset) {
        const now = new Date();
        const end = localDateKey(now);
        if (preset === 'hoje') {
            periodFrom.value = end;
            periodTo.value = end;
        } else if (preset === 'mes') {
            periodFrom.value = localDateKey(new Date(now.getFullYear(), now.getMonth(), 1));
            periodTo.value = end;
        } else if (preset === 'mes-passado') {
            periodFrom.value = localDateKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
            periodTo.value = localDateKey(new Date(now.getFullYear(), now.getMonth(), 0));
        } else {
            periodTo.value = end;
            periodFrom.value = dateDays(-(Number(preset) - 1), end);
        }
        syncPresetButtons(preset);
        loadPeriodReports();
    }

    function syncPresetButtons(active) {
        document.querySelectorAll('#hydroPeriodPresets [data-preset]').forEach((button) => {
            button.classList.toggle('hydro-active', button.dataset.preset === active);
        });
        periodClear.hidden = !active;
    }

    function exportCsv(kind) {
        const stock = state.stock || {};
        let filename;
        let headings;
        let rows;
        if (kind === 'summary') {
            const data = state.payloads.resumo || {};
            filename = 'resumo-financeiro.csv';
            headings = ['Indicador', 'Valor'];
            rows = [
                ['Faturamento', data.faturamento], ['Lucro bruto', data.lucro], ['Margem (%)', data.margem],
                ['Vendas', data.num_vendas], ['Ticket médio', data.ticket_medio], ['Descontos', data.descontos],
                ['Produtos sem custo', data.produtos_sem_custo && data.produtos_sem_custo.quantidade],
                ['Faturamento de produtos sem custo', data.produtos_sem_custo && data.produtos_sem_custo.faturamento],
            ];
        } else if (kind === 'daily') {
            const data = state.payloads['vendas-por-dia'] || {};
            filename = 'vendas-por-dia.csv';
            headings = ['Data', 'Faturamento', 'Lucro bruto', 'Vendas', 'Faturamento período anterior'];
            rows = (data.atual || []).map((row, index) => [
                row.data, row.faturamento, row.lucro, row.num_vendas, (data.anterior || [])[index]?.faturamento || 0,
            ]);
        } else if (kind === 'payments') {
            filename = 'formas-de-pagamento.csv';
            headings = ['Forma de pagamento', 'Valor', 'Percentual (%)', 'Vendas'];
            rows = (state.payloads.pagamentos || []).map((row) => [row.forma, row.valor, row.percentual, row.num_vendas]);
        } else if (kind === 'hours') {
            filename = 'vendas-por-horario.csv';
            headings = ['Dia da semana', 'Hora', 'Média de vendas/dia', 'Faturamento médio/dia'];
            const days = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
            rows = ((state.payloads.horarios || {}).matriz || []).map((row) => [days[row.dia_semana], row.hora, row.num_vendas, row.faturamento]);
        } else if (kind === 'operators') {
            filename = 'desempenho-operadores.csv';
            headings = ['Operador', 'Vendas', 'Faturamento', 'Ticket médio', 'Cancelamentos'];
            rows = (state.payloads.operadores || []).map((row) => [row.nome, row.num_vendas, row.faturamento, row.ticket_medio, row.cancelamentos]);
        } else if (kind === 'products') {
            const data = state.payloads.produtos || {};
            rows = data[state.productTab] || [];
            filename = `produtos-${state.productTab}.csv`;
            headings = ['Produto', 'Unidade', 'Quantidade', 'Faturamento', 'Lucro bruto', 'Margem (%)', 'Custo ausente'];
            rows = rows.map((row) => [row.nome, row.unidade, row.quantidade, row.faturamento, row.lucro, row.margem, row.sem_custo ? 'Sim' : 'Não']);
        } else if (kind === 'rupture') {
            filename = 'risco-ruptura.csv';
            headings = ['Produto', 'Unidade', 'Estoque', 'Consumo médio/dia', 'Dias restantes', 'Data prevista'];
            rows = (stock.ruptura || []).map((row) => [row.nome, row.unidade, row.quantidade, row.media_diaria, row.dias_restantes, row.data_prevista]);
        } else if (kind === 'stagnant') {
            filename = 'estoque-sem-venda.csv';
            headings = ['Produto', 'Unidade', 'Quantidade', 'Valor parado a custo', 'Última venda'];
            rows = (stock.parados || []).map((row) => [row.nome, row.unidade, row.quantidade, row.valor_parado_custo, row.ultima_venda]);
        } else if (kind === 'cancellations') {
            const data = state.payloads.cancelamentos || {};
            filename = 'cancelamentos.csv';
            headings = ['Venda', 'Data', 'Valor', 'Operador', 'Autorizador', 'Motivo'];
            rows = (data.ultimos || []).map((row) => [row.numero_venda, row.data, row.valor, row.operador, row.autorizador, row.motivo]);
        } else {
            return;
        }
        const csvValue = (value) => {
            let text = value == null ? '' : String(value);
            if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
            return `"${text.replace(/"/g, '""')}"`;
        };
        const content = `\uFEFF${headings.map(csvValue).join(';')}\r\n${rows.map((row) => row.map(csvValue).join(';')).join('\r\n')}`;
        const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    }

    function printTable(title, headers, rows) {
        const content = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:14px Arial,sans-serif;padding:24px;color:#111}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #999;padding:8px;text-align:left}th{background:#eee}@media print{button{display:none}}</style><h1>${escapeHtml(title)}</h1><p>${escapeHtml(new Date().toLocaleString('pt-BR'))}</p><table><thead><tr>${headers.map((item) => `<th>${escapeHtml(item)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((item) => `<td>${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table><script>window.print()</script></html>`;
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
        document.body.appendChild(frame);
        frame.contentDocument.open();
        frame.contentDocument.write(content);
        frame.contentDocument.close();
        frame.contentWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
    }

    function setupInteractions() {
        document.querySelectorAll('#hydroPeriodPresets [data-preset]').forEach((button) => button.addEventListener('click', () => setPreset(button.dataset.preset)));
        // Escolher "de" e "até" em seguida disparava as 7 consultas do
        // período duas vezes; a espera curta junta as duas mudanças numa só.
        let recargaPeriodo = null;
        [periodFrom, periodTo].forEach((input) => input.addEventListener('change', () => {
            clearTimeout(recargaPeriodo);
            recargaPeriodo = setTimeout(() => {
                if (periodFrom.value && periodTo.value && periodFrom.value > periodTo.value) {
                    window.alert('A data inicial não pode ser posterior à data final.');
                    return;
                }
                syncPresetButtons('');
                loadPeriodReports();
            }, 400);
        }));
        periodClear.addEventListener('click', () => setPreset('30'));
        document.querySelectorAll('[data-product-tab]').forEach((button) => button.addEventListener('click', () => {
            state.productTab = button.dataset.productTab;
            document.querySelectorAll('[data-product-tab]').forEach((tab) => tab.classList.toggle('hydro-active', tab === button));
            if (state.payloads.produtos) renderProducts(state.payloads.produtos);
        }));
        document.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', () => exportCsv(button.dataset.export)));
        document.getElementById('reportPrintPurchase').addEventListener('click', () => {
            const rows = (state.stock?.ruptura || []).map((item) => [item.nome, number(item.quantidade, 3), number(item.media_diaria, 3), number(item.dias_restantes, 0), item.data_prevista || '—']);
            printTable('Lista de produtos com risco de ruptura', ['Produto', 'Estoque', 'Consumo médio/dia', 'Dias restantes', 'Previsão'], rows);
        });
        document.getElementById('reportPrintExpiry').addEventListener('click', () => {
            const rows = (state.stock?.alertas_validade || []).map((item) => [item.nome, number(item.quantidade, 3), item.validade, statusLabel(item.status)]);
            printTable('Produtos vencidos ou a vencer', ['Produto', 'Quantidade', 'Validade', 'Situação'], rows);
        });
        // Menu lateral do celular: window.hydraMenuLateral (api.js).
    }

    function demoPayloads(de, ate) {
        const products = HydroStore.getProducts();
        const catalog = new Map(products.map((product) => [String(product.id), product]));
        const sales = HydroStore.getSales().filter((sale) => sale.date.slice(0, 10) >= de && sale.date.slice(0, 10) <= ate);
        const sum = (list) => list.reduce((value, row) => value + row.total, 0);
        const financials = (list) => {
            let cost = 0;
            let items = 0;
            list.forEach((sale) => (sale.items || []).forEach((item) => {
                items += Number(item.qty);
                const product = catalog.get(String(item.productId));
                if (product && product.costPrice != null) cost += Number(item.qty) * Number(product.costPrice);
            }));
            return { faturamento: sum(list), lucro: sum(list) - cost, itens_vendidos: items };
        };
        const priorDe = dateDays(-(Math.round((new Date(`${ate}T12:00:00`) - new Date(`${de}T12:00:00`)) / 86400000) + 1), de);
        const prior = HydroStore.getSales().filter((sale) => sale.date.slice(0, 10) >= priorDe && sale.date.slice(0, 10) < de);
        const todaySales = HydroStore.getSales().filter((sale) => sale.date.slice(0, 10) === today);
        const previousDay = dateDays(-7);
        const sameDaySales = HydroStore.getSales().filter((sale) => sale.date.slice(0, 10) === previousDay);
        const daily = [];
        for (let day = de; day <= ate; day = dateDays(1, day)) {
            const matching = sales.filter((sale) => sale.date.slice(0, 10) === day);
            daily.push({ data: day, ...financials(matching), num_vendas: matching.length });
        }
        const previousDaily = [];
        for (let day = priorDe; day < de; day = dateDays(1, day)) {
            const matching = prior.filter((sale) => sale.date.slice(0, 10) === day);
            previousDaily.push({ data: day, ...financials(matching), num_vendas: matching.length });
        }
        const productTotals = new Map();
        sales.forEach((sale) => (sale.items || []).forEach((item) => {
            const product = catalog.get(String(item.productId));
            const previousValue = productTotals.get(item.productId) || {
                quantidade: 0, faturamento: 0, lucro: 0, nome: item.name,
                unidade: product && product.unit || 'unidade', sem_custo: !product || product.costPrice == null,
            };
            previousValue.quantidade += Number(item.qty);
            previousValue.faturamento += Number(item.qty) * Number(item.price);
            if (product && product.costPrice != null) previousValue.lucro += Number(item.qty) * (Number(item.price) - Number(product.costPrice));
            productTotals.set(item.productId, previousValue);
        }));
        const itemRows = [...productTotals.entries()].map(([id, item]) => ({
            id_produto: id, nome: item.nome, unidade: item.unidade, quantidade: item.quantidade,
            faturamento: item.faturamento, lucro: item.lucro,
            margem: item.faturamento > 0 && !item.sem_custo ? item.lucro / item.faturamento * 100 : null,
            sem_custo: item.sem_custo,
        }));
        itemRows.sort((a, b) => b.faturamento - a.faturamento);
        const acumuladoTotal = sum(sales);
        let acumulado = 0;
        const totalsAbc = { A: 0, B: 0, C: 0 };
        const curvaAbc = itemRows.map((item) => {
            acumulado += item.faturamento;
            const percentual = acumuladoTotal ? acumulado / acumuladoTotal : 0;
            const classe = percentual <= 0.8 ? 'A' : (percentual <= 0.95 ? 'B' : 'C');
            totalsAbc[classe]++;
            return { ...item, classe, percentual_acumulado: percentual * 100 };
        });
        const productsReport = {
            top_faturamento: itemRows.slice(0, 10),
            top_lucro: itemRows.slice().sort((a, b) => b.lucro - a.lucro).slice(0, 10),
            menor_margem: itemRows.filter((item) => item.margem != null && item.margem < 10).sort((a, b) => a.margem - b.margem).slice(0, 10),
            curva_abc: curvaAbc,
            totais_curva_abc: totalsAbc,
        };
        const paymentTotals = new Map();
        sales.forEach((sale) => {
            const payment = sale.payment || 'Não informado';
            const totals = paymentTotals.get(payment) || { valor: 0, num_vendas: 0 };
            totals.valor += sale.total;
            totals.num_vendas++;
            paymentTotals.set(payment, totals);
        });
        const paymentRows = [...paymentTotals.entries()].map(([forma, totals]) => ({
            forma, valor: totals.valor, percentual: acumuladoTotal ? totals.valor / acumuladoTotal * 100 : 0, num_vendas: totals.num_vendas,
        }));
        const dayCounts = Array(7).fill(0);
        for (let day = de; day <= ate; day = dateDays(1, day)) dayCounts[new Date(`${day}T12:00:00`).getDay()]++;
        const hourTotals = new Map();
        sales.forEach((sale) => {
            const date = new Date(sale.date);
            const key = `${date.getDay()}:${date.getHours()}`;
            const totals = hourTotals.get(key) || { dia_semana: date.getDay(), hora: date.getHours(), num_vendas: 0, faturamento: 0 };
            totals.num_vendas++;
            totals.faturamento += Number(sale.total);
            hourTotals.set(key, totals);
        });
        const hourlyMatrix = [...hourTotals.values()].map((item) => ({
            ...item,
            num_vendas: item.num_vendas / Math.max(1, dayCounts[item.dia_semana]),
            faturamento: item.faturamento / Math.max(1, dayCounts[item.dia_semana]),
        }));
        const peak = hourlyMatrix.slice().sort((a, b) => b.num_vendas - a.num_vendas || b.faturamento - a.faturamento)[0] || null;
        const currentMetrics = financials(sales);
        const priorMetrics = financials(prior);
        const todayMetrics = financials(todaySales);
        const sameDayMetrics = financials(sameDaySales);
        const estoque = {
            valor_estoque_custo: products.reduce((sumValue, product) => sumValue + Number(product.quantity) * Number(product.costPrice || 0), 0),
            valor_estoque_venda: products.reduce((sumValue, product) => sumValue + Number(product.quantity) * Number(product.price || 0), 0),
            produtos_sem_custo: products.filter((product) => product.costPrice == null).length,
            ruptura: [], parados: [], alertas_estoque: [], alertas_validade: [],
        };
        const cutoff = dateDays(-29);
        const recentSales = HydroStore.getSales().filter((sale) => sale.date.slice(0, 10) >= cutoff && sale.date.slice(0, 10) <= today);
        const soldRecently = new Map();
        recentSales.forEach((sale) => (sale.items || []).forEach((item) => {
            soldRecently.set(String(item.productId), (soldRecently.get(String(item.productId)) || 0) + Number(item.qty));
        }));
        products.forEach((product) => {
            const stockStatus = HydroStore.stockStatus(product.quantity, product.minStock);
            if (stockStatus !== 'ok') estoque.alertas_estoque.push({ nome: product.name, quantidade: product.quantity, unidade: product.unit, estoque_minimo: product.minStock, status: stockStatus });
            const expiryStatus = HydroStore.expiryStatus(product.validade);
            if (expiryStatus && expiryStatus !== 'ok') estoque.alertas_validade.push({ nome: product.name, quantidade: product.quantity, unidade: product.unit, validade: product.validade, status: expiryStatus });
            const recentQuantity = soldRecently.get(String(product.id)) || 0;
            if (recentQuantity > 0) {
                const average = recentQuantity / 30;
                const daysLeft = Number(product.quantity) / average;
                if (product.quantity > 0 && daysLeft <= 7) {
                    estoque.ruptura.push({
                        nome: product.name, quantidade: product.quantity, unidade: product.unit,
                        media_diaria: average, dias_restantes: Math.ceil(daysLeft), data_prevista: dateDays(Math.ceil(daysLeft)),
                    });
                }
            } else if (Number(product.quantity) > 0) {
                const lastSale = HydroStore.getSales().filter((sale) => (sale.items || []).some((item) => String(item.productId) === String(product.id)))
                    .sort((a, b) => b.date.localeCompare(a.date))[0];
                estoque.parados.push({
                    nome: product.name, quantidade: product.quantity, unidade: product.unit,
                    valor_parado_custo: product.costPrice == null ? null : Number(product.quantity) * Number(product.costPrice),
                    ultima_venda: lastSale ? lastSale.date : null,
                });
            }
        });
        estoque.parados.sort((a, b) => (b.valor_parado_custo || 0) - (a.valor_parado_custo || 0));
        return {
            resumo: {
                faturamento: currentMetrics.faturamento, lucro: currentMetrics.lucro,
                margem: currentMetrics.faturamento > 0 ? currentMetrics.lucro / currentMetrics.faturamento * 100 : null,
                num_vendas: sales.length, ticket_medio: sales.length ? currentMetrics.faturamento / sales.length : null,
                descontos: 0, itens_vendidos: currentMetrics.itens_vendidos,
                produtos_sem_custo: {
                    quantidade: new Set(itemRows.filter((item) => item.sem_custo).map((item) => item.id_produto)).size,
                    faturamento: itemRows.filter((item) => item.sem_custo).reduce((total, item) => total + item.faturamento, 0),
                },
                vendas_custo_estimado: 0,
                anterior: { ...priorMetrics, num_vendas: prior.length },
                hoje: { faturamento: todayMetrics.faturamento, num_vendas: todaySales.length },
                mesmo_dia_semana_passada: { faturamento: sameDayMetrics.faturamento, num_vendas: sameDaySales.length },
            },
            'vendas-por-dia': { atual: daily, anterior: previousDaily },
            pagamentos: paymentRows,
            horarios: { matriz: hourlyMatrix, pico: peak },
            produtos: productsReport,
            cancelamentos: { quantidade: 0, valor_total: 0, percentual_sobre_vendas: 0, por_operador: [], por_autorizador: [], ultimos: [] },
            operadores: [],
            estoque,
        };
    }

    function renderDemo(de, ate) {
        HydroStore.seedHistoryIfNeeded();
        const reports = demoPayloads(de, ate);
        state.payloads = {
            resumo: reports.resumo,
            'vendas-por-dia': reports['vendas-por-dia'],
            pagamentos: reports.pagamentos,
            horarios: reports.horarios,
            produtos: reports.produtos,
            cancelamentos: reports.cancelamentos,
            operadores: reports.operadores,
        };
        renderSummary(reports.resumo);
        renderDaily(reports['vendas-por-dia']);
        renderPayments(reports.pagamentos);
        renderHours(reports.horarios);
        renderProducts(reports.produtos);
        renderCancellations(reports.cancelamentos);
        renderOperators(reports.operadores);
        renderStock(reports.estoque);
        const name = document.getElementById('hydroUserName');
        if (name) name.textContent = 'Demonstração';
    }

    async function initialize() {
        setupInteractions();
        periodTo.value = today;
        periodFrom.value = dateDays(-29);
        syncPresetButtons('30');
        try {
            const { usuario } = await window.hydraSessao();
            window.hydraAplicarMenuPorPermissao(usuario);
            const name = document.getElementById('hydroUserName');
            if (name) name.textContent = (usuario.nome || '').split(' ')[0];
            const alertLink = document.getElementById('hydroAlertasSettingsLink');
            if (alertLink && window.hydraPode(usuario, ['relatorios.visualizar'])) alertLink.hidden = false;
            if (!window.hydraGuardaDeTela(usuario, ['relatorios.visualizar'])) return;
            await Promise.all([loadPeriodReports(), loadStock()]);
        } catch (error) {
            if (error && error.status === 401) {
                renderDemo(periodFrom.value, periodTo.value);
                return;
            }
            document.querySelectorAll('[data-report-section]').forEach((section) => {
                setSection(section.dataset.reportSection, 'error', 'Não foi possível verificar sua sessão. Verifique a conexão e atualize a página.');
                appendRetry(section.dataset.reportSection, initialize);
            });
        }
    }

    initialize();
})();
