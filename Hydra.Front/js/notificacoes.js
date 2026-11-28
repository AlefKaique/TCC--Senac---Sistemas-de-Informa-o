/**
 * Sino de notificações (todas as telas com o botão "Notificações" no topo).
 *
 * Cada clique abre um painel lateral à direita, em formato de página, com
 * os alertas da filial ativa, buscados de novo a cada abertura:
 *   - Esgotados (quantidade zero);
 *   - Abaixo do estoque mínimo (situação "Crítico" ou "Baixo", a mesma
 *     regra de window.hydraSituacaoEstoque usada no Estoque e no Relatório);
 *   - Vencidos;
 *   - Vencendo nos próximos DIAS_VALIDADE dias.
 * Sem alertas, o painel diz isso. A bolinha vermelha do sino só aparece
 * quando há alerta.
 *
 * Os dados vêm de GET /api/produtos (permissão estoque.consultar), sem
 * endpoint próprio: são as mesmas regras que o Estoque já mostra.
 *
 * Pop-up de alerta novo: além da bolinha, um aviso aparece no canto da
 * tela sempre que surge um alerta que a pessoa ainda não viu. Os alertas
 * são conferidos ao abrir a tela, a cada INTERVALO_VERIFICACAO_MS com a aba
 * visível, ao voltar para a aba e logo depois de uma venda ou movimentação
 * (window.hydraVerificarAlertas). Cada alerta tem uma chave (tipo +
 * produto); as já avisadas ficam guardadas no navegador, por usuário, para
 * o aviso não se repetir a cada troca de tela. Se o alerta some (o produto
 * foi reposto) e volta, avisa de novo. O pop-up pode ser desligado nele
 * mesmo ou no painel do sino, e religado no painel.
 */
(function () {
    'use strict';

    const DIAS_VALIDADE = 7;
    const INTERVALO_VERIFICACAO_MS = 2 * 60 * 1000;
    /** Quanto tempo o pop-up fica na tela sem interação (pausa com o mouse ou o foco nele). */
    const DURACAO_POPUP_MS = 15000;
    /** Quantos alertas o pop-up lista; o resto vira "e mais N". */
    const MAX_ITENS_POPUP = 3;

    // CSS ao lado deste arquivo: ../css/notificacoes.css a partir de js/.
    const scriptAtual = document.currentScript;
    if (scriptAtual && scriptAtual.src && !document.querySelector('link[data-hydra-notificacoes]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/notificacoes.css?v=2026112820', scriptAtual.src).href;
        link.setAttribute('data-hydra-notificacoes', '');
        document.head.appendChild(link);
    }

    let sino = null;
    let ponto = null;
    let el = null;          // elementos do painel, criados no primeiro clique
    let aberto = false;
    let focoAnterior = null;
    let pedido = 0;         // só a resposta do último carregamento vale
    let usuarioId = null;   // dono das preferências guardadas no navegador
    let pop = null;         // elementos do pop-up, criados na primeira vez
    let timerPop = null;
    let verificando = false;

    /* ================= Preferências (localStorage, por usuário) ================= */

    function chaveGuardada(nome) {
        return `hydra-alertas-${nome}:${usuarioId}`;
    }

    function ler(nome) {
        try { return window.localStorage.getItem(chaveGuardada(nome)); } catch (e) { return null; }
    }

    function gravar(nome, valor) {
        try {
            if (valor === null) window.localStorage.removeItem(chaveGuardada(nome));
            else window.localStorage.setItem(chaveGuardada(nome), valor);
        } catch (e) { /* navegador sem localStorage (aba anônima): segue sem guardar */ }
    }

    /** Pop-up ligado, a não ser que a pessoa o tenha desligado. */
    function popupLigado() {
        return ler('popup') !== 'desligado';
    }

    function definirPopup(ligado) {
        gravar('popup', ligado ? null : 'desligado');
        const interruptor = el && el.overlay.querySelector('#hydraNotifPopup');
        if (interruptor) interruptor.checked = ligado;
    }

    function chavesAvisadas() {
        try { return new Set(JSON.parse(ler('avisados') || '[]')); } catch (e) { return new Set(); }
    }

    /** Guarda os alertas de agora como já vistos: os resolvidos saem da lista. */
    function marcarComoAvisados(itens) {
        gravar('avisados', JSON.stringify(itens.map((item) => item.chave)));
    }

    /* ================= Regras dos alertas ================= */

    function hojeIso() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function diasAte(dataIso) {
        const [a, m, d] = String(dataIso).slice(0, 10).split('-').map(Number);
        const [ha, hm, hd] = hojeIso().split('-').map(Number);
        return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ha, hm - 1, hd)) / 86400000);
    }

    function formatarData(dataIso) {
        const [a, m, d] = String(dataIso).slice(0, 10).split('-');
        return `${d}/${m}/${a}`;
    }

    function qtd(produto) {
        return window.hydraFormatarQuantidade
            ? window.hydraFormatarQuantidade(produto.quantidade, produto.unidade)
            : String(produto.quantidade);
    }

    /** @return {{titulo:string, tipo:string, itens:{nome:string, detalhe:string}[]}[]} grupos com itens */
    function montarAlertas(produtos) {
        const esgotados = [];
        const abaixo = [];
        const vencidos = [];
        const vencendo = [];

        produtos.filter((p) => p.status !== 'inativo').forEach((p) => {
            const situacao = window.hydraSituacaoEstoque(p.quantidade, p.estoque_minimo);
            // "chave" identifica o alerta (tipo + produto) para o pop-up
            // saber o que já foi avisado.
            const id = p.id_produto;
            if (situacao === 'empty') {
                esgotados.push({ chave: `esgotado:${id}`, nome: p.nome, detalhe: 'Sem estoque', ordem: 0 });
            } else if (situacao === 'critical' || situacao === 'low') {
                abaixo.push({
                    chave: `abaixo:${id}`,
                    nome: p.nome,
                    detalhe: `${qtd(p)} em estoque · mínimo ${qtd({ quantidade: p.estoque_minimo, unidade: p.unidade })}`,
                    ordem: Number(p.quantidade) / (Number(p.estoque_minimo) || 1),
                });
            }

            if (p.validade) {
                const dias = diasAte(p.validade);
                if (dias < 0) {
                    vencidos.push({ chave: `vencido:${id}`, nome: p.nome, detalhe: `Venceu em ${formatarData(p.validade)}`, ordem: dias });
                } else if (dias <= DIAS_VALIDADE) {
                    const quando = dias === 0 ? 'Vence hoje' : dias === 1 ? 'Vence amanhã' : `Vence em ${dias} dias`;
                    vencendo.push({ chave: `vencendo:${id}`, nome: p.nome, detalhe: `${quando} (${formatarData(p.validade)})`, ordem: dias });
                }
            }
        });

        const porOrdem = (a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR');
        return [
            { titulo: 'Esgotados', tipo: 'perigo', itens: esgotados.sort(porOrdem) },
            { titulo: 'Abaixo do estoque mínimo', tipo: 'atencao', itens: abaixo.sort(porOrdem) },
            { titulo: 'Vencidos', tipo: 'perigo', itens: vencidos.sort(porOrdem) },
            { titulo: `Vencendo nos próximos ${DIAS_VALIDADE} dias`, tipo: 'atencao', itens: vencendo.sort(porOrdem) },
        ].filter((g) => g.itens.length > 0);
    }

    /** Todos os alertas numa lista só, cada um com o tipo (cor) do seu grupo. */
    function itensDe(grupos) {
        return grupos.flatMap((grupo) => grupo.itens.map((item) => ({ ...item, tipo: grupo.tipo })));
    }

    /* ================= Painel ================= */

    /* Contêiner da tela (.hydro-stock, .hydro-dash...), que é quem define as
       cores e o tema escuro: o painel e o pop-up entram dentro dele. */
    function raizDaTela() {
        let raiz = sino;
        while (raiz.parentElement && raiz.parentElement !== document.body) raiz = raiz.parentElement;
        return raiz;
    }

    function criarPainel() {
        const raiz = raizDaTela();

        const overlay = document.createElement('div');
        overlay.className = 'hydra-notif-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <aside class="hydra-notif-painel" role="dialog" aria-modal="true" aria-labelledby="hydraNotifTitulo">
                <header class="hydra-notif-topo">
                    <div>
                        <h2 id="hydraNotifTitulo">Alertas</h2>
                        <p class="hydra-notif-filial" id="hydraNotifFilial"></p>
                    </div>
                    <button type="button" class="hydra-notif-fechar" aria-label="Fechar alertas" data-demo-allow>
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
                            stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
                    </button>
                </header>
                <div class="hydra-notif-corpo" id="hydraNotifCorpo" aria-live="polite"></div>
                <footer class="hydra-notif-rodape">
                    <label class="hydra-notif-preferencia" for="hydraNotifPopup">
                        <input type="checkbox" id="hydraNotifPopup" role="switch" data-demo-allow>
                        <span class="hydra-notif-chave" aria-hidden="true"></span>
                        <span class="hydra-notif-preferencia-texto">
                            <strong>Avisar com pop-up</strong>
                            <span>Mostra um aviso no canto da tela quando surgir um alerta novo.</span>
                        </span>
                    </label>
                    <a href="controle-estoque.html" class="hydra-notif-link">Abrir o Estoque</a>
                </footer>
            </aside>`;
        raiz.appendChild(overlay);

        const interruptor = overlay.querySelector('#hydraNotifPopup');
        interruptor.checked = popupLigado();
        interruptor.addEventListener('change', () => definirPopup(interruptor.checked));

        el = {
            overlay,
            painel: overlay.querySelector('.hydra-notif-painel'),
            fechar: overlay.querySelector('.hydra-notif-fechar'),
            corpo: overlay.querySelector('#hydraNotifCorpo'),
            filial: overlay.querySelector('#hydraNotifFilial'),
        };

        el.fechar.addEventListener('click', fechar);
        // Clique fora do painel (no fundo escuro) fecha.
        overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                fechar();
            } else if (e.key === 'Tab') {
                // Mantém o foco dentro do painel enquanto ele está aberto.
                const focaveis = Array.from(el.painel.querySelectorAll('button, a[href], input'));
                const primeiro = focaveis[0];
                const ultimo = focaveis[focaveis.length - 1];
                if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
                else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
            }
        });
    }

    function mensagem(texto, classe) {
        const p = document.createElement('p');
        p.className = classe;
        p.textContent = texto;
        el.corpo.replaceChildren(p);
    }

    function semAlertas() {
        const vazio = document.createElement('div');
        vazio.className = 'hydra-notif-vazio';
        vazio.innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.8"'
            + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
        const titulo = document.createElement('strong');
        titulo.textContent = 'Nenhum alerta no momento';
        const texto = document.createElement('p');
        texto.textContent = 'Estoque e validades da filial estão em dia.';
        vazio.append(titulo, texto);
        el.corpo.replaceChildren(vazio);
    }

    function renderizar(grupos) {
        if (!grupos.length) {
            semAlertas();
            return;
        }
        const fragmento = document.createDocumentFragment();
        grupos.forEach((grupo) => {
            const secao = document.createElement('section');
            secao.className = `hydra-notif-grupo hydra-notif-grupo--${grupo.tipo}`;
            const h3 = document.createElement('h3');
            h3.textContent = grupo.titulo;
            const contador = document.createElement('span');
            contador.className = 'hydra-notif-contador';
            contador.textContent = String(grupo.itens.length);
            h3.appendChild(contador);
            const lista = document.createElement('ul');
            grupo.itens.forEach((item) => {
                const li = document.createElement('li');
                const nome = document.createElement('strong');
                nome.textContent = item.nome;
                const detalhe = document.createElement('span');
                detalhe.textContent = item.detalhe;
                li.append(nome, detalhe);
                lista.appendChild(li);
            });
            secao.append(h3, lista);
            fragmento.appendChild(secao);
        });
        el.corpo.replaceChildren(fragmento);
    }

    function atualizarPonto(quantidade) {
        if (!ponto) return;
        ponto.hidden = quantidade === 0;
        sino.setAttribute('aria-label', quantidade > 0
            ? `Notificações: ${quantidade} ${quantidade === 1 ? 'alerta' : 'alertas'}`
            : 'Notificações: nenhum alerta');
    }

    /** Busca os alertas; devolve os grupos ou lança o erro da API. */
    async function buscarAlertas() {
        const { produtos } = await window.hydraApi('/produtos');
        return montarAlertas(produtos || []);
    }

    const totalDe = (grupos) => grupos.reduce((soma, g) => soma + g.itens.length, 0);

    async function carregar() {
        const meu = ++pedido;
        mensagem('Carregando alertas…', 'hydra-notif-carregando');
        // Nome da filial ativa, do botão "Filial: ..." do topo (trocar-filial.js).
        const chip = document.querySelector('.hydra-filial-chip-nome');
        const nomeFilial = chip ? chip.textContent.trim() : '';
        el.filial.textContent = nomeFilial && nomeFilial !== '—' && nomeFilial !== 'escolha uma'
            ? `Filial: ${nomeFilial}` : '';
        try {
            const grupos = await buscarAlertas();
            if (meu !== pedido) return;
            atualizarPonto(totalDe(grupos));
            renderizar(grupos);
            // Quem abriu o painel já viu esses alertas: o pop-up não repete.
            if (usuarioId !== null) marcarComoAvisados(itensDe(grupos));
        } catch (err) {
            if (meu !== pedido) return;
            if (err && err.status === 401) {
                mensagem('Entre no sistema para ver os alertas da sua loja.', 'hydra-notif-info');
            } else if (err && err.status === 403) {
                mensagem('Seu cargo não tem acesso ao estoque, então não há alertas para mostrar.', 'hydra-notif-info');
            } else if (err && err.status === 409) {
                mensagem('Escolha a filial em que vai trabalhar para ver os alertas dela.', 'hydra-notif-info');
            } else {
                mensagem(err && err.status !== undefined
                    ? `Não foi possível carregar os alertas: ${err.message}`
                    : 'Não foi possível falar com o servidor. Confira a internet e tente de novo.', 'hydra-notif-erro');
            }
        }
    }

    function abrir() {
        if (!el) criarPainel();
        fecharPopup();
        aberto = true;
        focoAnterior = document.activeElement;
        el.overlay.hidden = false;
        // Próximo quadro: deixa o navegador aplicar o estado inicial antes da animação.
        requestAnimationFrame(() => el.overlay.classList.add('is-aberto'));
        sino.setAttribute('aria-expanded', 'true');
        el.fechar.focus();
        carregar();
    }

    function fechar() {
        if (!el || !aberto) return;
        aberto = false;
        el.overlay.classList.remove('is-aberto');
        sino.setAttribute('aria-expanded', 'false');
        setTimeout(() => { if (!aberto) el.overlay.hidden = true; }, 200);
        if (focoAnterior && typeof focoAnterior.focus === 'function') focoAnterior.focus();
    }

    /* ================= Pop-up de alerta novo ================= */

    const ICONE_SINO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"'
        + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>'
        + '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
    const ICONE_FECHAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"'
        + ' stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

    /* A região "status" existe desde o início (vazia): assim o leitor de
       tela anuncia o aviso quando o conteúdo entra, sem roubar o foco de
       quem está digitando no Caixa, por exemplo. */
    function criarPopup() {
        const regiao = document.createElement('section');
        regiao.className = 'hydra-alerta-pop';
        regiao.setAttribute('role', 'status');
        regiao.setAttribute('aria-label', 'Aviso de alertas');
        raizDaTela().appendChild(regiao);

        regiao.addEventListener('mouseenter', pausarPopup);
        regiao.addEventListener('mouseleave', retomarPopup);
        regiao.addEventListener('focusin', pausarPopup);
        regiao.addEventListener('focusout', (e) => { if (!regiao.contains(e.relatedTarget)) retomarPopup(); });
        regiao.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharPopup(); });
        regiao.addEventListener('click', (e) => {
            const acao = e.target.closest('[data-pop-acao]');
            if (!acao) return;
            const qual = acao.dataset.popAcao;
            if (qual === 'ver') abrir();
            else if (qual === 'desligar') desligarPeloPopup();
            else fecharPopup();
        });
        pop = { regiao };
    }

    function botao(texto, acao, classe) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = classe;
        b.dataset.popAcao = acao;
        b.setAttribute('data-demo-allow', '');
        b.textContent = texto;
        return b;
    }

    /** @param {'perigo'|'atencao'|'info'} tom cor da borda e do ícone */
    function cartaoDoPopup(tom) {
        const cartao = document.createElement('div');
        cartao.className = `hydra-alerta-pop__cartao hydra-alerta-pop__cartao--${tom}`;
        const icone = document.createElement('span');
        icone.className = 'hydra-alerta-pop__icone';
        icone.innerHTML = ICONE_SINO;
        const fechar = botao('', 'fechar', 'hydra-alerta-pop__fechar');
        fechar.innerHTML = ICONE_FECHAR;
        fechar.setAttribute('aria-label', 'Fechar aviso');
        const texto = document.createElement('div');
        texto.className = 'hydra-alerta-pop__texto';
        cartao.append(icone, texto, fechar);
        return { cartao, texto };
    }

    function mostrarPopup(novos) {
        if (!pop) criarPopup();
        const perigo = novos.some((item) => item.tipo === 'perigo');
        const { cartao, texto } = cartaoDoPopup(perigo ? 'perigo' : 'atencao');

        const titulo = document.createElement('strong');
        titulo.className = 'hydra-alerta-pop__titulo';
        titulo.textContent = novos.length === 1 ? 'Novo alerta no estoque' : `${novos.length} novos alertas no estoque`;
        texto.appendChild(titulo);

        const chip = document.querySelector('.hydra-filial-chip-nome');
        const nomeFilial = chip ? chip.textContent.trim() : '';
        if (nomeFilial && nomeFilial !== '—' && nomeFilial !== 'escolha uma') {
            const filial = document.createElement('span');
            filial.className = 'hydra-alerta-pop__filial';
            filial.textContent = `Filial ${nomeFilial}`;
            texto.appendChild(filial);
        }

        const lista = document.createElement('ul');
        lista.className = 'hydra-alerta-pop__lista';
        novos.slice(0, MAX_ITENS_POPUP).forEach((item) => {
            const li = document.createElement('li');
            li.className = `hydra-alerta-pop__item hydra-alerta-pop__item--${item.tipo}`;
            const nome = document.createElement('b');
            nome.textContent = item.nome;
            const detalhe = document.createElement('span');
            detalhe.textContent = item.detalhe;
            li.append(nome, detalhe);
            lista.appendChild(li);
        });
        texto.appendChild(lista);
        const resto = novos.length - MAX_ITENS_POPUP;
        if (resto > 0) {
            const mais = document.createElement('p');
            mais.className = 'hydra-alerta-pop__mais';
            mais.textContent = resto === 1 ? 'e mais 1 alerta' : `e mais ${resto} alertas`;
            texto.appendChild(mais);
        }

        const acoes = document.createElement('div');
        acoes.className = 'hydra-alerta-pop__acoes';
        acoes.append(
            botao('Ver alertas', 'ver', 'hydra-alerta-pop__btn hydra-alerta-pop__btn--principal'),
            botao('Agora não', 'fechar', 'hydra-alerta-pop__btn')
        );
        texto.appendChild(acoes);
        texto.appendChild(botao('Não mostrar mais estes avisos', 'desligar', 'hydra-alerta-pop__desligar'));

        exibirCartao(cartao, DURACAO_POPUP_MS);
    }

    /* Desligou no pop-up: confirma por alguns segundos e diz onde religar. */
    function desligarPeloPopup() {
        definirPopup(false);
        const { cartao, texto } = cartaoDoPopup('info');
        const titulo = document.createElement('strong');
        titulo.className = 'hydra-alerta-pop__titulo';
        titulo.textContent = 'Pop-up de alertas desligado';
        const explica = document.createElement('p');
        explica.className = 'hydra-alerta-pop__mais';
        explica.textContent = 'Os alertas continuam no sino. Para voltar a receber o aviso, abra o sino e ligue "Avisar com pop-up".';
        texto.append(titulo, explica);
        exibirCartao(cartao, 6000);
    }

    function exibirCartao(cartao, duracao) {
        pop.regiao.replaceChildren(cartao);
        pop.duracao = duracao;
        // Lê o tamanho antes de ligar a classe: força o navegador a aplicar
        // o estado inicial (invisível), senão a animação de entrada é pulada.
        void pop.regiao.offsetWidth;
        pop.regiao.classList.add('is-visivel');
        retomarPopup();
    }

    function pausarPopup() {
        clearTimeout(timerPop);
    }

    function retomarPopup() {
        clearTimeout(timerPop);
        if (pop && pop.regiao.classList.contains('is-visivel')) timerPop = setTimeout(fecharPopup, pop.duracao);
    }

    function fecharPopup() {
        if (!pop) return;
        clearTimeout(timerPop);
        const tinhaFoco = pop.regiao.contains(document.activeElement);
        pop.regiao.classList.remove('is-visivel');
        // Espera a animação de saída antes de esvaziar.
        setTimeout(() => { if (!pop.regiao.classList.contains('is-visivel')) pop.regiao.replaceChildren(); }, 250);
        if (tinhaFoco && sino) sino.focus();
    }

    /** Confere os alertas; avisa com o pop-up os que ainda não foram avisados. */
    async function verificar() {
        if (usuarioId === null || document.hidden || verificando) return;
        verificando = true;
        try {
            const grupos = await buscarAlertas();
            atualizarPonto(totalDe(grupos));
            const itens = itensDe(grupos);
            const jaAvisados = chavesAvisadas();
            const novos = itens.filter((item) => !jaAvisados.has(item.chave));
            // Grava mesmo com o pop-up desligado: ao religar, não chega de
            // uma vez tudo o que surgiu enquanto ele estava desligado.
            marcarComoAvisados(itens);
            if (novos.length && popupLigado() && !aberto) mostrarPopup(novos);
        } catch (e) {
            // Sem acesso ao estoque, sem filial ou sem rede: fica sem aviso.
        } finally {
            verificando = false;
        }
    }

    /* ================= Início ================= */
    async function iniciar() {
        sino = document.querySelector('.hydro-icon-btn[aria-label="Notificações"]');
        if (!sino || !window.hydraApi) return;
        ponto = sino.querySelector('.hydro-notif-dot');
        if (ponto) ponto.hidden = true; // só acende quando houver alerta
        sino.type = 'button';
        sino.setAttribute('aria-haspopup', 'dialog');
        sino.setAttribute('aria-expanded', 'false');
        // A demonstração pública bloqueia cliques em botões; este só lê dados.
        sino.setAttribute('data-demo-allow', '');
        sino.addEventListener('click', () => (aberto ? fechar() : abrir()));

        // Outras telas pedem uma conferência logo depois de mudar o estoque
        // (venda finalizada, entrada/saída lançada).
        window.hydraVerificarAlertas = verificar;

        // O pop-up é só para quem está logado: as preferências e os alertas
        // já avisados são guardados por usuário. A sessão é a mesma Promise
        // que a tela já pediu (api.js), sem chamada a mais.
        try {
            const { usuario } = await window.hydraSessao();
            usuarioId = usuario && usuario.id_usuario != null ? usuario.id_usuario : null;
        } catch (e) {
            usuarioId = null;
        }

        if (usuarioId === null) {
            // Acende a bolinha mesmo assim, como antes.
            buscarAlertas().then((grupos) => atualizarPonto(totalDe(grupos))).catch(() => {});
            return;
        }

        // Já ao abrir a tela (acende a bolinha e, se for o caso, avisa).
        verificar();
        setInterval(verificar, INTERVALO_VERIFICACAO_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) verificar(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
