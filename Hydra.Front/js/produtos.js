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
        if (!data.categoria) {
            setError('hydroProdCategory', 'Selecione uma categoria');
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

        return valid;
    }

    /* ================= Salvar ================= */
    const CATEGORY_LABELS = {
        alimentos: 'Alimentos',
        bebidas: 'Bebidas',
        limpeza: 'Limpeza',
        higiene: 'Higiene e beleza',
        outros: 'Outros',
    };

    function getFormData() {
        const fd = new FormData(form);
        const unidadeSelecionada = (fd.get('unidade') || 'un').toString();
        const unidadeCaixa = (fd.get('unidadeCaixa') || 'un').toString();
        return {
            nome: (fd.get('nome') || '').toString(),
            codigoBarras: (fd.get('codigoBarras') || '').toString(),
            categoria: (fd.get('categoria') || '').toString(),
            precoCusto: (fd.get('precoCusto') || '').toString(),
            precoVenda: (fd.get('precoVenda') || '').toString(),
            quantidade: (fd.get('quantidade') || '').toString(),
            estoqueMinimo: (fd.get('estoqueMinimo') || '').toString(),
            // "Caixa" nunca é gravada como unidade do produto — quando
            // selecionada, o campo extra escolhe a unidade real.
            unidade: unidadeSelecionada === 'cx' ? unidadeCaixa : unidadeSelecionada,
            validade: (fd.get('validade') || '').toString(),
        };
    }

    function generateSku(name, barcode) {
        if (barcode && barcode.trim()) return barcode.trim();
        const base = name
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 8);
        return (base || 'PROD') + '-' + Date.now().toString(36).slice(-4).toUpperCase();
    }

    function saveProductLocally(data) {
        const name = data.nome.trim();
        const product = {
            id: HydroStore.uid('p'),
            name: name,
            desc: '',
            sku: generateSku(name, data.codigoBarras),
            category: CATEGORY_LABELS[data.categoria] || data.categoria,
            costPrice: data.precoCusto ? Number(data.precoCusto) : 0,
            price: Number(data.precoVenda),
            quantity: Number(data.quantidade),
            minStock: data.estoqueMinimo ? Number(data.estoqueMinimo) : 0,
            unit: data.unidade,
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
                codigo_barras: data.codigoBarras.trim(),
                categoria: CATEGORY_LABELS[data.categoria] || data.categoria,
                preco_custo: data.precoCusto || null,
                preco_venda: Number(data.precoVenda),
                quantidade: Number(data.quantidade),
                estoque_minimo: data.estoqueMinimo || 0,
                unidade: data.unidade,
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
