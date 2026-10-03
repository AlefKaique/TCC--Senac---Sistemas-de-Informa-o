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

    /* A barra lateral e a guarda de permissão são aplicadas dentro de
       init(), que já aguarda GET /auth/me — antes havia uma IIFE separada
       aqui em cima que repetia a mesma chamada e, por não ser aguardada,
       corria com o primeiro render do painel do pedido. */

    HydroStore.seedHistoryIfNeeded();

    const PAYMENT_LABELS = {
        dinheiro: 'Dinheiro',
        cartao: 'Cartão',
        pix: 'PIX',
        vale: 'Vale',
    };

    // A UI só oferece uma forma de pagamento por venda (sem split de
    // pagamento); o back-end distingue crédito/débito (RN10), então o
    // botão genérico "Cartão" é enviado como crédito por padrão.
    const PAYMENT_METHOD_TO_API = { dinheiro: 'dinheiro', cartao: 'cartao_credito', pix: 'pix', vale: 'vale_refeicao' };
    const PAYMENT_METHOD_FROM_API = {
        dinheiro: 'dinheiro',
        cartao_credito: 'cartao',
        cartao_debito: 'cartao',
        pix: 'pix',
        vale_refeicao: 'vale',
    };

    /* ================= Catálogo de produtos e histórico de vendas =================
       Vêm da API real quando o usuário está autenticado (RF04); para o
       visitante da demo pública, continuam vindo do HydroStore local. */
    let usingRealApi = false;
    let catalog = [];
    let salesHistory = [];
    // Usuário autenticado: o histórico e o cabeçalho do pedido mostram quem
    // operou o caixa (null para o visitante da demo pública).
    let usuarioAtual = null;

    function getCatalog() {
        return catalog;
    }

    // Os ids viram string para bater com as chaves usadas em order.items
    // (toda chave de objeto em JS é string) e com dataset.productId.
    function mapApiProduct(p) {
        return {
            id: String(p.id_produto),
            name: p.nome,
            desc: p.descricao || '',
            category: p.categoria,
            price: Number(p.preco_venda),
            quantity: Number(p.quantidade),
            unit: p.unidade,
        };
    }

    function mapApiVenda(v) {
        const primeiroPagamento = (v.pagamentos || [])[0];
        return {
            id: String(v.id_venda),
            // O número exibido é o sequencial DA LOJA, não a chave primária
            // (que é global e compartilhada entre lojas).
            orderId: Number(v.numero_venda),
            date: v.data_venda,
            usuario: v.nome_usuario || 'Usuário removido',
            items: (v.itens || []).map((it) => ({
                productId: String(it.id_produto),
                name: it.nome_produto,
                qty: Number(it.quantidade),
                price: Number(it.preco_unitario),
            })),
            subtotal: Number(v.subtotal),
            total: Number(v.valor_total),
            payment: primeiroPagamento ? (PAYMENT_METHOD_FROM_API[primeiroPagamento.forma_pagamento] || primeiroPagamento.forma_pagamento) : null,
            cashReceived: null,
            change: null,
        };
    }

    function findProduct(productId) {
        return getCatalog().find((p) => p.id === productId);
    }

    /* ================= Itens vendidos por peso (kg) =================
       Um produto é "pesável" quando cadastrado com unidade "kg": ao ser
       adicionado à venda, o Caixa abre o modal de peso para o operador
       digitar os gramas/quilos lidos na balança. */
    function isWeightUnit(unit) {
        return unit === 'kg';
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
       Os itens referenciam produtos reais (mesmos ids usados em Produtos/Estoque/Dashboard).

       "proximoNumero" é o número que a próxima venda vai receber. Ele vem do
       back-end (GET /api/vendas devolve "proximo_numero", calculado sobre as
       vendas da loja) e é reajustado a cada venda finalizada, para bater com
       o que o Histórico mostra. Antes isto era 7800 + a quantidade de vendas
       de DEMONSTRAÇÃO guardadas no localStorage: um número que nunca chegava
       ao banco, mudava de navegador para navegador e não tinha relação
       nenhuma com o "#" exibido no histórico. */
    let proximoNumero = 1;

    function createOrder() {
        return { id: proximoNumero, items: {}, payment: null, cashReceived: '' };
    }

    let order = createOrder();

    /* Recalcula o número do pedido aberto depois que "proximoNumero" muda
       (carga inicial e cada venda finalizada). Só mexe em pedido vazio: se o
       operador já começou a montar a venda, trocar o cabeçalho no meio do
       caminho seria confuso — o número definitivo é o que o back-end gravar. */
    function syncOrderNumber() {
        if (!Object.keys(order.items).length) order.id = proximoNumero;
    }

    /* O número só é desconhecido (null) quando o cargo não pode ler
       /api/vendas — ver init(). Nesse caso o pedido é identificado como
       "Nova Venda" até ser gravado. */
    function rotuloPedido(numero) {
        return numero == null ? 'Nova Venda' : `Pedido #${numero}`;
    }

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
            renderAll();
        }
    });

    /* ================= Navegação: Nova Venda / Histórico de Vendas ================= */
    const viewTabsEl = document.getElementById('hydroViewTabs');
    const saleViewEl = document.getElementById('hydroSaleView');
    const historyViewEl = document.getElementById('hydroHistoryView');

    function mostrarAba(view) {
        viewTabsEl.querySelectorAll('.hydro-order-tab').forEach((b) => {
            b.classList.toggle('hydro-active', b.dataset.view === view);
        });
        saleViewEl.hidden = view !== 'venda';
        historyViewEl.hidden = view !== 'historico';
        if (view === 'historico') renderHistory();
    }

    viewTabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.hydro-order-tab');
        if (!btn) return;
        mostrarAba(btn.dataset.view);
    });

    /* As duas abas desta tela têm permissões diferentes: "vendas.operar"
       abre o PDV e "vendas.historico" abre a consulta. Um cargo pode ter só
       uma delas — por exemplo, um conferente que acompanha as vendas do dia
       sem poder registrar nenhuma. A aba que o cargo não tem some, e se a
       que sobrou não for a inicial, a tela já abre nela. */
    function aplicarAbasPorPermissao(usuario) {
        const abas = [
            ['venda', 'vendas.operar'],
            ['historico', 'vendas.historico'],
        ];
        let primeiraDisponivel = null;
        for (const [view, permissao] of abas) {
            const btn = viewTabsEl.querySelector(`.hydro-order-tab[data-view="${view}"]`);
            if (!btn) continue;
            const pode = window.hydraPode(usuario, [permissao]);
            btn.hidden = !pode;
            if (pode && primeiraDisponivel === null) primeiraDisponivel = view;
        }
        if (primeiraDisponivel && primeiraDisponivel !== 'venda') mostrarAba(primeiraDisponivel);
    }

    /* ================= Vitrine: produtos em estoque =================
       A tela de Vendas abre mostrando o que há na prateleira, com busca por
       nome e filtro de categoria. O operador do mercadinho vende olhando a
       lista, sem precisar decorar nada. */
    const searchInput = document.getElementById('hydroProductSearch');
    const catalogGridEl = document.getElementById('hydroCatalogGrid');
    const catalogEmptyEl = document.getElementById('hydroCatalogEmpty');
    const catalogCategoryEl = document.getElementById('hydroCatalogCategory');

    const catalogState = { search: '', category: '' };

    /* A quantidade é DECIMAL(10,3) no banco, então o MySQL devolve "20.000"
       para 20 unidades e "42.500" para 42,5 kg. Mesma normalização usada em
       controle-estoque.js (duplicada: cada tela carrega seu próprio script). */
    function formatStock(value, unit) {
        const n = Number(value);
        if (!Number.isFinite(n)) return String(value);
        return `${n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${unit || 'un'}`;
    }

    function getFilteredCatalog() {
        return getCatalog()
            .filter(
                (p) =>
                    (!catalogState.search || p.name.toLowerCase().includes(catalogState.search)) &&
                    (!catalogState.category || p.category === catalogState.category)
            )
            // Sem estoque vai para o fim em vez de desaparecer: escondido, o
            // produto pareceria excluído do cadastro.
            .sort(
                (a, b) =>
                    (a.quantity <= 0) - (b.quantity <= 0) || a.name.localeCompare(b.name, 'pt-BR')
            );
    }

    function renderCatalogFilters() {
        Array.from(new Set(getCatalog().map((p) => p.category).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'pt-BR'))
            .forEach((categoria) => {
                const option = document.createElement('option');
                option.value = categoria;
                option.textContent = categoria;
                catalogCategoryEl.appendChild(option);
            });
    }

    function renderCatalog() {
        const items = getFilteredCatalog();
        catalogEmptyEl.hidden = items.length > 0;
        catalogGridEl.innerHTML = items
            .map((p) => {
                const outOfStock = p.quantity <= 0;
                const priceLabel = isWeightUnit(p.unit) ? `${money(p.price)}/kg` : money(p.price);
                return `<button type="button" class="hydro-catalog-card" data-product-id="${p.id}" ${outOfStock ? 'disabled' : ''}>
                    <span class="hydro-catalog-name">${escapeHtml(p.name)}</span>
                    <span class="hydro-catalog-meta">${escapeHtml(p.category || '—')}</span>
                    <span class="hydro-catalog-price">${priceLabel}</span>
                    <span class="hydro-catalog-stock${outOfStock ? ' hydro-catalog-stock-empty' : ''}">${outOfStock ? 'Esgotado' : formatStock(p.quantity, p.unit)}</span>
                </button>`;
            })
            .join('');
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

    /* Adiciona ao pedido o produto clicado na vitrine. O filtro não é
       limpo: a vitrine é superfície de navegação, e o operador normalmente
       pega vários itens da mesma categoria em sequência. */
    function selectProduct(productId) {
        const product = findProduct(productId);
        if (!product) return;

        if (isWeightUnit(product.unit)) {
            openWeightModal(product);
            return;
        }
        if (addProductToOrder(product.id)) renderAll();
    }

    catalogGridEl.addEventListener('click', (e) => {
        const card = e.target.closest('[data-product-id]');
        if (!card || card.disabled) return;
        selectProduct(card.dataset.productId);
    });

    searchInput.addEventListener('input', () => {
        catalogState.search = (searchInput.value || '').trim().toLowerCase();
        renderCatalog();
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            catalogState.search = '';
            renderCatalog();
            return;
        }
        if (e.key !== 'Enter') return;

        // Atalho de teclado: com a busca reduzida a um único produto, o Enter
        // já o põe na venda sem exigir o clique no card.
        e.preventDefault();
        const matches = getFilteredCatalog().filter((p) => p.quantity > 0);
        if (matches.length === 1) {
            selectProduct(matches[0].id);
        } else if (matches.length === 0) {
            showToast('Produto não encontrado', true);
        } else {
            showToast('Refine a busca ou clique no produto desejado');
        }
    });

    catalogCategoryEl.addEventListener('change', () => {
        catalogState.category = catalogCategoryEl.value;
        renderCatalog();
    });

    /* ================= Render: tabela de itens do pedido ================= */
    const orderTitleEl = document.getElementById('hydroOrderTitle');
    const orderClientEl = document.getElementById('hydroOrderClient');
    const orderItemsEl = document.getElementById('hydroOrderItems');
    const orderItemsWrapEl = orderItemsEl.closest('.hydro-items-table-wrap');
    const orderSubtotalEl = document.getElementById('hydroOrderSubtotal');
    const orderTotalEl = document.getElementById('hydroOrderTotal');
    const footerCountEl = document.getElementById('hydroFooterCount');
    const footerTotalEl = document.getElementById('hydroFooterTotal');
    const paymentButtons = document.querySelectorAll('.hydro-payment-btn');
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

        return { entries, subtotal, total: subtotal };
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
        orderTitleEl.textContent = rotuloPedido(order.id);
        // Quem está operando o caixa — é esse nome que fica gravado na venda.
        orderClientEl.textContent = `Operador: ${(usuarioAtual && usuarioAtual.nome) || 'Demonstração'}`;

        const { entries, subtotal, total } = computeTotals(order);
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
                    <td data-label="Descrição">
                        <p class="hydro-item-name">${escapeHtml(product.name)}</p>
                        <p class="hydro-item-desc">${escapeHtml(product.desc || product.category)}</p>
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
        orderTotalEl.textContent = money(total);
        footerCountEl.textContent = String(itemCount);
        footerTotalEl.textContent = money(total);

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

    /* ================= Ação: cancelar pedido ================= */
    document.getElementById('hydroClearOrderBtn').addEventListener('click', () => {
        if (!Object.keys(order.items).length) {
            showToast('Este pedido já está vazio', true);
            return;
        }
        if (confirm(`Cancelar ${rotuloPedido(order.id)}? Todos os itens serão removidos.`)) {
            order = createOrder();
            renderAll();
            showToast('Pedido cancelado');
        }
    });

    /* ================= Finalizar pedido ================= */
    document.getElementById('hydroFinishOrderBtn').addEventListener('click', async () => {
        const { entries, subtotal, total } = computeTotals(order);

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

        const finishBtn = document.getElementById('hydroFinishOrderBtn');

        if (usingRealApi) {
            finishBtn.disabled = true;
            try {
                const { venda } = await window.hydraApi('/vendas', {
                    method: 'POST',
                    body: {
                        itens: entries.map(([productId, qty]) => ({ id_produto: Number(productId), quantidade: qty })),
                        pagamentos: [{ forma_pagamento: PAYMENT_METHOD_TO_API[order.payment], valor: Math.round(total * 100) / 100 }],
                    },
                });
                // Baixa local do estoque exibido — o back-end já deu a baixa real (RN11).
                entries.forEach(([productId, qty]) => {
                    const product = findProduct(productId);
                    if (product) product.quantity -= qty;
                });
                const vendaGravada = mapApiVenda(venda);
                salesHistory.unshift(vendaGravada);
                // O número efetivo é o que o back-end gravou — pode não ser
                // o previsto, se outro caixa finalizou primeiro.
                order.id = vendaGravada.orderId;
                proximoNumero = vendaGravada.orderId + 1;
            } catch (err) {
                showToast(err.message, true);
                finishBtn.disabled = false;
                return;
            }
            finishBtn.disabled = false;
        } else {
            // HydroStore.addSale grava a venda e já dá baixa no estoque compartilhado
            const vendaDemo = HydroStore.addSale({
                orderId: order.id,
                usuario: 'Demonstração',
                items: saleItems,
                subtotal: Math.round(subtotal * 100) / 100,
                total: Math.round(total * 100) / 100,
                payment: order.payment,
                cashReceived: cashReceived === null ? null : Math.round(cashReceived * 100) / 100,
                change,
            });
            /* addSale grava no localStorage lendo uma lista nova, sem tocar
               nesta referência em memória — sem este unshift a venda só
               apareceria no histórico depois de recarregar a página. */
            salesHistory.unshift(vendaDemo);
            proximoNumero = order.id + 1;
        }

        const changeMsg = change !== null ? ` — troco: ${money(change)}` : '';
        // Aqui o número já é sempre conhecido: a resposta do POST o traz.
        showToast(`${rotuloPedido(order.id)} finalizado — pagamento em ${PAYMENT_LABELS[order.payment]}${changeMsg}`);
        order = createOrder();
        renderAll();
    });

    /* ================= Histórico de vendas ================= */
    const historySearchInput = document.getElementById('hydroHistorySearch');
    const historyBodyEl = document.getElementById('hydroHistoryBody');
    const historyWrapEl = document.getElementById('hydroHistoryTableWrap');
    const historyPresetsEl = document.getElementById('hydroHistoryPresets');
    const historyFromInput = document.getElementById('hydroHistoryFrom');
    const historyToInput = document.getElementById('hydroHistoryTo');

    /* Dia local de uma data, em YYYY-MM-DD, para comparar com o valor de um
       <input type="date"> (que também é dia local).

       Não dá para usar toISOString(): ele converte para UTC, e em UTC-3 uma
       venda feita depois das 21h cairia no dia seguinte — some do filtro
       "Hoje" na hora em que o mercadinho ainda está aberto. Mesmo cuidado
       que todayIso() toma em controle-estoque.js. */
    function diaLocal(valor) {
        const d = valor instanceof Date ? valor : new Date(valor);
        if (isNaN(d)) return '';
        const mes = String(d.getMonth() + 1).padStart(2, '0');
        const dia = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mes}-${dia}`;
    }

    function renderHistory() {
        const term = (historySearchInput.value || '').trim().toLowerCase();
        const de = historyFromInput.value;
        const ate = historyToInput.value;

        const sales = salesHistory
            .slice()
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .filter((sale) => {
                const dia = diaLocal(sale.date);
                // Comparação de strings YYYY-MM-DD: a ordem lexicográfica
                // coincide com a cronológica nesse formato.
                if (de && dia < de) return false;
                if (ate && dia > ate) return false;
                if (!term) return true;
                return String(sale.orderId).includes(term) || (sale.usuario || '').toLowerCase().includes(term);
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
                    <td data-label="Usuário">${escapeHtml(sale.usuario || 'Demonstração')}</td>
                    <td data-label="Itens">${itemCount} ${itemCount === 1 ? 'item' : 'itens'}</td>
                    <td data-label="Pagamento">${escapeHtml(PAYMENT_LABELS[sale.payment] || sale.payment || '—')}</td>
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

    /* Marca visualmente o atalho que corresponde ao período atual. "Tudo" é o
       atalho dos dois campos vazios; mexer num campo à mão normalmente não
       bate com atalho nenhum, e aí nenhum fica marcado. */
    function marcarPresetAtivo(preset) {
        historyPresetsEl.querySelectorAll('.hydro-history-preset').forEach((btn) => {
            btn.classList.toggle('hydro-active', preset !== null && btn.dataset.preset === preset);
        });
    }

    historyPresetsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.hydro-history-preset');
        if (!btn) return;
        const preset = btn.dataset.preset;

        if (preset === '') {
            historyFromInput.value = '';
            historyToInput.value = '';
        } else {
            const hoje = new Date();
            const inicio = new Date();
            // "7 dias" inclui hoje, então recua 6 — não 7. Com 7 o filtro
            // pegaria oito dias e não bateria com o rótulo.
            if (preset !== 'hoje') inicio.setDate(inicio.getDate() - (Number(preset) - 1));
            historyFromInput.value = diaLocal(inicio);
            historyToInput.value = diaLocal(hoje);
        }

        marcarPresetAtivo(preset);
        renderHistory();
    });

    [historyFromInput, historyToInput].forEach((input) => {
        input.addEventListener('change', () => {
            // Um período digitado à mão só continua sendo "Tudo" se os dois
            // campos ficaram vazios; nos demais casos nenhum atalho descreve
            // o período, então todos são desmarcados.
            const vazio = !historyFromInput.value && !historyToInput.value;
            marcarPresetAtivo(vazio ? '' : null);
            renderHistory();
        });
    });

    /* ================= Modal: detalhes da venda (Histórico) ================= */
    const saleDetailModalEl = document.getElementById('hydroSaleDetailModal');
    const saleDetailWhenEl = document.getElementById('hydroSaleDetailWhen');
    const saleDetailTitleEl = document.getElementById('hydroSaleDetailTitle');
    const saleDetailUserEl = document.getElementById('hydroSaleDetailUser');
    const saleDetailPaymentEl = document.getElementById('hydroSaleDetailPayment');
    const saleDetailCashRowEl = document.getElementById('hydroSaleDetailCashRow');
    const saleDetailReceivedEl = document.getElementById('hydroSaleDetailReceived');
    const saleDetailChangeEl = document.getElementById('hydroSaleDetailChange');
    const saleDetailItemsEl = document.getElementById('hydroSaleDetailItems');
    const saleDetailSubtotalEl = document.getElementById('hydroSaleDetailSubtotal');
    const saleDetailTotalEl = document.getElementById('hydroSaleDetailTotal');

    function openSaleDetailModal(sale) {
        saleDetailWhenEl.textContent = new Date(sale.date).toLocaleString('pt-BR');
        saleDetailTitleEl.textContent = `Pedido #${sale.orderId}`;
        saleDetailUserEl.textContent = sale.usuario || 'Demonstração';
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
                    <td data-label="Produto">${escapeHtml(it.name)}</td>
                    <td data-label="Qtd">${qtyLabel}</td>
                    <td data-label="Unitário">${unitLabel}</td>
                    <td data-label="Total" class="hydro-item-total">${money(it.qty * it.price)}</td>
                </tr>`;
            })
            .join('');

        const subtotal = sale.subtotal != null ? sale.subtotal : sale.total;
        saleDetailSubtotalEl.textContent = money(subtotal);
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
        const sale = salesHistory.find((s) => s.id === btn.dataset.viewSale);
        if (sale) openSaleDetailModal(sale);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSaleDetailModal();
    });

    /* ================= Render geral ================= */
    function renderAll() {
        renderOrderPanel();
        // A vitrine entra aqui para o saldo dos cards acompanhar a baixa de
        // estoque feita ao finalizar cada venda.
        renderCatalog();
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

    /* Catálogo e histórico de demonstração (localStorage), usados pelo
       visitante não autenticado. Sem back-end não há numeração de loja, então
       o próximo número sai do próprio histórico local. */
    function carregarDemonstracao() {
        catalog = HydroStore.getProducts();
        salesHistory = HydroStore.getSales();
        proximoNumero = salesHistory.reduce((maior, s) => Math.max(maior, Number(s.orderId) || 0), 0) + 1;
    }

    /* ================= Init ================= */
    (async function init() {
        if (!window.hydraApi) {
            carregarDemonstracao();
            finalizarCarga();
            return;
        }

        let usuario;
        try {
            ({ usuario } = await window.hydraApi('/auth/me'));
        } catch (err) {
            // Visitante não autenticado (demo pública): a tela continua
            // navegável com o catálogo local.
            carregarDemonstracao();
            finalizarCarga();
            return;
        }

        usuarioAtual = usuario;
        const nameEl = document.getElementById('hydroUserName');
        if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
        window.hydraAplicarMenuPorPermissao(usuario);
        // Quem não opera o caixa nem consulta o histórico não tem o que
        // fazer nesta tela. Sem esta guarda, ela abria, a API respondia 403
        // e o catch abaixo exibia o catálogo de DEMONSTRAÇÃO — dados
        // inventados apresentados como se fossem os da loja.
        if (!window.hydraGuardaDeTela(usuario, ['vendas.operar', 'vendas.historico'])) return;
        aplicarAbasPorPermissao(usuario);

        /* allSettled, e não all: o Caixa e o Histórico têm permissões
           distintas, então um cargo só de PDV leva 403 em /vendas e um cargo
           só de histórico não deveria perder o catálogo por causa disso.
           Cada parte da tela carrega o que lhe cabe. */
        const [produtosRes, vendasRes] = await Promise.allSettled([
            window.hydraApi('/produtos'),
            window.hydraApi('/vendas'),
        ]);

        if (produtosRes.status === 'fulfilled') {
            catalog = produtosRes.value.produtos.map(mapApiProduct);
        }
        if (vendasRes.status === 'fulfilled') {
            salesHistory = vendasRes.value.vendas.map(mapApiVenda);
            proximoNumero = Number(vendasRes.value.proximo_numero) || 1;
        } else {
            /* É de /api/vendas que vem o próximo número, e um cargo só de PDV
               (sem "Histórico de Vendas") leva 403 ali. Melhor o cabeçalho
               não mostrar número nenhum do que mostrar "#1" numa loja com 30
               vendas — o número certo aparece assim que a venda é gravada,
               porque o back-end o devolve na resposta. */
            proximoNumero = null;
        }
        usingRealApi = true;
        finalizarCarga();
    })();

    function finalizarCarga() {
        syncOrderNumber();
        renderCatalogFilters();
        renderAll();
        /* renderAll() só cuida do PDV. Quando a tela já abriu na aba de
           histórico — caso de um cargo que tem "vendas.historico" e não
           "vendas.operar" —, aquela aba foi montada antes de a API
           responder e ficaria vazia para sempre sem este render. */
        if (!historyViewEl.hidden) renderHistory();
    }
})();
