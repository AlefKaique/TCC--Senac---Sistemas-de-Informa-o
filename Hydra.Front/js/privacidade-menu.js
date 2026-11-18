/**
 * Item "Privacidade" da barra lateral, compartilhado por todas as telas
 * internas. Basta incluir, DEPOIS de api.js:
 *     <script src="../js/privacidade-menu.js"></script>
 * O CSS (css/privacidade-menu.css) é carregado por este próprio arquivo.
 *
 * O item fica logo acima do "Trocar Filial" e só aparece para o titular da
 * conta — quem cadastrou a loja e contratou o plano (GET /api/auth/me
 * devolve "titular": true). Funcionários criados na tela Equipe não veem o
 * item, nem com o cargo Administrador; se abrirem o endereço direto, a tela
 * os manda de volta e a API responde 403 (Auth::requireTitular).
 */
(function () {
    'use strict';

    const PAGINA = 'privacidade-conta.html';

    const ICONE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3z" stroke="currentColor" stroke-width="2"'
        + ' stroke-linejoin="round"/><rect x="9" y="11" width="6" height="5" rx="1" stroke="currentColor" stroke-width="2"/>'
        + '<path d="M10.5 11V9.5a1.5 1.5 0 0 1 3 0V11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

    // CSS ao lado deste arquivo: ../css/privacidade-menu.css a partir de js/.
    const scriptAtual = document.currentScript;
    if (scriptAtual && scriptAtual.src && !document.querySelector('link[data-hydra-privacidade]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/privacidade-menu.css', scriptAtual.src).href;
        link.setAttribute('data-hydra-privacidade', '');
        document.head.appendChild(link);
    }

    /* Cria o item escondido. A ordem com trocar-filial.js não importa: se o
       "Trocar Filial" já existe, este entra antes dele; se ainda não, entra
       antes do "Sair", e o trocar-filial.js põe o dele entre os dois. */
    function montar() {
        const existente = document.getElementById('hydraPrivacidadeMenuLink');
        if (existente) return existente.closest('li');

        const sair = document.querySelector('.hydro-menu a[data-view="sair"]');
        if (!sair) return null;

        const atual = window.location.pathname.endsWith('/' + PAGINA);
        const li = document.createElement('li');
        li.className = 'hydra-privacidade-item';
        li.hidden = true;
        // <a> sem data-view: várias telas tratam ".hydro-menu a[data-view]"
        // como troca de aba interna.
        li.innerHTML = `<a href="${PAGINA}" id="hydraPrivacidadeMenuLink" class="hydra-privacidade-link${atual ? ' hydro-active' : ''}"`
            + `${atual ? ' aria-current="page"' : ''}>${ICONE}<span>Privacidade</span></a>`;

        const filial = document.getElementById('hydraFilialMenuBtn');
        (filial ? filial.closest('li') : sair.closest('li')).before(li);
        return li;
    }

    async function iniciar() {
        const li = montar();
        if (!li || !window.hydraSessao) return;
        try {
            const resposta = await window.hydraSessao();
            li.hidden = !(resposta && resposta.usuario && resposta.usuario.titular === true);
        } catch (err) {
            // Visitante da demonstração ou sessão encerrada: continua escondido.
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
