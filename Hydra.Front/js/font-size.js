(function () {
    'use strict';

    const storageKey = 'fontSize';
    const defaultSize = 16;
    const minimumSize = 12;
    const maximumSize = 22;
    const root = document.documentElement;

    let size = parseFloat(localStorage.getItem(storageKey)) || defaultSize;
    // O zoom não muda a largura que as media queries enxergam: em 1,375× um
    // celular de 360px passava a caber só ~260px de layout e tudo estourava
    // para o lado. No celular o aumento máximo efetivo fica em 1,125×; o
    // valor escolhido continua salvo e volta inteiro em telas maiores.
    const celular = window.matchMedia('(max-width: 640px)');
    const maximumZoomCelular = 1.125;
    const applyVisualSize = () => {
        const zoomEscolhido = size / defaultSize;
        const zoom = String(celular.matches ? Math.min(zoomEscolhido, maximumZoomCelular) : zoomEscolhido);
        root.style.fontSize = `${size}px`;
        document.body.style.zoom = zoom;
        // O zoom também encolhe as alturas em "vh" (barra lateral, fundo da
        // página); os CSS das telas dividem por esta variável para compensar.
        root.style.setProperty('--hydra-zoom', zoom);
    };

    applyVisualSize();
    // Girar o tablet/celular ou redimensionar a janela recalcula o limite.
    if (celular.addEventListener) celular.addEventListener('change', applyVisualSize);

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
