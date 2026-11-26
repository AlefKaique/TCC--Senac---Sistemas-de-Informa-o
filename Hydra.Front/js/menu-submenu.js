/**
 * Submenu recolhível da barra lateral ("Configurações": Dados da loja,
 * Filiais).
 *
 * Marcação (igual em todas as telas):
 *   <div class="hydro-submenu">
 *     <button type="button" class="hydro-submenu-toggle"
 *             aria-expanded="false" aria-controls="ID">...</button>
 *     <ul class="hydro-submenu-itens" id="ID" hidden>...</ul>
 *   </div>
 *
 * O <button> já responde a Enter e Espaço sozinho. Aqui só se alterna
 * aria-expanded e o "hidden" da lista. O grupo que contém a tela atual
 * (link com aria-current="page" ou .hydro-active) fica aberto: é assim
 * que o estado se mantém ao navegar.
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

    function iniciar() {
        document.querySelectorAll('.hydro-submenu-toggle[aria-controls]').forEach(ligar);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
