(function () {
    'use strict';

    HydroStore.seedHistoryIfNeeded();

    const PAYMENT_LABELS = { dinheiro: 'Dinheiro', cartao: 'Cartão', pix: 'PIX' };

    /* ================= Catálogo de produtos (dados reais, compartilhados) ================= */
    function getCatalog() {
        return HydroStore.getProducts();
    }

    function findProduct(productId) {
        return getCatalog().find((p) => p.id === productId);
    }

    /* ================= Estado dos pedidos (abas do Caixa, em memória) =================
       Os itens referenciam produtos reais (mesmos ids usados em Produtos/Estoque/Dashboard). */
    const seedProducts = getCatalog();
    const byName = (name) => (seedProducts.find((p) => p.name === name) || {}).id;

    const orders = [
        { id: 7812, clienteId: 'CL92', items: {}, payment: null },
        {
            id: 7813,
            clienteId: 'CL88',
            items: {
                [byName('Café Tradicional 500g')]: 2,
                [byName('Leite Integral 1L')]: 2,
                [byName('Açúcar Cristal 1kg')]: 1,
            },
            payment: 'cartao',
        },
        { id: 7814, clienteId: 'CL05', items: {}, payment: null },
    ];
    let activeOrderId = 7813;

    function getActiveOrder() {
        return orders.find((o) => o.id === activeOrderId);
    }

    function money(value) {
        return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    /* ================= Toast ================= */
    const toast = document.getElementById('hydroToast');
    let toastTimer = null;
    function showToast(message, isError) {
        toast.textContent = message;
        toast.classList.toggle('hydro-toast-error', !!isError);
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 3000);
    }

    /* ================= Render: abas de pedidos ================= */
    const tabsEl = document.getElementById('hydroOrderTabs');
    function renderTabs() {
        tabsEl.innerHTML = orders
            .map((o) => {
                const count = Object.values(o.items).reduce((a, b) => a + b, 0);
                const active = o.id === activeOrderId ? ' hydro-active' : '';
                const badge = count > 0 ? `<span class="hydro-tab-badge">${count}</span>` : '';
                return `<button type="button" class="hydro-order-tab${active}" data-order-id="${o.id}">Pedido #${o.id}${badge}</button>`;
            })
            .join('');
    }

    tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.hydro-order-tab');
        if (!btn) return;
        activeOrderId = Number(btn.dataset.orderId);
        renderAll();
    });

    /* ================= Render: grade de produtos ================= */
    const gridEl = document.getElementById('hydroProductGrid');
    const searchInput = document.getElementById('hydroProductSearch');

    function productCardHtml(product) {
        const order = getActiveOrder();
        const qty = order.items[product.id] || 0;
        const outOfStock = product.quantity <= 0;
        const atStockLimit = qty >= product.quantity;

        let controls;
        if (qty > 0) {
            controls = `<div class="hydro-qty-stepper">
                 <button type="button" class="hydro-qty-btn" data-action="dec" data-product-id="${product.id}" aria-label="Diminuir quantidade">
                   <i class="hydro-ic hydro-ic-minus"></i>
                 </button>
                 <span class="hydro-qty-value">${qty}</span>
                 <button type="button" class="hydro-qty-btn" data-action="inc" data-product-id="${product.id}" ${atStockLimit ? 'disabled' : ''} aria-label="Aumentar quantidade">
                   <i class="hydro-ic hydro-ic-plus"></i>
                 </button>
               </div>`;
        } else {
            controls = `<button type="button" class="hydro-add-btn" data-action="inc" data-product-id="${product.id}" ${outOfStock ? 'disabled' : ''}>
                 <i class="hydro-ic hydro-ic-plus"></i> ${outOfStock ? 'Sem estoque' : 'Adicionar'}
               </button>`;
        }

        return `
        <article class="hydro-product-card${outOfStock ? ' hydro-product-out' : ''}">
            <div class="hydro-product-thumb"><i class="hydro-ic hydro-ic-package"></i></div>
            <div class="hydro-product-info">
                <p class="hydro-product-name">${product.name}</p>
                <p class="hydro-product-desc">${product.desc || product.category}</p>
                <p class="hydro-product-stock${outOfStock ? ' hydro-stock-zero' : ''}">${product.quantity} un. em estoque</p>
            </div>
            <div class="hydro-product-footer">
                <span class="hydro-product-price">${money(product.price)}</span>
                ${controls}
            </div>
        </article>`;
    }

    function renderGrid() {
        const term = (searchInput.value || '').trim().toLowerCase();
        const catalog = getCatalog();
        const list = term ? catalog.filter((p) => p.name.toLowerCase().includes(term)) : catalog;
        gridEl.innerHTML = list.length
            ? list.map(productCardHtml).join('')
            : '<p style="color:var(--muted); font-size:14px; padding:20px;">Nenhum produto encontrado.</p>';
    }

    searchInput.addEventListener('input', renderGrid);

    gridEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn || btn.disabled) return;
        const order = getActiveOrder();
        const productId = btn.dataset.productId;
        const product = findProduct(productId);
        const current = order.items[productId] || 0;

        if (btn.dataset.action === 'inc') {
            if (!product || current >= product.quantity) {
                showToast('Quantidade em estoque insuficiente', true);
                return;
            }
            order.items[productId] = current + 1;
        } else if (btn.dataset.action === 'dec') {
            const next = current - 1;
            if (next <= 0) {
                delete order.items[productId];
            } else {
                order.items[productId] = next;
            }
        }
        renderAll();
    });

    /* ================= Render: painel do pedido ================= */
    const orderTitleEl = document.getElementById('hydroOrderTitle');
    const orderClientEl = document.getElementById('hydroOrderClient');
    const orderItemsEl = document.getElementById('hydroOrderItems');
    const orderTotalEl = document.getElementById('hydroOrderTotal');
    const paymentButtons = document.querySelectorAll('.hydro-payment-btn');

    function renderOrderPanel() {
        const order = getActiveOrder();
        orderTitleEl.textContent = `Pedido #${order.id}`;
        orderClientEl.textContent = `Cliente ID #${order.clienteId}`;

        const entries = Object.entries(order.items);
        let total = 0;

        if (!entries.length) {
            orderItemsEl.innerHTML = '<p class="hydro-order-empty">Nenhum item adicionado ainda. Selecione produtos na lista ao lado.</p>';
        } else {
            orderItemsEl.innerHTML = entries
                .map(([productId, qty]) => {
                    const product = findProduct(productId);
                    const subtotal = product.price * qty;
                    total += subtotal;
                    return `
                    <div class="hydro-order-item">
                        <div class="hydro-order-item-name">
                            <span class="hydro-order-item-qty">${qty}x</span>
                            <span>${product.name}</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span class="hydro-order-item-price">${money(subtotal)}</span>
                            <button type="button" class="hydro-order-item-remove" data-remove-id="${productId}" aria-label="Remover item">
                                <i class="hydro-ic hydro-ic-trash"></i>
                            </button>
                        </div>
                    </div>`;
                })
                .join('');
        }

        orderTotalEl.textContent = money(total);

        paymentButtons.forEach((btn) => {
            btn.classList.toggle('hydro-selected', btn.dataset.method === order.payment);
        });
    }

    orderItemsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove-id]');
        if (!btn) return;
        const order = getActiveOrder();
        delete order.items[btn.dataset.removeId];
        renderAll();
    });

    paymentButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const order = getActiveOrder();
            order.payment = order.payment === btn.dataset.method ? null : btn.dataset.method;
            renderOrderPanel();
        });
    });

    /* ================= Ações: editar cliente / cancelar pedido ================= */
    document.getElementById('hydroEditClientBtn').addEventListener('click', () => {
        const order = getActiveOrder();
        const value = prompt('ID do cliente para este pedido:', order.clienteId);
        if (value === null) return;
        order.clienteId = value.trim() || order.clienteId;
        renderOrderPanel();
    });

    document.getElementById('hydroClearOrderBtn').addEventListener('click', () => {
        const order = getActiveOrder();
        if (!Object.keys(order.items).length) {
            showToast('Este pedido já está vazio', true);
            return;
        }
        if (confirm(`Cancelar o Pedido #${order.id}? Todos os itens serão removidos.`)) {
            order.items = {};
            order.payment = null;
            renderAll();
            showToast('Pedido cancelado');
        }
    });

    document.getElementById('hydroCancelOrderBtn').addEventListener('click', () => {
        document.getElementById('hydroClearOrderBtn').click();
    });

    /* ================= Finalizar pedido ================= */
    document.getElementById('hydroFinishOrderBtn').addEventListener('click', () => {
        const order = getActiveOrder();
        const entries = Object.entries(order.items);

        if (!entries.length) {
            showToast('Adicione ao menos um item ao pedido', true);
            return;
        }
        if (!order.payment) {
            showToast('Selecione a forma de pagamento', true);
            return;
        }

        const saleItems = entries.map(([productId, qty]) => {
            const product = findProduct(productId);
            return { productId, name: product.name, qty, price: product.price };
        });
        const total = saleItems.reduce((sum, it) => sum + it.qty * it.price, 0);

        // HydroStore.addSale grava a venda e já dá baixa no estoque compartilhado
        HydroStore.addSale({
            orderId: order.id,
            clienteId: order.clienteId,
            items: saleItems,
            total: Math.round(total * 100) / 100,
            payment: order.payment,
        });

        showToast(`Pedido #${order.id} finalizado — pagamento em ${PAYMENT_LABELS[order.payment]}`);
        order.items = {};
        order.payment = null;
        renderAll();
    });

    /* ================= Render geral ================= */
    function renderAll() {
        renderTabs();
        renderGrid();
        renderOrderPanel();
    }

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

    /* ================= Init ================= */
    renderAll();
})();
