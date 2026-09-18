(function () {
    'use strict';

    (async function guardAdminMenu() {
        if (!window.hydraApi) return;
        try {
            const { usuario } = await window.hydraApi('/auth/me');
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            if (usuario.perfil !== 'administrador') {
                document.getElementById('hydroLiEquipe').style.display = 'none';
                document.getElementById('hydroLiConfig').style.display = 'none';
            }
        } catch (err) {
            // Visitante não autenticado (demo pública): mantém os itens visíveis, mostrando todas as telas.
        }
    })();

    HydroStore.seedHistoryIfNeeded();

    const PAYMENT_LABELS = {
        dinheiro: 'Dinheiro',
        cartao: 'Cartão',
        pix: 'PIX',
        vale: 'Vale',
    };

    /* ================= Cupons de desconto (demo) ================= */
    const COUPONS = {
        HYDRA10: { type: 'percent', value: 10, label: '10% de desconto' },
        BEMVINDO20: { type: 'fixed', value: 20, label: 'R$ 20,00 de desconto' },
    };

    /* ================= Catálogo de produtos (dados reais, compartilhados) ================= */
    function getCatalog() {
        return HydroStore.getProducts();
    }

    function findProduct(productId) {
        return getCatalog().find((p) => p.id === productId);
    }

    /* ================= Itens vendidos por peso (kg) =================
       Um produto é "pesável" quando cadastrado com unidade "kg". O código
       de barras impresso pela balança usa a convenção "peso embutido"
       (comum no varejo brasileiro para produtos a granel):
         dígito 1......: prefixo "2" (faixa de uso interno/itens pesáveis)
         dígitos 2-6...: PLU — código do produto cadastrado na loja
         dígitos 7-12..: peso em gramas
         dígito 13.....: dígito verificador (checksum padrão EAN-13)
       Ex.: 2000120003507 = PLU 00012, 350g (0,350 kg). */
    function isWeightUnit(unit) {
        return unit === 'kg';
    }

    function productPlu(product) {
        if (product.plu) return String(product.plu).padStart(5, '0').slice(-5);
        return String(product.sku || '').replace(/\D/g, '').padStart(5, '0').slice(-5);
    }

    function decodeWeightBarcode(code) {
        if (!/^2\d{12}$/.test(code)) return null;
        const digits = code.split('').map(Number);
        const checkDigit = digits[12];
        let sum = 0;
        for (let i = 0; i < 12; i++) {
            sum += digits[i] * (i % 2 === 0 ? 1 : 3);
        }
        const calculated = (10 - (sum % 10)) % 10;
        if (calculated !== checkDigit) return null;

        const plu = code.slice(1, 6);
        const weightGrams = Number(code.slice(6, 12));
        return { plu, weightKg: weightGrams / 1000 };
    }

    /* Define (não soma) o peso da linha do pedido para um produto pesável. */
    function setWeightItem(product, weightKg) {
        if (!(weightKg > 0)) {
            showToast('Informe um peso válido', true);
            return false;
        }
        if (weightKg > product.quantity + 1e-6) {
            showToast('Quantidade em estoque insuficiente', true);
            return false;
        }
        getActiveOrder().items[product.id] = Math.round(weightKg * 1000) / 1000;
        return true;
    }

    /* ================= Estado do pedido (Caixa aceita 1 pedido aberto por vez) =================
       Os itens referenciam produtos reais (mesmos ids usados em Produtos/Estoque/Dashboard). */
    let orderCounter = 7800 + HydroStore.getSales().length;

    function createOrder() {
        orderCounter += 1;
        return { id: orderCounter, clienteId: '—', items: {}, payment: null, coupon: null, cashReceived: '' };
    }

    let order = createOrder();

    function getActiveOrder() {
        return order;
    }

    function money(value) {
        return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }

    /* Aceita "10,50", "10.50" ou "1.234,56" (formato brasileiro) */
    function parseMoney(str) {
        if (str === null || str === undefined || str === '') return NaN;
        let s = String(str).trim().replace(/[^\d,.-]/g, '');
        if (s.includes(',') && s.includes('.')) {
            s = s.replace(/\./g, '').replace(',', '.');
        } else if (s.includes(',')) {
            s = s.replace(',', '.');
        }
        return parseFloat(s);
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

    /* ================= Modal: item pesável (peso embutido / entrada manual) =================
       Entrada manual pensada para ser rápida: o operador digita a quantidade
       do jeito que vê no visor da balança (normalmente em gramas, um número
       inteiro) e escolhe a unidade — g ou kg — em vez de precisar converter
       de cabeça para quilos. Internamente tudo é guardado em kg, porque o
       preço cadastrado do produto é por kg. */
    const weightModalEl = document.getElementById('hydroWeightModal');
    const weightTitleEl = document.getElementById('hydroWeightModalTitle');
    const weightPriceEl = document.getElementById('hydroWeightModalPrice');
    const weightInputEl = document.getElementById('hydroWeightInput');
    const weightUnitSuffixEl = document.getElementById('hydroWeightUnitSuffix');
    const weightUnitButtons = document.querySelectorAll('#hydroWeightUnitToggle .hydro-weight-unit-btn');
    const weightTotalEl = document.getElementById('hydroWeightModalTotal');
    const weightConfirmBtn = document.getElementById('hydroWeightConfirmBtn');
    let weightModalProduct = null;
    let weightUnit = 'g';

    function weightToKg(value, unit) {
        return unit === 'g' ? value / 1000 : value;
    }

    function setWeightUnit(unit) {
        weightUnit = unit;
        weightUnitButtons.forEach((b) => b.classList.toggle('hydro-active', b.dataset.unit === unit));
        weightUnitSuffixEl.textContent = unit;
        weightInputEl.placeholder = unit === 'g' ? '0' : '0,000';
        updateWeightModalTotal();
    }

    weightUnitButtons.forEach((btn) => {
        btn.addEventListener('click', () => setWeightUnit(btn.dataset.unit));
    });

    function updateWeightModalTotal() {
        const raw = parseMoney(weightInputEl.value);
        const weightKg = isNaN(raw) ? NaN : weightToKg(raw, weightUnit);
        const total = !isNaN(weightKg) && weightModalProduct ? weightKg * weightModalProduct.price : 0;
        weightTotalEl.textContent = money(total > 0 ? total : 0);
    }

    function openWeightModal(product, prefillKg) {
        weightModalProduct = product;
        weightTitleEl.textContent = product.name;
        weightPriceEl.textContent = `${money(product.price)}/kg`;
        weightInputEl.value = prefillKg ? String(Math.round(prefillKg * 1000)) : '';
        setWeightUnit('g');
        weightModalEl.hidden = false;
        setTimeout(() => weightInputEl.focus(), 0);
    }

    function closeWeightModal() {
        weightModalEl.hidden = true;
        weightModalProduct = null;
    }

    weightModalEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-weight-close]')) closeWeightModal();
    });

    weightInputEl.addEventListener('input', updateWeightModalTotal);
    weightInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            weightConfirmBtn.click();
        } else if (e.key === 'Escape') {
            closeWeightModal();
        }
    });

    weightConfirmBtn.addEventListener('click', () => {
        if (!weightModalProduct) return;
        const raw = parseMoney(weightInputEl.value);
        if (isNaN(raw)) {
            showToast('Informe uma quantidade válida', true);
            return;
        }
        if (setWeightItem(weightModalProduct, weightToKg(raw, weightUnit))) {
            closeWeightModal();
            searchInput.value = '';
            closeSuggestions();
            renderAll();
        }
    });

    /* ================= Navegação: Nova Venda / Histórico de Vendas ================= */
    const viewTabsEl = document.getElementById('hydroViewTabs');
    const saleViewEl = document.getElementById('hydroSaleView');
    const historyViewEl = document.getElementById('hydroHistoryView');

    viewTabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.hydro-order-tab');
        if (!btn) return;
        const view = btn.dataset.view;
        viewTabsEl.querySelectorAll('.hydro-order-tab').forEach((b) => b.classList.toggle('hydro-active', b === btn));
        saleViewEl.hidden = view !== 'venda';
        historyViewEl.hidden = view !== 'historico';
        if (view === 'historico') renderHistory();
    });

    /* ================= Busca / leitura de código de barras ================= */
    const searchInput = document.getElementById('hydroProductSearch');
    const suggestionsEl = document.getElementById('hydroSuggestions');

    function matchesTerm(product, term) {
        return (
            product.name.toLowerCase().includes(term) ||
            (product.sku || '').toLowerCase().includes(term)
        );
    }

    function addProductToOrder(productId, qtyToAdd = 1) {
        const order = getActiveOrder();
        const product = findProduct(productId);
        if (!product) {
            showToast('Produto não encontrado', true);
            return false;
        }
        const current = order.items[productId] || 0;
        if (current + qtyToAdd > product.quantity) {
            showToast('Quantidade em estoque insuficiente', true);
            return false;
        }
        order.items[productId] = current + qtyToAdd;
        return true;
    }

    function closeSuggestions() {
        suggestionsEl.classList.remove('hydro-show');
        suggestionsEl.innerHTML = '';
    }

    function renderSuggestions() {
        const term = (searchInput.value || '').trim().toLowerCase();
        if (!term) {
            closeSuggestions();
            return;
        }
        const matches = getCatalog().filter((p) => matchesTerm(p, term)).slice(0, 8);
        if (!matches.length) {
            suggestionsEl.innerHTML = '<button type="button" class="hydro-suggestion" disabled>Nenhum produto encontrado</button>';
        } else {
            suggestionsEl.innerHTML = matches
                .map((p) => {
                    const outOfStock = p.quantity <= 0;
                    const priceLabel = outOfStock ? 'sem estoque' : isWeightUnit(p.unit) ? `${money(p.price)}/kg` : money(p.price);
                    return `<button type="button" class="hydro-suggestion" data-product-id="${p.id}" ${outOfStock ? 'disabled' : ''}>
                        <span class="hydro-suggestion-name">${p.name}</span>
                        <span class="hydro-suggestion-meta">${p.sku} · ${priceLabel}</span>
                    </button>`;
                })
                .join('');
        }
        suggestionsEl.classList.add('hydro-show');
    }

    function scanTerm() {
        const raw = (searchInput.value || '').trim();
        if (!raw) return;

        /* Etiqueta de balança (peso embutido): 13 dígitos começando com 2. */
        const digitsOnly = raw.replace(/\D/g, '');
        if (digitsOnly.length === 13 && digitsOnly.charAt(0) === '2') {
            const decoded = decodeWeightBarcode(digitsOnly);
            if (!decoded) {
                showToast('Código de barras de peso inválido (dígito verificador não confere)', true);
                return;
            }
            const product = getCatalog().find((p) => isWeightUnit(p.unit) && productPlu(p) === decoded.plu);
            if (!product) {
                showToast('Nenhum produto pesável cadastrado com este código', true);
                return;
            }
            if (setWeightItem(product, decoded.weightKg)) {
                searchInput.value = '';
                closeSuggestions();
                renderAll();
                showToast(`${product.name} adicionado — ${decoded.weightKg.toFixed(3)} kg`);
            }
            return;
        }

        const term = raw.toLowerCase();
        const exactSku = getCatalog().find((p) => (p.sku || '').toLowerCase() === term);
        const matches = exactSku ? [exactSku] : getCatalog().filter((p) => matchesTerm(p, term));

        if (matches.length === 1) {
            const product = matches[0];
            if (isWeightUnit(product.unit)) {
                searchInput.value = '';
                closeSuggestions();
                openWeightModal(product);
                return;
            }
            if (addProductToOrder(product.id)) {
                searchInput.value = '';
                closeSuggestions();
                renderAll();
            }
        } else if (matches.length === 0) {
            showToast('Produto não encontrado', true);
        } else {
            showToast('Vários produtos encontrados — selecione um da lista');
        }
    }

    searchInput.addEventListener('input', renderSuggestions);
    searchInput.addEventListener('focus', renderSuggestions);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            scanTerm();
        } else if (e.key === 'Escape') {
            closeSuggestions();
        }
    });

    suggestionsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-product-id]');
        if (!btn || btn.disabled) return;
        const product = findProduct(btn.dataset.productId);
        if (!product) return;

        if (isWeightUnit(product.unit)) {
            searchInput.value = '';
            closeSuggestions();
            openWeightModal(product);
            return;
        }
        if (addProductToOrder(product.id)) {
            searchInput.value = '';
            closeSuggestions();
            renderAll();
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.hydro-scan-bar')) closeSuggestions();
    });

    /* ================= Render: tabela de itens do pedido ================= */
    const orderTitleEl = document.getElementById('hydroOrderTitle');
    const orderClientEl = document.getElementById('hydroOrderClient');
    const orderItemsEl = document.getElementById('hydroOrderItems');
    const orderItemsWrapEl = orderItemsEl.closest('.hydro-items-table-wrap');
    const orderSubtotalEl = document.getElementById('hydroOrderSubtotal');
    const orderDiscountEl = document.getElementById('hydroOrderDiscount');
    const orderTotalEl = document.getElementById('hydroOrderTotal');
    const footerCountEl = document.getElementById('hydroFooterCount');
    const footerTotalEl = document.getElementById('hydroFooterTotal');
    const paymentButtons = document.querySelectorAll('.hydro-payment-btn');
    const couponInput = document.getElementById('hydroCouponInput');
    const couponRowEl = document.getElementById('hydroCouponRow');
    const couponAppliedEl = document.getElementById('hydroCouponApplied');
    const couponAppliedLabelEl = document.getElementById('hydroCouponAppliedLabel');
    const cashBoxEl = document.getElementById('hydroCashBox');
    const cashInputEl = document.getElementById('hydroCashReceived');
    const cashInputWrapEl = cashInputEl.closest('.hydro-cash-input-wrap');
    const cashChangeRowEl = document.getElementById('hydroCashChangeRow');
    const cashChangeEl = document.getElementById('hydroCashChange');

    function computeTotals(order) {
        const entries = Object.entries(order.items);
        const subtotal = entries.reduce((sum, [productId, qty]) => {
            const product = findProduct(productId);
            return sum + (product ? product.price * qty : 0);
        }, 0);

        let discount = 0;
        if (order.coupon) {
            discount = order.coupon.type === 'percent'
                ? subtotal * (order.coupon.value / 100)
                : Math.min(order.coupon.value, subtotal);
        }

        return { entries, subtotal, discount, total: Math.max(subtotal - discount, 0) };
    }

    /* ================= Dinheiro recebido / troco ================= */
    function updateCashUI(order, total, opts) {
        const isCash = order.payment === 'dinheiro';
        cashBoxEl.hidden = !isCash;
        if (!isCash) return;

        if (!opts || !opts.skipInputValue) {
            cashInputEl.value = order.cashReceived || '';
        }

        const received = parseMoney(order.cashReceived);
        const hasValue = !isNaN(received);
        const change = hasValue ? received - total : null;
        const insufficient = hasValue && change < 0;

        cashChangeEl.textContent = money(hasValue ? Math.max(change, 0) : 0);
        cashChangeRowEl.classList.toggle('hydro-cash-change-warning', insufficient);
        cashInputWrapEl.classList.toggle('hydro-cash-invalid', insufficient);
    }

    cashInputEl.addEventListener('input', () => {
        const order = getActiveOrder();
        order.cashReceived = cashInputEl.value;
        const { total } = computeTotals(order);
        updateCashUI(order, total, { skipInputValue: true });
    });

    function renderOrderPanel() {
        const order = getActiveOrder();
        orderTitleEl.textContent = `Pedido #${order.id}`;
        orderClientEl.textContent = `Cliente ID #${order.clienteId}`;

        const { entries, subtotal, discount, total } = computeTotals(order);
        const itemCount = entries.reduce((sum, [, qty]) => sum + qty, 0);

        orderItemsWrapEl.classList.toggle('hydro-empty', entries.length === 0);

        orderItemsEl.innerHTML = entries
            .map(([productId, qty]) => {
                const product = findProduct(productId);
                const lineTotal = product.price * qty;
                const weighty = isWeightUnit(product.unit);
                const atStockLimit = qty >= product.quantity;

                const qtyCell = weighty
                    ? `<div class="hydro-weight-cell">
                            <span class="hydro-qty-value">${qty.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg</span>
                            <button type="button" class="hydro-qty-btn" data-action="edit-weight" data-product-id="${productId}" aria-label="Editar peso">
                                <i class="hydro-ic hydro-ic-pencil"></i>
                            </button>
                       </div>`
                    : `<div class="hydro-qty-stepper">
                            <button type="button" class="hydro-qty-btn" data-action="dec" data-product-id="${productId}" aria-label="Diminuir quantidade">
                                <i class="hydro-ic hydro-ic-minus"></i>
                            </button>
                            <span class="hydro-qty-value">${qty}</span>
                            <button type="button" class="hydro-qty-btn" data-action="inc" data-product-id="${productId}" ${atStockLimit ? 'disabled' : ''} aria-label="Aumentar quantidade">
                                <i class="hydro-ic hydro-ic-plus"></i>
                            </button>
                       </div>`;

                return `
                <tr>
                    <td data-label="Item"><div class="hydro-item-thumb"><i class="hydro-ic hydro-ic-package"></i></div></td>
                    <td data-label="Código" class="hydro-item-code">${product.sku}</td>
                    <td data-label="Descrição">
                        <p class="hydro-item-name">${product.name}</p>
                        <p class="hydro-item-desc">${product.desc || product.category}</p>
                    </td>
                    <td data-label="Qtd">${qtyCell}</td>
                    <td data-label="Unitário" class="hydro-item-unit">${weighty ? `${money(product.price)}/kg` : money(product.price)}</td>
                    <td data-label="Total" class="hydro-item-total">${money(lineTotal)}</td>
                    <td data-label="Ações">
                        <button type="button" class="hydro-item-remove" data-remove-id="${productId}" aria-label="Remover item">
                            <i class="hydro-ic hydro-ic-trash"></i>
                        </button>
                    </td>
                </tr>`;
            })
            .join('');

        orderSubtotalEl.textContent = money(subtotal);
        orderDiscountEl.textContent = discount > 0 ? `- ${money(discount)}` : money(0);
        orderTotalEl.textContent = money(total);
        footerCountEl.textContent = String(itemCount);
        footerTotalEl.textContent = money(total);

        couponInput.value = '';
        if (order.coupon) {
            couponRowEl.hidden = true;
            couponAppliedEl.hidden = false;
            couponAppliedLabelEl.textContent = `${order.coupon.code} — ${order.coupon.label}`;
        } else {
            couponRowEl.hidden = false;
            couponAppliedEl.hidden = true;
        }

        paymentButtons.forEach((btn) => {
            btn.classList.toggle('hydro-selected', btn.dataset.method === order.payment);
        });

        updateCashUI(order, total);
    }

    orderItemsEl.addEventListener('click', (e) => {
        const order = getActiveOrder();

        const removeBtn = e.target.closest('[data-remove-id]');
        if (removeBtn) {
            delete order.items[removeBtn.dataset.removeId];
            renderAll();
            return;
        }

        const qtyBtn = e.target.closest('[data-action]');
        if (!qtyBtn || qtyBtn.disabled) return;
        const productId = qtyBtn.dataset.productId;
        const current = order.items[productId] || 0;

        if (qtyBtn.dataset.action === 'edit-weight') {
            const product = findProduct(productId);
            if (product) openWeightModal(product, current);
            return;
        }
        if (qtyBtn.dataset.action === 'inc') {
            addProductToOrder(productId);
        } else if (qtyBtn.dataset.action === 'dec') {
            const next = current - 1;
            if (next <= 0) delete order.items[productId];
            else order.items[productId] = next;
        }
        renderAll();
    });

    paymentButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            const order = getActiveOrder();
            order.payment = order.payment === btn.dataset.method ? null : btn.dataset.method;
            renderOrderPanel();
        });
    });

    /* ================= Cupom de desconto ================= */
    document.getElementById('hydroCouponApplyBtn').addEventListener('click', () => {
        const order = getActiveOrder();
        const code = (couponInput.value || '').trim().toUpperCase();
        if (!code) {
            showToast('Digite um código de cupom', true);
            return;
        }
        const coupon = COUPONS[code];
        if (!coupon) {
            showToast('Cupom inválido ou expirado', true);
            return;
        }
        order.coupon = { code, ...coupon };
        renderOrderPanel();
        showToast(`Cupom ${code} aplicado`);
    });

    couponInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('hydroCouponApplyBtn').click();
        }
    });

    document.getElementById('hydroCouponRemoveBtn').addEventListener('click', () => {
        const order = getActiveOrder();
        order.coupon = null;
        renderOrderPanel();
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
        if (!Object.keys(order.items).length) {
            showToast('Este pedido já está vazio', true);
            return;
        }
        if (confirm(`Cancelar o Pedido #${order.id}? Todos os itens serão removidos.`)) {
            order = createOrder();
            renderAll();
            showToast('Pedido cancelado');
        }
    });

    /* ================= Finalizar pedido ================= */
    document.getElementById('hydroFinishOrderBtn').addEventListener('click', () => {
        const { entries, subtotal, discount, total } = computeTotals(order);

        if (!entries.length) {
            showToast('Adicione ao menos um item ao pedido', true);
            return;
        }
        if (!order.payment) {
            showToast('Selecione a forma de pagamento', true);
            return;
        }

        let cashReceived = null;
        let change = null;
        if (order.payment === 'dinheiro') {
            cashReceived = parseMoney(order.cashReceived);
            if (isNaN(cashReceived) || cashReceived < total) {
                showToast('Informe um valor recebido suficiente para cobrir o total', true);
                return;
            }
            change = Math.round((cashReceived - total) * 100) / 100;
        }

        const saleItems = entries.map(([productId, qty]) => {
            const product = findProduct(productId);
            return { productId, name: product.name, qty, price: product.price };
        });

        // HydroStore.addSale grava a venda e já dá baixa no estoque compartilhado
        HydroStore.addSale({
            orderId: order.id,
            clienteId: order.clienteId,
            items: saleItems,
            subtotal: Math.round(subtotal * 100) / 100,
            discount: Math.round(discount * 100) / 100,
            total: Math.round(total * 100) / 100,
            payment: order.payment,
            coupon: order.coupon ? order.coupon.code : null,
            cashReceived: cashReceived === null ? null : Math.round(cashReceived * 100) / 100,
            change,
        });

        const changeMsg = change !== null ? ` — troco: ${money(change)}` : '';
        showToast(`Pedido #${order.id} finalizado — pagamento em ${PAYMENT_LABELS[order.payment]}${changeMsg}`);
        order = createOrder();
        renderAll();
    });

    /* ================= Histórico de vendas ================= */
    const historySearchInput = document.getElementById('hydroHistorySearch');
    const historyBodyEl = document.getElementById('hydroHistoryBody');
    const historyWrapEl = document.getElementById('hydroHistoryTableWrap');

    function renderHistory() {
        const term = (historySearchInput.value || '').trim().toLowerCase();
        const sales = HydroStore.getSales()
            .slice()
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .filter((sale) => {
                if (!term) return true;
                return String(sale.orderId).includes(term) || (sale.clienteId || '').toLowerCase().includes(term);
            });

        historyWrapEl.classList.toggle('hydro-empty', sales.length === 0);

        historyBodyEl.innerHTML = sales
            .map((sale) => {
                const itemCount = (sale.items || []).reduce((sum, it) => sum + it.qty, 0);
                const when = new Date(sale.date).toLocaleString('pt-BR');
                return `
                <tr>
                    <td data-label="Data/Hora">${when}</td>
                    <td data-label="Pedido">#${sale.orderId}</td>
                    <td data-label="Cliente">${sale.clienteId || '—'}</td>
                    <td data-label="Itens">${itemCount} ${itemCount === 1 ? 'item' : 'itens'}</td>
                    <td data-label="Pagamento">${PAYMENT_LABELS[sale.payment] || sale.payment || '—'}</td>
                    <td data-label="Total" class="hydro-item-total">${money(sale.total)}</td>
                    <td data-label="Ações">
                        <button type="button" class="hydro-item-remove" data-view-sale="${sale.id}" aria-label="Ver detalhes da venda">
                            <i class="hydro-ic hydro-ic-eye"></i>
                        </button>
                    </td>
                </tr>`;
            })
            .join('');
    }

    historySearchInput.addEventListener('input', renderHistory);

    /* ================= Modal: detalhes da venda (Histórico) ================= */
    const saleDetailModalEl = document.getElementById('hydroSaleDetailModal');
    const saleDetailWhenEl = document.getElementById('hydroSaleDetailWhen');
    const saleDetailTitleEl = document.getElementById('hydroSaleDetailTitle');
    const saleDetailClientEl = document.getElementById('hydroSaleDetailClient');
    const saleDetailPaymentEl = document.getElementById('hydroSaleDetailPayment');
    const saleDetailCashRowEl = document.getElementById('hydroSaleDetailCashRow');
    const saleDetailReceivedEl = document.getElementById('hydroSaleDetailReceived');
    const saleDetailChangeEl = document.getElementById('hydroSaleDetailChange');
    const saleDetailItemsEl = document.getElementById('hydroSaleDetailItems');
    const saleDetailSubtotalEl = document.getElementById('hydroSaleDetailSubtotal');
    const saleDetailDiscountEl = document.getElementById('hydroSaleDetailDiscount');
    const saleDetailCouponLabelEl = document.getElementById('hydroSaleDetailCouponLabel');
    const saleDetailTotalEl = document.getElementById('hydroSaleDetailTotal');

    function openSaleDetailModal(sale) {
        saleDetailWhenEl.textContent = new Date(sale.date).toLocaleString('pt-BR');
        saleDetailTitleEl.textContent = `Pedido #${sale.orderId}`;
        saleDetailClientEl.textContent = sale.clienteId || '—';
        saleDetailPaymentEl.textContent = PAYMENT_LABELS[sale.payment] || sale.payment || '—';

        const isCash = sale.payment === 'dinheiro' && sale.cashReceived != null;
        saleDetailCashRowEl.hidden = !isCash;
        if (isCash) {
            saleDetailReceivedEl.textContent = money(sale.cashReceived);
            saleDetailChangeEl.textContent = money(sale.change || 0);
        }

        saleDetailItemsEl.innerHTML = (sale.items || [])
            .map((it) => {
                const product = findProduct(it.productId);
                const weighty = product && isWeightUnit(product.unit);
                const qtyLabel = weighty
                    ? `${Number(it.qty).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`
                    : it.qty;
                const unitLabel = weighty ? `${money(it.price)}/kg` : money(it.price);
                return `
                <tr>
                    <td data-label="Produto">${it.name}</td>
                    <td data-label="Qtd">${qtyLabel}</td>
                    <td data-label="Unitário">${unitLabel}</td>
                    <td data-label="Total" class="hydro-item-total">${money(it.qty * it.price)}</td>
                </tr>`;
            })
            .join('');

        const subtotal = sale.subtotal != null ? sale.subtotal : sale.total;
        const discount = sale.discount || 0;
        saleDetailSubtotalEl.textContent = money(subtotal);
        saleDetailDiscountEl.textContent = discount > 0 ? `- ${money(discount)}` : money(0);
        saleDetailCouponLabelEl.textContent = sale.coupon ? ` (${sale.coupon})` : '';
        saleDetailTotalEl.textContent = money(sale.total);

        saleDetailModalEl.hidden = false;
    }

    function closeSaleDetailModal() {
        saleDetailModalEl.hidden = true;
    }

    saleDetailModalEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-sale-detail-close]')) closeSaleDetailModal();
    });

    historyBodyEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view-sale]');
        if (!btn) return;
        const sale = HydroStore.getSales().find((s) => s.id === btn.dataset.viewSale);
        if (sale) openSaleDetailModal(sale);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSaleDetailModal();
    });

    /* ================= Render geral ================= */
    function renderAll() {
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
