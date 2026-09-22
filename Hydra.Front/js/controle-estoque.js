(function () {
    'use strict';

    /* ================= Mock data ================= */
    const CATALOG = {
        'Utilidades': [
            ['Balde Plástico 10L', 'Uso doméstico e industrial'],
            ['Vassoura de Piaçava', 'Cabo de madeira 1,20m'],
            ['Rodo Duplo 40cm', 'Base emborrachada'],
            ['Lixeira com Pedal 20L', 'Aço inox escovado'],
            ['Mangueira de Jardim 15m', 'Reforçada com engate'],
            ['Varal Retrátil', 'Fixação em parede'],
        ],
        'Limpeza': [
            ['Detergente Neutro 500ml', 'Concentrado, uso geral'],
            ['Água Sanitária 1L', 'Alvejante clorado'],
            ['Sabão em Pó 1kg', 'Ação removedora de manchas'],
            ['Desinfetante Lavanda 2L', 'Fragrância prolongada'],
            ['Esponja Multiuso (kit 3un)', 'Dupla face'],
            ['Álcool 70% 1L', 'Antisséptico'],
        ],
        'Alimentos': [
            ['Arroz Integral 1kg', 'Tipo 1, grãos longos'],
            ['Feijão Carioca 1kg', 'Safra atual'],
            ['Óleo de Soja 900ml', 'Garrafa PET'],
            ['Café Torrado 500g', 'Moagem fina'],
            ['Açúcar Refinado 1kg', 'Embalagem lacrada'],
            ['Macarrão Espaguete 500g', 'Sêmola de trigo'],
        ],
        'Eletrônicos': [
            ['Lâmpada LED 9W', 'Luz branca 6500K'],
            ['Pilha Alcalina AA (par)', 'Duração estendida'],
            ['Carregador USB-C 20W', 'Entrada bivolt'],
            ['Extensão Elétrica 3m', '3 tomadas'],
            ['Fita Isolante 10m', 'Uso profissional'],
            ['Adaptador Multiplug', '4 saídas'],
        ],
        'Papelaria': [
            ['Caderno Universitário 96fl', 'Capa dura'],
            ['Caneta Esferográfica (kit 10un)', 'Ponta 1.0mm'],
            ['Papel Sulfite A4 (500fl)', '75g/m²'],
            ['Pasta Catálogo 50 envelopes', 'Ofício'],
            ['Grampeador Médio', 'Capacidade 20 folhas'],
            ['Post-it Colorido', 'Bloco 100 folhas'],
        ],
        'Bebidas': [
            ['Água Mineral 500ml (fardo)', '12 unidades'],
            ['Refrigerante Cola 2L', 'Retornável'],
            ['Suco de Uva Integral 1L', 'Sem conservantes'],
            ['Café Solúvel 200g', 'Vidro'],
            ['Chá Verde (caixa 20un)', 'Sachês individuais'],
            ['Energético 250ml', 'Lata'],
        ],
    };

    // Categorias cujos itens possuem data de validade (perecíveis).
    // Eletrônicos e Papelaria não vencem, então ficam sem essa informação.
    const PERISHABLE_CATEGORIES = ['Alimentos', 'Bebidas', 'Limpeza'];

    function addDays(date, days) {
        const d = new Date(date);
        d.setDate(d.getDate() + days);
        return d;
    }

    function toIsoDate(date) {
        return date.toISOString().slice(0, 10);
    }

    function seedProducts() {
        const list = [];
        let seq = 1;
        Object.keys(CATALOG).forEach((category) => {
            const prefix = category.slice(0, 2).toUpperCase();
            CATALOG[category].forEach(([name, desc]) => {
                // pseudo-aleatório determinístico baseado no índice, para um resultado plausível
                const r = (seq * 37) % 100;
                const minStock = 10 + (seq % 4) * 5;
                let quantity;
                if (r < 18) quantity = Math.max(0, Math.round(minStock * 0.25));
                else if (r < 40) quantity = Math.round(minStock * 0.7);
                else quantity = minStock + 10 + (seq % 6) * 8;
                const price = 6 + ((seq * 13) % 90) + 0.9;

                // Data de validade determinística: alguns itens já vencidos,
                // outros vencendo em breve, a maioria dentro da validade.
                let validade = null;
                if (PERISHABLE_CATEGORIES.includes(category)) {
                    const offsetDays = ((seq * 53) % 150) - 20;
                    validade = toIsoDate(addDays(new Date(), offsetDays));
                }

                list.push({
                    id: seq,
                    name,
                    desc,
                    sku: `${prefix}-${(1000 + seq)}-${String(seq % 30).padStart(2, '0')}`,
                    category,
                    quantity,
                    minStock,
                    price: Math.round(price * 100) / 100,
                    validade,
                });
                seq++;
            });
        });
        return list;
    }

    /* Converte o formato retornado pela API (produtos.* do schema.sql)
       para o formato usado pelas funções de renderização desta tela. */
    function mapApiProduct(p) {
        return {
            id: p.id_produto,
            name: p.nome,
            desc: p.descricao || '',
            sku: p.codigo_barras || `PRD-${p.id_produto}`,
            codigoBarras: p.codigo_barras || null,
            category: p.categoria,
            quantity: Number(p.quantidade),
            minStock: Number(p.estoque_minimo),
            price: Number(p.preco_venda),
            costPrice: p.preco_custo !== null ? Number(p.preco_custo) : 0,
            unit: p.unidade,
            validade: p.validade,
            status: p.status,
        };
    }

    let products = [];
    // true quando os produtos vieram da API real (usuário autenticado);
    // false enquanto a tela mostra o catálogo de demonstração (visitante).
    let usingRealApi = false;
    // Perfil do usuário autenticado (null para o visitante da demo pública).
    // RN04: só o Administrador pode alterar preços de produtos.
    let usuarioPerfil = null;

    /* ================= State ================= */
    const state = {
        search: '',
        category: '',
        status: '',
        validade: '',
        page: 1,
        pageSize: 5,
    };

    /* ================= Helpers ================= */
    function getStatus(product) {
        const { quantity, minStock } = product;
        if (quantity <= minStock * 0.4) return 'Crítico';
        if (quantity <= minStock) return 'Baixo';
        return 'Em estoque';
    }

    function statusBadgeClass(status) {
        if (status === 'Crítico') return 'hydro-badge-critical';
        if (status === 'Baixo') return 'hydro-badge-low';
        return 'hydro-badge-ok';
    }

    const EXPIRY_WARNING_DAYS = 30;

    function getExpiryStatus(product) {
        if (!product.validade) return null;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expiry = new Date(`${product.validade}T00:00:00`);
        const diffDays = Math.round((expiry - today) / 86400000);
        if (diffDays < 0) return 'Vencido';
        if (diffDays <= EXPIRY_WARNING_DAYS) return 'Vence em breve';
        return 'Válido';
    }

    function expiryBadgeClass(status) {
        if (status === 'Vencido') return 'hydro-badge-critical';
        if (status === 'Vence em breve') return 'hydro-badge-low';
        return 'hydro-badge-ok';
    }

    function formatDate(isoDate) {
        if (!isoDate) return '';
        const [y, m, d] = isoDate.split('-');
        return `${d}/${m}/${y}`;
    }

    // Formata "YYYY-MM-DD HH:MM:SS" (retorno do MySQL) como "DD/MM/AAAA HH:MM".
    function formatDateTime(datetime) {
        const [datePart, timePart] = String(datetime).split(' ');
        const [y, m, d] = datePart.split('-');
        const hm = (timePart || '').slice(0, 5);
        return `${d}/${m}/${y}${hm ? ' ' + hm : ''}`;
    }

    function formatCurrency(value) {
        return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function getFilteredProducts() {
        return products.filter((p) => {
            const status = getStatus(p);
            const matchesSearch =
                !state.search ||
                p.name.toLowerCase().includes(state.search) ||
                p.sku.toLowerCase().includes(state.search);
            const matchesCategory = !state.category || p.category === state.category;
            const matchesStatus = !state.status || status === state.status;
            const matchesValidade = !state.validade || getExpiryStatus(p) === state.validade;
            return matchesSearch && matchesCategory && matchesStatus && matchesValidade;
        });
    }

    /* ================= Rendering: stats ================= */
    function renderStats() {
        const totalItens = products.reduce((sum, p) => sum + p.quantity, 0);
        const valorEstoque = products.reduce((sum, p) => sum + p.quantity * p.price, 0);
        const baixoCount = products.filter((p) => getStatus(p) !== 'Em estoque').length;
        const vencendoCount = products.filter((p) => {
            const status = getExpiryStatus(p);
            return status === 'Vencido' || status === 'Vence em breve';
        }).length;

        document.getElementById('hydroStatTotalItens').textContent = totalItens.toLocaleString('pt-BR');
        document.getElementById('hydroStatValorEstoque').textContent = formatCurrency(valorEstoque);
        document.getElementById('hydroStatBaixo').textContent = baixoCount.toLocaleString('pt-BR');
        document.getElementById('hydroStatVencendo').textContent = vencendoCount.toLocaleString('pt-BR');
    }

    /* ================= Rendering: filters (category options) ================= */
    function renderCategoryOptions() {
        const select = document.getElementById('hydroFilterCategoria');
        const current = select.value;
        const categories = Array.from(new Set(products.map((p) => p.category))).sort();
        select.innerHTML =
            '<option value="">Todas as categorias</option>' +
            categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        select.value = current;
    }

    /* ================= Rendering: table ================= */
    function renderTable() {
        const filtered = getFilteredProducts();
        const totalItems = filtered.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
        if (state.page > totalPages) state.page = totalPages;
        if (state.page < 1) state.page = 1;

        const start = (state.page - 1) * state.pageSize;
        const pageItems = filtered.slice(start, start + state.pageSize);

        const tbody = document.getElementById('hydroTableBody');
        const emptyState = document.getElementById('hydroEmptyState');

        if (pageItems.length === 0) {
            tbody.innerHTML = '';
            emptyState.classList.add('hydro-is-visible');
        } else {
            emptyState.classList.remove('hydro-is-visible');
            tbody.innerHTML = pageItems
                .map((p) => {
                    const status = getStatus(p);
                    const expiryStatus = getExpiryStatus(p);
                    const expiryCell = p.validade
                        ? `${formatDate(p.validade)}${expiryStatus !== 'Válido' ? ` <span class="hydro-badge ${expiryBadgeClass(expiryStatus)}">${expiryStatus}</span>` : ''}`
                        : '<span class="hydro-text-muted">—</span>';
                    return `
          <tr data-id="${p.id}">
            <td class="hydro-product-cell-wrap" data-label="Produto">
              <div class="hydro-product-cell">
                <div class="hydro-product-thumb"><i class="hydro-ic hydro-ic-package"></i></div>
                <div>
                  <div class="hydro-product-name">${escapeHtml(p.name)}</div>
                  <div class="hydro-product-desc">${escapeHtml(p.desc)}</div>
                </div>
              </div>
            </td>
            <td class="hydro-sku" data-label="SKU">${escapeHtml(p.sku)}</td>
            <td data-label="Categoria">${escapeHtml(p.category)}</td>
            <td class="hydro-qty" data-label="Quantidade">${p.quantity}</td>
            <td data-label="Estoque mínimo">${p.minStock}</td>
            <td data-label="Validade">${expiryCell}</td>
            <td data-label="Status"><span class="hydro-badge ${statusBadgeClass(status)}">${status}</span></td>
            <td class="hydro-col-actions" data-label="Ações">
              <div class="hydro-row-actions">
                <button class="hydro-action-btn hydro-action-view" title="Ver detalhes" data-id="${p.id}"><i class="hydro-ic hydro-ic-eye"></i></button>
                <button class="hydro-action-btn hydro-action-edit" title="Editar produto" data-id="${p.id}"><i class="hydro-ic hydro-ic-pencil"></i></button>
                <button class="hydro-action-btn hydro-action-history" title="Histórico de movimentações" data-id="${p.id}"><i class="hydro-ic hydro-ic-history"></i></button>
                <button class="hydro-action-btn hydro-action-delete" title="Excluir produto" data-id="${p.id}"><i class="hydro-ic hydro-ic-trash"></i></button>
              </div>
            </td>
          </tr>`;
                })
                .join('');
        }

        renderFooter(totalItems, start, pageItems.length, totalPages);
        bindRowActions();
    }

    function renderFooter(totalItems, start, shownCount, totalPages) {
        const footerCount = document.getElementById('hydroFooterCount');
        if (totalItems === 0) {
            footerCount.textContent = 'Mostrando 0 a 0 de 0 itens';
        } else {
            footerCount.textContent = `Mostrando ${start + 1} a ${start + shownCount} de ${totalItems} itens`;
        }

        const pagination = document.getElementById('hydroPagination');
        const pages = buildPageList(state.page, totalPages);

        let html = `<button class="hydro-page-btn" id="hydroPagePrev" ${state.page === 1 ? 'disabled' : ''} aria-label="Página anterior"><i class="hydro-ic hydro-ic-chevron-left"></i></button>`;
        pages.forEach((item) => {
            if (item === '...') {
                html += `<span class="hydro-page-ellipsis">…</span>`;
            } else {
                html += `<button class="hydro-page-btn ${item === state.page ? 'hydro-active' : ''}" data-page="${item}">${item}</button>`;
            }
        });
        html += `<button class="hydro-page-btn" id="hydroPageNext" ${state.page === totalPages ? 'disabled' : ''} aria-label="Próxima página"><i class="hydro-ic hydro-ic-chevron-right"></i></button>`;

        pagination.innerHTML = html;

        pagination.querySelectorAll('[data-page]').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.page = Number(btn.dataset.page);
                renderTable();
            });
        });
        const prevBtn = document.getElementById('hydroPagePrev');
        const nextBtn = document.getElementById('hydroPageNext');
        if (prevBtn) prevBtn.addEventListener('click', () => { state.page--; renderTable(); });
        if (nextBtn) nextBtn.addEventListener('click', () => { state.page++; renderTable(); });
    }

    function buildPageList(current, total) {
        if (total <= 5) {
            return Array.from({ length: total }, (_, i) => i + 1);
        }
        const pages = [1];
        if (current > 3) pages.push('...');
        const start = Math.max(2, current - 1);
        const end = Math.min(total - 1, current + 1);
        for (let i = start; i <= end; i++) pages.push(i);
        if (current < total - 2) pages.push('...');
        pages.push(total);
        return pages;
    }

    /* ================= Row actions ================= */
    function bindRowActions() {
        document.querySelectorAll('.hydro-action-view').forEach((btn) =>
            btn.addEventListener('click', () => openViewModal(Number(btn.dataset.id)))
        );
        document.querySelectorAll('.hydro-action-edit').forEach((btn) =>
            btn.addEventListener('click', () => openEditModal(Number(btn.dataset.id)))
        );
        document.querySelectorAll('.hydro-action-history').forEach((btn) =>
            btn.addEventListener('click', () => openHistoryModal(Number(btn.dataset.id)))
        );
        document.querySelectorAll('.hydro-action-delete').forEach((btn) =>
            btn.addEventListener('click', () => openDeleteModal(Number(btn.dataset.id)))
        );
    }

    /* ================= Modal engine ================= */
    const modalOverlay = document.getElementById('hydroModalOverlay');
    const modalTitle = document.getElementById('hydroModalTitle');
    const modalBody = document.getElementById('hydroModalBody');
    const modalFooter = document.getElementById('hydroModalFooter');

    function openModal({ title, bodyHtml, footerHtml, onMount }) {
        modalTitle.textContent = title;
        modalBody.innerHTML = bodyHtml;
        modalFooter.innerHTML = footerHtml;
        modalOverlay.classList.add('hydro-show');
        if (onMount) onMount();
    }

    function closeModal() {
        modalOverlay.classList.remove('hydro-show');
    }

    document.getElementById('hydroModalClose').addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    /* ---- View modal ---- */
    function openViewModal(id) {
        const p = products.find((x) => x.id === id);
        if (!p) return;
        const status = getStatus(p);
        const expiryStatus = getExpiryStatus(p);
        const validadeValue = p.validade
            ? `${formatDate(p.validade)}${expiryStatus !== 'Válido' ? ` <span class="hydro-badge ${expiryBadgeClass(expiryStatus)}">${expiryStatus}</span>` : ''}`
            : 'Não aplicável';
        openModal({
            title: p.name,
            bodyHtml: `
        <div class="hydro-detail-row"><span>Descrição</span><span>${escapeHtml(p.desc)}</span></div>
        <div class="hydro-detail-row"><span>SKU</span><span>${escapeHtml(p.sku)}</span></div>
        <div class="hydro-detail-row"><span>Categoria</span><span>${escapeHtml(p.category)}</span></div>
        <div class="hydro-detail-row"><span>Quantidade</span><span>${p.quantity} un.</span></div>
        <div class="hydro-detail-row"><span>Estoque mínimo</span><span>${p.minStock} un.</span></div>
        <div class="hydro-detail-row"><span>Validade</span><span>${validadeValue}</span></div>
        <div class="hydro-detail-row"><span>Preço unitário</span><span>${formatCurrency(p.price)}</span></div>
        <div class="hydro-detail-row"><span>Valor em estoque</span><span>${formatCurrency(p.price * p.quantity)}</span></div>
        <div class="hydro-detail-row"><span>Status</span><span><span class="hydro-badge ${statusBadgeClass(status)}">${status}</span></span></div>
      `,
            footerHtml: `<button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalOkBtn">Fechar</button>`,
        });
        document.getElementById('hydroModalOkBtn').addEventListener('click', closeModal);
    }

    /* ---- Edit modal ---- */
    function openEditModal(id) {
        const p = products.find((x) => x.id === id);
        if (!p) return;
        const categories = Array.from(new Set(products.map((x) => x.category))).sort();

        // RN04 — só o Administrador pode alterar preços de produtos; para os
        // demais perfis (Estoquista), os campos de preço nem aparecem no
        // formulário de edição.
        const isAdmin = usuarioPerfil === 'administrador';
        const priceFieldsHtml = isAdmin
            ? `
        <div class="hydro-form-group">
          <label for="hydroEditCostPrice">Preço de custo (R$)</label>
          <input type="number" id="hydroEditCostPrice" min="0" step="0.01" value="${p.costPrice || ''}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditSalePrice">Preço de venda (R$)</label>
          <input type="number" id="hydroEditSalePrice" min="0" step="0.01" value="${p.price}">
        </div>`
            : '';

        openModal({
            title: 'Editar produto',
            bodyHtml: `
        <div class="hydro-form-group">
          <label for="hydroEditName">Nome do produto</label>
          <input type="text" id="hydroEditName" value="${escapeHtml(p.name)}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditDesc">Descrição</label>
          <input type="text" id="hydroEditDesc" value="${escapeHtml(p.desc)}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditCategory">Categoria</label>
          <select id="hydroEditCategory">
            ${categories.map((c) => `<option value="${escapeHtml(c)}" ${c === p.category ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
          </select>
        </div>${priceFieldsHtml}
        <div class="hydro-form-group">
          <label for="hydroEditQuantity">Quantidade</label>
          <input type="number" id="hydroEditQuantity" min="0" value="${p.quantity}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditMin">Estoque mínimo</label>
          <input type="number" id="hydroEditMin" min="0" value="${p.minStock}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditValidade">Data de validade</label>
          <input type="date" id="hydroEditValidade" value="${p.validade || ''}">
        </div>
      `,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-primary hydro-btn-sm" id="hydroModalSaveBtn">Salvar alterações</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalSaveBtn').addEventListener('click', async () => {
            const name = document.getElementById('hydroEditName').value.trim();
            const desc = document.getElementById('hydroEditDesc').value.trim();
            const category = document.getElementById('hydroEditCategory').value;
            const quantity = Math.max(0, Number(document.getElementById('hydroEditQuantity').value) || 0);
            const minStock = Math.max(0, Number(document.getElementById('hydroEditMin').value) || 0);
            const validade = document.getElementById('hydroEditValidade').value || null;
            // Só existem no formulário quando usuarioPerfil === 'administrador' (RN04).
            const costPriceInput = document.getElementById('hydroEditCostPrice');
            const salePriceInput = document.getElementById('hydroEditSalePrice');
            const costPrice = costPriceInput ? Number(costPriceInput.value) || 0 : p.costPrice || 0;
            const salePrice = salePriceInput ? Number(salePriceInput.value) || 0 : p.price;

            if (!name) {
                showToast('Informe o nome do produto');
                return;
            }
            if (salePriceInput && salePrice <= 0) {
                showToast('Informe um preço de venda válido');
                return;
            }

            if (usingRealApi) {
                const saveBtn = document.getElementById('hydroModalSaveBtn');
                saveBtn.disabled = true;
                try {
                    // A quantidade só muda de fato via movimentação de estoque
                    // (RF12/RN11), para manter o histórico consolidado (RF10).
                    const delta = Math.round((quantity - p.quantity) * 1000) / 1000;
                    if (delta !== 0) {
                        await window.hydraApi('/estoque/movimentacoes', {
                            method: 'POST',
                            body: { id_produto: p.id, tipo: delta > 0 ? 'entrada' : 'saida', quantidade: Math.abs(delta) },
                        });
                    }
                    const { produto } = await window.hydraApi(`/produtos/${p.id}`, {
                        method: 'PUT',
                        body: {
                            nome: name,
                            descricao: desc,
                            codigo_barras: p.codigoBarras,
                            categoria: category,
                            preco_custo: costPrice || null,
                            preco_venda: salePrice,
                            estoque_minimo: minStock,
                            unidade: p.unit,
                            validade,
                            status: p.status || 'ativo',
                        },
                    });
                    Object.assign(p, mapApiProduct(produto));
                    closeModal();
                    refreshAll();
                    showToast('Produto atualizado com sucesso');
                } catch (err) {
                    showToast(err.message);
                    saveBtn.disabled = false;
                }
                return;
            }

            p.name = name;
            p.desc = desc;
            p.category = category;
            p.quantity = quantity;
            p.minStock = minStock;
            p.validade = validade;
            if (salePriceInput) {
                p.costPrice = costPrice;
                p.price = salePrice;
            }

            closeModal();
            refreshAll();
            showToast('Produto atualizado com sucesso');
        });
    }

    /* ---- Histórico de movimentações (RF10) ---- */
    async function openHistoryModal(id) {
        const p = products.find((x) => x.id === id);
        if (!p) return;

        openModal({
            title: `Movimentações — ${p.name}`,
            bodyHtml: '<p class="hydro-detail-row"><span>Carregando…</span></p>',
            footerHtml: `<button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalOkBtn">Fechar</button>`,
        });
        document.getElementById('hydroModalOkBtn').addEventListener('click', closeModal);

        if (!usingRealApi) {
            modalBody.innerHTML = '<p class="hydro-detail-row"><span>Histórico de movimentações disponível após login (demonstração não guarda esse histórico).</span></p>';
            return;
        }

        try {
            const { movimentacoes } = await window.hydraApi(`/produtos/${p.id}/movimentacoes`);
            if (!movimentacoes.length) {
                modalBody.innerHTML = '<p class="hydro-detail-row"><span>Nenhuma movimentação registrada para este produto.</span></p>';
                return;
            }
            const ORIGEM_LABELS = { cadastro: 'Cadastro', ajuste_manual: 'Ajuste manual', venda: 'Venda' };
            modalBody.innerHTML = movimentacoes
                .map((m) => {
                    const tipoLabel = m.tipo === 'entrada' ? 'Entrada' : 'Saída';
                    const origemLabel = ORIGEM_LABELS[m.origem] || m.origem;
                    return `
          <div class="hydro-detail-row">
            <span>${formatDateTime(m.data_movimentacao)} · ${escapeHtml(origemLabel)}</span>
            <span class="hydro-badge ${m.tipo === 'entrada' ? 'hydro-badge-ok' : 'hydro-badge-critical'}">${tipoLabel} · ${m.quantidade}</span>
          </div>`;
                })
                .join('');
        } catch (err) {
            modalBody.innerHTML = `<p class="hydro-detail-row"><span>${escapeHtml(err.message)}</span></p>`;
        }
    }

    /* ---- Excluir produto (RF02, RN03, RN20) ---- */
    function openDeleteModal(id) {
        const p = products.find((x) => x.id === id);
        if (!p) return;

        openModal({
            title: 'Confirmar exclusão',
            bodyHtml: `<p>Tem certeza de que deseja excluir o produto <strong>${escapeHtml(p.name)}</strong>? Se ele já tiver vendas registradas, será apenas inativado, preservando o histórico (RN03).</p>`,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-danger hydro-btn-sm" id="hydroModalConfirmBtn">Excluir</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalConfirmBtn').addEventListener('click', async () => {
            const confirmBtn = document.getElementById('hydroModalConfirmBtn');
            confirmBtn.disabled = true;

            if (usingRealApi) {
                try {
                    const { inativado } = await window.hydraApi(`/produtos/${p.id}`, { method: 'DELETE' });
                    products = products.filter((x) => x.id !== p.id);
                    closeModal();
                    refreshAll();
                    showToast(inativado ? `"${p.name}" já tinha vendas registradas e foi inativado` : `"${p.name}" removido`);
                } catch (err) {
                    showToast(err.message);
                    confirmBtn.disabled = false;
                }
                return;
            }

            products = products.filter((x) => x.id !== p.id);
            closeModal();
            refreshAll();
            showToast(`"${p.name}" removido`);
        });
    }

    /* ---- Entrada / Saída modal (global) ---- */
    function openMovementModal(type) {
        const isEntrada = type === 'entrada';
        const options = products
            .map((p) => `<option value="${p.id}">${escapeHtml(p.name)} (${p.quantity} un.)</option>`)
            .join('');

        openModal({
            title: isEntrada ? 'Entrada de estoque' : 'Saída de estoque',
            bodyHtml: `
        <div class="hydro-form-group">
          <label for="hydroMoveProduct">Produto</label>
          <select id="hydroMoveProduct">${options}</select>
        </div>
        <div class="hydro-form-group">
          <label for="hydroMoveQty">Quantidade</label>
          <input type="number" id="hydroMoveQty" min="1" value="10">
        </div>
      `,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn ${isEntrada ? 'hydro-btn-primary' : 'hydro-btn-danger'} hydro-btn-sm" id="hydroModalConfirmBtn">Confirmar ${isEntrada ? 'entrada' : 'saída'}</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalConfirmBtn').addEventListener('click', async () => {
            const productId = Number(document.getElementById('hydroMoveProduct').value);
            const qty = Math.max(1, Number(document.getElementById('hydroMoveQty').value) || 0);
            const p = products.find((x) => x.id === productId);
            if (!p) return;

            if (!isEntrada && qty > p.quantity) {
                showToast('Quantidade maior que o estoque disponível');
                return;
            }

            if (usingRealApi) {
                const confirmBtn = document.getElementById('hydroModalConfirmBtn');
                confirmBtn.disabled = true;
                try {
                    const { produto } = await window.hydraApi('/estoque/movimentacoes', {
                        method: 'POST',
                        body: { id_produto: p.id, tipo: isEntrada ? 'entrada' : 'saida', quantidade: qty },
                    });
                    Object.assign(p, mapApiProduct(produto));
                } catch (err) {
                    showToast(err.message);
                    confirmBtn.disabled = false;
                    return;
                }
            } else if (isEntrada) {
                p.quantity += qty;
            } else {
                p.quantity -= qty;
            }

            closeModal();
            refreshAll();
            showToast(isEntrada ? `Entrada registrada para "${p.name}"` : `Saída registrada para "${p.name}"`);
        });
    }

    /* ================= Toast ================= */
    let toastTimer = null;
    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        toast.textContent = message;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 2600);
    }

    /* ================= Refresh orchestration ================= */
    function refreshAll() {
        renderStats();
        renderCategoryOptions();
        renderTable();
    }

    /* ================= Wiring: filters, search, buttons ================= */
    document.getElementById('hydroSearchInput').addEventListener('input', (e) => {
        state.search = e.target.value.trim().toLowerCase();
        state.page = 1;
        renderTable();
    });

    document.getElementById('hydroFilterCategoria').addEventListener('change', (e) => {
        state.category = e.target.value;
        state.page = 1;
        renderTable();
    });

    document.getElementById('hydroFilterStatus').addEventListener('change', (e) => {
        state.status = e.target.value;
        state.page = 1;
        renderTable();
    });

    document.getElementById('hydroFilterValidade').addEventListener('change', (e) => {
        state.validade = e.target.value;
        state.page = 1;
        renderTable();
    });

    document.getElementById('hydroBtnNovoProduto').addEventListener('click', () => { window.location.href = 'produtos.html'; });
    document.getElementById('hydroBtnEntrada').addEventListener('click', () => openMovementModal('entrada'));
    document.getElementById('hydroBtnSaida').addEventListener('click', () => openMovementModal('saida'));

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
            if (link.dataset.view !== 'estoque') {
                showToast('Esta é uma demonstração — apenas as telas de Estoque, Equipe e Configurações estão implementadas');
            }
        });
    });

    /* ================= Guarda de sessão + carga de produtos =================
       RN04: os itens "Equipe" e "Configurações" só aparecem para o Administrador.
       Visitantes não autenticados (demo pública) continuam vendo todas as telas,
       com o catálogo de demonstração local (RF02: produtos reais exigem login). */
    (async function initAuthAndProducts() {
        if (!window.hydraApi) {
            products = seedProducts();
            refreshAll();
            return;
        }

        try {
            const { usuario } = await window.hydraApi('/auth/me');
            usuarioPerfil = usuario.perfil;
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            if (usuario.perfil !== 'administrador') {
                document.getElementById('hydroMenuAdminLabel').style.display = 'none';
                document.getElementById('hydroLiEquipe').style.display = 'none';
                document.getElementById('hydroLiConfig').style.display = 'none';
            }
        } catch (err) {
            // Visitante não autenticado (demo pública): mantém os itens visíveis, mostrando todas as telas.
            products = seedProducts();
            refreshAll();
            return;
        }

        try {
            const { produtos } = await window.hydraApi('/produtos');
            products = produtos.map(mapApiProduct);
            usingRealApi = true;
        } catch (err) {
            products = seedProducts();
        }
        refreshAll();
    })();

    /* ================= Mobile sidebar ================= */
    const sidebar = document.getElementById('hydroSidebar');
    const overlay = document.getElementById('hydroSidebarOverlay');
    document.getElementById('hydroMobileToggle').addEventListener('click', () => {
        sidebar.classList.add('hydro-open');
        overlay.classList.add('hydro-show');
    });
    overlay.addEventListener('click', closeSidebar);
    function closeSidebar() {
        sidebar.classList.remove('hydro-open');
        overlay.classList.remove('hydro-show');
    }
})();