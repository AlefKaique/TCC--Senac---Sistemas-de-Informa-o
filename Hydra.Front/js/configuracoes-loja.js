(function () {
    'use strict';

    const form = document.getElementById('hydroSettingsForm');
    if (!form) return;

    /* ================= Toast ================= */
    let toastTimer = null;
    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        toast.textContent = message;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 2600);
    }

    /* ================= Upload de logo (pré-visualização local) =================
       O envio do arquivo para o servidor ainda não tem endpoint dedicado —
       a Figura 21 documenta o campo, mas o armazenamento do logo é um
       próximo passo (precisa de uma coluna/tabela de mídia). */
    const logoInput = document.getElementById('hydroLogoInput');
    const logoPreview = document.getElementById('hydroLogoPreview');

    logoInput.addEventListener('change', () => {
        const file = logoInput.files && logoInput.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            showToast('Selecione um arquivo de imagem');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            showToast('A imagem deve ter até 2MB');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            logoPreview.innerHTML = `<img src="${reader.result}" alt="Logo da loja">`;
        };
        reader.readAsDataURL(file);
    });

    /* ================= Carregar dados atuais da loja ================= */
    function fillForm(loja) {
        document.getElementById('hydroNomeLoja').value = loja.nome_loja || '';
        document.getElementById('hydroCnpj').value = loja.cnpj || '';
        document.getElementById('hydroTelefone').value = loja.telefone || '';
        document.getElementById('hydroCep').value = loja.cep || '';
        document.getElementById('hydroEndereco').value = loja.endereco || '';
        document.getElementById('hydroCidade').value = loja.cidade || '';
        document.getElementById('hydroEstado').value = loja.estado || 'SP';
    }

    let lojaAtual = null;

    /* ================= Salvar / cancelar ================= */
    const savedLabel = document.getElementById('hydroSettingsSaved');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const nome_loja = document.getElementById('hydroNomeLoja').value.trim();
        if (!nome_loja) {
            showToast('Informe o nome da loja');
            return;
        }

        const btn = document.getElementById('hydroBtnSalvar');
        btn.disabled = true;

        try {
            const { loja } = await window.hydraApi('/loja', {
                method: 'PUT',
                body: {
                    nome_loja,
                    cnpj: document.getElementById('hydroCnpj').value.trim(),
                    telefone: document.getElementById('hydroTelefone').value.trim(),
                    cep: document.getElementById('hydroCep').value.trim(),
                    endereco: document.getElementById('hydroEndereco').value.trim(),
                    cidade: document.getElementById('hydroCidade').value.trim(),
                    estado: document.getElementById('hydroEstado').value,
                },
            });
            lojaAtual = loja;

            savedLabel.textContent = 'Alterações salvas';
            savedLabel.classList.add('hydro-show');
            clearTimeout(savedLabel._timer);
            savedLabel._timer = setTimeout(() => savedLabel.classList.remove('hydro-show'), 3000);
            showToast('Configurações da loja atualizadas com sucesso');
        } catch (err) {
            showToast(err.message);
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('hydroBtnCancelar').addEventListener('click', () => {
        if (lojaAtual) fillForm(lojaAtual);
        showToast('Alterações descartadas');
    });

    /* ================= Sidebar nav (cosmético, demo de página única) ================= */
    document.querySelectorAll('.hydro-menu a[data-view]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            if (link.dataset.view === 'sair') {
                window.hydraApi('/auth/logout', { method: 'POST' }).finally(() => {
                    window.location.href = 'login.html';
                });
                return;
            }
            document.querySelectorAll('.hydro-menu a').forEach((a) => a.classList.remove('hydro-active'));
            link.classList.add('hydro-active');
            closeSidebar();
            if (link.dataset.view !== 'configuracoes') {
                showToast('Esta é uma demonstração — apenas as telas de Estoque, Equipe e Configurações estão implementadas');
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
    (async function init() {
        try {
            const { usuario } = await window.hydraApi('/auth/me');
            if (usuario.perfil !== 'administrador') {
                window.location.href = 'controle-estoque.html';
                return;
            }
        } catch (err) {
            window.location.href = 'login.html';
            return;
        }

        try {
            const { loja } = await window.hydraApi('/loja');
            lojaAtual = loja;
            fillForm(loja);
        } catch (err) {
            showToast(err.message);
        }
    })();
})();
