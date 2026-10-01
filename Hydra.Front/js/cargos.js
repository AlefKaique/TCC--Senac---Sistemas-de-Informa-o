(function () {
    'use strict';

    // Paleta inspirada nas cores de cargo do Discord.
    const SWATCHES = [
        '#1ABC9C', '#2ECC71', '#3498DB', '#9B59B6', '#E91E63',
        '#F1C40F', '#E67E22', '#E74C3C', '#95A5A6', '#607D8B',
        '#11806A', '#206694', '#71368A', '#AD1457', '#5865F2',
    ];

    let cargos = [];
    let catalogo = []; // [{codigo,nome,descricao,categoria}]
    let selectedId = null; // id_cargo (number) ou 'new'
    let original = null;   // snapshot do cargo carregado {nome,descricao,cor,permissoes:Set}
    let draft = null;      // estado em edição, mesmo formato

    /* ================= Helpers ================= */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : str;
        return div.innerHTML;
    }

    function randomSwatch() {
        return SWATCHES[Math.floor(Math.random() * SWATCHES.length)];
    }

    let toastTimer = null;
    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        toast.textContent = message;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 2600);
    }

    /* ================= Modal engine (igual às demais telas) ================= */
    const modalOverlay = document.getElementById('hydroModalOverlay');
    const modalTitle = document.getElementById('hydroModalTitle');
    const modalBody = document.getElementById('hydroModalBody');
    const modalFooter = document.getElementById('hydroModalFooter');

    function openModal({ title, bodyHtml, footerHtml }) {
        modalTitle.textContent = title;
        modalBody.innerHTML = bodyHtml;
        modalFooter.innerHTML = footerHtml;
        modalOverlay.classList.add('hydro-show');
    }

    function closeModal() {
        modalOverlay.classList.remove('hydro-show');
    }

    document.getElementById('hydroModalClose').addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    /* ================= Catálogo de permissões agrupado por categoria ================= */
    function groupCatalogo() {
        const map = new Map();
        catalogo.forEach((p) => {
            if (!map.has(p.categoria)) map.set(p.categoria, []);
            map.get(p.categoria).push(p);
        });
        return map;
    }

    /* ================= Renderização: lista de cargos ================= */
    function renderList() {
        const list = document.getElementById('hydroCargoList');
        document.getElementById('hydroCargoCount').textContent = cargos.length;

        list.innerHTML = cargos
            .map((c) => `
        <li>
          <button type="button" class="hydro-cargo-list-item ${selectedId === c.id_cargo ? 'hydro-active' : ''}" data-id="${c.id_cargo}">
            <span class="hydro-cargo-dot" style="background:${c.cor}"></span>
            <span class="hydro-cargo-list-item-name">${escapeHtml(c.nome)}</span>
            ${c.cargo_sistema ? '<i class="hydro-ic hydro-ic-lock" title="Cargo de sistema"></i>' : ''}
            <span class="hydro-cargo-list-item-count" title="Usuários neste cargo">${c.qtd_usuarios}</span>
          </button>
        </li>`)
            .join('');

        list.querySelectorAll('[data-id]').forEach((btn) => {
            btn.addEventListener('click', () => selectCargo(Number(btn.dataset.id)));
        });
    }

    /* ================= Renderização: editor ================= */
    function showEmptyState() {
        document.getElementById('hydroCargoEmpty').hidden = false;
        document.getElementById('hydroCargoForm').hidden = true;
        document.getElementById('hydroCargoSavebar').classList.remove('hydro-show');
    }

    function updatePreviewDot() {
        document.getElementById('hydroCargoPreviewDot').style.background = draft.cor;
        document.getElementById('hydroCargoCorInput').value = draft.cor;
    }

    function renderSwatches() {
        const wrap = document.getElementById('hydroCargoSwatches');
        wrap.innerHTML = SWATCHES
            .map((hex) => `<button type="button" class="hydro-cargo-swatch ${hex.toUpperCase() === draft.cor.toUpperCase() ? 'hydro-is-selected' : ''}" style="background:${hex}" data-color="${hex}" title="${hex}" aria-label="Cor ${hex}"></button>`)
            .join('');

        wrap.querySelectorAll('[data-color]').forEach((btn) => {
            btn.addEventListener('click', () => {
                draft.cor = btn.dataset.color;
                updatePreviewDot();
                renderSwatches();
                checkDirty();
            });
        });
    }

    /* ================= Abas do editor ================= */
    function selectTab(name) {
        document.querySelectorAll('.hydro-cargo-tab').forEach((tab) => {
            const active = tab.dataset.tab === name;
            tab.classList.toggle('hydro-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.hydro-cargo-tabpanel').forEach((panel) => {
            panel.hidden = panel.dataset.panel !== name;
        });
    }

    document.querySelectorAll('.hydro-cargo-tab').forEach((tab) => {
        tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    });

    /* Mostra "marcadas/total" na aba Permissoes, para dar noção do alcance
       do cargo sem precisar abrir a aba. */
    function updatePermCount() {
        document.getElementById('hydroCargoPermCount').textContent =
            `${draft ? draft.permissoes.size : 0}/${catalogo.length}`;
    }

    function renderPermGroups() {
        const container = document.getElementById('hydroCargoPermGroups');
        const groups = groupCatalogo();
        let html = '';
        groups.forEach((permissoesDoGrupo, categoria) => {
            html += `<div class="hydro-cargo-perm-group"><p class="hydro-cargo-perm-group-title">${escapeHtml(categoria)}</p>`;
            permissoesDoGrupo.forEach((p) => {
                const checked = draft.permissoes.has(p.codigo) ? 'checked' : '';
                html += `
          <label class="hydro-cargo-perm-row">
            <span class="hydro-cargo-perm-copy">
              <strong>${escapeHtml(p.nome)}</strong>
              <span>${escapeHtml(p.descricao || '')}</span>
            </span>
            <input type="checkbox" class="hydro-cargo-checkbox" data-codigo="${escapeHtml(p.codigo)}" ${checked}>
          </label>`;
            });
            html += '</div>';
        });
        container.innerHTML = html;

        container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', () => {
                if (cb.checked) draft.permissoes.add(cb.dataset.codigo);
                else draft.permissoes.delete(cb.dataset.codigo);
                updatePermCount();
                checkDirty();
            });
        });
    }

    /* O cabecalho repete o nome do cargo porque o campo de texto vive na
       aba "Dados": sem isso, quem esta na aba de permissoes perde a
       referencia de qual cargo esta editando. */
    function updateHeadName() {
        const nome = (draft && draft.nome.trim()) || '';
        document.getElementById('hydroCargoHeadName').textContent =
            nome || (selectedId === 'new' ? 'Novo cargo' : 'Sem nome');
    }

    function showEditor(cargo) {
        document.getElementById('hydroCargoEmpty').hidden = true;
        document.getElementById('hydroCargoForm').hidden = false;

        const isSystem = !!(cargo && cargo.cargo_sistema);
        const nomeInput = document.getElementById('hydroCargoNome');
        nomeInput.value = draft.nome;
        nomeInput.disabled = isSystem;
        document.getElementById('hydroCargoDescricao').value = draft.descricao;
        document.getElementById('hydroCargoSystemTag').hidden = !isSystem;

        updateHeadName();
        updatePreviewDot();
        renderSwatches();
        renderPermGroups();
        updatePermCount();

        // Cargos de sistema e cargos ainda nao criados nao podem ser excluidos.
        document.getElementById('hydroCargoDangerZone').hidden = isSystem || selectedId === 'new';

        // Trocar de cargo sempre volta para a primeira aba.
        selectTab('dados');
    }

    /* ================= Estado "sujo" (alterações não salvas) ================= */
    function isDirty() {
        if (!draft) return false;
        if (selectedId === 'new') return true;
        if (!original) return false;
        if (draft.nome !== original.nome) return true;
        if (draft.descricao !== original.descricao) return true;
        if (draft.cor.toUpperCase() !== original.cor.toUpperCase()) return true;
        if (draft.permissoes.size !== original.permissoes.size) return true;
        for (const codigo of draft.permissoes) {
            if (!original.permissoes.has(codigo)) return true;
        }
        return false;
    }

    function checkDirty() {
        const dirty = isDirty();
        // A barra flutuante so avisa e permite descartar; salvar fica no
        // botao fixo do cabecalho do editor, sempre visivel.
        document.getElementById('hydroCargoSavebar').classList.toggle('hydro-show', dirty);
        document.getElementById('hydroCargoSaveBtn').disabled = !dirty;
    }

    /* ================= Seleção de cargo ================= */
    function applySelection(id) {
        const cargo = cargos.find((c) => c.id_cargo === id);
        if (!cargo) return;
        selectedId = id;
        original = {
            nome: cargo.nome,
            descricao: cargo.descricao || '',
            cor: cargo.cor,
            permissoes: new Set(cargo.permissoes),
        };
        draft = {
            nome: original.nome,
            descricao: original.descricao,
            cor: original.cor,
            permissoes: new Set(original.permissoes),
        };
        renderList();
        showEditor(cargo);
        checkDirty();
    }

    function selectCargo(id) {
        if (selectedId === id) return;
        if (isDirty() && !window.confirm('Você tem alterações não salvas neste cargo. Deseja descartá-las?')) {
            return;
        }
        applySelection(id);
    }

    function startCreate() {
        if (isDirty() && !window.confirm('Você tem alterações não salvas. Deseja descartá-las?')) {
            return;
        }
        selectedId = 'new';
        original = null;
        draft = { nome: '', descricao: '', cor: randomSwatch(), permissoes: new Set() };
        renderList();
        showEditor(null);
        checkDirty();
        document.getElementById('hydroCargoNome').focus();
    }

    /* ================= Salvar / Descartar ================= */
    async function handleSave() {
        const nome = document.getElementById('hydroCargoNome').value.trim();
        const descricao = document.getElementById('hydroCargoDescricao').value.trim();
        if (!nome) {
            showToast('Informe o nome do cargo');
            return;
        }

        draft.nome = nome;
        draft.descricao = descricao;

        const payload = {
            nome,
            descricao,
            cor: draft.cor,
            permissoes: Array.from(draft.permissoes),
        };

        try {
            let cargoSalvo;
            if (selectedId === 'new') {
                const { cargo } = await window.hydraApi('/cargos', { method: 'POST', body: payload });
                cargos.push(cargo);
                cargoSalvo = cargo;
                showToast(`Cargo "${cargo.nome}" criado`);
            } else {
                const { cargo } = await window.hydraApi(`/cargos/${selectedId}`, { method: 'PUT', body: payload });
                const idx = cargos.findIndex((c) => c.id_cargo === selectedId);
                if (idx !== -1) cargos[idx] = cargo;
                cargoSalvo = cargo;
                showToast(`Cargo "${cargo.nome}" atualizado`);
            }
            applySelection(cargoSalvo.id_cargo);
        } catch (err) {
            showToast(err.message);
        }
    }

    function handleDiscard() {
        if (selectedId === 'new') {
            selectedId = null;
            original = null;
            draft = null;
            if (cargos.length) {
                applySelection(cargos[0].id_cargo);
            } else {
                renderList();
                showEmptyState();
            }
            return;
        }
        applySelection(selectedId);
    }

    /* ================= Excluir cargo ================= */
    function openDeleteModal() {
        const cargo = cargos.find((c) => c.id_cargo === selectedId);
        if (!cargo) return;

        openModal({
            title: 'Excluir cargo',
            bodyHtml: `<p>Tem certeza de que deseja excluir o cargo <strong>${escapeHtml(cargo.nome)}</strong>? Essa ação não pode ser desfeita.</p>`,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-danger hydro-btn-sm" id="hydroModalConfirmBtn">Excluir</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalConfirmBtn').addEventListener('click', async () => {
            try {
                await window.hydraApi(`/cargos/${cargo.id_cargo}`, { method: 'DELETE' });
                cargos = cargos.filter((c) => c.id_cargo !== cargo.id_cargo);
                closeModal();
                selectedId = null;
                original = null;
                draft = null;
                if (cargos.length) {
                    applySelection(cargos[0].id_cargo);
                } else {
                    renderList();
                    showEmptyState();
                }
                showToast(`Cargo "${cargo.nome}" removido`);
            } catch (err) {
                closeModal();
                showToast(err.message);
            }
        });
    }

    /* ================= Wiring ================= */
    document.getElementById('hydroCargoNome').addEventListener('input', (e) => {
        if (!draft) return;
        draft.nome = e.target.value;
        updateHeadName();
        checkDirty();
    });
    document.getElementById('hydroCargoDescricao').addEventListener('input', (e) => {
        if (!draft) return;
        draft.descricao = e.target.value;
        checkDirty();
    });
    document.getElementById('hydroCargoCorInput').addEventListener('input', (e) => {
        if (!draft) return;
        draft.cor = e.target.value;
        updatePreviewDot();
        renderSwatches();
        checkDirty();
    });

    document.getElementById('hydroBtnNovoCargo').addEventListener('click', startCreate);
    document.getElementById('hydroCargoSaveBtn').addEventListener('click', handleSave);
    document.getElementById('hydroCargoDiscardBtn').addEventListener('click', handleDiscard);
    document.getElementById('hydroCargoDeleteBtn').addEventListener('click', openDeleteModal);

    /* ================= Sidebar nav (cosmético) ================= */
    document.querySelectorAll('.hydro-menu a[data-view="sair"]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            window.hydraApi('/auth/logout', { method: 'POST' }).finally(() => {
                window.location.href = 'login.html';
            });
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
            const { usuario } = await window.hydraApi('/auth/me');
            const nameEl = document.getElementById('hydroUserName');
            if (nameEl) nameEl.textContent = (usuario.nome || '').split(' ')[0];
            const permissoesUsuario = usuario.permissoes || [];
            if (!permissoesUsuario.includes('cargos.visualizar')) {
                window.location.href = 'controle-estoque.html';
                return;
            }
        } catch (err) {
            // Visitante não autenticado (demo pública): mantém a tela estática, sem carregar dados reais.
            return;
        }

        try {
            const data = await window.hydraApi('/cargos');
            cargos = data.cargos;
            catalogo = data.permissoes;
            renderList();
            if (cargos.length) {
                applySelection(cargos[0].id_cargo);
            } else {
                showEmptyState();
            }
        } catch (err) {
            showToast(err.message);
        }
    })();
})();
