(function () {
    'use strict';

    const form = document.getElementById('hydroSettingsForm');
    if (!form) return;

    /* ================= Toast ================= */
    let toastTimer = null;
    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        // Leitores de tela anunciam a confirmação/erro sem tirar o foco (QA 004).
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        toast.textContent = message;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 2600);
    }

    /* ================= Logo da loja =================
       Antes era só pré-visualização local e sumia ao recarregar (QA 006).
       Agora a imagem é reduzida aqui (até 256 px, para não pesar no banco)
       e vai como data URL no mesmo PUT /api/loja dos demais campos. */
    const logoInput = document.getElementById('hydroLogoInput');
    const logoPreview = document.getElementById('hydroLogoPreview');
    const logoPreviewOriginal = logoPreview.innerHTML;
    const LOGO_LADO_MAX = 256;
    // undefined = logo não mexida (o PUT não manda a chave); string = nova logo.
    let logoPendente;

    function mostrarLogo(dataUrl) {
        if (dataUrl) {
            logoPreview.innerHTML = '';
            const img = document.createElement('img');
            img.src = dataUrl;
            img.alt = 'Logo da loja';
            logoPreview.appendChild(img);
        } else {
            logoPreview.innerHTML = logoPreviewOriginal;
        }
    }

    function reduzirImagem(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const escala = Math.min(1, LOGO_LADO_MAX / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * escala));
                canvas.height = Math.max(1, Math.round(img.height * escala));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                // PNG preserva transparência, comum em logos.
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('Não foi possível ler a imagem'));
            img.src = dataUrl;
        });
    }

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
        reader.onload = async () => {
            try {
                logoPendente = await reduzirImagem(reader.result);
                mostrarLogo(logoPendente);
                showToast('Logo selecionada. Clique em "Salvar alterações" para gravar.');
            } catch (err) {
                showToast(err.message);
            }
        };
        reader.readAsDataURL(file);
    });

    /* ================= Máscaras e validação (QA 005) =================
       Mesmas regras de Hydra\Support\Validacao no back-end, que é quem
       decide; aqui é para o usuário ver o erro no campo antes de enviar. */
    const cnpjInput = document.getElementById('hydroCnpj');
    const telefoneInput = document.getElementById('hydroTelefone');
    const cepInput = document.getElementById('hydroCep');

    // CNPJ alfanumérico (2026): 12 posições 0-9/A-Z + 2 dígitos verificadores.
    function mascaraCnpj(v) {
        const c = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14);
        return c
            .replace(/^(.{2})(.)/, '$1.$2')
            .replace(/^(.{2})\.(.{3})(.)/, '$1.$2.$3')
            .replace(/^(.{2})\.(.{3})\.(.{3})(.)/, '$1.$2.$3/$4')
            .replace(/^(.{2})\.(.{3})\.(.{3})\/(.{4})(.)/, '$1.$2.$3/$4-$5');
    }
    function mascaraTelefone(v) {
        const d = String(v || '').replace(/\D/g, '').slice(0, 11);
        if (d.length <= 2) return d ? `(${d}` : '';
        if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
        if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
        return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    }
    function mascaraCep(v) {
        const d = String(v || '').replace(/\D/g, '').slice(0, 8);
        return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
    }

    function cnpjValido(v) {
        const c = String(v).toUpperCase().replace(/[^0-9A-Z]/g, '');
        if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
        const val = [...c].map((ch) => ch.charCodeAt(0) - 48);
        const dv = (n) => {
            const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
            const resto = pesos.reduce((soma, p, i) => soma + val[i] * p, 0) % 11;
            return resto < 2 ? 0 : 11 - resto;
        };
        return dv(12) === val[12] && dv(13) === val[13];
    }
    const telefoneValido = (v) => /^[1-9][1-9](?:[2-8]\d{7}|9\d{8})$/.test(String(v).replace(/\D/g, ''));
    const cepValido = (v) => String(v).replace(/\D/g, '').length === 8;

    [[cnpjInput, mascaraCnpj], [telefoneInput, mascaraTelefone], [cepInput, mascaraCep]].forEach(([input, mascara]) => {
        input.addEventListener('input', () => {
            input.value = mascara(input.value);
            limparErroCampo(input);
        });
    });

    function limparErroCampo(input) {
        input.removeAttribute('aria-invalid');
        input.style.borderColor = '';
        const msg = document.getElementById(input.id + 'Erro');
        if (msg) msg.remove();
    }
    function marcarErroCampo(input, mensagem) {
        limparErroCampo(input);
        input.setAttribute('aria-invalid', 'true');
        input.style.borderColor = '#d93636';
        const msg = document.createElement('small');
        msg.id = input.id + 'Erro';
        msg.style.cssText = 'display:block;color:#d93636;margin-top:4px;font-size:12px;';
        msg.textContent = mensagem;
        input.setAttribute('aria-describedby', msg.id);
        input.insertAdjacentElement('afterend', msg);
    }

    const CAMPO_API_PARA_INPUT = {
        nome_loja: 'hydroNomeLoja',
        cnpj: 'hydroCnpj',
        telefone: 'hydroTelefone',
        cep: 'hydroCep',
        estado: 'hydroEstado',
        logo: 'hydroLogoInput',
    };

    /* ================= Carregar dados atuais da loja ================= */
    function fillForm(loja) {
        document.getElementById('hydroNomeLoja').value = loja.nome_loja || '';
        cnpjInput.value = mascaraCnpj(loja.cnpj);
        telefoneInput.value = mascaraTelefone(loja.telefone);
        cepInput.value = mascaraCep(loja.cep);
        document.getElementById('hydroEndereco').value = loja.endereco || '';
        document.getElementById('hydroCidade').value = loja.cidade || '';
        document.getElementById('hydroEstado').value = loja.estado || '';
        logoPendente = undefined;
        mostrarLogo(loja.logo || null);
        [cnpjInput, telefoneInput, cepInput].forEach(limparErroCampo);
    }

    let lojaAtual = null;

    /* ================= Salvar / cancelar ================= */
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const nomeInput = document.getElementById('hydroNomeLoja');
        const nome_loja = nomeInput.value.trim();
        const erros = [];
        if (!nome_loja) erros.push([nomeInput, 'Informe o nome da loja']);
        if (cnpjInput.value.trim() && !cnpjValido(cnpjInput.value)) {
            erros.push([cnpjInput, 'CNPJ inválido. Confira os 14 caracteres e os dígitos verificadores.']);
        }
        if (telefoneInput.value.trim() && !telefoneValido(telefoneInput.value)) {
            erros.push([telefoneInput, 'Telefone inválido. Use DDD + número, ex.: (11) 99999-8888.']);
        }
        if (cepInput.value.trim() && !cepValido(cepInput.value)) {
            erros.push([cepInput, 'CEP inválido. Use 8 números, ex.: 01310-100.']);
        }
        [nomeInput, cnpjInput, telefoneInput, cepInput].forEach(limparErroCampo);
        if (erros.length) {
            erros.forEach(([input, msg]) => marcarErroCampo(input, msg));
            erros[0][0].focus();
            showToast(erros[0][1]);
            return;
        }

        const btn = document.getElementById('hydroBtnSalvar');
        btn.disabled = true;

        try {
            const { loja } = await window.hydraApi('/loja', {
                method: 'PUT',
                body: {
                    nome_loja,
                    cnpj: cnpjInput.value.trim(),
                    telefone: telefoneInput.value.trim(),
                    cep: cepInput.value.trim(),
                    endereco: document.getElementById('hydroEndereco').value.trim(),
                    cidade: document.getElementById('hydroCidade').value.trim(),
                    estado: document.getElementById('hydroEstado').value,
                    // Só manda a chave quando a logo mudou: o back-end trata
                    // ausência como "não mexer".
                    ...(logoPendente !== undefined ? { logo: logoPendente } : {}),
                },
            });
            lojaAtual = loja;
            fillForm(loja);

            // Uma confirmação só. Antes apareciam "Alterações salvas" no
            // rodapé E o toast, discretos e redundantes (QA 004).
            showToast('Configurações da loja salvas com sucesso');
        } catch (err) {
            const input = document.getElementById(CAMPO_API_PARA_INPUT[err.data && err.data.campo]);
            if (input && input.type !== 'file') {
                marcarErroCampo(input, err.message);
                input.focus();
            }
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
        if (!window.hydraApi) return;
        try {
            const { usuario } = await window.hydraSessao();
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            window.hydraAplicarMenuPorPermissao(usuario);
            // Mesma permissao que a API exige em GET /api/loja.
            if (!window.hydraGuardaDeTela(usuario, ['loja.configurar'])) return;
        } catch (err) {
            // Visitante não autenticado (demo pública): mantém a tela estática, sem carregar dados reais.
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
