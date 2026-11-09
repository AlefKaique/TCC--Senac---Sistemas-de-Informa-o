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
        }
    })();

    HydroStore.seedHistoryIfNeeded();

    /* ================= Categorias já usadas na loja =================
       Não existe lista fixa nem tabela de categorias: o usuário digita a
       que fizer sentido para o mercadinho dele. As que já estão em uso
       vêm do próprio catálogo e são oferecidas como sugestão, o que evita
       criar "Bebidas" de novo só porque a grafia saiu diferente. */
    let categoriasDaLoja = [];

    function preencherDatalistCategorias(nomes) {
        categoriasDaLoja = Array.from(new Set(nomes.map((n) => String(n || '').trim()).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'pt-BR'));

        const datalist = document.getElementById('hydroCategoryList');
        datalist.innerHTML = '';
        categoriasDaLoja.forEach((categoria) => {
            const option = document.createElement('option');
            // Atribuído como propriedade, nunca via innerHTML: é à prova de
            // injeção por construção, sem precisar de um escapeHtml aqui.
            option.value = categoria;
            datalist.appendChild(option);
        });
        renderChipsCategorias();
    }

    /* O <datalist> só aparece quando o usuário começa a digitar, e na
       maioria dos navegadores nem há seta indicando que existe uma lista
       (QA 011). As categorias da loja ficam visíveis como botões logo abaixo
       do campo: um clique preenche. Digitar uma nova continua valendo. */
    function renderChipsCategorias() {
        const wrap = document.getElementById('hydroCategoryChips');
        const input = document.getElementById('hydroProdCategory');
        if (!wrap || !input) return;
        wrap.innerHTML = '';
        categoriasDaLoja.forEach((categoria) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'hydro-btn hydro-btn-outline hydro-btn-sm';
            // Não é ação de gravação: a demonstração pública não deve
            // bloquear este clique com o convite de cadastro.
            chip.setAttribute('data-demo-allow', '');
            chip.textContent = categoria;
            chip.addEventListener('click', () => {
                input.value = categoria;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            });
            wrap.appendChild(chip);
        });
        wrap.style.display = categoriasDaLoja.length ? 'flex' : 'none';
    }

    (async function loadCategorias() {
        if (window.hydraApi) {
            try {
                const { produtos } = await window.hydraApi('/produtos');
                preencherDatalistCategorias(produtos.map((p) => p.categoria));
                return;
            } catch (err) {
                // Visitante da demo pública (401) ou cargo sem acesso ao
                // catálogo: cai para o catálogo local abaixo. Sem sugestões o
                // campo ainda funciona, livre para digitar.
            }
        }
        preencherDatalistCategorias(HydroStore.getProducts().map((p) => p.category));
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

    /* ================= Validação ================= */
    function clearErrors() {
        form.querySelectorAll('.hydro-invalid').forEach((el) => el.classList.remove('hydro-invalid'));
        form.querySelectorAll('.hydro-field-error').forEach((el) => (el.textContent = ''));
    }

    function setError(inputId, message) {
        const input = document.getElementById(inputId);
        const errorEl = form.querySelector(`[data-error-for="${inputId}"]`);
        if (input) input.classList.add('hydro-invalid');
        if (errorEl) errorEl.textContent = message;
    }

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
            showToast('Verifique os campos destacados', true);
            return;
        }

        saveBtn.disabled = true;

        if (window.hydraApi) {
            try {
                await saveProductRemote(data);
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

        /* Categoria recém-criada entra nas sugestões sem recarregar a tela:
           cadastrar dois produtos da mesma categoria nova em sequência
           reaproveita a grafia do primeiro. */
        const categoriaSalva = normalizeCategory(data.categoria, categoriasDaLoja);
        if (categoriaSalva && !categoriasDaLoja.includes(categoriaSalva)) {
            categoriasDaLoja.push(categoriaSalva);
            categoriasDaLoja.sort((a, b) => a.localeCompare(b, 'pt-BR'));
            const option = document.createElement('option');
            option.value = categoriaSalva;
            document.getElementById('hydroCategoryList').appendChild(option);
            renderChipsCategorias();
        }

        /* Depois de salvar, volta para a listagem do Estoque, onde o produto
           novo aparece (QA 007). Quem quer cadastrar vários em sequência
           marca "Cadastrar outro" e continua no formulário. */
        const cadastrarOutro = document.getElementById('hydroProdCadastrarOutro');
        if (!cadastrarOutro || !cadastrarOutro.checked) {
            showToast('Produto salvo com sucesso! Voltando para o estoque...');
            setTimeout(() => { window.location.href = 'controle-estoque.html'; }, 900);
            return;
        }

        showToast('Produto salvo com sucesso!');
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

    /* ================= Mobile sidebar (padrão do sistema) ================= */
    const sidebar = document.getElementById('hydroSidebar');
    const overlay = document.getElementById('hydroSidebarOverlay');
    const mobileToggle = document.getElementById('hydroMobileToggle');
    if (mobileToggle) {
        mobileToggle.addEventListener('click', () => {
            sidebar.classList.add('hydro-open');
            overlay.classList.add('hydro-show');
        });
        overlay.addEventListener('click', closeSidebar);
    }
    function closeSidebar() {
        sidebar.classList.remove('hydro-open');
        overlay.classList.remove('hydro-show');
    }
})();
