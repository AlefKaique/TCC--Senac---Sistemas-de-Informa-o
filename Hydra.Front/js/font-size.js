(function () {
    'use strict';

    const storageKey = 'fontSize';
    const defaultSize = 16;
    const minimumSize = 12;
    const maximumSize = 22;
    const root = document.documentElement;

    let size = parseFloat(localStorage.getItem(storageKey)) || defaultSize;
    const applyVisualSize = () => {
        root.style.fontSize = `${size}px`;
        document.body.style.zoom = String(size / defaultSize);
    };

    applyVisualSize();

    function applySize(nextSize) {
        size = Math.min(maximumSize, Math.max(minimumSize, nextSize));
        applyVisualSize();
        localStorage.setItem(storageKey, size);
    }

    document.addEventListener('click', (event) => {
        const control = event.target.closest('[data-font-action]');
        if (!control) return;

        event.preventDefault();
        applySize(size + (control.dataset.fontAction === 'increase' ? 1 : -1));
    });

    /* Nas telas internas os botões A+/A− flutuavam no canto inferior direito
       e cobriam botões da própria tela (ex.: "Salvar alterações"). Quando há
       barra lateral, eles passam para a seção "Geral" dela, fora do conteúdo.
       Nas páginas sem barra lateral (página inicial) continuam flutuando. */
    function acomodarWidget() {
        const widget = document.querySelector('.accessibility-widget');
        if (!widget) return;

        const mais = widget.querySelector('[data-font-action="increase"]');
        const menos = widget.querySelector('[data-font-action="decrease"]');
        if (mais) mais.setAttribute('aria-label', 'Aumentar o tamanho da fonte');
        if (menos) menos.setAttribute('aria-label', 'Diminuir o tamanho da fonte');
        widget.setAttribute('role', 'group');
        widget.setAttribute('aria-label', 'Tamanho da fonte');

        const destino = document.querySelector('.hydro-sidebar .hydro-menu-bottom');
        if (!destino) return;

        const rotulo = document.createElement('span');
        rotulo.className = 'accessibility-widget__label';
        rotulo.textContent = 'Fonte';
        widget.prepend(rotulo);
        // Diminuir antes de aumentar, na ordem de leitura da linha.
        if (menos && mais) widget.insertBefore(menos, mais);
        widget.classList.add('accessibility-widget--sidebar');
        // Logo abaixo do título "Geral", acima de Trocar Filial e Sair.
        const titulo = destino.querySelector('.hydro-menu-label');
        if (titulo) titulo.after(widget);
        else destino.prepend(widget);
    }

    acomodarWidget();

    document.querySelectorAll('[data-font-toggle]').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const panel = document.getElementById(toggle.dataset.fontToggle);
            if (!panel) return;
            const isOpen = panel.hidden;
            panel.hidden = !isOpen;
            toggle.setAttribute('aria-expanded', String(isOpen));
        });
    });

})();
