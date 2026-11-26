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
 */
(function () {
    'use strict';

    const DIAS_VALIDADE = 7;

    // CSS ao lado deste arquivo: ../css/notificacoes.css a partir de js/.
    const scriptAtual = document.currentScript;
    if (scriptAtual && scriptAtual.src && !document.querySelector('link[data-hydra-notificacoes]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/notificacoes.css?v=20261126', scriptAtual.src).href;
        link.setAttribute('data-hydra-notificacoes', '');
        document.head.appendChild(link);
    }

    let sino = null;
    let ponto = null;
    let el = null;          // elementos do painel, criados no primeiro clique
    let aberto = false;
    let focoAnterior = null;
    let pedido = 0;         // só a resposta do último carregamento vale

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
            if (situacao === 'empty') {
                esgotados.push({ nome: p.nome, detalhe: 'Sem estoque', ordem: 0 });
            } else if (situacao === 'critical' || situacao === 'low') {
                abaixo.push({
                    nome: p.nome,
                    detalhe: `${qtd(p)} em estoque · mínimo ${qtd({ quantidade: p.estoque_minimo, unidade: p.unidade })}`,
                    ordem: Number(p.quantidade) / (Number(p.estoque_minimo) || 1),
                });
            }

            if (p.validade) {
                const dias = diasAte(p.validade);
                if (dias < 0) {
                    vencidos.push({ nome: p.nome, detalhe: `Venceu em ${formatarData(p.validade)}`, ordem: dias });
                } else if (dias <= DIAS_VALIDADE) {
                    const quando = dias === 0 ? 'Vence hoje' : dias === 1 ? 'Vence amanhã' : `Vence em ${dias} dias`;
                    vencendo.push({ nome: p.nome, detalhe: `${quando} (${formatarData(p.validade)})`, ordem: dias });
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

    /* ================= Painel ================= */

    function criarPainel() {
        // Dentro do contêiner da tela (.hydro-stock, .hydro-dash...), que é
        // quem define as cores e o tema escuro.
        let raiz = sino;
        while (raiz.parentElement && raiz.parentElement !== document.body) raiz = raiz.parentElement;

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
                    <a href="controle-estoque.html" class="hydra-notif-link">Abrir o Estoque</a>
                </footer>
            </aside>`;
        raiz.appendChild(overlay);

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
                const focaveis = Array.from(el.painel.querySelectorAll('button, a[href]'));
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

    /* ================= Início ================= */
    function iniciar() {
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

        // Acende a bolinha já ao abrir a tela, sem esperar o clique.
        buscarAlertas().then((grupos) => atualizarPonto(totalDe(grupos))).catch(() => {});
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();
