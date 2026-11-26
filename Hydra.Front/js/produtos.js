(function () {
    'use strict';

    (async function guardaDeAcesso() {
        if (!window.hydraApi) return;
        try {
            const { usuario } = await window.hydraSessao();
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
            /* Esta tela só serve para cadastrar produto. Sem a permissão, o
               formulário abria normalmente e o POST só falhava com 403 na
               hora de salvar — depois de o usuário ter preenchido tudo. */
            window.hydraGuardaDeTela(usuario, ['produtos.gerenciar']);
        } catch (err) {
            // Visitante não autenticado (demo pública): mantém os itens visíveis, mostrando todas as telas.
            // O histórico fictício da demonstração só interessa a ele; para
            // quem está logado, gerar ~30 dias de vendas no localStorage era
            // trabalho jogado fora na primeira abertura da tela.
            HydroStore.seedHistoryIfNeeded();
        }
    })();

    /* ================= Categorias =================
       Não existe tabela de categorias: a categoria é um texto gravado no
       produto. A lista de seleção junta as categorias padrão de mercado
       (CATEGORIAS_PADRAO) com as que a loja já usa nos produtos, e o botão
       "+ Nova categoria" cria outra na hora. Uma categoria nova passa a
       existir de verdade quando o primeiro produto com ela é salvo.

       A lista não repete a mesma categoria com grafias diferentes: se a
       loja já usa "bebidas", ela aparece com essa grafia no lugar da
       padrão "Bebidas", para não dividir o filtro do Estoque em dois. */
    const CATEGORIAS_PADRAO = [
        'Mercearia', 'Açougue', 'Hortifruti', 'Padaria', 'Bebidas',
        'Higiene e beleza', 'Limpeza', 'Pet', 'Tabacaria',
    ];
    let categoriasDaLoja = [];

    const categoriaSelect = document.getElementById('hydroProdCategory');
    const novaCategoriaBtn = document.getElementById('hydroCategoryNewBtn');
    const novaCategoriaPainel = document.getElementById('hydroCategoryNewPanel');
    const novaCategoriaInput = document.getElementById('hydroCategoryNewInput');

    const chaveCategoria = (nome) => nome.toLocaleLowerCase('pt-BR');

    function montarListaCategorias(nomesDaLoja) {
        const porChave = new Map();
        // As da loja primeiro: a grafia delas ganha da padrão.
        nomesDaLoja.concat(CATEGORIAS_PADRAO).forEach((nome) => {
            const limpo = String(nome || '').replace(/\s+/g, ' ').trim();
            if (limpo && !porChave.has(chaveCategoria(limpo))) porChave.set(chaveCategoria(limpo), limpo);
        });
        categoriasDaLoja = Array.from(porChave.values()).sort((a, b) => a.localeCompare(b, 'pt-BR'));
        renderizarSelectCategorias(categoriaSelect.value);
    }

    function renderizarSelectCategorias(selecionada) {
        const primeira = categoriaSelect.options[0]; // "Selecione a categoria"
        categoriaSelect.replaceChildren(primeira);
        categoriasDaLoja.forEach((categoria) => {
            // new Option() atribui como texto, nunca como HTML.
            categoriaSelect.add(new Option(categoria, categoria));
        });
        categoriaSelect.value = selecionada && categoriasDaLoja.includes(selecionada) ? selecionada : '';
    }

    /** Inclui a categoria na lista (se ainda não estiver) e devolve a grafia usada. */
    function incluirCategoria(nome) {
        const normalizada = normalizeCategory(nome, categoriasDaLoja);
        if (normalizada && !categoriasDaLoja.includes(normalizada)) {
            categoriasDaLoja.push(normalizada);
            categoriasDaLoja.sort((a, b) => a.localeCompare(b, 'pt-BR'));
        }
        return normalizada;
    }

    function abrirNovaCategoria(abrir) {
        novaCategoriaPainel.hidden = !abrir;
        novaCategoriaBtn.setAttribute('aria-expanded', String(abrir));
        if (abrir) {
            novaCategoriaInput.value = '';
            novaCategoriaInput.focus();
        } else {
            novaCategoriaBtn.focus();
        }
    }

    function adicionarNovaCategoria() {
        const nome = novaCategoriaInput.value;
        if (!nome.trim()) {
            showToast('Digite o nome da nova categoria');
            novaCategoriaInput.focus();
            return;
        }
        const jaExistia = categoriasDaLoja.some((c) => chaveCategoria(c) === chaveCategoria(nome.replace(/\s+/g, ' ').trim()));
        const categoria = incluirCategoria(nome);
        renderizarSelectCategorias(categoria);
        // "input" limpa o destaque de erro do campo (listener do formulário).
        categoriaSelect.dispatchEvent(new Event('input', { bubbles: true }));
        atualizarPreviaSku();
        abrirNovaCategoria(false);
        categoriaSelect.focus();
        showToast(jaExistia
            ? `A categoria "${categoria}" já existia e foi selecionada`
            : `Categoria "${categoria}" criada. Ela fica salva junto com o produto.`);
    }

    novaCategoriaBtn.addEventListener('click', () => abrirNovaCategoria(novaCategoriaPainel.hidden));
    document.getElementById('hydroCategoryNewCancel').addEventListener('click', () => abrirNovaCategoria(false));
    document.getElementById('hydroCategoryNewAdd').addEventListener('click', adicionarNovaCategoria);
    novaCategoriaInput.addEventListener('keydown', (e) => {
        // Enter aqui cria a categoria em vez de enviar o formulário do produto.
        if (e.key === 'Enter') {
            e.preventDefault();
            adicionarNovaCategoria();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            abrirNovaCategoria(false);
        }
    });

    /* ================= SKU =================
       Gerado pelo servidor a partir da categoria (SkuRepository): 2 letras
       + número da faixa da categoria, ex.: Padaria → PA.3001. Aqui só se
       mostra a PRÉVIA, pedida a cada troca de categoria; o definitivo vem
       na resposta do cadastro. */
    const skuInput = document.getElementById('hydroProdSku');
    let pedidoSku = 0;

    async function atualizarPreviaSku() {
        const categoria = categoriaSelect.value;
        const pedido = ++pedidoSku; // só a resposta do último pedido vale
        skuInput.value = '';
        if (!categoria) {
            skuInput.placeholder = 'Escolha a categoria';
            return;
        }
        skuInput.placeholder = 'Gerando…';
        try {
            const { sku } = await window.hydraApi(`/produtos/proximo-sku?categoria=${encodeURIComponent(categoria)}`);
            if (pedido !== pedidoSku) return;
            skuInput.value = sku;
        } catch (err) {
            if (pedido !== pedidoSku) return;
            skuInput.placeholder = 'Definido ao salvar';
            // Categoria cheia (1.000 SKUs): avisa já, antes de preencher o resto.
            if (err.status === 422) showToast(err.message, true);
        }
    }

    categoriaSelect.addEventListener('change', atualizarPreviaSku);
    // "form" só é declarado mais abaixo neste arquivo; busca direto aqui.
    document.getElementById('hydroProductForm').addEventListener('reset', () => {
        pedidoSku++;
        skuInput.placeholder = 'Escolha a categoria';
    });

    montarListaCategorias([]); // padrões já na tela enquanto a API responde

    (async function loadCategorias() {
        if (window.hydraApi) {
            try {
                const { produtos } = await window.hydraApi('/produtos');
                montarListaCategorias(produtos.map((p) => p.categoria));
                return;
            } catch (err) {
                // Visitante da demo pública (401) ou cargo sem acesso ao
                // catálogo: cai para o catálogo local abaixo. As categorias
                // padrão continuam na lista de qualquer forma.
            }
        }
        montarListaCategorias(HydroStore.getProducts().map((p) => p.category));
    })();

    /* Normaliza a categoria digitada: colapsa espaços, corta no tamanho da
       coluna e, se já existir uma equivalente na loja, reaproveita a grafia
       dela — é isso que impede "bebidas", " Bebidas " e "BEBIDAS" de virarem
       três opções no filtro do Estoque. */
    function normalizeCategory(value, existing) {
        const cleaned = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!cleaned) return '';
        const hit = (existing || []).find(
            (c) => c.toLocaleLowerCase('pt-BR') === cleaned.toLocaleLowerCase('pt-BR')
        );
        return hit || cleaned.charAt(0).toLocaleUpperCase('pt-BR') + cleaned.slice(1);
    }

    /* Data de hoje em YYYY-MM-DD no fuso local. toISOString() não serve:
       é UTC, então em UTC-3 depois das 21h devolveria o dia seguinte e
       recusaria um produto que vence hoje. */
    function todayIso() {
        const d = new Date();
        const mes = String(d.getMonth() + 1).padStart(2, '0');
        const dia = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mes}-${dia}`;
    }

    const form = document.getElementById('hydroProductForm');
    const saveBtn = document.getElementById('hydroSaveBtn');
    const toast = document.getElementById('hydroToast');
    const barcodeInput = document.getElementById('hydroProdBarcode');
    const cameraModal = document.getElementById('hydroProductCameraModal');
    const cameraVideo = document.getElementById('hydroProductCameraVideo');
    const cameraStatus = document.getElementById('hydroProductCameraStatus');
    let activeBarcodeScanner = null;
    let productCameraRequest = 0;

    /* ================= Unidade "Caixa" =================
       "Caixa" nunca é gravada como unidade do produto: é só um atalho
       para o operador indicar a unidade real (a que existe dentro da
       caixa), exibida neste segundo campo. */
    const unitSelect = document.getElementById('hydroProdUnit');
    const boxUnitGroup = document.getElementById('hydroProdBoxUnitGroup');

    function toggleBoxUnitGroup() {
        boxUnitGroup.hidden = unitSelect.value !== 'cx';
    }

    unitSelect.addEventListener('change', toggleBoxUnitGroup);
    toggleBoxUnitGroup();

    /* Não se cadastra produto vencido: o seletor nativo já aparece com os
       dias passados em cinza, antes de qualquer tentativa de salvar. */
    const expiryInput = document.getElementById('hydroProdExpiry');
    expiryInput.min = todayIso();

    /* ================= Toast ================= */
    let toastTimer = null;
    function showToast(message, isError) {
        toast.textContent = message;
        toast.classList.toggle('hydro-toast-error', !!isError);
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 3200);
    }

    function closeProductCamera() {
        productCameraRequest++;
        if (activeBarcodeScanner) activeBarcodeScanner.stop();
        activeBarcodeScanner = null;
        cameraModal.hidden = true;
    }

    document.getElementById('hydroScanProductBarcode').addEventListener('click', async () => {
        const request = ++productCameraRequest;
        cameraModal.hidden = false;
        cameraStatus.textContent = 'Solicitando acesso à câmera…';
        try {
            const scanner = await window.HydraBarcodeScanner.start(
                cameraVideo,
                (value) => {
                    const digits = String(value || '').trim();
                    if (!/^\d{8,14}$/.test(digits)) {
                        cameraStatus.textContent = 'Código lido fora do limite de 8 a 14 dígitos. Tente novamente.';
                        return;
                    }
                    barcodeInput.value = digits;
                    barcodeInput.dispatchEvent(new Event('input', { bubbles: true }));
                    closeProductCamera();
                    barcodeInput.focus();
                    showToast('Código de barras capturado.');
                },
                (error) => {
                    cameraStatus.textContent = error.message || 'Não foi possível ler o código.';
                }
            );
            if (request !== productCameraRequest || cameraModal.hidden) {
                scanner.stop();
                return;
            }
            activeBarcodeScanner = scanner;
            cameraStatus.textContent = 'Aponte a câmera para o código de barras.';
        } catch (error) {
            if (request === productCameraRequest && !cameraModal.hidden) {
                cameraStatus.textContent = error.message || 'Não foi possível iniciar a câmera.';
            }
        }
    });

    cameraModal.addEventListener('click', (event) => {
        if (event.target.closest('[data-product-camera-close]')) closeProductCamera();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !cameraModal.hidden) closeProductCamera();
    });

    barcodeInput.addEventListener('input', () => {
        barcodeInput.value = barcodeInput.value.replace(/\D/g, '').slice(0, 14);
        const errorEl = form.querySelector('[data-error-for="hydroProdBarcode"]');
        if (errorEl) errorEl.textContent = '';
        barcodeInput.classList.remove('hydro-invalid');
    });

    /* ================= Validação ================= */
    function clearErrors() {
        form.querySelectorAll('.hydro-invalid').forEach((el) => {
            el.classList.remove('hydro-invalid');
            el.removeAttribute('aria-invalid');
        });
        form.querySelectorAll('.hydro-field-error').forEach((el) => (el.textContent = ''));
    }

    function setError(inputId, message) {
        const input = document.getElementById(inputId);
        const errorEl = form.querySelector(`[data-error-for="${inputId}"]`);
        if (input) {
            input.classList.add('hydro-invalid');
            input.setAttribute('aria-invalid', 'true');
        }
        if (errorEl) errorEl.textContent = message;
    }

    // O destaque vermelho de um campo some assim que ele é corrigido, sem
    // esperar um novo "Salvar" — fica claro o que ainda falta preencher.
    form.addEventListener('input', (event) => {
        const campo = event.target;
        if (!campo.classList || !campo.classList.contains('hydro-invalid')) return;
        campo.classList.remove('hydro-invalid');
        campo.removeAttribute('aria-invalid');
        const errorEl = form.querySelector(`[data-error-for="${campo.id}"]`);
        if (errorEl) errorEl.textContent = '';
    });

    function validate(data) {
        clearErrors();
        let valid = true;

        if (!data.nome.trim()) {
            setError('hydroProdName', 'Informe o nome do produto');
            valid = false;
        }
        if (!normalizeCategory(data.categoria, categoriasDaLoja)) {
            setError('hydroProdCategory', 'Informe a categoria do produto');
            valid = false;
        }
        if (data.codigo !== ''
            && (!Number.isInteger(Number(data.codigo)) || Number(data.codigo) < 500 || Number(data.codigo) > 599)) {
            setError('hydroProdCode', 'Use um código inteiro de 500 a 599');
            valid = false;
        }
        if (data.codigoBarras !== '' && !/^\d{8,14}$/.test(data.codigoBarras)) {
            setError('hydroProdBarcode', 'Informe de 8 a 14 dígitos numéricos ou deixe o campo vazio');
            valid = false;
        }
        if (data.precoVenda === '' || Number(data.precoVenda) <= 0) {
            setError('hydroProdSalePrice', 'Informe um preço de venda válido');
            valid = false;
        }
        if (data.quantidade === '' || Number(data.quantidade) < 0) {
            setError('hydroProdQty', 'Informe a quantidade em estoque');
            valid = false;
        }
        // RN02: estoque mínimo obrigatório. Vazio virava 0 sem aviso.
        if (data.estoqueMinimo === '' || Number(data.estoqueMinimo) < 0) {
            setError('hydroProdMinStock', 'Informe o estoque mínimo (use 0 se não precisar de alerta)');
            valid = false;
        }
        if (data.validade && data.validade < todayIso()) {
            setError('hydroProdExpiry', 'A data de validade informada já passou');
            valid = false;
        }

        return valid;
    }

    /* ================= Salvar ================= */
    function getFormData() {
        const fd = new FormData(form);
        const unidadeSelecionada = (fd.get('unidade') || 'un').toString();
        const unidadeCaixa = (fd.get('unidadeCaixa') || 'un').toString();
        return {
            nome: (fd.get('nome') || '').toString(),
            categoria: (fd.get('categoria') || '').toString(),
            codigo: (fd.get('codigo') || '').toString(),
            codigoBarras: (fd.get('codigo_barras') || '').toString(),
            precoCusto: (fd.get('precoCusto') || '').toString(),
            precoVenda: (fd.get('precoVenda') || '').toString(),
            quantidade: (fd.get('quantidade') || '').toString(),
            estoqueMinimo: (fd.get('estoqueMinimo') || '').toString(),
            // "Caixa" nunca é gravada como unidade do produto — quando
            // selecionada, o campo extra escolhe a unidade real.
            unidade: unidadeSelecionada === 'cx' ? unidadeCaixa : unidadeSelecionada,
            lote: (fd.get('lote') || '').toString(),
            validade: (fd.get('validade') || '').toString(),
        };
    }

    function saveProductLocally(data) {
        const name = data.nome.trim();
        const product = {
            id: HydroStore.uid('p'),
            name: name,
            desc: '',
            category: normalizeCategory(data.categoria, categoriasDaLoja),
            code: data.codigo ? String(Number(data.codigo)) : null,
            barcode: data.codigoBarras || null,
            costPrice: data.precoCusto ? Number(data.precoCusto) : 0,
            price: Number(data.precoVenda),
            quantity: Number(data.quantidade),
            minStock: data.estoqueMinimo ? Number(data.estoqueMinimo) : 0,
            unit: data.unidade,
            lote: data.lote.trim() || null,
            validade: data.validade || null,
            criadoEm: new Date().toISOString(),
        };
        HydroStore.addProduct(product);
        return product;
    }

    /* Grava o produto via API real (RF02). */
    async function saveProductRemote(data) {
        const { produto } = await window.hydraApi('/produtos', {
            method: 'POST',
            body: {
                nome: data.nome.trim(),
                categoria: normalizeCategory(data.categoria, categoriasDaLoja),
                codigo: data.codigo === '' ? null : Number(data.codigo),
                codigo_barras: data.codigoBarras || null,
                preco_custo: data.precoCusto || null,
                preco_venda: Number(data.precoVenda),
                quantidade: Number(data.quantidade),
                estoque_minimo: Number(data.estoqueMinimo),
                unidade: data.unidade,
                lote: data.lote.trim() || null,
                validade: data.validade || null,
            },
        });
        return produto;
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = getFormData();
        if (!validate(data)) {
            // Nem todo erro é campo vazio (ex.: código de barras com 5
            // dígitos), por isso a mensagem não fala só em obrigatórios.
            showToast('Corrija os campos destacados em vermelho', true);
            // Leva o cursor ao primeiro campo com problema.
            const primeiroInvalido = form.querySelector('.hydro-invalid');
            if (primeiroInvalido) primeiroInvalido.focus();
            return;
        }

        saveBtn.disabled = true;
        let skuSalvo = '';

        if (window.hydraApi) {
            try {
                const produto = await saveProductRemote(data);
                skuSalvo = (produto && produto.sku) || '';
                // O SKU definitivo vem do servidor (a prévia pode ter mudado
                // se outro cadastro da mesma categoria salvou antes).
                if (skuSalvo) skuInput.value = skuSalvo;
            } catch (err) {
                // Visitante não autenticado (demo pública) cai para o cadastro
                // local; qualquer outro erro (validação, duplicidade, servidor)
                // é mostrado de verdade para quem está autenticado.
                if (err.status !== 401) {
                    showToast(err.message, true);
                    saveBtn.disabled = false;
                    return;
                }
                saveProductLocally(data);
            }
        } else {
            saveProductLocally(data);
        }

        /* A categoria salva continua na lista sem recarregar a tela (inclusive
           uma criada agora por "+ Nova categoria"), para "Cadastrar outro"
           na mesma categoria. */
        incluirCategoria(data.categoria);

        /* Depois de salvar, volta para a listagem do Estoque, onde o produto
           novo aparece (QA 007). Quem quer cadastrar vários em sequência
           marca "Cadastrar outro" e continua no formulário. */
        const cadastrarOutro = document.getElementById('hydroProdCadastrarOutro');
        const comSku = skuSalvo ? ` SKU ${skuSalvo}.` : '';
        if (!cadastrarOutro || !cadastrarOutro.checked) {
            showToast(`Produto salvo com sucesso!${comSku} Voltando para o estoque...`);
            setTimeout(() => { window.location.href = 'controle-estoque.html'; }, 1400);
            return;
        }

        showToast(`Produto salvo com sucesso!${comSku}`);
        setTimeout(() => {
            form.reset();
            // form.reset() desmarcaria a opção que o usuário acabou de usar.
            if (cadastrarOutro) cadastrarOutro.checked = true;
            clearImage();
            clearErrors();
            toggleBoxUnitGroup();
            saveBtn.disabled = false;
        }, 600);
    });

    /* Menu lateral do celular: window.hydraMenuLateral (api.js). */
})();
