(function () {
    'use strict';

    window.HYDRA_PUBLIC_DEMO = true;

    var pageByView = {
        dashboard: 'dashboard.html',
        caixa: 'caixa.html',
        vendas: 'caixa.html',
        produtos: 'produtos.html',
        estoque: 'controle-estoque.html',
        financeiro: 'dashboard.html',
        equipe: 'gerenciar-usuarios.html',
        configuracoes: 'configuracoes-loja.html',
    };

    function createModal() {
        var modal = document.createElement('div');
        modal.className = 'hydra-demo-modal';
        modal.setAttribute('aria-hidden', 'true');
        modal.innerHTML = '<div class="hydra-demo-modal__backdrop" data-demo-close></div>' +
            '<section class="hydra-demo-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="hydra-demo-title">' +
            '<button class="hydra-demo-modal__close" type="button" aria-label="Fechar" data-demo-close>&times;</button>' +
            '<span class="hydra-demo-modal__eyebrow">Experimente o Hydra</span>' +
            '<h2 id="hydra-demo-title">Crie sua conta para continuar</h2>' +
            '<p>Você pode conhecer todas as telas gratuitamente. Para salvar alterações, registrar vendas ou cadastrar informações, faça seu cadastro.</p>' +
            '<div class="hydra-demo-modal__actions">' +
            '<button class="hydra-demo-modal__secondary" type="button" data-demo-close>Continuar vendo</button>' +
            '<a class="hydra-demo-modal__primary" href="cadastro.html">Criar cadastro</a>' +
            '</div></section>';
        document.body.appendChild(modal);
        modal.addEventListener('click', function (event) {
            if (event.target.closest('[data-demo-close]')) closeModal();
        });
        return modal;
    }

    var modal;
    function openModal() {
        modal = modal || createModal();
        modal.classList.add('is-visible');
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('hydra-demo-modal-open');
    }

    function closeModal() {
        if (!modal) return;
        modal.classList.remove('is-visible');
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('hydra-demo-modal-open');
    }

    document.addEventListener('click', function (event) {
        var link = event.target.closest('a[data-view]');
        if (link && link.dataset.view === 'sair') {
            event.preventDefault();
            event.stopImmediatePropagation();
            openModal();
            return;
        }

        if (link && link.getAttribute('href') === '#' && pageByView[link.dataset.view]) {
            event.preventDefault();
            event.stopImmediatePropagation();
            window.location.href = pageByView[link.dataset.view];
            return;
        }

        var button = event.target.closest('button');
        if (button && !button.closest('.hydra-demo-modal__dialog')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            openModal();
        }
    }, true);

    document.addEventListener('submit', function (event) {
        if (event.target.id === 'login-form' || event.target.id === 'signup-form') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openModal();
    }, true);

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closeModal();
    });
})();
