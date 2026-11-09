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
        credito: 'Cartão de crédito',
        debito: 'Cartão de débito',
        // Só aparece no histórico de demonstração antigo (localStorage),
        // gravado antes de crédito e débito serem separados.
        cartao: 'Cartão',
        pix: 'PIX',
        vale: 'Vale',
    };

    // Uma forma de pagamento por venda (sem split). Crédito e débito são
    // botões separados (RF13/RN10). Antes havia um único "Cartão", sempre
    // enviado como cartao_credito: nenhuma venda em débito era registrada.
    const PAYMENT_METHOD_TO_API = {
        dinheiro: 'dinheiro',
        credito: 'cartao_credito',
        debito: 'cartao_debito',
        pix: 'pix',
        vale: 'vale_refeicao',
    };
    const PAYMENT_METHOD_FROM_API = {
        dinheiro: 'dinheiro',
        cartao_credito: 'credito',
        cartao_debito: 'debito',
        pix: 'pix',
        vale_refeicao: 'vale',
    };

    /* ================= Catálogo de produtos e histórico de vendas =================
       Vêm da API real quando o usuário está autenticado (RF04); para o
       visitante da demo pública, continuam vindo do HydroStore local. */
    let usingRealApi = false;
    /* Estado da sessão nesta tela: 'carregando' até /auth/me e os dados
       responderem, depois 'autenticado' ou 'visitante'. Antes só existia
       usingRealApi, que é false tanto para o visitante quanto para quem
       está logado mas a tela ainda carrega — e quem clicava em "Cancelar
       Venda" logo após recarregar via "funciona apenas com login" (QA 012). */
    let sessaoEstado = 'carregando';
    let catalog = [];
    let registeredProducts = [];
    let standardHortifruti = [];
    let standardCatalogError = '';
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
        // Em promoção (tela Promoções), "price" já é o preço promocional:
        // é o que o back-end vai cobrar, então é com ele que o total e o
        // troco precisam ser calculados. "regularPrice" só serve para
        // mostrar o preço normal riscado.
        const promo = p.preco_promocional != null ? Number(p.preco_promocional) : null;
        return {
            id: String(p.id_produto),
            name: p.nome,
            desc: p.descricao || '',
            category: p.categoria,
            price: p.preco_venda == null ? null : (promo != null ? promo : Number(p.preco_venda)),
            regularPrice: promo != null && p.preco_venda != null ? Number(p.preco_venda) : null,
            quantity: Number(p.quantidade),
            unit: p.unidade,
            code: p.codigo == null ? null : String(p.codigo),
            barcode: p.codigo_barras == null ? null : String(p.codigo_barras),
            status: p.status || 'ativo',
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
            // Banco anterior ao cancelamento não manda "status": é concluída.
            cancelled: v.status === 'cancelada',
            cancelledAt: v.data_cancelamento || null,
            cancelReason: v.motivo_cancelamento || '',
            cancelAuthorizer: v.nome_autorizador_cancelamento || '',
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
        return String(unit || '').toLowerCase() === 'kg';
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
        return { id: proximoNumero, items: {}, payment: null, cashReceived: '', pixPayerEmail: '' };
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
    /* Valor monetário em pt-BR: "49", "49,2", "49,22", "1.234,56".
       Antes as letras eram descartadas em silêncio, e "49,22ddeede" virava
       49,22 e finalizava a venda (QA 013). Agora qualquer caractere fora do
       formato torna o valor inválido (NaN). */
    function parseMoney(str) {
        if (str === null || str === undefined) return NaN;
        const s = String(str).trim();
        // "49.22": ponto como decimal (teclado numérico), sem vírgula.
        if (/^\d+\.\d{1,2}$/.test(s)) return parseFloat(s);
        if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(s)) return NaN;
        return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    }

    /* Filtro do campo "Valor recebido": só dígitos, pontos de milhar e uma
       vírgula decimal com até duas casas. Letras e símbolos nem entram. */
    function sanitizarDinheiro(valor) {
        let s = String(valor || '').replace(/[^\d.,]/g, '');
        const virgula = s.indexOf(',');
        if (virgula >= 0) {
            s = s.slice(0, virgula + 1) + s.slice(virgula + 1).replace(/[.,]/g, '').slice(0, 2);
        }
        return s;
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
    const cancelViewEl = document.getElementById('hydroCancelView');

    function mostrarAba(view) {
        // Sair da aba de cancelamento tranca de novo: voltar a ela pede a
        // senha do gerente outra vez.
        if (view !== 'cancelar' && !cancelViewEl.hidden) encerrarAutorizacao();
        viewTabsEl.querySelectorAll('.hydro-order-tab').forEach((b) => {
            b.classList.toggle('hydro-active', b.dataset.view === view);
        });
        saleViewEl.hidden = view !== 'venda';
        historyViewEl.hidden = view !== 'historico';
        cancelViewEl.hidden = view !== 'cancelar';
        if (view === 'historico') renderHistory();
        if (view === 'cancelar') renderCancelList();
    }

    viewTabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.hydro-order-tab');
        if (!btn) return;
        // A aba de cancelamento só abre com a senha de autorização.
        if (btn.dataset.view === 'cancelar') {
            if (cancelViewEl.hidden) openAuthModal();
            return;
        }
        mostrarAba(btn.dataset.view);
    });

    /* As duas abas desta tela têm permissões diferentes: "vendas.operar"
       abre o PDV e "vendas.historico" abre a consulta. Um cargo pode ter só
       uma delas — por exemplo, um conferente que acompanha as vendas do dia
       sem poder registrar nenhuma. A aba que o cargo não tem some, e se a
       que sobrou não for a inicial, a tela já abre nela. */
    function aplicarAbasPorPermissao(usuario) {
        /* "Cancelar Venda" lista as vendas, que vêm de GET /api/vendas
           ("vendas.historico"). Quem pode cancelar de fato é decidido pela
           senha de autorização do gerente, não pelo cargo do operador. */
        const abas = [
            ['venda', 'vendas.operar'],
            ['historico', 'vendas.historico'],
            ['cancelar', 'vendas.historico'],
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
                    (!catalogState.search || p.name.toLowerCase().includes(catalogState.search)
                        || String(p.code || '').includes(catalogState.search)
                        || String(p.barcode || '').includes(catalogState.search)) &&
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
                const perKg = isWeightUnit(p.unit) ? '/kg' : '';
                const priceLabel = p.price == null
                    ? 'Defina o preço deste item'
                    : `${money(p.price)}${perKg}`;
                const promoLabel = p.regularPrice != null
                    ? `<span class="hydro-catalog-promo"><s>${money(p.regularPrice)}${perKg}</s> Promoção</span>`
                    : '';
                return `<button type="button" class="hydro-catalog-card${p.regularPrice != null ? ' hydro-catalog-card-promo' : ''}" data-product-id="${p.id}" ${outOfStock ? 'disabled' : ''}>
                    <span class="hydro-catalog-name">${escapeHtml(p.name)}</span>
                    <span class="hydro-catalog-meta">${escapeHtml(p.category || '—')}</span>
                    ${promoLabel}
                    <span class="hydro-catalog-price${p.price == null ? ' hydro-catalog-price-missing' : ''}">${priceLabel}</span>
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
        if (product.price == null) {
            showToast('Defina o preço deste item no cadastro de produtos antes de vendê-lo.', true);
            return;
        }

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

    function lookupProductByBarcode(codigoBarras) {
        window.hydraApi(`/produtos/codigo-barras/${encodeURIComponent(codigoBarras)}`)
            .then(({ produto }) => {
                const encontrado = mapApiProduct(produto);
                const existingIndex = registeredProducts.findIndex((item) => item.id === encontrado.id);
                if (existingIndex >= 0) registeredProducts[existingIndex] = encontrado;
                else registeredProducts.push(encontrado);

                if (encontrado.status !== 'ativo') {
                    showToast('Este produto está inativo nesta filial.', true);
                    return;
                }

                const catalogIndex = catalog.findIndex((item) => item.id === encontrado.id);
                if (catalogIndex >= 0) catalog[catalogIndex] = encontrado;
                else catalog.push(encontrado);
                renderCatalog();
                selectProduct(encontrado.id);
            })
            .catch((error) => {
                showToast(error.status === 404
                    ? 'Código de barras não encontrado nesta filial.'
                    : error.message, true);
            });
    }

    function processProductSearch(termoEntrada) {
        const termo = String(termoEntrada || '').trim();
        if (!termo) return false;

        const produtoPorBarras = registeredProducts.find((item) => item.barcode === termo);
        if (produtoPorBarras) {
            if (produtoPorBarras.status !== 'ativo') {
                showToast('Este produto está inativo nesta filial.', true);
                return true;
            }
            selectProduct(produtoPorBarras.id);
            return true;
        }

        const etiqueta = /^\d{13}$/.test(termo) && termo.startsWith('2') ? termo : null;
        if (etiqueta) {
            const digitos = Array.from(etiqueta.slice(0, 12), Number);
            const soma = digitos.reduce((total, digito, indice) => total + digito * (indice % 2 === 0 ? 1 : 3), 0);
            const verificador = (10 - (soma % 10)) % 10;
            if (verificador !== Number(etiqueta[12])) {
                showToast('Etiqueta EAN-13 inválida. Confira o código de barras.', true);
                return true;
            }

            const codigo = String(Number(etiqueta.slice(2, 7)));
            const produto = catalog.find((item) => item.code === codigo);
            if (!produto) {
                const produtoCadastrado = registeredProducts.find((item) => item.code === codigo);
                const itemPadrao = standardHortifruti.find((item) => String(item.codigo) === codigo);
                showToast(
                    produtoCadastrado
                        ? `O produto ${codigo} está inativo nesta filial.`
                        : itemPadrao
                            ? `O código ${codigo} ainda não foi importado para esta filial.`
                            : 'Código de produto não encontrado.',
                    true
                );
                return true;
            }
            if (produto.price == null) {
                showToast('Defina o preço deste item no cadastro de produtos antes de vendê-lo.', true);
                return true;
            }
            if (!isWeightUnit(produto.unit)) {
                showToast('A etiqueta de balança só pode ser usada com produtos cadastrados em KG.', true);
                return true;
            }
            const pesoKg = Number(etiqueta.slice(7, 12)) / 1000;
            const pesoAtual = getActiveOrder().items[produto.id] || 0;
            if (!(pesoKg > 0) || pesoAtual + pesoKg > produto.quantity + 1e-6) {
                showToast('Peso inválido ou quantidade em estoque insuficiente.', true);
                return true;
            }
            getActiveOrder().items[produto.id] = Math.round((pesoAtual + pesoKg) * 1000) / 1000;
            renderAll();
            return true;
        }

        if (/^\d{1,5}$/.test(termo)) {
            const codigo = String(Number(termo));
            const produto = catalog.find((item) => item.code === codigo);
            if (produto) {
                selectProduct(produto.id);
                return true;
            }
            if (registeredProducts.some((item) => item.code === codigo)) {
                showToast(`O produto ${codigo} está inativo nesta filial.`, true);
                return true;
            }
            if (standardHortifruti.some((item) => String(item.codigo) === codigo)) {
                showToast(`O código ${codigo} ainda não foi importado para esta filial.`, true);
                return true;
            }
            showToast('Código de produto não encontrado.', true);
            return true;
        }

        if (/^\d{8,14}$/.test(termo)) {
            if (usingRealApi) {
                lookupProductByBarcode(termo);
            } else {
                showToast('Código de barras não encontrado nesta filial.', true);
            }
            return true;
        }

        const matches = getFilteredCatalog().filter((p) => p.quantity > 0);
        if (matches.length === 1) {
            selectProduct(matches[0].id);
        } else if (matches.length === 0) {
            showToast('Produto não encontrado', true);
        } else {
            showToast('Refine a busca ou clique no produto desejado');
        }
        return true;
    }

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            catalogState.search = '';
            renderCatalog();
            return;
        }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        processProductSearch(searchInput.value);
    });

    const saleCameraModal = document.getElementById('hydroSaleCameraModal');
    const saleCameraVideo = document.getElementById('hydroSaleCameraVideo');
    const saleCameraStatus = document.getElementById('hydroSaleCameraStatus');
    let activeSaleScanner = null;
    let saleCameraRequest = 0;

    function closeSaleCamera() {
        saleCameraRequest++;
        if (activeSaleScanner) activeSaleScanner.stop();
        activeSaleScanner = null;
        saleCameraModal.hidden = true;
    }

    document.getElementById('hydroScanSaleBarcode').addEventListener('click', async () => {
        const request = ++saleCameraRequest;
        saleCameraModal.hidden = false;
        saleCameraStatus.textContent = 'Solicitando acesso à câmera…';
        try {
            const scanner = await window.HydraBarcodeScanner.start(
                saleCameraVideo,
                (value) => {
                    const codigoBarras = String(value || '').trim();
                    if (!/^\d{8,14}$/.test(codigoBarras)) {
                        saleCameraStatus.textContent = 'Código lido fora do limite de 8 a 14 dígitos. Tente novamente.';
                        return;
                    }
                    closeSaleCamera();
                    searchInput.value = codigoBarras;
                    catalogState.search = codigoBarras.toLowerCase();
                    renderCatalog();
                    if (/^\d{13}$/.test(codigoBarras) && codigoBarras.startsWith('2')) {
                        processProductSearch(codigoBarras);
                    } else if (usingRealApi) {
                        lookupProductByBarcode(codigoBarras);
                    } else {
                        processProductSearch(codigoBarras);
                    }
                    searchInput.focus();
                },
                (error) => {
                    saleCameraStatus.textContent = error.message || 'Não foi possível ler o código.';
                }
            );
            if (request !== saleCameraRequest || saleCameraModal.hidden) {
                scanner.stop();
                return;
            }
            activeSaleScanner = scanner;
            saleCameraStatus.textContent = 'Aponte a câmera para o código de barras do produto.';
        } catch (error) {
            if (request === saleCameraRequest && !saleCameraModal.hidden) {
                saleCameraStatus.textContent = error.message || 'Não foi possível iniciar a câmera.';
            }
        }
    });

    saleCameraModal.addEventListener('click', (event) => {
        if (event.target.closest('[data-sale-camera-close]')) closeSaleCamera();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !saleCameraModal.hidden) closeSaleCamera();
    });

    catalogCategoryEl.addEventListener('change', () => {
        catalogState.category = catalogCategoryEl.value;
        renderCatalog();
    });

    /* ================= Catálogo de códigos de frutas, vegetais e pesáveis ================= */
    const weightedCatalogModal = document.getElementById('hydroWeightedCatalogModal');
    const weightedCatalogOpenBtn = document.getElementById('hydroOpenWeightedCatalog');
    const weightedCatalogSearchEl = document.getElementById('hydroWeightedCatalogSearch');
    const weightedCatalogListEl = document.getElementById('hydroWeightedCatalogList');
    const weightedCatalogEmptyEl = document.getElementById('hydroWeightedCatalogEmpty');
    const weightedCatalogErrorEl = document.getElementById('hydroWeightedCatalogError');
    const weightedCatalogCountEl = document.getElementById('hydroWeightedCatalogCount');
    const printHortifrutiBtn = document.getElementById('hydroPrintHortifrutiCatalog');
    let weightedCatalogSearch = '';

    function normalizeCatalogText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLocaleLowerCase('pt-BR')
            .trim();
    }

    function isWeightedCatalogProduct(product) {
        const category = normalizeCatalogText(product.category);
        return [
            'fruta', 'frutas', 'legume', 'legumes', 'verdura', 'verduras',
            'vegetal', 'vegetais', 'hortifruti', 'hortifrutis', 'pesavel', 'pesaveis',
        ].includes(category)
            || isWeightUnit(product.unit);
    }

    function getWeightedCatalogProducts() {
        const standardCodes = new Set(standardHortifruti.map((item) => String(item.codigo)));
        const products = standardHortifruti.map((item) => {
            const code = String(item.codigo);
            return {
                code,
                name: item.nome,
                category: item.categoria,
                unit: item.unidade,
                product: registeredProducts.find((product) => product.code === code) || null,
            };
        });
        registeredProducts
            .filter((product) => isWeightedCatalogProduct(product)
                && (!product.code || !standardCodes.has(product.code)))
            .forEach((product) => products.push({
                code: product.code || '—',
                name: product.name,
                category: product.category,
                unit: product.unit,
                product,
            }));

        return products.filter((item) => !weightedCatalogSearch || [
            item.name,
            item.category,
            item.code,
        ].some((value) => normalizeCatalogText(value).includes(weightedCatalogSearch)));
    }

    function renderWeightedCatalog() {
        const products = getWeightedCatalogProducts();
        weightedCatalogCountEl.textContent = `${products.length} ${products.length === 1 ? 'produto encontrado' : 'produtos encontrados'}`;
        weightedCatalogErrorEl.hidden = !standardCatalogError;
        weightedCatalogErrorEl.textContent = standardCatalogError
            ? `Não foi possível carregar os códigos padrão: ${standardCatalogError}`
            : '';
        weightedCatalogEmptyEl.hidden = products.length > 0 || Boolean(standardCatalogError);
        weightedCatalogListEl.innerHTML = products.map((item) => {
            const product = item.product;
            const active = product !== null && product.status !== 'inativo';
            const code = item.code === '—' ? '—' : `#${escapeHtml(item.code)}`;
            const stockLabel = !product
                ? 'Não importado nesta filial'
                : !active
                    ? 'Inativo'
                    : product.price == null
                        ? 'Defina o preço deste item'
                        : formatStock(product.quantity, product.unit);
            const priceLabel = product && product.price != null
                ? `${money(product.price)}${isWeightUnit(item.unit) ? '/kg' : ''}`
                : (product ? 'Preço pendente' : `${escapeHtml(item.unit)} · código padrão`);
            return `<button type="button" class="hydro-weighted-catalog-item" ${product ? `data-product-id="${escapeHtml(product.id)}"` : ''} ${active ? '' : 'disabled'}>
                <span class="hydro-weighted-catalog-code">${code}</span>
                <span class="hydro-weighted-catalog-info">
                    <strong>${escapeHtml(item.name)}</strong>
                    <span>${escapeHtml(item.category || 'Sem categoria')} · ${escapeHtml(priceLabel)}</span>
                </span>
                <span class="hydro-weighted-catalog-stock">${escapeHtml(stockLabel)}</span>
            </button>`;
        }).join('');
    }

    function openWeightedCatalog() {
        weightedCatalogSearch = '';
        weightedCatalogSearchEl.value = '';
        renderWeightedCatalog();
        weightedCatalogModal.hidden = false;
        document.body.classList.add('hydro-weighted-catalog-open');
        weightedCatalogSearchEl.focus();
    }

    function closeWeightedCatalog() {
        weightedCatalogModal.hidden = true;
        document.body.classList.remove('hydro-weighted-catalog-open');
        weightedCatalogOpenBtn.focus();
    }

    weightedCatalogOpenBtn.addEventListener('click', openWeightedCatalog);
    weightedCatalogModal.addEventListener('click', (event) => {
        if (event.target.closest('[data-weighted-catalog-close]')) {
            closeWeightedCatalog();
            return;
        }
        const item = event.target.closest('[data-product-id]');
        if (!item || item.disabled) return;
        closeWeightedCatalog();
        selectProduct(item.dataset.productId);
    });
    weightedCatalogSearchEl.addEventListener('input', () => {
        weightedCatalogSearch = normalizeCatalogText(weightedCatalogSearchEl.value);
        renderWeightedCatalog();
    });
    printHortifrutiBtn.addEventListener('click', () => {
        if (standardHortifruti.length === 0) {
            showToast('Os códigos padrão não foram carregados. Tente novamente quando o servidor estiver disponível.', true);
            return;
        }
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            showToast('Permita a abertura de janelas para imprimir a lista A4.', true);
            return;
        }
        const categorias = ['FRUTAS', 'LEGUMES', 'VERDURAS', 'TEMPEROS', 'RAIZES'];
        const secoes = categorias.map((categoria) => {
            const itens = standardHortifruti.filter((item) => item.categoria === categoria);
            if (itens.length === 0) return '';
            return `<section><h2>${escapeHtml(categoria)}</h2><div class="itens">${itens.map((item) =>
                `<div class="item"><strong>${escapeHtml(item.codigo)}</strong><span>${escapeHtml(item.nome)}</span></div>`
            ).join('')}</div></section>`;
        }).join('');
        printWindow.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Códigos hortifrúti padrão</title>
            <style>
                @page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0}
                h1{font-size:22px;margin:0 0 6px}header{margin-bottom:18px}header p{font-size:11px;margin:0;color:#444}
                section{break-inside:avoid;margin:0 0 16px}h2{font-size:14px;border-bottom:2px solid #222;padding-bottom:4px;margin:0 0 7px}
                .itens{display:grid;grid-template-columns:1fr 1fr;gap:4px 18px}.item{display:flex;align-items:center;gap:10px;min-height:25px;border-bottom:1px solid #ddd}
                .item strong{font-size:17px;min-width:40px;font-variant-numeric:tabular-nums}.item span{font-size:10px;font-weight:600}
            </style></head><body><header><h1>Códigos hortifrúti padrão</h1><p>Códigos internos para consulta no caixa. Etiquetas EAN-13 de balança devem ser configuradas conforme a convenção descrita na documentação da loja.</p></header>${secoes}</body></html>`);
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => printWindow.print(), 250);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !weightedCatalogModal.hidden) closeWeightedCatalog();
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
    const pixPayerBoxEl = document.getElementById('hydroPixPayerBox');
    const pixPayerEmailEl = document.getElementById('hydroPixPayerEmail');
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
        // Vazio não é erro (ainda não digitou); texto fora do formato é.
        const malformado = !hasValue && String(order.cashReceived || '').trim() !== '';
        const insufficient = (hasValue && change < 0) || malformado;

        cashChangeEl.textContent = money(hasValue ? Math.max(change, 0) : 0);
        cashChangeRowEl.classList.toggle('hydro-cash-change-warning', insufficient);
        cashInputWrapEl.classList.toggle('hydro-cash-invalid', insufficient);
    }

    cashInputEl.addEventListener('input', () => {
        const limpo = sanitizarDinheiro(cashInputEl.value);
        if (limpo !== cashInputEl.value) cashInputEl.value = limpo;
        const order = getActiveOrder();
        order.cashReceived = cashInputEl.value;
        const { total } = computeTotals(order);
        updateCashUI(order, total, { skipInputValue: true });
    });

    pixPayerEmailEl.addEventListener('input', () => {
        getActiveOrder().pixPayerEmail = pixPayerEmailEl.value.trim();
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
                    <td data-label="Unitário" class="hydro-item-unit">${weighty ? `${money(product.price)}/kg` : money(product.price)}${product.regularPrice != null ? '<span class="hydro-item-promo">Promoção</span>' : ''}</td>
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
        pixPayerBoxEl.hidden = order.payment !== 'pix';
        pixPayerEmailEl.value = order.pixPayerEmail || '';

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

    const pixModal = document.getElementById('hydroPixModal');
    const pixAmount = document.getElementById('hydroPixAmount');
    const pixQrImage = document.getElementById('hydroPixQrImage');
    const pixStatus = document.getElementById('hydroPixStatus');
    const pixCopyCode = document.getElementById('hydroPixCopyCode');
    const pixReopenButton = document.getElementById('hydroPixReopenButton');
    const PENDING_PIX_KEY = 'hydra-pix-pagamento-pendente';

    function salvarPixPendente(id) {
        try {
            window.localStorage.setItem(PENDING_PIX_KEY, id);
        } catch (error) {
            console.warn('A cobrança Pix não pôde ser salva para retomada após recarregar a página.', error);
            showToast('Mantenha esta tela aberta até a confirmação do Pix.', true);
        }
    }

    function limparPixPendente() {
        try {
            window.localStorage.removeItem(PENDING_PIX_KEY);
        } catch (error) {
            console.warn('Não foi possível limpar o identificador local da cobrança Pix.', error);
        }
    }

    function mostrarQrPix(pagamento) {
        pixAmount.textContent = money(Number(pagamento.valor));
        pixQrImage.src = `data:image/png;base64,${pagamento.qr_code_base64}`;
        pixCopyCode.value = pagamento.qr_code || '';
        pixStatus.textContent = 'Aguardando o pagamento do cliente…';
        pixModal.hidden = false;
        pixReopenButton.hidden = true;
    }

    function aguardar(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function monitorarPagamentoPix(id, qrInicial) {
        pixModal.hidden = false;
        pixReopenButton.hidden = true;
        if (qrInicial) mostrarQrPix(qrInicial);
        else pixStatus.textContent = 'Retomando a cobrança Pix pendente…';

        while (true) {
            try {
                const resposta = await window.hydraApi(`/pix/pagamentos/${encodeURIComponent(id)}`);
                if (resposta.status === 'approved' && resposta.venda) {
                    limparPixPendente();
                    pixStatus.textContent = 'Pagamento confirmado. Finalizando a venda…';
                    pixModal.hidden = true;
                    pixReopenButton.hidden = true;
                    return resposta.venda;
                }
                if (resposta.status === 'pending') {
                    if (resposta.qr_code && resposta.qr_code_base64) {
                        mostrarQrPix(resposta);
                    } else if (!pixModal.hidden) {
                        pixStatus.textContent = 'Aguardando a confirmação da cobrança no Mercado Pago…';
                    }
                    await aguardar(2500);
                    continue;
                }
                if (['rejeitado', 'cancelado', 'expired', 'expirado'].includes(resposta.status)) {
                    limparPixPendente();
                    pixModal.hidden = true;
                    pixReopenButton.hidden = true;
                    const terminalError = new Error(resposta.status === 'expired' || resposta.status === 'expirado'
                        ? 'A cobrança Pix expirou. Gere um novo QR Code.'
                        : 'O pagamento Pix não foi aprovado. Confira com o cliente e tente novamente.');
                    terminalError.status = 422;
                    throw terminalError;
                }
                await aguardar(2500);
            } catch (error) {
                if (error.data && error.data.codigo === 'pix_aprovado_venda_pendente') {
                    pixStatus.textContent = error.message;
                    await aguardar(5000);
                    continue;
                }
                if (error.status === 404) {
                    limparPixPendente();
                    pixModal.hidden = true;
                    pixReopenButton.hidden = true;
                }
                if (error.status === 502 || error.status === undefined) {
                    pixStatus.textContent = 'Sem resposta temporária do Mercado Pago. Tentando consultar novamente…';
                    await aguardar(5000);
                    continue;
                }
                throw error;
            }
        }
    }

    function registrarVendaApiNaTela(venda, entries, baixarEstoque) {
        if (baixarEstoque) {
            entries.forEach(([productId, qty]) => {
                const product = findProduct(productId);
                if (product) product.quantity -= qty;
            });
        }
        const vendaGravada = mapApiVenda(venda);
        if (!salesHistory.some((item) => item.id === vendaGravada.id)) salesHistory.unshift(vendaGravada);
        order.id = vendaGravada.orderId;
        proximoNumero = vendaGravada.orderId + 1;
    }

    document.getElementById('hydroPixCopyButton').addEventListener('click', async () => {
        if (!pixCopyCode.value) return;
        try {
            await navigator.clipboard.writeText(pixCopyCode.value);
            showToast('Código Pix copiado.');
        } catch (error) {
            pixCopyCode.focus();
            pixCopyCode.select();
            showToast('Não foi possível copiar automaticamente. Selecione e copie o código Pix.');
        }
    });

    document.getElementById('hydroPixHideButton').addEventListener('click', () => {
        pixModal.hidden = true;
        pixReopenButton.hidden = false;
        showToast('A cobrança continua sendo consultada; a venda será finalizada após a confirmação.');
    });

    pixReopenButton.addEventListener('click', () => {
        pixModal.hidden = false;
        pixReopenButton.hidden = true;
    });

    async function retomarPixPendente() {
        let id = null;
        let cobranca = null;
        try {
            id = window.localStorage.getItem(PENDING_PIX_KEY);
        } catch (error) {
            console.warn('Não foi possível verificar uma cobrança Pix pendente neste navegador.', error);
        }
        if (!id) {
            try {
                ({ pagamento: cobranca } = await window.hydraApi('/pix/pagamentos/pendente'));
                id = cobranca ? cobranca.id : null;
                if (id) salvarPixPendente(id);
            } catch (error) {
                showToast(error.message || 'Não foi possível verificar cobranças Pix pendentes.', true);
                return;
            }
        }
        if (!id) return;

        const finishBtn = document.getElementById('hydroFinishOrderBtn');
        finishBtn.disabled = true;
        try {
            const venda = await monitorarPagamentoPix(id, cobranca);
            registrarVendaApiNaTela(venda, [], false);
            renderAll();
            if (!historyViewEl.hidden) renderHistory();
            showToast(`${rotuloPedido(order.id)} confirmado automaticamente pelo Pix.`);
        } catch (error) {
            showToast(error.message || 'Não foi possível retomar a cobrança Pix.', true);
        } finally {
            finishBtn.disabled = false;
        }
    }

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
        if (order.payment === 'pix' && (!pixPayerEmailEl.value.trim() || !pixPayerEmailEl.validity.valid)) {
            showToast('Informe um e-mail válido do cliente para gerar o Pix.', true);
            pixPayerEmailEl.focus();
            return;
        }

        let cashReceived = null;
        let change = null;
        if (order.payment === 'dinheiro') {
            cashReceived = parseMoney(order.cashReceived);
            if (isNaN(cashReceived)) {
                showToast('Valor recebido inválido. Use só números, ex.: 50,00', true);
                cashInputEl.focus();
                return;
            }
            if (cashReceived < total) {
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
                let venda;
                if (order.payment === 'pix') {
                    const cobranca = await window.hydraApi('/pix/pagamentos', {
                        method: 'POST',
                        body: {
                            payer_email: order.pixPayerEmail,
                            itens: entries.map(([productId, qty]) => ({
                                id_produto: Number(productId),
                                quantidade: qty,
                            })),
                        },
                    });
                    salvarPixPendente(cobranca.id);
                    venda = await monitorarPagamentoPix(cobranca.id, cobranca);
                } else {
                    ({ venda } = await window.hydraApi('/vendas', {
                        method: 'POST',
                        body: {
                            itens: entries.map(([productId, qty]) => ({ id_produto: Number(productId), quantidade: qty })),
                            pagamentos: [{ forma_pagamento: PAYMENT_METHOD_TO_API[order.payment], valor: Math.round(total * 100) / 100 }],
                        },
                    }));
                }
                registrarVendaApiNaTela(venda, entries, true);
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
                const cancelada = sale.cancelled
                    ? ' <span class="hydro-tag-cancelled">Cancelada</span>'
                    : '';
                return `
                <tr${sale.cancelled ? ' class="hydro-sale-cancelled"' : ''}>
                    <td data-label="Data/Hora">${when}</td>
                    <td data-label="Pedido">#${sale.orderId}${cancelada}</td>
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
    const saleDetailCancelledEl = document.getElementById('hydroSaleDetailCancelled');

    function openSaleDetailModal(sale) {
        saleDetailWhenEl.textContent = new Date(sale.date).toLocaleString('pt-BR');
        saleDetailTitleEl.textContent = `Pedido #${sale.orderId}`;
        saleDetailUserEl.textContent = sale.usuario || 'Demonstração';
        saleDetailPaymentEl.textContent = PAYMENT_LABELS[sale.payment] || sale.payment || '—';

        saleDetailCancelledEl.hidden = !sale.cancelled;
        if (sale.cancelled) {
            const quando = sale.cancelledAt ? ` em ${new Date(sale.cancelledAt).toLocaleString('pt-BR')}` : '';
            const quem = sale.cancelAuthorizer ? `, autorizada por <strong>${escapeHtml(sale.cancelAuthorizer)}</strong>` : '';
            const motivo = sale.cancelReason ? `<br>Motivo: ${escapeHtml(sale.cancelReason)}` : '';
            saleDetailCancelledEl.innerHTML = `Venda cancelada${quando}${quem}. Os itens voltaram ao estoque.${motivo}`;
        }

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
        if (e.key !== 'Escape') return;
        closeSaleDetailModal();
        closeAuthModal();
        closeCancelConfirm();
    });

    /* ================= Cancelar Venda (senha de autorização) =================
       A aba só abre depois que o gerente ou administrador digita a senha de
       autorização dele (PIN cadastrado na tela Equipe). O back-end guarda a
       autorização na sessão por 5 minutos; aqui ela também tranca ao sair da
       aba, ao clicar em "Bloquear" ou quando o tempo acaba. */
    const authModalEl = document.getElementById('hydroAuthModal');
    const authFormEl = document.getElementById('hydroAuthForm');
    const authPinEl = document.getElementById('hydroAuthPin');
    const authErrorEl = document.getElementById('hydroAuthError');
    const authConfirmBtn = document.getElementById('hydroAuthConfirmBtn');
    const cancelAuthNameEl = document.getElementById('hydroCancelAuthName');
    const cancelAuthTimerEl = document.getElementById('hydroCancelAuthTimer');
    const cancelSearchInput = document.getElementById('hydroCancelSearch');
    const cancelBodyEl = document.getElementById('hydroCancelBody');
    const cancelWrapEl = document.getElementById('hydroCancelTableWrap');
    const cancelConfirmModalEl = document.getElementById('hydroCancelConfirmModal');
    const cancelConfirmTitleEl = document.getElementById('hydroCancelConfirmTitle');
    const cancelConfirmDescEl = document.getElementById('hydroCancelConfirmDesc');
    const cancelMotivoEl = document.getElementById('hydroCancelMotivo');
    const cancelConfirmBtn = document.getElementById('hydroCancelConfirmBtn');

    let authExpiraEm = 0;
    let authTimer = null;
    let saleToCancel = null;

    function openAuthModal() {
        if (sessaoEstado === 'carregando') {
            showToast('Aguarde: carregando seus dados de acesso...');
            return;
        }
        if (sessaoEstado === 'visitante') {
            showToast('O cancelamento de venda funciona apenas com login no sistema.', true);
            return;
        }
        authPinEl.value = '';
        authErrorEl.hidden = true;
        authModalEl.hidden = false;
        setTimeout(() => authPinEl.focus(), 0);
    }

    function closeAuthModal() {
        authModalEl.hidden = true;
        authPinEl.value = '';
    }

    authModalEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-auth-close]')) closeAuthModal();
    });

    // Só números, como o PIN cadastrado na tela Equipe.
    authPinEl.addEventListener('input', () => {
        authPinEl.value = authPinEl.value.replace(/\D/g, '').slice(0, 8);
        authErrorEl.hidden = true;
    });

    authFormEl.addEventListener('submit', async (e) => {
        e.preventDefault();
        const senha = authPinEl.value;
        if (senha.length < 4) {
            authErrorEl.textContent = 'Digite a senha de autorização (4 a 8 números).';
            authErrorEl.hidden = false;
            return;
        }
        authConfirmBtn.disabled = true;
        try {
            const res = await window.hydraApi('/vendas/autorizar-cancelamento', {
                method: 'POST',
                body: { senha },
            });
            closeAuthModal();
            iniciarAutorizacao(res.autorizador, Number(res.expira_em_segundos) || 300);
            mostrarAba('cancelar');
        } catch (err) {
            authErrorEl.textContent = err.message;
            authErrorEl.hidden = false;
            authPinEl.value = '';
            authPinEl.focus();
        } finally {
            authConfirmBtn.disabled = false;
        }
    });

    function iniciarAutorizacao(nome, segundos) {
        cancelAuthNameEl.textContent = nome || '—';
        authExpiraEm = Date.now() + segundos * 1000;
        clearInterval(authTimer);
        atualizarTimer();
        authTimer = setInterval(atualizarTimer, 1000);
    }

    function atualizarTimer() {
        const restante = Math.max(0, Math.round((authExpiraEm - Date.now()) / 1000));
        const mm = String(Math.floor(restante / 60));
        const ss = String(restante % 60).padStart(2, '0');
        cancelAuthTimerEl.textContent = `· expira em ${mm}:${ss}`;
        if (restante === 0 && !cancelViewEl.hidden) {
            showToast('A autorização expirou. Peça a senha do gerente de novo.', true);
            mostrarAba(primeiraAbaVisivel());
        }
    }

    /* Tranca a aba: para o relógio e avisa o back-end (sem esperar). */
    function encerrarAutorizacao() {
        clearInterval(authTimer);
        authTimer = null;
        authExpiraEm = 0;
        closeCancelConfirm();
        if (usingRealApi) {
            window.hydraApi('/vendas/autorizar-cancelamento/encerrar', { method: 'POST' }).catch(() => {});
        }
    }

    function primeiraAbaVisivel() {
        const btn = Array.from(viewTabsEl.querySelectorAll('.hydro-order-tab'))
            .find((b) => !b.hidden && b.dataset.view !== 'cancelar');
        return btn ? btn.dataset.view : 'historico';
    }

    document.getElementById('hydroCancelLockBtn').addEventListener('click', () => {
        mostrarAba(primeiraAbaVisivel());
        showToast('Cancelamento bloqueado.');
    });

    function renderCancelList() {
        const term = (cancelSearchInput.value || '').trim().toLowerCase();
        const sales = salesHistory
            .filter((sale) => !sale.cancelled)
            .slice()
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .filter((sale) => !term
                || String(sale.orderId).includes(term)
                || (sale.usuario || '').toLowerCase().includes(term));

        cancelWrapEl.classList.toggle('hydro-empty', sales.length === 0);
        cancelBodyEl.innerHTML = sales
            .map((sale) => {
                const itemCount = (sale.items || []).reduce((sum, it) => sum + it.qty, 0);
                return `
                <tr>
                    <td data-label="Data/Hora">${new Date(sale.date).toLocaleString('pt-BR')}</td>
                    <td data-label="Pedido">#${sale.orderId}</td>
                    <td data-label="Usuário">${escapeHtml(sale.usuario || '—')}</td>
                    <td data-label="Itens">${itemCount} ${itemCount === 1 ? 'item' : 'itens'}</td>
                    <td data-label="Pagamento">${escapeHtml(PAYMENT_LABELS[sale.payment] || sale.payment || '—')}</td>
                    <td data-label="Total" class="hydro-item-total">${money(sale.total)}</td>
                    <td data-label="Ação">
                        <button type="button" class="hydro-cancel-row-btn" data-cancel-sale="${sale.id}">Cancelar</button>
                    </td>
                </tr>`;
            })
            .join('');
    }

    cancelSearchInput.addEventListener('input', renderCancelList);

    cancelBodyEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cancel-sale]');
        if (!btn) return;
        const sale = salesHistory.find((s) => s.id === btn.dataset.cancelSale);
        if (sale) openCancelConfirm(sale);
    });

    function openCancelConfirm(sale) {
        saleToCancel = sale;
        cancelConfirmTitleEl.textContent = `Pedido #${sale.orderId}`;
        cancelConfirmDescEl.textContent =
            `Venda de ${money(sale.total)} feita em ${new Date(sale.date).toLocaleString('pt-BR')}. ` +
            'Os itens voltam para o estoque e a venda sai dos relatórios. Esta ação não pode ser desfeita.';
        cancelMotivoEl.value = '';
        cancelConfirmModalEl.hidden = false;
    }

    function closeCancelConfirm() {
        cancelConfirmModalEl.hidden = true;
        saleToCancel = null;
    }

    cancelConfirmModalEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-cancel-confirm-close]')) closeCancelConfirm();
    });

    cancelConfirmBtn.addEventListener('click', async () => {
        if (!saleToCancel) return;
        const sale = saleToCancel;
        cancelConfirmBtn.disabled = true;
        try {
            const { venda } = await window.hydraApi(`/vendas/${sale.id}/cancelar`, {
                method: 'POST',
                body: { motivo: cancelMotivoEl.value.trim() },
            });
            const atualizada = mapApiVenda(venda);
            const idx = salesHistory.findIndex((s) => s.id === sale.id);
            if (idx >= 0) salesHistory[idx] = atualizada;
            // A vitrine do PDV mostra o saldo: os itens voltaram ao estoque.
            (sale.items || []).forEach((it) => {
                const product = findProduct(it.productId);
                if (product) product.quantity += it.qty;
            });
            closeCancelConfirm();
            renderCancelList();
            renderCatalog();
            showToast(`Pedido #${sale.orderId} cancelado — itens devolvidos ao estoque`);
        } catch (err) {
            showToast(err.message, true);
            // Autorização vencida no servidor: tranca a aba.
            if (err.data && err.data.codigo === 'autorizacao_necessaria') {
                closeCancelConfirm();
                mostrarAba(primeiraAbaVisivel());
            }
        } finally {
            cancelConfirmBtn.disabled = false;
        }
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
        registeredProducts = catalog;
        salesHistory = HydroStore.getSales();
        proximoNumero = salesHistory.reduce((maior, s) => Math.max(maior, Number(s.orderId) || 0), 0) + 1;
    }

    /* ================= Init ================= */
    /* A aba de cancelamento fica desabilitada enquanto a sessão carrega. */
    const cancelTabBtn = document.querySelector('.hydro-order-tab[data-view="cancelar"]');
    function atualizarBotaoCancelar() {
        if (!cancelTabBtn) return;
        const carregando = sessaoEstado === 'carregando';
        cancelTabBtn.disabled = carregando;
        cancelTabBtn.setAttribute('aria-busy', carregando ? 'true' : 'false');
        cancelTabBtn.title = carregando ? 'Carregando seus dados de acesso...' : '';
    }
    atualizarBotaoCancelar();

    (async function init() {
        if (!window.hydraApi) {
            sessaoEstado = 'visitante';
            standardCatalogError = 'Servidor da API indisponível.';
            carregarDemonstracao();
            finalizarCarga();
            return;
        }

        const standardCatalogPromise = window.hydraApi('/catalogo-hortifruti')
            .then((resposta) => {
                standardHortifruti = Array.isArray(resposta.itens) ? resposta.itens : [];
                if (standardHortifruti.length !== 120) {
                    standardHortifruti = [];
                    throw new Error('O catálogo padrão não contém os 120 itens.');
                }
            })
            .catch((err) => {
                standardCatalogError = err.message || 'Falha de comunicação com o servidor.';
            });

        /* Os dados saem junto com a sessão, e não depois dela: com o lock de
           sessão liberado no back-end, as três chamadas rodam em paralelo. */
        const dadosPromise = Promise.allSettled([
            window.hydraApi('/produtos'),
            window.hydraApi('/vendas'),
        ]);

        let usuario;
        try {
            ({ usuario } = await window.hydraSessao());
        } catch (err) {
            // Visitante não autenticado (demo pública): a tela continua
            // navegável com o catálogo local.
            sessaoEstado = 'visitante';
            carregarDemonstracao();
            await standardCatalogPromise;
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
        const [produtosRes, vendasRes] = await dadosPromise;
        await standardCatalogPromise;

        if (produtosRes.status === 'fulfilled') {
            registeredProducts = produtosRes.value.produtos.map(mapApiProduct);
            // Só produtos ativos vão para a vitrine. Um produto inativado
            // (RN03) aparecia na grade e só era recusado ao finalizar a
            // venda, com "Produto indisponível para venda".
            catalog = registeredProducts.filter((p) => p.status === 'ativo');
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
        sessaoEstado = 'autenticado';
        finalizarCarga();
        retomarPixPendente();
    })();

    function finalizarCarga() {
        atualizarBotaoCancelar();
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
