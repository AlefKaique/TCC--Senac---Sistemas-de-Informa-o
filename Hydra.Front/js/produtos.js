(function () {
    'use strict';

    (async function guardAdminMenu() {
        if (!window.hydraApi) return;
        try {
            const { usuario } = await window.hydraApi('/auth/me');
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
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
        categoriasDaLoja.forEach((categoria) => {
            const option = document.createElement('option');
            // Atribuído como propriedade, nunca via innerHTML: é à prova de
            // injeção por construção, sem precisar de um escapeHtml aqui.
            option.value = categoria;
            datalist.appendChild(option);
        });
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

    const dropzone = document.getElementById('hydroDropzone');
    const fileInput = document.getElementById('hydroProdImageInput');
    const previewWrap = document.getElementById('hydroDropzonePreview');
    const previewImg = document.getElementById('hydroDropzoneImg');
    const emptyState = document.getElementById('hydroDropzoneEmpty');
    const removeBtn = document.getElementById('hydroDropzoneRemove');

    let imageDataUrl = null;

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

    /* ================= Upload de imagem ================= */
    function setImage(file) {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            showToast('Selecione um arquivo de imagem válido (PNG, JPG ou WEBP)', true);
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            showToast('A imagem deve ter no máximo 5MB', true);
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            imageDataUrl = e.target.result;
            previewImg.src = imageDataUrl;
            previewWrap.hidden = false;
            emptyState.hidden = true;
            removeBtn.hidden = false;
        };
        reader.readAsDataURL(file);
    }

    function clearImage() {
        imageDataUrl = null;
        fileInput.value = '';
        previewImg.src = '';
        previewWrap.hidden = true;
        emptyState.hidden = false;
        removeBtn.hidden = true;
    }

    fileInput.addEventListener('change', (e) => setImage(e.target.files[0]));

    removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        clearImage();
    });

    ['dragenter', 'dragover'].forEach((evt) => {
        dropzone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('hydro-dragover');
        });
    });

    ['dragleave', 'drop'].forEach((evt) => {
        dropzone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('hydro-dragover');
        });
    });

    dropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        setImage(file);
    });

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
            image: imageDataUrl,
            criadoEm: new Date().toISOString(),
        };
        HydroStore.addProduct(product);
        return product;
    }

    /* Grava o produto via API real (RF02). A imagem ainda não é enviada
       ao back-end — assim como o logotipo da loja, permanece, por ora,
       como pré-visualização local (sem endpoint de armazenamento). */
    async function saveProductRemote(data) {
        const { produto } = await window.hydraApi('/produtos', {
            method: 'POST',
            body: {
                nome: data.nome.trim(),
                categoria: normalizeCategory(data.categoria, categoriasDaLoja),
                preco_custo: data.precoCusto || null,
                preco_venda: Number(data.precoVenda),
                quantidade: Number(data.quantidade),
                estoque_minimo: data.estoqueMinimo || 0,
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
        }

        showToast('Produto salvo com sucesso!');
        setTimeout(() => {
            form.reset();
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
