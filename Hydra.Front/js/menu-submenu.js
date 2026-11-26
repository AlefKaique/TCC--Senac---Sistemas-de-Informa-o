/**
 * Submenus recolhíveis da barra lateral ("Configurações" e os subitens de
 * "Estoque", estes em ligarRecolhivel()).
 *
 * Marcação (igual nas telas e nos dois grupos):
 *   <div class="hydro-submenu">
 *     <button type="button" class="hydro-submenu-toggle"
 *             aria-expanded="false" aria-controls="ID">...</button>
 *     <ul class="hydro-submenu-itens" id="ID" hidden>...</ul>
 *   </div>
 *
 * O <button> já responde a Enter e Espaço sozinho. Aqui só se alterna
 * aria-expanded e o "hidden" da lista. O grupo que contém a tela atual
 * (link com aria-current="page" ou .hydro-active) fica aberto: é assim
 * que o estado se mantém ao navegar, como o "Configurações" já fazia.
 */
(function () {
    'use strict';

    function ligar(botao) {
        const lista = document.getElementById(botao.getAttribute('aria-controls'));
        if (!lista || botao.dataset.hydroSubmenuLigado) return;
        botao.dataset.hydroSubmenuLigado = '1';

        const definir = (aberto) => {
            botao.setAttribute('aria-expanded', String(aberto));
            lista.hidden = !aberto;
        };

        if (lista.querySelector('a[aria-current="page"], a.hydro-active')) definir(true);
        botao.addEventListener('click', () => definir(botao.getAttribute('aria-expanded') !== 'true'));
    }

    /**
     * Subitens que abrem pelo próprio link do item ("Estoque" → Entrada e
     * Saída de estoque): <ul data-hydro-recolhivel> dentro do <li> do link.
     * Clicar no link abre a tela e expande os subitens; clicar fora do grupo
     * os recolhe. Nas telas do grupo (link ou subitem ativo) começam abertos.
     */
    function ligarRecolhivel(lista) {
        const grupo = lista.closest('li');
        const link = grupo && grupo.querySelector(':scope > a');
        if (!link || lista.dataset.hydroSubmenuLigado) return;
        lista.dataset.hydroSubmenuLigado = '1';
        link.setAttribute('aria-controls', lista.id);

        const definir = (aberto) => {
            lista.hidden = !aberto;
            link.setAttribute('aria-expanded', String(aberto));
        };
        definir(Boolean(grupo.querySelector('a.hydro-active, a[aria-current="page"]')));

        link.addEventListener('click', () => definir(true));
        document.addEventListener('click', (e) => {
            if (!grupo.contains(e.target)) definir(false);
        });
    }

    function iniciar() {
        document.querySelectorAll('.hydro-submenu-toggle[aria-controls]').forEach(ligar);
        document.querySelectorAll('[data-hydro-recolhivel]').forEach(ligarRecolhivel);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
