(function () {
    'use strict';

    const PERFIL_LABEL = {
        administrador: 'Administrador',
        operador_caixa: 'Operador de Caixa',
        estoquista: 'Estoquista',
    };
    const STATUS_LABEL = { ativo: 'Ativo', inativo: 'Inativo' };

    let lojaAtual = null;
    let users = [];

    /* ================= State ================= */
    const state = {
        search: '',
        perfil: '',
        status: '',
        page: 1,
        pageSize: 5,
    };

    /* ================= Helpers ================= */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function initials(name) {
        const parts = name.trim().split(/\s+/);
        const first = parts[0]?.[0] || '';
        const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
        return (first + last).toUpperCase();
    }

    function formatDate(datetime) {
        const [ymd] = datetime.split(' ');
        const [y, m, d] = ymd.split('-');
        return `${d}/${m}/${y}`;
    }

    function statusBadgeClass(status) {
        return status === 'ativo' ? 'hydro-badge-ok' : 'hydro-badge-neutral';
    }

    function perfilBadgeClass(perfil) {
        if (perfil === 'administrador') return 'hydro-badge-critical';
        if (perfil === 'operador_caixa') return 'hydro-badge-low';
        return 'hydro-badge-ok';
    }

    function getFilteredUsers() {
        return users.filter((u) => {
            const matchesSearch =
                !state.search ||
                u.nome.toLowerCase().includes(state.search) ||
                u.email.toLowerCase().includes(state.search);
            const matchesPerfil = !state.perfil || u.perfil === state.perfil;
            const matchesStatus = !state.status || u.status === state.status;
            return matchesSearch && matchesPerfil && matchesStatus;
        });
    }

    /* ================= Rendering: stats ================= */
    function renderStats() {
        document.getElementById('hydroStatTotalUsers').textContent = users.length;
        document.getElementById('hydroStatCaixa').textContent = users.filter((u) => u.perfil === 'operador_caixa').length;
        document.getElementById('hydroStatEstoquista').textContent = users.filter((u) => u.perfil === 'estoquista').length;
    }

    /* ================= Rendering: table ================= */
    function renderTable() {
        const filtered = getFilteredUsers();
        const totalItems = filtered.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
        if (state.page > totalPages) state.page = totalPages;
        if (state.page < 1) state.page = 1;

        const start = (state.page - 1) * state.pageSize;
        const pageItems = filtered.slice(start, start + state.pageSize);

        const tbody = document.getElementById('hydroUserTableBody');
        const emptyState = document.getElementById('hydroUserEmptyState');

        if (pageItems.length === 0) {
            tbody.innerHTML = '';
            emptyState.classList.add('hydro-is-visible');
        } else {
            emptyState.classList.remove('hydro-is-visible');
            tbody.innerHTML = pageItems
                .map((u) => `
          <tr data-id="${u.id_usuario}">
            <td data-label="Usuário">
              <div class="hydro-user-cell">
                <div class="hydro-user-initials">${escapeHtml(initials(u.nome))}</div>
                <div>
                  <div class="hydro-user-name">${escapeHtml(u.nome)}</div>
                  <div class="hydro-user-email">${escapeHtml(u.email)}</div>
                </div>
              </div>
            </td>
            <td data-label="Perfil"><span class="hydro-badge ${perfilBadgeClass(u.perfil)}">${PERFIL_LABEL[u.perfil]}</span></td>
            <td data-label="Loja">${escapeHtml(lojaAtual ? lojaAtual.nome_loja : '')}</td>
            <td data-label="Status"><span class="hydro-badge ${statusBadgeClass(u.status)}">${STATUS_LABEL[u.status]}</span></td>
            <td data-label="Criado em">${formatDate(u.data_criacao)}</td>
            <td class="hydro-col-actions" data-label="Ações">
              <div class="hydro-row-actions">
                <button class="hydro-action-btn hydro-action-edit" title="Editar usuário" data-id="${u.id_usuario}"><i class="hydro-ic hydro-ic-pencil"></i></button>
                <button class="hydro-action-btn hydro-action-toggle" title="${u.status === 'ativo' ? 'Desativar usuário' : 'Ativar usuário'}" data-id="${u.id_usuario}"><i class="hydro-ic hydro-ic-power"></i></button>
                <button class="hydro-action-btn hydro-action-delete" title="Excluir usuário" data-id="${u.id_usuario}"><i class="hydro-ic hydro-ic-trash"></i></button>
              </div>
            </td>
          </tr>`)
                .join('');
        }

        renderFooter(totalItems, start, pageItems.length, totalPages);
        bindRowActions();
    }

    function renderFooter(totalItems, start, shownCount, totalPages) {
        const footerCount = document.getElementById('hydroUserFooterCount');
        footerCount.textContent = totalItems === 0
            ? 'Mostrando 0 a 0 de 0 usuários'
            : `Mostrando ${start + 1} a ${start + shownCount} de ${totalItems} usuários`;

        const pagination = document.getElementById('hydroUserPagination');
        const pages = buildPageList(state.page, totalPages);

        let html = `<button class="hydro-page-btn" id="hydroUserPagePrev" ${state.page === 1 ? 'disabled' : ''} aria-label="Página anterior"><i class="hydro-ic hydro-ic-chevron-left"></i></button>`;
        pages.forEach((item) => {
            if (item === '...') {
                html += `<span class="hydro-page-ellipsis">…</span>`;
            } else {
                html += `<button class="hydro-page-btn ${item === state.page ? 'hydro-active' : ''}" data-page="${item}">${item}</button>`;
            }
        });
        html += `<button class="hydro-page-btn" id="hydroUserPageNext" ${state.page === totalPages ? 'disabled' : ''} aria-label="Próxima página"><i class="hydro-ic hydro-ic-chevron-right"></i></button>`;

        pagination.innerHTML = html;

        pagination.querySelectorAll('[data-page]').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.page = Number(btn.dataset.page);
                renderTable();
            });
        });
        const prevBtn = document.getElementById('hydroUserPagePrev');
        const nextBtn = document.getElementById('hydroUserPageNext');
        if (prevBtn) prevBtn.addEventListener('click', () => { state.page--; renderTable(); });
        if (nextBtn) nextBtn.addEventListener('click', () => { state.page++; renderTable(); });
    }

    function buildPageList(current, total) {
        if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
        const pages = [1];
        if (current > 3) pages.push('...');
        const start = Math.max(2, current - 1);
        const end = Math.min(total - 1, current + 1);
        for (let i = start; i <= end; i++) pages.push(i);
        if (current < total - 2) pages.push('...');
        pages.push(total);
        return pages;
    }

    /* ================= Row actions ================= */
    function bindRowActions() {
        document.querySelectorAll('.hydro-action-edit').forEach((btn) =>
            btn.addEventListener('click', () => openEditModal(Number(btn.dataset.id)))
        );
        document.querySelectorAll('.hydro-action-toggle').forEach((btn) =>
            btn.addEventListener('click', () => toggleStatus(Number(btn.dataset.id)))
        );
        document.querySelectorAll('.hydro-action-delete').forEach((btn) =>
            btn.addEventListener('click', () => openDeleteModal(Number(btn.dataset.id)))
        );
    }

    async function toggleStatus(id) {
        const u = users.find((x) => x.id_usuario === id);
        if (!u) return;
        const novoStatus = u.status === 'ativo' ? 'inativo' : 'ativo';
        try {
            const { usuario } = await window.hydraApi(`/usuarios/${id}`, {
                method: 'PUT',
                body: { nome: u.nome, email: u.email, perfil: u.perfil, status: novoStatus },
            });
            Object.assign(u, usuario);
            renderStats();
            renderTable();
            showToast(novoStatus === 'ativo' ? `"${u.nome}" foi ativado` : `"${u.nome}" foi desativado`);
        } catch (err) {
            showToast(err.message);
        }
    }

    /* ================= Modal engine ================= */
    const modalOverlay = document.getElementById('hydroModalOverlay');
    const modalTitle = document.getElementById('hydroModalTitle');
    const modalBody = document.getElementById('hydroModalBody');
    const modalFooter = document.getElementById('hydroModalFooter');

    function openModal({ title, bodyHtml, footerHtml, onMount }) {
        modalTitle.textContent = title;
        modalBody.innerHTML = bodyHtml;
        modalFooter.innerHTML = footerHtml;
        modalOverlay.classList.add('hydro-show');
        if (onMount) onMount();
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

    /* ---- Novo usuário ---- */
    function openCreateModal() {
        openModal({
            title: 'Novo usuário',
            bodyHtml: `
        <div class="hydro-modal-info">
          <i class="hydro-ic hydro-ic-inventory"></i>
          <span>Este usuário será vinculado automaticamente à loja <strong>${escapeHtml(lojaAtual ? lojaAtual.nome_loja : '')}</strong>, a mesma do administrador logado.</span>
        </div>
        <div class="hydro-form-group">
          <label for="hydroNewName">Nome</label>
          <input type="text" id="hydroNewName" placeholder="Nome completo">
        </div>
        <div class="hydro-form-group">
          <label for="hydroNewEmail">E-mail</label>
          <input type="email" id="hydroNewEmail" placeholder="nome@exemplo.com">
        </div>
        <div class="hydro-form-group">
          <label for="hydroNewSenha">Senha inicial</label>
          <input type="password" id="hydroNewSenha" placeholder="Mínimo de 6 caracteres" minlength="6">
        </div>
        <div class="hydro-form-group">
          <label for="hydroNewPerfil">Perfil</label>
          <select id="hydroNewPerfil">
            <option value="operador_caixa">Operador de Caixa</option>
            <option value="estoquista">Estoquista</option>
          </select>
        </div>
      `,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-primary hydro-btn-sm" id="hydroModalSaveBtn">Cadastrar usuário</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalSaveBtn').addEventListener('click', async () => {
            const nome = document.getElementById('hydroNewName').value.trim();
            const email = document.getElementById('hydroNewEmail').value.trim();
            const senha = document.getElementById('hydroNewSenha').value;
            const perfil = document.getElementById('hydroNewPerfil').value;

            if (!nome || !email) {
                showToast('Preencha nome e e-mail');
                return;
            }
            if (senha.length < 6) {
                showToast('A senha deve ter pelo menos 6 caracteres');
                return;
            }

            try {
                const { usuario } = await window.hydraApi('/usuarios', {
                    method: 'POST',
                    body: { nome, email, senha, perfil },
                });
                users.push(usuario);
                closeModal();
                state.page = 1;
                renderStats();
                renderTable();
                showToast(`Usuário "${nome}" cadastrado com sucesso`);
            } catch (err) {
                showToast(err.message);
            }
        });
    }

    /* ---- Editar usuário ---- */
    function openEditModal(id) {
        const u = users.find((x) => x.id_usuario === id);
        if (!u) return;

        openModal({
            title: 'Editar usuário',
            bodyHtml: `
        <div class="hydro-form-group">
          <label for="hydroEditUserName">Nome</label>
          <input type="text" id="hydroEditUserName" value="${escapeHtml(u.nome)}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditUserEmail">E-mail</label>
          <input type="email" id="hydroEditUserEmail" value="${escapeHtml(u.email)}">
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditUserPerfil">Perfil</label>
          <select id="hydroEditUserPerfil">
            <option value="administrador" ${u.perfil === 'administrador' ? 'selected' : ''}>Administrador</option>
            <option value="operador_caixa" ${u.perfil === 'operador_caixa' ? 'selected' : ''}>Operador de Caixa</option>
            <option value="estoquista" ${u.perfil === 'estoquista' ? 'selected' : ''}>Estoquista</option>
          </select>
        </div>
        <div class="hydro-form-group">
          <label for="hydroEditUserStatus">Status</label>
          <select id="hydroEditUserStatus">
            <option value="ativo" ${u.status === 'ativo' ? 'selected' : ''}>Ativo</option>
            <option value="inativo" ${u.status === 'inativo' ? 'selected' : ''}>Inativo</option>
          </select>
        </div>
      `,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-primary hydro-btn-sm" id="hydroModalSaveBtn">Salvar alterações</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalSaveBtn').addEventListener('click', async () => {
            const nome = document.getElementById('hydroEditUserName').value.trim();
            const email = document.getElementById('hydroEditUserEmail').value.trim();
            const perfil = document.getElementById('hydroEditUserPerfil').value;
            const status = document.getElementById('hydroEditUserStatus').value;

            if (!nome || !email) {
                showToast('Preencha nome e e-mail');
                return;
            }

            try {
                const { usuario } = await window.hydraApi(`/usuarios/${id}`, {
                    method: 'PUT',
                    body: { nome, email, perfil, status },
                });
                Object.assign(u, usuario);
                closeModal();
                renderStats();
                renderTable();
                showToast('Usuário atualizado com sucesso');
            } catch (err) {
                showToast(err.message);
            }
        });
    }

    /* ---- Excluir usuário (RN21: exige confirmação prévia) ---- */
    function openDeleteModal(id) {
        const u = users.find((x) => x.id_usuario === id);
        if (!u) return;

        openModal({
            title: 'Confirmar exclusão',
            bodyHtml: `<p>Tem certeza de que deseja excluir o usuário <strong>${escapeHtml(u.nome)}</strong>? Essa ação não pode ser desfeita.</p>`,
            footerHtml: `
        <button class="hydro-btn hydro-btn-outline hydro-btn-sm" id="hydroModalCancelBtn">Cancelar</button>
        <button class="hydro-btn hydro-btn-danger hydro-btn-sm" id="hydroModalConfirmBtn">Excluir</button>
      `,
        });

        document.getElementById('hydroModalCancelBtn').addEventListener('click', closeModal);
        document.getElementById('hydroModalConfirmBtn').addEventListener('click', async () => {
            try {
                await window.hydraApi(`/usuarios/${id}`, { method: 'DELETE' });
                users = users.filter((x) => x.id_usuario !== id);
                closeModal();
                renderStats();
                renderTable();
                showToast(`Usuário "${u.nome}" removido`);
            } catch (err) {
                closeModal();
                showToast(err.message);
            }
        });
    }

    /* ================= Toast ================= */
    let toastTimer = null;
    function showToast(message) {
        const toast = document.getElementById('hydroToast');
        toast.textContent = message;
        toast.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('hydro-show'), 2600);
    }

    /* ================= Wiring ================= */
    document.getElementById('hydroUserSearchInput').addEventListener('input', (e) => {
        state.search = e.target.value.trim().toLowerCase();
        state.page = 1;
        renderTable();
    });

    document.getElementById('hydroFilterPerfil').addEventListener('change', (e) => {
        state.perfil = e.target.value;
        state.page = 1;
        renderTable();
    });

    document.getElementById('hydroFilterStatusUser').addEventListener('change', (e) => {
        state.status = e.target.value;
        state.page = 1;
        renderTable();
    });

    document.getElementById('hydroBtnNovoUsuario').addEventListener('click', openCreateModal);

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
            if (link.dataset.view !== 'equipe') {
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
            const [lojaRes, usersRes] = await Promise.all([
                window.hydraApi('/loja'),
                window.hydraApi('/usuarios'),
            ]);
            lojaAtual = lojaRes.loja;
            users = usersRes.usuarios;
            renderStats();
            renderTable();
        } catch (err) {
            showToast(err.message);
        }
    })();
})();
