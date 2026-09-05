/* ===================================================================
   HydroStore — camada de dados compartilhada entre as telas do Hydra PDV.
   Usa localStorage como "banco de dados" local, para que Produtos, Caixa,
   Estoque e Dashboard leiam e escrevam nas mesmas informações.
   =================================================================== */
(function (global) {
    'use strict';

    var KEYS = {
        products: 'hydro_products',
        sales: 'hydro_sales',
        movements: 'hydro_stock_movements',
        snapshots: 'hydro_daily_snapshots',
        seeded: 'hydro_seeded_v1',
    };

    function read(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            /* armazenamento indisponível — ignora silenciosamente */
        }
    }

    function uid(prefix) {
        return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function todayKey(d) {
        d = d || new Date();
        return d.toISOString().slice(0, 10);
    }

    /* Gerador pseudo-aleatório determinístico (mulberry32), usado só para
       popular um histórico de demonstração plausível na primeira execução. */
    function mulberry32(seed) {
        return function () {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /* ================= Catálogo inicial (seed) ================= */
    var SEED_CATALOG = [
        { id: 'p1', name: 'Café Tradicional 500g', desc: 'Torrado e moído, embalagem a vácuo.', sku: 'CAF500G', category: 'Alimentos', costPrice: 12.0, price: 18.9, quantity: 3, minStock: 10, unit: 'un', image: null },
        { id: 'p2', name: 'Leite Integral 1L', desc: 'Caixa longa vida, tipo A.', sku: 'LEITE1L', category: 'Bebidas', costPrice: 4.2, price: 6.5, quantity: 14, minStock: 20, unit: 'un', image: null },
        { id: 'p3', name: 'Açúcar Cristal 1kg', desc: 'Refinado, embalagem lacrada.', sku: 'ACU1K', category: 'Alimentos', costPrice: 3.1, price: 5.2, quantity: 12, minStock: 12, unit: 'un', image: null },
        { id: 'p4', name: 'Pão de Forma Integral', desc: 'Fatiado, pacote 500g.', sku: 'PAOFI500', category: 'Alimentos', costPrice: 6.0, price: 9.8, quantity: 34, minStock: 15, unit: 'un', image: null },
        { id: 'p5', name: 'Manteiga com Sal 200g', desc: 'Pote plástico, refrigerada.', sku: 'MANT200', category: 'Alimentos', costPrice: 8.0, price: 12.4, quantity: 26, minStock: 12, unit: 'un', image: null },
        { id: 'p6', name: 'Suco de Laranja 1L', desc: 'Natural, sem conservantes.', sku: 'SUCOLJ1L', category: 'Bebidas', costPrice: 5.5, price: 8.9, quantity: 40, minStock: 15, unit: 'un', image: null },
        { id: 'p7', name: 'Biscoito Recheado 140g', desc: 'Sabor chocolate.', sku: 'BISCR140', category: 'Alimentos', costPrice: 2.6, price: 4.5, quantity: 55, minStock: 20, unit: 'un', image: null },
        { id: 'p8', name: 'Chocolate ao Leite 90g', desc: 'Barra tradicional.', sku: 'CHOC90', category: 'Alimentos', costPrice: 4.3, price: 7.2, quantity: 48, minStock: 18, unit: 'un', image: null },
        { id: 'p9', name: 'Arroz Branco Tipo 1 5kg', desc: 'Grãos longos e soltos.', sku: 'ARROZ5KG', category: 'Alimentos', costPrice: 17.0, price: 24.9, quantity: 30, minStock: 10, unit: 'un', image: null },
    ];

    /* ================= Produtos ================= */
    function getProducts() {
        var list = read(KEYS.products, null);
        if (!list) {
            list = SEED_CATALOG.map(function (p) {
                return Object.assign({}, p, { criadoEm: nowIso() });
            });
            write(KEYS.products, list);
        }
        return list;
    }

    function saveProducts(list) {
        write(KEYS.products, list);
    }

    function addProduct(product) {
        var list = getProducts();
        list.push(product);
        saveProducts(list);
        if (product.quantity > 0) {
            addMovement({
                type: 'entrada',
                productId: product.id,
                productName: product.name,
                qty: product.quantity,
                source: 'cadastro',
                date: nowIso(),
            });
        }
        return product;
    }

    function updateProduct(id, patch) {
        var list = getProducts();
        var idx = list.findIndex(function (p) {
            return String(p.id) === String(id);
        });
        if (idx > -1) {
            list[idx] = Object.assign({}, list[idx], patch);
            saveProducts(list);
            return list[idx];
        }
        return null;
    }

    function adjustStock(id, delta, opts) {
        opts = opts || {};
        var list = getProducts();
        var idx = list.findIndex(function (p) {
            return String(p.id) === String(id);
        });
        if (idx === -1) return null;
        var before = list[idx].quantity || 0;
        var after = Math.max(0, before + delta);
        var movedQty = Math.abs(after - before);
        list[idx].quantity = after;
        saveProducts(list);
        if (movedQty > 0) {
            addMovement({
                type: delta >= 0 ? 'entrada' : 'saida',
                productId: list[idx].id,
                productName: list[idx].name,
                qty: movedQty,
                source: opts.source || 'estoque',
                date: opts.date || nowIso(),
            });
        }
        return list[idx];
    }

    function removeProduct(id) {
        var list = getProducts().filter(function (p) {
            return String(p.id) !== String(id);
        });
        saveProducts(list);
    }

    /* ================= Regra única de status de estoque ================= */
    function stockStatus(quantity, minStock) {
        quantity = Number(quantity) || 0;
        minStock = Number(minStock) || 0;
        if (minStock <= 0) return quantity > 0 ? 'ok' : 'critical';
        if (quantity < minStock / 2) return 'critical';
        if (quantity < minStock) return 'warning';
        return 'ok';
    }

    var STATUS_LABELS = { critical: 'Crítico', warning: 'Atenção', ok: 'Em estoque' };

    /* ================= Vendas ================= */
    function getSales() {
        return read(KEYS.sales, []);
    }

    function addSale(sale) {
        var list = getSales();
        sale.id = sale.id || uid('sale');
        sale.date = sale.date || nowIso();
        list.push(sale);
        write(KEYS.sales, list);

        (sale.items || []).forEach(function (item) {
            adjustStock(item.productId, -item.qty, { source: 'venda', date: sale.date });
        });

        return sale;
    }

    /* ================= Movimentações (entradas / saídas) ================= */
    function getMovements() {
        return read(KEYS.movements, []);
    }

    function addMovement(mov) {
        var list = getMovements();
        mov.id = mov.id || uid('mov');
        mov.date = mov.date || nowIso();
        list.push(mov);
        write(KEYS.movements, list);
        return mov;
    }

    /* ================= Snapshots diários (variação % dos KPIs) ================= */
    function snapshotToday(metrics) {
        var all = read(KEYS.snapshots, {});
        all[todayKey()] = metrics;
        write(KEYS.snapshots, all);
    }

    function getPreviousSnapshot() {
        var all = read(KEYS.snapshots, {});
        var keys = Object.keys(all)
            .filter(function (k) {
                return k !== todayKey();
            })
            .sort();
        if (!keys.length) return null;
        return all[keys[keys.length - 1]];
    }

    /* ================= Histórico de demonstração (roda só na 1ª vez) =================
       Popula ~30 dias de vendas e movimentações plausíveis, para que o Dashboard,
       o Caixa e o Estoque já nasçam com dados reais para exibir. Uso real do
       sistema (novas vendas, entradas/saídas) se soma a esse histórico. */
    function seedHistoryIfNeeded() {
        if (read(KEYS.seeded, false)) return;

        var products = getProducts();
        var rand = mulberry32(20260826);
        var sales = getSales();
        var movements = getMovements();

        for (var d = 29; d >= 0; d--) {
            var day = new Date();
            day.setDate(day.getDate() - d);
            day.setHours(9 + Math.floor(rand() * 9), Math.floor(rand() * 60), 0, 0);

            var salesToday = d === 0 ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 4);

            for (var s = 0; s < salesToday; s++) {
                var itemCount = 1 + Math.floor(rand() * 3);
                var items = [];
                var usedIds = {};
                for (var i = 0; i < itemCount; i++) {
                    var product = products[Math.floor(rand() * products.length)];
                    if (usedIds[product.id]) continue;
                    usedIds[product.id] = true;
                    var qty = 1 + Math.floor(rand() * 3);
                    items.push({ productId: product.id, name: product.name, qty: qty, price: product.price });
                }
                if (!items.length) continue;

                var total = items.reduce(function (sum, it) {
                    return sum + it.qty * it.price;
                }, 0);
                var saleDate = new Date(day.getTime() + s * 600000).toISOString();

                sales.push({
                    id: uid('sale'),
                    orderId: 7800 + sales.length,
                    clienteId: 'CL' + (10 + Math.floor(rand() * 90)),
                    items: items,
                    total: Math.round(total * 100) / 100,
                    payment: ['dinheiro', 'cartao', 'pix'][Math.floor(rand() * 3)],
                    date: saleDate,
                });

                items.forEach(function (it) {
                    movements.push({
                        id: uid('mov'),
                        type: 'saida',
                        productId: it.productId,
                        productName: it.name,
                        qty: it.qty,
                        source: 'venda',
                        date: saleDate,
                    });
                });
            }

            if (rand() < 0.35) {
                var restockProduct = products[Math.floor(rand() * products.length)];
                var restockQty = 5 + Math.floor(rand() * 20);
                movements.push({
                    id: uid('mov'),
                    type: 'entrada',
                    productId: restockProduct.id,
                    productName: restockProduct.name,
                    qty: restockQty,
                    source: 'estoque',
                    date: day.toISOString(),
                });
            }
        }

        write(KEYS.sales, sales);
        write(KEYS.movements, movements);
        write(KEYS.seeded, true);
    }

    global.HydroStore = {
        KEYS: KEYS,
        getProducts: getProducts,
        saveProducts: saveProducts,
        addProduct: addProduct,
        updateProduct: updateProduct,
        adjustStock: adjustStock,
        removeProduct: removeProduct,
        stockStatus: stockStatus,
        STATUS_LABELS: STATUS_LABELS,
        getSales: getSales,
        addSale: addSale,
        getMovements: getMovements,
        addMovement: addMovement,
        snapshotToday: snapshotToday,
        getPreviousSnapshot: getPreviousSnapshot,
        seedHistoryIfNeeded: seedHistoryIfNeeded,
        todayKey: todayKey,
        uid: uid,
    };
})(window);
