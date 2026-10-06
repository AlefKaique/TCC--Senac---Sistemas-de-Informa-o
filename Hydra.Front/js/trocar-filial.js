/**
 * Componente "Trocar Filial", compartilhado por todas as telas internas.
 *
 * Basta incluir, DEPOIS de api.js:
 *     <script src="../js/trocar-filial.js"></script>
 * O CSS (css/trocar-filial.css) é carregado por este próprio arquivo.
 *
 * O que ele faz:
 *   - põe o botão "Trocar Filial" logo acima do "Sair" na barra lateral e o
 *     aviso "Filial: Centro" no topo da tela;
 *   - abre a janela de escolha, com as filiais de GET /api/filiais/minhas;
 *   - confirma com POST /api/filiais/trocar e recarrega a tela, que então
 *     busca os dados da nova filial.
 *
 * Quem decide o que cada usuário pode acessar é o back-end: esta tela só
 * lista o que a API devolve, e a API confere de novo na troca.
 *
 * Quando não há filial ativa (primeiro acesso de quem tem várias filiais e
 * nenhuma "última usada", ou filial desativada no meio do expediente) a
 * janela abre sozinha e não pode ser fechada sem escolher — no lugar de
 * "Cancelar" aparece "Sair do sistema". api.js também a abre quando uma
 * chamada responde 409 "filial_nao_selecionada".
 */
(function () {
    'use strict';

    const MSG_SEM_OUTRAS = 'Você não tem acesso a outras filiais. Solicite ao administrador.';

    const ICONE_LOJA = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M3 9l1.5-5h15L21 9M3 9h18M3 9v1a3 3 0 0 0 6 0V9m0 1a3 3 0 0 0 6 0V9m0 1a3 3 0 0 0 6 0V9M5 13v8h14v-8M10 21v-5h4v5"'
        + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    // CSS ao lado deste arquivo: ../css/trocar-filial.css a partir de js/.
    const scriptAtual = document.currentScript;
    if (scriptAtual && scriptAtual.src && !document.querySelector('link[data-hydra-filial]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/trocar-filial.css', scriptAtual.src).href;
        link.setAttribute('data-hydra-filial', '');
        document.head.appendChild(link);
    }

    const estado = {
        carregado: false,     // /filiais/minhas já respondeu com sucesso
        filiais: [],
        ativa: null,          // { id_filial, nome, ... } ou null
        selecionada: null,    // id_filial marcado na janela
        obrigatorio: false,   // sem filial ativa: não dá para fechar sem escolher
        aberta: false,
        carregando: false,
        enviando: false,
        focoAnterior: null,
    };

    let el = null; // elementos da janela, criados na primeira abertura

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    /** Mensagem amigável para cada tipo de falha da API. */
    function mensagemDeErro(err) {
        if (!err || err.status === undefined) {
            return 'Não foi possível falar com o servidor. Confira a internet e tente de novo.';
        }
        if (err.status === 401) return 'Sua sessão terminou. Entre no sistema de novo.';
        if (err.status === 403) return err.message || 'Você não tem acesso a esta filial. Solicite ao administrador.';
        return err.message || 'Não foi possível trocar de filial. Tente de novo.';
    }

    /** Busca as filiais do usuário. Registra no Console e relança qualquer falha. */
    async function carregarFiliais() {
        let resposta;
        try {
            resposta = await window.hydraApi('/filiais/minhas');
        } catch (err) {
            console.error(
                '[trocar-filial] GET /api/filiais/minhas falhou:',
                err && err.status !== undefined ? `HTTP ${err.status}` : 'sem resposta do servidor',
                '-',
                err && err.message
            );
            throw err;
        }
        estado.carregado = true;
        estado.filiais = resposta.filiais || [];
        estado.ativa = resposta.filial_ativa || null;
        atualizarChip();
    }

    /* ================= Botão na barra lateral e aviso no topo ================= */

    /* Cria o botão e o aviso do topo SEM depender da API: eles aparecem
       assim que a página monta, com "Filial: —" até /filiais/minhas
       responder. Se a API falhar, o botão continua lá e a janela mostra o
       erro ao ser aberta. */
    function montarControles() {
        const sair = document.querySelector('.hydro-menu a[data-view="sair"]');
        if (!sair) {
            console.warn('[trocar-filial] botão Sair não encontrado');
        } else if (!document.getElementById('hydraFilialMenuBtn')) {
            const li = document.createElement('li');
            // <button>, e não <a data-view>: várias telas tratam todo
            // ".hydro-menu a[data-view]" como item de navegação.
            li.innerHTML = `<button type="button" class="hydra-filial-menu-btn" id="hydraFilialMenuBtn">${ICONE_LOJA}<span>Trocar Filial</span></button>`;
            sair.closest('li').before(li);
            li.querySelector('button').addEventListener('click', () => abrir());
        }

        const acoes = document.querySelector('.hydro-topbar-actions');
        if (!acoes) {
            console.warn('[trocar-filial] topo da tela (.hydro-topbar-actions) não encontrado');
        } else if (!document.getElementById('hydraFilialChip')) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.id = 'hydraFilialChip';
            chip.className = 'hydra-filial-chip';
            chip.addEventListener('click', () => abrir());
            const usuario = acoes.querySelector('.hydro-user');
            if (usuario) acoes.insertBefore(chip, usuario);
            else acoes.appendChild(chip);
        }
        atualizarChip();
    }

    function atualizarChip() {
        const chip = document.getElementById('hydraFilialChip');
        if (!chip) return;
        // "—" enquanto a API não respondeu (ou se ela falhou); "escolha uma"
        // quando respondeu e não há filial ativa na sessão.
        const nome = estado.ativa ? estado.ativa.nome : (estado.carregado ? 'escolha uma' : '—');
        chip.classList.toggle('hydra-filial-chip-pendente', estado.carregado && !estado.ativa);
        chip.title = 'Trocar de filial';
        chip.setAttribute('aria-label', `Filial atual: ${nome}. Clique para trocar de filial.`);
        chip.innerHTML = `${ICONE_LOJA}<span class="hydra-filial-chip-rotulo">Filial:</span>`
            + `<span class="hydra-filial-chip-nome">${escapeHtml(nome)}</span>`;
    }

    /* ================= Janela ================= */

    function criarJanela() {
        const overlay = document.createElement('div');
        overlay.className = 'hydra-filial-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="hydra-filial-modal" role="dialog" aria-modal="true"
                 aria-labelledby="hydraFilialTitulo" aria-describedby="hydraFilialSubtitulo">
                <div class="hydra-filial-header">
                    <h2 id="hydraFilialTitulo">Trocar filial</h2>
                    <p id="hydraFilialSubtitulo">Escolha a filial em que você vai trabalhar.</p>
                </div>
                <div class="hydra-filial-body">
                    <p class="hydra-filial-carregando">Carregando filiais…</p>
                    <ul class="hydra-filial-lista" role="radiogroup" aria-labelledby="hydraFilialTitulo"></ul>
                    <p class="hydra-filial-aviso hydra-filial-aviso-info" hidden>${MSG_SEM_OUTRAS}</p>
                    <p class="hydra-filial-aviso hydra-filial-aviso-erro" role="alert" hidden></p>
                </div>
                <div class="hydra-filial-footer">
                    <button type="button" class="hydra-filial-btn hydra-filial-btn-secundario" data-acao="cancelar">Cancelar</button>
                    <button type="button" class="hydra-filial-btn hydra-filial-btn-primario" data-acao="confirmar">Confirmar troca</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        el = {
            overlay,
            modal: overlay.querySelector('.hydra-filial-modal'),
            titulo: overlay.querySelector('#hydraFilialTitulo'),
            subtitulo: overlay.querySelector('#hydraFilialSubtitulo'),
            carregando: overlay.querySelector('.hydra-filial-carregando'),
            lista: overlay.querySelector('.hydra-filial-lista'),
            info: overlay.querySelector('.hydra-filial-aviso-info'),
            erro: overlay.querySelector('.hydra-filial-aviso-erro'),
            cancelar: overlay.querySelector('[data-acao="cancelar"]'),
            confirmar: overlay.querySelector('[data-acao="confirmar"]'),
        };

        // Clique fora da caixa fecha (exceto quando a escolha é obrigatória).
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) fechar();
        });
        el.cancelar.addEventListener('click', () => {
            if (estado.obrigatorio) sairDoSistema();
            else fechar();
        });
        el.confirmar.addEventListener('click', confirmar);
        el.lista.addEventListener('click', (e) => {
            const opcao = e.target.closest('[data-id-filial]');
            if (opcao) selecionar(Number(opcao.dataset.idFilial));
        });
        overlay.addEventListener('keydown', tratarTeclado);
    }

    function tratarTeclado(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            fechar();
            return;
        }

        // Setas para cima/baixo mudam a filial marcada, como numa lista de opções.
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.target.closest('.hydra-filial-lista')) {
            e.preventDefault();
            const ids = estado.filiais.map((f) => Number(f.id_filial));
            const atual = ids.indexOf(estado.selecionada);
            const passo = e.key === 'ArrowDown' ? 1 : -1;
            const proximo = ids[(atual + passo + ids.length) % ids.length];
            if (proximo !== undefined) {
                selecionar(proximo);
                const botao = el.lista.querySelector(`[data-id-filial="${proximo}"]`);
                if (botao) botao.focus();
            }
            return;
        }

        // Mantém o Tab dentro da janela enquanto ela está aberta.
        if (e.key === 'Tab') {
            const focaveis = Array.from(el.modal.querySelectorAll('button:not([disabled])'))
                .filter((b) => b.offsetParent !== null);
            if (!focaveis.length) return;
            const primeiro = focaveis[0];
            const ultimo = focaveis[focaveis.length - 1];
            if (e.shiftKey && document.activeElement === primeiro) {
                e.preventDefault();
                ultimo.focus();
            } else if (!e.shiftKey && document.activeElement === ultimo) {
                e.preventDefault();
                primeiro.focus();
            }
        }
    }

    function mostrarErro(mensagem) {
        el.erro.textContent = mensagem || '';
        el.erro.hidden = !mensagem;
    }

    function renderizar() {
        const idAtiva = estado.ativa ? Number(estado.ativa.id_filial) : null;

        el.titulo.textContent = estado.obrigatorio ? 'Escolha a filial' : 'Trocar filial';
        el.subtitulo.textContent = estado.obrigatorio
            ? 'Antes de continuar, escolha em qual filial você vai trabalhar agora.'
            : 'Escolha a filial em que você vai trabalhar. A tela será recarregada com os dados dela.';
        el.cancelar.textContent = estado.obrigatorio ? 'Sair do sistema' : 'Cancelar';

        el.carregando.hidden = true;
        el.lista.innerHTML = estado.filiais
            .map((f) => {
                const id = Number(f.id_filial);
                const marcada = id === estado.selecionada;
                const atual = id === idAtiva;
                return `
                <li>
                    <button type="button" class="hydra-filial-opcao" role="radio" data-id-filial="${id}"
                            aria-checked="${marcada}" tabindex="${marcada ? '0' : '-1'}">
                        <span class="hydra-filial-marca" aria-hidden="true"></span>
                        <span class="hydra-filial-textos">
                            <span class="hydra-filial-nome">${escapeHtml(f.nome)}</span>
                            ${f.endereco ? `<span class="hydra-filial-endereco">${escapeHtml(f.endereco)}</span>` : ''}
                        </span>
                        ${atual ? '<span class="hydra-filial-atual-tag">Você está aqui</span>' : ''}
                    </button>
                </li>`;
            })
            .join('');

        // Sem nenhuma opção marcada, a primeira fica alcançável pelo Tab.
        if (estado.selecionada === null) {
            const primeira = el.lista.querySelector('.hydra-filial-opcao');
            if (primeira) primeira.tabIndex = 0;
        }

        el.info.hidden = estado.filiais.length !== 1;
        if (estado.filiais.length === 0) {
            mostrarErro('Nenhuma filial disponível para você. Solicite ao administrador.');
        }

        atualizarBotaoConfirmar();
    }

    function atualizarBotaoConfirmar() {
        const idAtiva = estado.ativa ? Number(estado.ativa.id_filial) : null;
        const temOutraEscolha = estado.selecionada !== null && estado.selecionada !== idAtiva;

        el.confirmar.textContent = estado.enviando
            ? 'Trocando…'
            : (estado.obrigatorio ? 'Entrar nesta filial' : 'Confirmar troca');
        // Com uma filial só, e já sendo a atual, não há o que confirmar.
        el.confirmar.hidden = !estado.obrigatorio && estado.filiais.length === 1 && !temOutraEscolha;
        el.confirmar.disabled = estado.enviando || !temOutraEscolha;
        el.cancelar.disabled = estado.enviando;
    }

    function selecionar(idFilial) {
        if (estado.enviando) return;
        estado.selecionada = idFilial;
        el.lista.querySelectorAll('.hydra-filial-opcao').forEach((botao) => {
            const marcada = Number(botao.dataset.idFilial) === idFilial;
            botao.setAttribute('aria-checked', String(marcada));
            botao.tabIndex = marcada ? 0 : -1;
        });
        mostrarErro('');
        atualizarBotaoConfirmar();
    }

    /**
     * Abre a janela. { obrigatorio: true } = não há filial ativa; a janela
     * não fecha sem escolher. Pode ser chamada de novo com ela já aberta
     * (ex.: api.js recebendo 409): só passa a valer o modo obrigatório.
     */
    async function abrir(opcoes = {}) {
        if (!el) criarJanela();
        const obrigatorio = Boolean(opcoes.obrigatorio);

        if (estado.aberta) {
            if (obrigatorio && !estado.obrigatorio) {
                estado.obrigatorio = true;
                // Durante o carregamento a lista ainda está vazia; quem
                // abriu a janela renderiza quando ela chegar.
                if (!estado.carregando) renderizar();
            }
            return;
        }

        estado.aberta = true;
        estado.obrigatorio = obrigatorio;
        estado.enviando = false;
        estado.focoAnterior = document.activeElement;

        el.overlay.hidden = false;
        el.lista.innerHTML = '';
        el.info.hidden = true;
        el.carregando.hidden = false;
        mostrarErro('');
        el.confirmar.disabled = true;
        el.cancelar.disabled = false;
        el.cancelar.textContent = obrigatorio ? 'Sair do sistema' : 'Cancelar';
        el.cancelar.focus();

        estado.carregando = true;
        try {
            // Sempre busca de novo: os vínculos podem ter mudado desde que a tela abriu.
            await carregarFiliais();
        } catch (err) {
            estado.carregando = false;
            el.carregando.hidden = true;
            // 404/500 aqui não são "filial não encontrada": é o servidor sem
            // o módulo de filiais (back-end antigo) ou sem a migração do banco.
            if (err && (err.status === 404 || err.status >= 500)) {
                mostrarErro(`Não foi possível carregar as filiais (erro ${err.status}). `
                    + 'Avise o responsável pelo sistema: o servidor precisa ser atualizado.');
            } else {
                mostrarErro(mensagemDeErro(err));
            }
            if (err && err.status === 401) setTimeout(() => { window.location.href = 'login.html'; }, 2000);
            return;
        }
        estado.carregando = false;

        // Se a sessão perdeu a filial, a janela vira obrigatória.
        if (!estado.ativa) estado.obrigatorio = true;

        const idAtiva = estado.ativa ? Number(estado.ativa.id_filial) : null;
        estado.selecionada = idAtiva !== null
            ? idAtiva
            : (estado.filiais.length === 1 ? Number(estado.filiais[0].id_filial) : null);

        renderizar();

        const foco = el.lista.querySelector('.hydra-filial-opcao[tabindex="0"]') || el.cancelar;
        foco.focus();
    }

    function fechar() {
        if (!el || !estado.aberta || estado.obrigatorio || estado.enviando) return;
        estado.aberta = false;
        el.overlay.hidden = true;
        if (estado.focoAnterior && typeof estado.focoAnterior.focus === 'function') {
            estado.focoAnterior.focus();
        }
    }

    async function confirmar() {
        if (estado.selecionada === null || estado.enviando) return;
        estado.enviando = true;
        mostrarErro('');
        atualizarBotaoConfirmar();

        try {
            await window.hydraApi('/filiais/trocar', {
                method: 'POST',
                body: { id_filial: estado.selecionada },
            });
            // Recarrega a tela atual: ela busca de novo os dados, agora da nova filial.
            window.location.reload();
        } catch (err) {
            estado.enviando = false;
            mostrarErro(mensagemDeErro(err));
            if (err && err.status === 401) {
                setTimeout(() => { window.location.href = 'login.html'; }, 2000);
                return;
            }
            // 403/404/422: a lista pode estar desatualizada (vínculo retirado,
            // filial desativada). Busca de novo, mantendo a mensagem de erro.
            if (err && err.status !== undefined) {
                const mensagem = el.erro.textContent;
                try {
                    await carregarFiliais();
                    const ids = estado.filiais.map((f) => Number(f.id_filial));
                    if (!ids.includes(estado.selecionada)) {
                        estado.selecionada = estado.ativa ? Number(estado.ativa.id_filial) : null;
                    }
                    renderizar();
                } catch (e) { /* mantém a lista que já estava */ }
                mostrarErro(mensagem);
            }
            atualizarBotaoConfirmar();
        }
    }

    function sairDoSistema() {
        window.hydraApi('/auth/logout', { method: 'POST' })
            .catch(() => {})
            .finally(() => { window.location.href = 'login.html'; });
    }

    window.hydraTrocarFilial = {
        abrir,
        // Relê a filial ativa (ex.: depois de renomeá-la em Configurações da Loja).
        atualizar: () => carregarFiliais().catch(() => {}),
    };

    /* ================= Início ================= */
    async function iniciar() {
        // 1) Botão e "Filial: —" primeiro, sem esperar a API.
        montarControles();

        if (!window.hydraApi) {
            console.error('[trocar-filial] api.js não foi carregado antes deste script (window.hydraApi não existe)');
            return;
        }

        // 2) Depois, o nome da filial. Falha já foi registrada no Console por
        //    carregarFiliais(); o botão continua na tela, e a janela mostra
        //    o erro quando for aberta. (Visitante da demonstração pública
        //    recebe 401 aqui — o public-demo.js intercepta o clique no botão.)
        try {
            await carregarFiliais();
        } catch (err) {
            return;
        }
        if (!estado.ativa) abrir({ obrigatorio: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
