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
