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

                list.push({
                    id: seq,
                    name,
                    desc,
                    sku: `${prefix}-${(1000 + seq)}-${String(seq % 30).padStart(2, '0')}`,
                    category,
                    quantity,
                    minStock,
                    price: Math.round(price * 100) / 100,
                });
                seq++;
            });
        });
        return list;
    }

    let products = seedProducts();

    /* ================= State ================= */
    const state = {
        search: '',
        category: '',
        status: '',
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
            return matchesSearch && matchesCategory && matchesStatus;
        });
    }

    /* ================= Rendering: stats ================= */
    function renderStats() {
        const totalItens = products.reduce((sum, p) => sum + p.quantity, 0);
        const valorEstoque = products.reduce((sum, p) => sum + p.quantity * p.price, 0);
        const baixoCount = products.filter((p) => getStatus(p) !== 'Em estoque').length;

        document.getElementById('hydroStatTotalItens').textContent = totalItens.toLocaleString('pt-BR');
        document.getElementById('hydroStatValorEstoque').textContent = formatCurrency(valorEstoque);
        document.getElementById('hydroStatBaixo').textContent = baixoCount.toLocaleString('pt-BR');
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
                    return `
          <tr data-id="${p.id}">
            <td class="hydro-col-check" data-label=""><input type="checkbox" class="hydro-row-check"></td>
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
            <td data-label="Status"><span class="hydro-badge ${statusBadgeClass(status)}">${status}</span></td>
            <td class="hydro-col-actions" data-label="Ações">
              <div class="hydro-row-actions">
                <button class="hydro-action-btn hydro-action-view" title="Ver detalhes" data-id="${p.id}"><i class="hydro-ic hydro-ic-eye"></i></button>
                <button class="hydro-action-btn hydro-action-edit" title="Editar produto" data-id="${p.id}"><i class="hydro-ic hydro-ic-pencil"></i></button>
                <button class="hydro-action-btn hydro-action-add" title="Adicionar estoque" data-id="${p.id}"><i class="hydro-ic hydro-ic-plus"></i></button>
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
        document.querySelectorAll('.hydro-action-add').forEach((btn) =>
            btn.addEventListener('click', () => openAddStockModal(Number(btn.dataset.id)))
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
        openModal({
            title: p.name,
            bodyHtml: `
        <div class="hydro-detail-row"><span>Descrição</span><span>${escapeHtml(p.desc)}</span></div>
        <div class="hydro-detail-row"><span>SKU</span><span>${escapeHtml(p.sku)}</span></div>
        <div class="hydro-detail-row"><span>Categoria</span><span>${escapeHtml(p.category)}</span></div>
        <div class="hydro-detail-row"><span>Quantidade</span><span>${p.quantity} un.</span></div>
        <div class="hydro-detail-row"><span>Estoque mínimo</span><span>${p.minStock} un.</span></div>
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
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditQuantity">Quantidade</label>
          <input type="number" id="hydroEditQuantity" min="0" value="${p.quantity}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditMin">Estoque mínimo</label>
          <input type="number" id="hydroEditMin" min="0" value="${p.minStock}">
        </div>
      `,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-primary hydro-btn-sm" id="hydroModalSaveBtn">Salvar alterações</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalSaveBtn').addEventListener('click', () => {
            const name = document.getElementById('hydroEditName').value.trim();
            const desc = document.getElementById('hydroEditDesc').value.trim();
            const category = document.getElementById('hydroEditCategory').value;
            const quantity = Math.max(0, Number(document.getElementById('hydroEditQuantity').value) || 0);
            const minStock = Math.max(0, Number(document.getElementById('hydroEditMin').value) || 0);

            if (!name) {
                showToast('Informe o nome do produto');
                return;
            }

            p.name = name;
            p.desc = desc;
            p.category = category;
            p.quantity = quantity;
            p.minStock = minStock;

            closeModal();
            refreshAll();
            showToast('Produto atualizado com sucesso');
        });
    }

    /* ---- Add stock modal (row) ---- */
    function openAddStockModal(id) {
        const p = products.find((x) => x.id === id);
        if (!p) return;

        openModal({
            title: `Adicionar estoque · ${p.name}`,
            bodyHtml: `
        <div class="hydro-detail-row"><span>Quantidade atual</span><span>${p.quantity} un.</span></div>
        <div class="hydro-form-group">
          <label for="hydroAddQty">Quantidade a adicionar</label>
          <input type="number" id="hydroAddQty" min="1" value="10">
        </div>
      `,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-primary hydro-btn-sm" id="hydroModalConfirmBtn">Adicionar</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalConfirmBtn').addEventListener('click', () => {
            const qty = Math.max(1, Number(document.getElementById('hydroAddQty').value) || 0);
            p.quantity += qty;
            closeModal();
            refreshAll();
            showToast(`${qty} un. adicionadas a "${p.name}"`);
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
        document.getElementById('hydroModalConfirmBtn').addEventListener('click', () => {
            const productId = Number(document.getElementById('hydroMoveProduct').value);
            const qty = Math.max(1, Number(document.getElementById('hydroMoveQty').value) || 0);
            const p = products.find((x) => x.id === productId);
            if (!p) return;

            if (isEntrada) {
                p.quantity += qty;
            } else {
                if (qty > p.quantity) {
                    showToast('Quantidade maior que o estoque disponível');
                    return;
                }
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

    document.getElementById('hydroBtnEntrada').addEventListener('click', () => openMovementModal('entrada'));
    document.getElementById('hydroBtnSaida').addEventListener('click', () => openMovementModal('saida'));

    document.getElementById('hydroCheckAll').addEventListener('change', (e) => {
        document.querySelectorAll('.hydro-row-check').forEach((cb) => (cb.checked = e.target.checked));
    });

    /* ================= Sidebar nav (cosmético, demo de página única) ================= */
    document.querySelectorAll('.hydro-menu a[data-view]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.hydro-menu a').forEach((a) => a.classList.remove('hydro-active'));
            link.classList.add('hydro-active');
            closeSidebar();
            if (link.dataset.view !== 'estoque') {
                showToast('Esta é uma demonstração — apenas a tela de Estoque está implementada');
            }
        });
    });

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

    /* ================= Init ================= */
    refreshAll();
})();