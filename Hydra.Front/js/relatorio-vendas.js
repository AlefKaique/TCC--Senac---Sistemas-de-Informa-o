/**
 * Tela Relatório de Vendas (pages/dashboard.html).
 *
 * Fluxo:
 *   1. GET /api/relatorios/preferencias — blocos que o usuário deixou
 *      marcados, o que o cargo dele pode ver e as filiais do seletor;
 *   2. GET /api/relatorios/vendas — o resumo e SÓ os blocos marcados.
 *      Marcar mais um bloco depois busca só aquele bloco (resumo=0);
 *      desmarcar não busca nada;
 *   3. PUT /api/relatorios/preferencias — salva os blocos a cada mudança.
 *
 * Quem pode ver o quê é decidido no back-end (RelatorioVendasController);
 * aqui a tela só deixa de oferecer o que a API recusaria.
 *
 * Tudo que aparece é formatado em pt-BR (Intl.NumberFormat e datas
 * dd/mm/aaaa). Sem gráficos: tabelas e barras horizontais em CSS.
 */
(function () {
    'use strict';

    /* ================= Constantes ================= */

    const BLOCOS = [
        {
            id: 'mais_vendidos',
            titulo: 'Produtos que mais venderam',
            ajuda: 'Os produtos que mais trouxeram dinheiro no período. A faixa azul atrás de cada linha compara o produto com o 1º colocado.',
        },
        {
            id: 'dia_a_dia',
            titulo: 'Dia a dia',
            ajuda: 'Uma linha para cada dia que teve venda. O campeão é o produto que mais trouxe dinheiro naquele dia.',
        },
        {
            id: 'horarios',
            titulo: 'Horário de movimento',
            ajuda: 'Em que parte do dia o dinheiro entra.',
        },
        {
            id: 'pagamentos',
            titulo: 'Como o cliente pagou',
            ajuda: 'Quanto entrou em cada forma de pagamento.',
        },
        {
            id: 'parados',
            titulo: 'Produtos que pararam de vender',
            ajuda: 'Produtos com estoque que venderam no máximo 2 vezes no período. É dinheiro parado na prateleira.',
        },
        {
            id: 'vai_acabar',
            titulo: 'Vai acabar logo',
            ajuda: 'Quantos dias o estoque de agora dura, no ritmo de venda do período. Aparecem os produtos que acabam em até 30 dias.',
        },
        {
            id: 'operadores',
            titulo: 'Vendas por operador',
            ajuda: 'Quantas vendas cada pessoa fez no caixa, quanto entrou e quantas dessas vendas foram canceladas.',
        },
    ];
    const ESSENCIAL = ['mais_vendidos', 'dia_a_dia'];
    const FORMAS = {
        pix: 'Pix',
        cartao_debito: 'Cartão de débito',
        cartao_credito: 'Cartão de crédito',
        dinheiro: 'Dinheiro',
        vale_refeicao: 'Vale-refeição',
    };
    const UNIDADES_FRACIONADAS = ['kg', 'g', 'l', 'ml'];
    const MAX_DIAS = 90;

    const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
    const umaCasa = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
    const tresCasas = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

    /* ================= Elementos ================= */

    const $ = (id) => document.getElementById(id);
    const dom = {
        filial: $('rvFilial'),
        imprimir: $('rvImprimir'),
        exportar: $('rvExportar'),
        datas: $('rvDatas'),
        dataInicio: $('rvDataInicio'),
        dataFim: $('rvDataFim'),
        aplicarDatas: $('rvAplicarDatas'),
        datasAjuda: $('rvDatasAjuda'),
        chips: $('rvChips'),
        chipOperadores: $('rvChipOperadores'),
        marcarTudo: $('rvMarcarTudo'),
        soEssencial: $('rvSoEssencial'),
        confirmacao: $('rvConfirmacao'),
        situacao: $('rvSituacao'),
        resumo: $('rvResumo'),
        comparando: $('rvComparando'),
        cartoes: $('rvCartoes'),
        avisoCusto: $('rvAvisoCusto'),
        comparacao: $('rvComparacao'),
        comparacaoConteudo: $('rvComparacaoConteudo'),
        blocos: $('rvBlocos'),
        nenhumBloco: $('rvNenhumBloco'),
        cancelamentos: $('rvCancelamentos'),
        cancelamentosConteudo: $('rvCancelamentosConteudo'),
        verCancelamentos: $('rvVerCancelamentos'),
        imprimirCompras: $('rvImprimirCompras'),
        imprimirValidade: $('rvImprimirValidade'),
    };
    const botoesPeriodo = Array.from(document.querySelectorAll('.rv-periodo'));

    /* ================= Estado ================= */

    const state = {
        periodo: '7dias',
        de: '',
        ate: '',
        filial: '',
        blocos: new Set(ESSENCIAL),
        disponiveis: BLOCOS.map((bloco) => bloco.id),
        acesso: { nivel: 'funcionario', todas_filiais: false, operadores: false, cancelamentos: false, lucro: false },
        filiais: [],
        dados: null,
        carregando: false,
        carregandoBlocos: new Set(),
        errosBlocos: new Map(),
        requisicao: 0,
        mostrarCancelamentos: false,
        pronto: false,
        visitante: false,
    };

    /* ================= Datas ================= */

    function chaveData(data) {
        const dois = (valor) => String(valor).padStart(2, '0');
        return `${data.getFullYear()}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}`;
    }

    function hoje() {
        return chaveData(new Date());
    }

    function somarDias(chave, dias) {
        const data = new Date(`${chave}T12:00:00`);
        data.setDate(data.getDate() + dias);
        return chaveData(data);
    }

    function diasEntre(de, ate) {
        return Math.round((new Date(`${ate}T12:00:00`) - new Date(`${de}T12:00:00`)) / 86400000) + 1;
    }

    /** "2026-11-26" → "26/11/2026" (sem passar por Date, para não sofrer com fuso). */
    function dataBR(chave) {
        const [ano, mes, dia] = String(chave).slice(0, 10).split('-');
        return `${dia}/${mes}/${ano}`;
    }

    function dataCurta(chave) {
        return dataBR(chave).slice(0, 5);
    }

    /** "2026-11-26 14:32:10" → "26/11/2026 às 14:32" */
    function dataHoraBR(valor) {
        if (!valor) return '—';
        const texto = String(valor);
        return `${dataBR(texto)} às ${texto.slice(11, 16)}`;
    }

    /** "de 20/11 a 26/11/2026", "o dia 26/11/2026" ou "de 28/12/2025 a 03/01/2026". */
    function textoIntervalo(de, ate) {
        if (de === ate) return `o dia ${dataBR(de)}`;
        if (de.slice(0, 4) === ate.slice(0, 4)) return `de ${dataCurta(de)} a ${dataBR(ate)}`;
        return `de ${dataBR(de)} a ${dataBR(ate)}`;
    }

    function intervaloDoPeriodo(periodo) {
        const dia = hoje();
        const agora = new Date(`${dia}T12:00:00`);
        switch (periodo) {
            case 'hoje':
                return [dia, dia];
            case 'ontem':
                return [somarDias(dia, -1), somarDias(dia, -1)];
            case 'mes':
                return [chaveData(new Date(agora.getFullYear(), agora.getMonth(), 1)), dia];
            case 'mes-passado':
                return [
                    chaveData(new Date(agora.getFullYear(), agora.getMonth() - 1, 1)),
                    chaveData(new Date(agora.getFullYear(), agora.getMonth(), 0)),
                ];
            case '7dias':
            default:
                return [somarDias(dia, -6), dia];
        }
    }

    /* ================= Formatação ================= */

    function escapeHtml(valor) {
        return String(valor == null ? '' : valor)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function dinheiro(valor) {
        return valor == null ? '—' : moeda.format(Number(valor));
    }

    function numero(valor) {
        return inteiro.format(Number(valor || 0));
    }

    function percentual(valor) {
        return `${umaCasa.format(Number(valor || 0))}%`;
    }

    /** Quantidade com a unidade certa: "12,5 kg", "30 un". */
    function quantidade(valor, unidade) {
        const sigla = String(unidade || 'un').toLowerCase();
        const numeroValor = Number(valor || 0);
        const formato = UNIDADES_FRACIONADAS.includes(sigla) || !Number.isInteger(numeroValor) ? tresCasas : inteiro;
        return `${formato.format(numeroValor)} ${escapeHtml(sigla)}`;
    }

    function plural(quantidadeValor, singular, pluralTexto) {
        return Number(quantidadeValor) === 1 ? singular : pluralTexto;
    }

    function textoFilial() {
        if (state.filial === 'todas') return 'todas as filiais';
        const filial = state.filiais.find((item) => String(item.id_filial) === String(state.filial));
        return filial ? `filial ${filial.nome}` : 'filial atual';
    }

    function nomeFilial() {
        if (state.filial === 'todas') return 'Todas as filiais';
        const filial = state.filiais.find((item) => String(item.id_filial) === String(state.filial));
        return filial ? filial.nome : '';
    }

    function mostraColunaFilial() {
        return Boolean(state.dados && state.dados.filial && state.dados.filial.id_filial === null);
    }

    /* ================= Pequenos componentes ================= */

    function tabela(rotuloId, cabecalho, linhas, rodape) {
        const ths = cabecalho
            .map((coluna) => `<th scope="col"${coluna.num ? ' class="rv-num"' : ''}>${escapeHtml(coluna.texto)}</th>`)
            .join('');
        return `<div class="rv-tabela-rolagem"><table class="rv-tabela" aria-labelledby="${rotuloId}">`
            + `<thead><tr>${ths}</tr></thead><tbody>${linhas.join('')}</tbody>`
            + `${rodape ? `<tfoot>${rodape}</tfoot>` : ''}</table></div>`;
    }

    function barra(pct) {
        const largura = Math.max(0, Math.min(100, Number(pct) || 0));
        return `<div class="rv-barra" aria-hidden="true"><span style="--rv-pct:${largura}%"></span></div>`;
    }

    function vazio(texto) {
        return `<p class="rv-vazio">${texto}</p>`;
    }

    function sugestaoDePeriodo() {
        return state.periodo === '7dias' ? 'Tente Este mês ou Mês passado.' : 'Tente Últimos 7 dias.';
    }

    let toastTimer = null;
    function toast(mensagem) {
        const elemento = $('hydroToast');
        if (!elemento) return;
        elemento.textContent = mensagem;
        elemento.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => elemento.classList.remove('hydro-show'), 4000);
    }

    /** Faixa de situação acima do resumo: carregando, aviso ou erro. */
    function situacao(tipo, html, tentarDeNovo) {
        dom.situacao.className = 'rv-situacao';
        dom.situacao.innerHTML = '';
        if (!tipo) return;
        if (tipo === 'carregando') dom.situacao.classList.add('rv-carregando');
        if (tipo === 'erro') dom.situacao.classList.add('rv-erro');
        const texto = document.createElement('span');
        texto.innerHTML = html;
        dom.situacao.appendChild(texto);
        if (tentarDeNovo) {
            const botao = document.createElement('button');
            botao.type = 'button';
            botao.className = 'rv-btn rv-btn-contorno';
            botao.textContent = 'Tentar de novo';
            botao.addEventListener('click', tentarDeNovo);
            dom.situacao.appendChild(botao);
        }
    }

    function mensagemDeErro(erro) {
        if (erro && erro.status && erro.message) return escapeHtml(erro.message);
        return 'Não foi possível carregar o relatório. Confira a internet e tente de novo.';
    }

    /* ================= API ================= */

    function blocosMarcados() {
        return BLOCOS.map((bloco) => bloco.id)
            .filter((id) => state.blocos.has(id) && state.disponiveis.includes(id));
    }

    function pedir({ blocos, resumo, pagina }) {
        const parametros = new URLSearchParams({
            data_inicio: state.de,
            data_fim: state.ate,
            id_filial: state.filial,
            blocos: blocos.join(','),
        });
        if (!resumo) parametros.set('resumo', '0');
        if (pagina) parametros.set('produtos_pagina', String(pagina));
        return window.hydraApi(`/relatorios/vendas?${parametros.toString()}`);
    }

    async function carregarTudo() {
        if (state.visitante || !state.pronto) return;
        const id = ++state.requisicao;
        state.carregando = true;
        state.dados = null;
        state.errosBlocos.clear();
        state.carregandoBlocos.clear();
        situacao('carregando', 'Carregando o relatório…');
        renderizarTudo();

        const blocos = blocosMarcados();
        if (state.mostrarCancelamentos) blocos.push('cancelamentos');
        try {
            const resposta = await pedir({ blocos, resumo: true });
            if (id !== state.requisicao) return;
            state.dados = resposta;
            if (resposta.acesso) state.acesso = resposta.acesso;
            state.carregando = false;
            if (resposta.resumo && resposta.resumo.num_vendas === 0) {
                situacao('aviso', `Nenhuma venda nesse período. ${sugestaoDePeriodo()}`);
            } else {
                situacao(null);
            }
            renderizarTudo();
            buscarBlocosQueFaltam();
        } catch (erro) {
            if (id !== state.requisicao) return;
            state.carregando = false;
            situacao('erro', mensagemDeErro(erro), carregarTudo);
            renderizarTudo();
        }
    }

    /** Busca, numa chamada só, os blocos marcados que ainda não têm dados. */
    function buscarBlocosQueFaltam() {
        if (!state.dados) return;
        const faltam = blocosMarcados().filter((id) => !(id in state.dados) && !state.carregandoBlocos.has(id));
        if (faltam.length) carregarBlocos(faltam);
    }

    async function carregarBlocos(blocos, pagina) {
        if (!state.dados || state.carregando) return;
        const id = state.requisicao;
        blocos.forEach((bloco) => {
            state.carregandoBlocos.add(bloco);
            state.errosBlocos.delete(bloco);
        });
        renderizarBlocos();
        try {
            const resposta = await pedir({ blocos, resumo: false, pagina });
            if (id !== state.requisicao) return;
            blocos.forEach((bloco) => {
                state.dados[bloco] = resposta[bloco];
            });
        } catch (erro) {
            if (id !== state.requisicao) return;
            blocos.forEach((bloco) => state.errosBlocos.set(bloco, mensagemDeErro(erro)));
        } finally {
            if (id === state.requisicao) {
                blocos.forEach((bloco) => state.carregandoBlocos.delete(bloco));
                renderizarBlocos();
                renderizarCancelamentos();
            }
        }
    }

    let salvarTimer = null;
    function salvarPreferencias() {
        if (state.visitante) return;
        clearTimeout(salvarTimer);
        salvarTimer = setTimeout(() => {
            window.hydraApi('/relatorios/preferencias', {
                method: 'PUT',
                body: { blocos: blocosMarcados() },
            }).catch(() => {
                toast('Não foi possível salvar sua escolha agora. Ela vale até você sair desta tela.');
            });
        }, 500);
    }

    /* ================= Renderização ================= */

    function renderizarTudo() {
        renderizarConfirmacao();
        renderizarResumo();
        renderizarComparacao();
        renderizarBlocos();
        renderizarCancelamentos();
    }

    function renderizarConfirmacao() {
        const marcados = blocosMarcados().length;
        const total = state.disponiveis.length;
        dom.confirmacao.textContent = `Mostrando ${textoIntervalo(state.de, state.ate)} · ${textoFilial()} · `
            + `${marcados} de ${total} detalhes na tela`;
    }

    function variacaoDinheiro(atual, anterior, rotulo, vendasAntes) {
        if (vendasAntes === 0 || atual == null || anterior == null) {
            return { classe: '', texto: `Não houve vendas ${rotulo} para comparar.` };
        }
        const diferenca = Math.round((Number(atual) - Number(anterior)) * 100) / 100;
        if (Math.abs(diferenca) < 0.005) return { classe: '', texto: `O mesmo valor que ${rotulo}.` };
        return diferenca > 0
            ? { classe: 'rv-sobe', seta: '▲', texto: `${moeda.format(diferenca)} a mais que ${rotulo}` }
            : { classe: 'rv-desce', seta: '▼', texto: `${moeda.format(-diferenca)} a menos que ${rotulo}` };
    }

    function variacaoQuantidade(atual, anterior, rotulo) {
        if (!anterior) return { classe: '', texto: `Não houve vendas ${rotulo} para comparar.` };
        const diferenca = Number(atual) - Number(anterior);
        if (diferenca === 0) return { classe: '', texto: `A mesma quantidade que ${rotulo}.` };
        const qtd = Math.abs(diferenca);
        const palavra = plural(qtd, 'venda', 'vendas');
        return diferenca > 0
            ? { classe: 'rv-sobe', seta: '▲', texto: `${numero(qtd)} ${palavra} a mais que ${rotulo}` }
            : { classe: 'rv-desce', seta: '▼', texto: `${numero(qtd)} ${palavra} a menos que ${rotulo}` };
    }

    function cartao(rotulo, valor, variacao, explica) {
        const seta = variacao && variacao.seta ? `<span aria-hidden="true">${variacao.seta}</span>` : '';
        const linhaVariacao = variacao
            ? `<p class="rv-variacao ${variacao.classe}">${seta}<span>${escapeHtml(variacao.texto)}</span></p>`
            : '';
        return `<article class="rv-cartao"><h3 class="rv-cartao-rotulo">${escapeHtml(rotulo)}</h3>`
            + `<p class="rv-cartao-valor">${valor}</p>${linhaVariacao}`
            + `<p class="rv-cartao-explica">${escapeHtml(explica)}</p></article>`;
    }

    function renderizarResumo() {
        dom.resumo.hidden = state.visitante;
        const titulos = [
            ['Dinheiro que entrou', 'Soma de todas as vendas concluídas.'],
            ['Quantidade de vendas', 'Vendas canceladas não entram nesta conta.'],
            ['Média por venda', 'Quanto cada cliente gastou, em média, por compra.'],
        ];
        if (state.acesso.lucro) titulos.push(['Lucro estimado', 'Dinheiro que entrou menos o preço de custo dos produtos vendidos.']);

        if (!state.dados || !state.dados.resumo) {
            dom.comparando.textContent = '';
            dom.avisoCusto.hidden = true;
            const espera = state.carregando ? 'Carregando…' : '—';
            dom.cartoes.dataset.qtd = String(titulos.length);
            dom.cartoes.innerHTML = titulos.map(([rotulo, explica]) => cartao(rotulo, espera, null, explica)).join('');
            dom.cartoes.setAttribute('aria-busy', String(state.carregando));
            return;
        }

        const resumo = state.dados.resumo;
        const anterior = state.dados.resumo_anterior || {};
        const periodoAnterior = state.dados.periodo_anterior;
        const rotulo = periodoAnterior.rotulo;
        dom.cartoes.setAttribute('aria-busy', 'false');
        dom.comparando.textContent = periodoAnterior.data_inicio === periodoAnterior.data_fim
            ? `As comparações usam o dia ${dataBR(periodoAnterior.data_inicio)}.`
            : `As comparações usam o período de ${dataBR(periodoAnterior.data_inicio)} a ${dataBR(periodoAnterior.data_fim)}.`;

        const cartoes = [
            cartao('Dinheiro que entrou', dinheiro(resumo.faturamento),
                variacaoDinheiro(resumo.faturamento, anterior.faturamento, rotulo, anterior.num_vendas), titulos[0][1]),
            cartao('Quantidade de vendas', numero(resumo.num_vendas),
                variacaoQuantidade(resumo.num_vendas, anterior.num_vendas, rotulo), titulos[1][1]),
            cartao('Média por venda', dinheiro(resumo.media_venda),
                variacaoDinheiro(resumo.media_venda, anterior.media_venda, rotulo, anterior.num_vendas), titulos[2][1]),
        ];
        if (state.acesso.lucro && resumo.lucro !== undefined) {
            cartoes.push(cartao('Lucro estimado', dinheiro(resumo.lucro),
                variacaoDinheiro(resumo.lucro, anterior.lucro, rotulo, anterior.num_vendas), titulos[3][1]));
        }
        dom.cartoes.dataset.qtd = String(cartoes.length);
        dom.cartoes.innerHTML = cartoes.join('');

        const semCusto = Number(resumo.produtos_sem_custo || 0);
        dom.avisoCusto.hidden = !(state.acesso.lucro && semCusto > 0);
        if (!dom.avisoCusto.hidden) {
            dom.avisoCusto.innerHTML = `<strong>Atenção:</strong> ${numero(semCusto)} `
                + `${plural(semCusto, 'produto vendido está', 'produtos vendidos estão')} sem preço de custo cadastrado `
                + `e ${plural(semCusto, 'ficou', 'ficaram')} fora do lucro estimado (${dinheiro(resumo.faturamento_sem_custo)} em vendas). `
                + 'Cadastre o preço de custo na tela Produtos para o lucro ficar mais certo.';
        }
    }

    function renderizarComparacao() {
        const linhas = state.dados && state.dados.comparacao_filiais;
        dom.comparacao.hidden = !linhas || state.visitante;
        if (!linhas) return;
        const maior = Math.max(0, ...linhas.map((linha) => Number(linha.faturamento) || 0));
        const cabecalho = [
            { texto: 'Filial' },
            { texto: 'Dinheiro que entrou', num: true },
            { texto: 'Vendas', num: true },
            { texto: 'Média por venda', num: true },
        ];
        if (state.acesso.lucro) cabecalho.push({ texto: 'Lucro estimado', num: true });
        const corpo = linhas.map((linha) => {
            const pct = maior > 0 ? (Number(linha.faturamento) / maior) * 100 : 0;
            return `<tr class="rv-linha-barra" style="--rv-pct:${pct}%">`
                + `<td class="rv-nome">${escapeHtml(linha.nome)}</td>`
                + `<td class="rv-num">${dinheiro(linha.faturamento)}</td>`
                + `<td class="rv-num">${numero(linha.num_vendas)}</td>`
                + `<td class="rv-num">${dinheiro(linha.media_venda)}</td>`
                + `${state.acesso.lucro ? `<td class="rv-num">${dinheiro(linha.lucro)}</td>` : ''}</tr>`;
        });
        const primeira = linhas[0];
        const destaque = primeira && Number(primeira.faturamento) > 0
            ? `<p class="rv-destaque-texto">A filial que mais vendeu foi <strong>${escapeHtml(primeira.nome)}</strong>, com <strong>${dinheiro(primeira.faturamento)}</strong>.</p>`
            : '';
        dom.comparacaoConteudo.innerHTML = destaque + tabela('rvComparacaoTitulo', cabecalho, corpo);
    }

    function renderizarBlocos() {
        if (state.visitante) {
            dom.blocos.innerHTML = '';
            dom.nenhumBloco.hidden = true;
            return;
        }
        const visiveis = BLOCOS.filter((bloco) => state.blocos.has(bloco.id) && state.disponiveis.includes(bloco.id));
        dom.nenhumBloco.hidden = visiveis.length > 0;
        dom.blocos.innerHTML = visiveis.map((bloco) => {
            const tituloId = `rvTitulo-${bloco.id}`;
            let corpo;
            if (state.carregandoBlocos.has(bloco.id) || (state.carregando && !state.dados)) {
                corpo = '<p class="rv-bloco-carregando">Carregando…</p>';
            } else if (state.errosBlocos.has(bloco.id)) {
                corpo = vazio(`${state.errosBlocos.get(bloco.id)} <button type="button" class="rv-btn rv-btn-contorno" data-rv-recarregar="${bloco.id}">Tentar de novo</button>`);
            } else if (!state.dados || !(bloco.id in state.dados)) {
                corpo = state.dados ? '<p class="rv-bloco-carregando">Carregando…</p>' : vazio('Escolha um período no Passo 1 para ver esta parte.');
            } else {
                corpo = RENDERIZADORES[bloco.id](state.dados[bloco.id], tituloId);
            }
            return `<section class="rv-card rv-bloco" id="rvBloco-${bloco.id}" aria-labelledby="${tituloId}"`
                + `${state.carregandoBlocos.has(bloco.id) ? ' aria-busy="true"' : ''}>`
                + `<h2 id="${tituloId}" tabindex="-1">${escapeHtml(bloco.titulo)}</h2>`
                + `<p class="rv-bloco-ajuda">${escapeHtml(bloco.ajuda)}</p>${corpo}</section>`;
        }).join('');
    }

    /* ---------- Produtos que mais venderam ---------- */
    function renderMaisVendidos(dados, tituloId) {
        if (!dados.itens.length) return vazio(`Nenhum produto vendido nesse período. ${sugestaoDePeriodo()}`);
        const primeiro = Number(dados.faturamento_primeiro) || 0;
        const linhas = dados.itens.map((item) => {
            const pct = primeiro > 0 ? (Number(item.faturamento) / primeiro) * 100 : 0;
            return `<tr class="rv-linha-barra" style="--rv-pct:${pct}%">`
                + `<td class="rv-pos">${item.posicao}º</td>`
                + `<td class="rv-nome">${escapeHtml(item.nome)}</td>`
                + `<td class="rv-num">${quantidade(item.quantidade, item.unidade)}</td>`
                + `<td class="rv-num">${dinheiro(item.faturamento)}</td>`
                + `<td class="rv-num">${percentual(item.percentual)}</td></tr>`;
        });
        const html = tabela(tituloId, [
            { texto: 'Posição' },
            { texto: 'Produto' },
            { texto: 'Quanto vendeu', num: true },
            { texto: 'Dinheiro que entrou', num: true },
            { texto: '% do total', num: true },
        ], linhas);

        const total = Number(dados.total_produtos) || 0;
        if (dados.pagina === 0) {
            if (total <= dados.itens.length) return html;
            return `${html}<div class="rv-paginacao"><button type="button" class="rv-btn rv-btn-contorno" data-rv-pagina="1">`
                + `Ver a lista completa (${numero(total)} produtos)</button></div>`;
        }
        const paginas = Math.max(1, Math.ceil(total / dados.por_pagina));
        return `${html}<div class="rv-paginacao">`
            + `<button type="button" class="rv-btn rv-btn-contorno" data-rv-pagina="${dados.pagina - 1}" ${dados.pagina <= 1 ? 'disabled' : ''}>Página anterior</button>`
            + `<span class="rv-paginacao-texto">Página ${numero(dados.pagina)} de ${numero(paginas)}</span>`
            + `<button type="button" class="rv-btn rv-btn-contorno" data-rv-pagina="${dados.pagina + 1}" ${dados.pagina >= paginas ? 'disabled' : ''}>Próxima página</button>`
            + '<button type="button" class="rv-btn rv-btn-contorno" data-rv-pagina="0">Voltar para os 5 primeiros</button></div>';
    }

    /* ---------- Dia a dia ---------- */
    function renderDiaADia(dados, tituloId) {
        const dias = dados.dias || [];
        if (!dias.length) return vazio(`Nenhuma venda nesse período. ${sugestaoDePeriodo()}`);
        let melhor = dias[0];
        let pior = dias[0];
        dias.forEach((dia) => {
            if (Number(dia.total) > Number(melhor.total)) melhor = dia;
            if (Number(dia.total) < Number(pior.total)) pior = dia;
        });
        const descreve = (dia) => `<strong>${escapeHtml(dia.dia_semana)}, ${dataBR(dia.data)}</strong>, com `
            + `<strong>${dinheiro(dia.total)}</strong> em ${numero(dia.num_vendas)} ${plural(dia.num_vendas, 'venda', 'vendas')}`;
        const resumo = dias.length === 1
            ? `<p class="rv-destaque-texto">Só houve vendas em um dia nesse período: ${descreve(melhor)}.</p>`
            : `<p class="rv-destaque-texto">O melhor dia foi ${descreve(melhor)}. O dia mais fraco foi ${descreve(pior)}. `
                + 'Dias sem nenhuma venda não aparecem na lista.</p>';

        const linhas = dias.map((dia) => {
            const eMelhor = dia === melhor && dias.length > 1;
            const campeao = dia.campeao
                ? `<span class="rv-nome">${escapeHtml(dia.campeao.nome)}</span>`
                : '—';
            const qtdCampeao = dia.campeao ? quantidade(dia.campeao.quantidade, dia.campeao.unidade) : '—';
            return `<tr${eMelhor ? ' class="rv-linha-melhor"' : ''}>`
                + `<td class="rv-nome">${dataBR(dia.data)}${eMelhor ? '<span class="rv-selo">Melhor dia</span>' : ''}</td>`
                + `<td>${escapeHtml(dia.dia_semana)}</td>`
                + `<td class="rv-num">${numero(dia.num_vendas)}</td>`
                + `<td class="rv-num">${dinheiro(dia.total)}</td>`
                + `<td>${campeao}</td>`
                + `<td class="rv-num">${qtdCampeao}</td></tr>`;
        });
        const rodape = `<tr><th scope="row" colspan="2">Total do período</th>`
            + `<td class="rv-num">${numero(dados.total.num_vendas)}</td>`
            + `<td class="rv-num">${dinheiro(dados.total.total)}</td><td colspan="2"></td></tr>`;
        return resumo + tabela(tituloId, [
            { texto: 'Data' },
            { texto: 'Dia da semana' },
            { texto: 'Vendas', num: true },
            { texto: 'Total do dia', num: true },
            { texto: 'Produto campeão' },
            { texto: 'Quanto vendeu dele', num: true },
        ], linhas, rodape);
    }

    /* ---------- Horário de movimento ---------- */
    function renderHorarios(faixas, tituloId) {
        const total = faixas.reduce((soma, faixa) => soma + Number(faixa.num_vendas), 0);
        if (!total) return vazio(`Nenhuma venda nesse período. ${sugestaoDePeriodo()}`);
        const forte = faixas.reduce((maior, faixa) => (Number(faixa.valor) > Number(maior.valor) ? faixa : maior), faixas[0]);
        const linhas = faixas.map((faixa) => `<tr><td class="rv-nome">${escapeHtml(faixa.rotulo)}</td>`
            + `<td class="rv-num">${dinheiro(faixa.valor)}</td>`
            + `<td class="rv-num">${numero(faixa.num_vendas)}</td>`
            + `<td class="rv-num">${percentual(faixa.percentual)}</td>`
            + `<td class="rv-barra-celula">${barra(faixa.percentual)}</td></tr>`);
        return `<p class="rv-destaque-texto">O horário mais forte é <strong>${escapeHtml(forte.rotulo.toLowerCase())}</strong>, `
            + `com <strong>${percentual(forte.percentual)}</strong> do dinheiro que entrou.</p>`
            + tabela(tituloId, [
                { texto: 'Parte do dia' },
                { texto: 'Dinheiro que entrou', num: true },
                { texto: 'Vendas', num: true },
                { texto: '% do dinheiro', num: true },
                { texto: 'Comparação' },
            ], linhas);
    }

    /* ---------- Como o cliente pagou ---------- */
    function renderPagamentos(formas, tituloId) {
        const total = formas.reduce((soma, forma) => soma + Number(forma.valor), 0);
        if (!total) return vazio(`Nenhuma venda nesse período. ${sugestaoDePeriodo()}`);
        const maisUsada = formas.reduce((maior, forma) => (Number(forma.valor) > Number(maior.valor) ? forma : maior), formas[0]);
        const linhas = formas.map((forma) => `<tr><td class="rv-nome">${escapeHtml(FORMAS[forma.forma] || forma.forma)}</td>`
            + `<td class="rv-num">${dinheiro(forma.valor)}</td>`
            + `<td class="rv-num">${percentual(forma.percentual)}</td>`
            + `<td class="rv-barra-celula">${barra(forma.percentual)}</td></tr>`);
        return `<p class="rv-destaque-texto">A forma que mais trouxe dinheiro foi <strong>${escapeHtml(FORMAS[maisUsada.forma] || maisUsada.forma)}</strong>, `
            + `com <strong>${percentual(maisUsada.percentual)}</strong> do total.</p>`
            + tabela(tituloId, [
                { texto: 'Forma de pagamento' },
                { texto: 'Valor', num: true },
                { texto: '% do total', num: true },
                { texto: 'Comparação' },
            ], linhas);
    }

    /* ---------- Produtos que pararam de vender ---------- */
    function renderParados(dados, tituloId) {
        if (!dados.itens.length) {
            return vazio('Nenhum produto parado. Tudo que tem estoque vendeu mais de 2 vezes no período.');
        }
        const comFilial = mostraColunaFilial();
        const total = Number(dados.total_produtos) || 0;
        const linhas = dados.itens.map((item) => `<tr><td class="rv-nome">${escapeHtml(item.nome)}</td>`
            + `${comFilial ? `<td>${escapeHtml(item.filial)}</td>` : ''}`
            + `<td class="rv-num">${quantidade(item.estoque, item.unidade)}</td>`
            + `<td class="rv-num">${numero(item.num_vendas)}</td>`
            + `<td class="rv-num">${dinheiro(item.valor_parado)}`
            + `${item.sem_custo ? '<span class="rv-detalhe">pelo preço de venda (sem custo cadastrado)</span>' : ''}</td></tr>`);
        const cabecalho = [{ texto: 'Produto' }];
        if (comFilial) cabecalho.push({ texto: 'Filial' });
        cabecalho.push({ texto: 'Estoque agora', num: true }, { texto: 'Vendas no período', num: true }, { texto: 'Dinheiro parado', num: true });
        const resumo = `<p class="rv-destaque-texto"><strong>${numero(total)} ${plural(total, 'produto parado', 'produtos parados')}</strong>, `
            + `somando <strong>${dinheiro(dados.valor_parado_total)}</strong> em estoque.`
            + `${total > dados.itens.length ? ` A lista mostra os ${numero(dados.itens.length)} com mais dinheiro parado.` : ''}</p>`;
        return resumo + tabela(tituloId, cabecalho, linhas);
    }

    /* ---------- Vai acabar logo ---------- */
    function textoAcabaEm(item) {
        const dias = Number(item.dias_restantes);
        if (Number(item.estoque) <= 0) return { texto: 'Já acabou', urgente: true };
        if (dias < 1) return { texto: 'Acaba hoje', urgente: true };
        const inteiros = Math.floor(dias);
        return { texto: `Acaba em ${numero(inteiros)} ${plural(inteiros, 'dia', 'dias')}`, urgente: inteiros <= 3 };
    }

    function renderVaiAcabar(dados, tituloId) {
        if (!dados.itens.length) {
            return vazio(`Nenhum produto deve acabar nos próximos ${numero(dados.limite_dias)} dias, pelo ritmo de venda do período.`);
        }
        const comFilial = mostraColunaFilial();
        const urgentes = dados.itens.filter((item) => textoAcabaEm(item).urgente).length;
        const linhas = dados.itens.map((item) => {
            const acaba = textoAcabaEm(item);
            return `<tr><td class="rv-nome">${escapeHtml(item.nome)}</td>`
                + `${comFilial ? `<td>${escapeHtml(item.filial)}</td>` : ''}`
                + `<td class="rv-num">${quantidade(item.estoque, item.unidade)}</td>`
                + `<td class="rv-num">${quantidade(item.media_diaria, item.unidade)}</td>`
                + `<td><span class="${acaba.urgente ? 'rv-urgente' : ''}">${escapeHtml(acaba.texto)}</span>`
                + `${acaba.urgente ? '<span class="rv-selo-urgente">Repor já</span>' : ''}</td></tr>`;
        });
        const cabecalho = [{ texto: 'Produto' }];
        if (comFilial) cabecalho.push({ texto: 'Filial' });
        cabecalho.push({ texto: 'Estoque agora', num: true }, { texto: 'Vende por dia (média)', num: true }, { texto: 'Quando acaba' });
        const resumo = urgentes
            ? `<p class="rv-destaque-texto"><strong class="rv-urgente">${numero(urgentes)} ${plural(urgentes, 'produto acaba', 'produtos acabam')} em 3 dias ou menos.</strong> Esses estão marcados com “Repor já”.</p>`
            : '<p class="rv-destaque-texto">Nenhum produto acaba nos próximos 3 dias.</p>';
        return resumo + tabela(tituloId, cabecalho, linhas);
    }

    /* ---------- Vendas por operador ---------- */
    function renderOperadores(linhasDados, tituloId) {
        if (!linhasDados.length) return vazio(`Nenhuma venda registrada nesse período. ${sugestaoDePeriodo()}`);
        const linhas = linhasDados.map((linha) => `<tr><td class="rv-nome">${escapeHtml(linha.nome)}</td>`
            + `<td class="rv-num">${numero(linha.num_vendas)}</td>`
            + `<td class="rv-num">${dinheiro(linha.valor)}</td>`
            + `<td class="rv-num">${numero(linha.cancelamentos)}</td></tr>`);
        return tabela(tituloId, [
            { texto: 'Operador' },
            { texto: 'Vendas', num: true },
            { texto: 'Dinheiro que entrou', num: true },
            { texto: 'Vendas canceladas', num: true },
        ], linhas);
    }

    const RENDERIZADORES = {
        mais_vendidos: renderMaisVendidos,
        dia_a_dia: renderDiaADia,
        horarios: renderHorarios,
        pagamentos: renderPagamentos,
        parados: renderParados,
        vai_acabar: renderVaiAcabar,
        operadores: renderOperadores,
    };

    /* ---------- Vendas canceladas (ferramenta mantida) ---------- */
    function renderizarCancelamentos() {
        const pode = state.acesso.cancelamentos && !state.visitante;
        dom.verCancelamentos.hidden = !pode;
        dom.cancelamentos.hidden = !pode || !state.mostrarCancelamentos;
        if (dom.cancelamentos.hidden) return;
        dom.verCancelamentos.textContent = 'Atualizar vendas canceladas';

        if (state.carregandoBlocos.has('cancelamentos') || (state.carregando && !state.dados)) {
            dom.cancelamentosConteudo.innerHTML = '<p class="rv-bloco-carregando">Carregando…</p>';
            return;
        }
        if (state.errosBlocos.has('cancelamentos')) {
            dom.cancelamentosConteudo.innerHTML = vazio(state.errosBlocos.get('cancelamentos'));
            return;
        }
        const dados = state.dados && state.dados.cancelamentos;
        if (!dados) {
            dom.cancelamentosConteudo.innerHTML = '';
            return;
        }
        if (!dados.quantidade) {
            dom.cancelamentosConteudo.innerHTML = vazio('Nenhuma venda foi cancelada nesse período.');
            return;
        }
        const comFilial = mostraColunaFilial();
        const cabecalho = [{ texto: 'Venda nº', num: true }];
        if (comFilial) cabecalho.push({ texto: 'Filial' });
        cabecalho.push(
            { texto: 'Cancelada em' },
            { texto: 'Valor', num: true },
            { texto: 'Quem vendeu' },
            { texto: 'Quem autorizou' },
            { texto: 'Motivo' }
        );
        const linhas = dados.itens.map((item) => `<tr><td class="rv-num">${escapeHtml(item.numero_venda)}</td>`
            + `${comFilial ? `<td>${escapeHtml(item.filial)}</td>` : ''}`
            + `<td>${dataHoraBR(item.data_cancelamento)}</td>`
            + `<td class="rv-num">${dinheiro(item.valor)}</td>`
            + `<td>${escapeHtml(item.operador)}</td>`
            + `<td>${escapeHtml(item.autorizador)}</td>`
            + `<td>${escapeHtml(item.motivo || '—')}</td></tr>`);
        dom.cancelamentosConteudo.innerHTML = `<p class="rv-destaque-texto"><strong>${numero(dados.quantidade)} `
            + `${plural(dados.quantidade, 'venda cancelada', 'vendas canceladas')}</strong>, somando <strong>${dinheiro(dados.valor)}</strong>.`
            + `${dados.quantidade > dados.itens.length ? ` A lista mostra as ${numero(dados.itens.length)} mais recentes.` : ''}</p>`
            + tabela('rvCancelamentosTitulo', cabecalho, linhas);
    }

    /* ================= Interações ================= */

    function marcarPeriodo(periodo) {
        botoesPeriodo.forEach((botao) => botao.setAttribute('aria-pressed', String(botao.dataset.periodo === periodo)));
    }

    function escolherPeriodo(periodo) {
        if (periodo === 'escolher') {
            const abrir = dom.datas.hidden;
            dom.datas.hidden = !abrir;
            document.querySelector('[data-periodo="escolher"]').setAttribute('aria-expanded', String(abrir));
            if (abrir) {
                dom.dataInicio.value = state.de;
                dom.dataFim.value = state.ate;
                dom.datasAjuda.textContent = `Você pode escolher até ${MAX_DIAS} dias de uma vez.`;
                dom.datasAjuda.classList.remove('rv-erro');
                dom.dataInicio.focus();
            }
            return;
        }
        dom.datas.hidden = true;
        document.querySelector('[data-periodo="escolher"]').setAttribute('aria-expanded', 'false');
        state.periodo = periodo;
        [state.de, state.ate] = intervaloDoPeriodo(periodo);
        marcarPeriodo(periodo);
        carregarTudo();
    }

    function aplicarDatas() {
        const de = dom.dataInicio.value;
        const ate = dom.dataFim.value;
        let erro = '';
        if (!de || !ate) erro = 'Preencha as duas datas: o primeiro e o último dia.';
        else if (de > ate) erro = 'O primeiro dia precisa vir antes do último dia.';
        else if (diasEntre(de, ate) > MAX_DIAS) erro = `Escolha no máximo ${MAX_DIAS} dias. Você escolheu ${numero(diasEntre(de, ate))}.`;
        if (erro) {
            dom.datasAjuda.textContent = erro;
            dom.datasAjuda.classList.add('rv-erro');
            return;
        }
        dom.datasAjuda.textContent = `Você pode escolher até ${MAX_DIAS} dias de uma vez.`;
        dom.datasAjuda.classList.remove('rv-erro');
        state.periodo = 'escolher';
        state.de = de;
        state.ate = ate;
        marcarPeriodo('escolher');
        carregarTudo();
    }

    function sincronizarChips() {
        dom.chips.querySelectorAll('input[type="checkbox"]').forEach((caixa) => {
            caixa.checked = state.blocos.has(caixa.value);
        });
        dom.chipOperadores.hidden = !state.disponiveis.includes('operadores');
    }

    function definirBlocos(lista) {
        state.blocos = new Set(lista.filter((id) => state.disponiveis.includes(id)));
        sincronizarChips();
        salvarPreferencias();
        renderizarConfirmacao();
        renderizarBlocos();
        buscarBlocosQueFaltam();
    }

    async function imprimirLista(tipo, botao) {
        if (state.visitante || !state.pronto) return;
        const textoOriginal = botao.textContent;
        botao.disabled = true;
        botao.textContent = 'Preparando…';
        try {
            const resposta = await pedir({ blocos: [tipo], resumo: false });
            const itens = resposta[tipo] || [];
            const comFilial = resposta.filial && resposta.filial.id_filial === null;
            const dia = dataBR(hoje());
            if (!itens.length) {
                toast(tipo === 'lista_compras'
                    ? 'Nenhum produto no estoque mínimo ou abaixo dele agora. Não há o que imprimir.'
                    : 'Nenhum produto vencido ou vencendo nos próximos 30 dias. Não há o que imprimir.');
                return;
            }
            if (tipo === 'lista_compras') {
                const cabecalho = (comFilial ? ['Filial'] : []).concat(['Produto', 'Tem agora', 'Mínimo', 'Falta para o mínimo', 'Situação', 'Comprei']);
                const linhas = itens.map((item) => (comFilial ? [item.filial] : []).concat([
                    item.nome,
                    quantidadeTexto(item.estoque, item.unidade),
                    quantidadeTexto(item.estoque_minimo, item.unidade),
                    quantidadeTexto(item.falta, item.unidade),
                    item.situacao,
                    '☐',
                ]));
                imprimirTabela('Lista de compras', `${resposta.filial.nome} · situação em ${dia}`, cabecalho, linhas);
            } else {
                const cabecalho = (comFilial ? ['Filial'] : []).concat(['Produto', 'Quantidade', 'Validade', 'Situação']);
                const linhas = itens.map((item) => {
                    const situacaoValidade = item.dias < 0
                        ? `Vencido há ${numero(-item.dias)} ${plural(-item.dias, 'dia', 'dias')}`
                        : (item.dias === 0 ? 'Vence hoje' : `Vence em ${numero(item.dias)} ${plural(item.dias, 'dia', 'dias')}`);
                    return (comFilial ? [item.filial] : []).concat([
                        item.nome,
                        quantidadeTexto(item.estoque, item.unidade),
                        dataBR(item.validade),
                        situacaoValidade,
                    ]);
                });
                imprimirTabela('Relatório de validade', `${resposta.filial.nome} · situação em ${dia} · vencidos e que vencem em até 30 dias`, cabecalho, linhas);
            }
        } catch (erro) {
            toast(erro && erro.message ? erro.message : 'Não foi possível preparar a impressão. Tente de novo.');
        } finally {
            botao.disabled = false;
            botao.textContent = textoOriginal;
        }
    }

    /** Quantidade em texto puro (para impressão e planilha). */
    function quantidadeTexto(valor, unidade) {
        const div = document.createElement('div');
        div.innerHTML = quantidade(valor, unidade);
        return div.textContent;
    }

    function imprimirTabela(titulo, subtitulo, cabecalho, linhas) {
        const conteudo = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
            + `<title>${escapeHtml(titulo)}</title><style>`
            + 'body{font:16px Arial,sans-serif;padding:24px;color:#000}h1{font-size:24px;margin:0 0 4px}'
            + 'p{margin:0 0 16px;font-size:15px}table{width:100%;border-collapse:collapse}'
            + 'th,td{border:1px solid #777;padding:8px 10px;text-align:left}th{background:#eee}'
            + 'tr{break-inside:avoid}</style></head><body>'
            + `<h1>${escapeHtml(titulo)}</h1><p>${escapeHtml(subtitulo)}</p>`
            + `<table><thead><tr>${cabecalho.map((item) => `<th>${escapeHtml(item)}</th>`).join('')}</tr></thead>`
            + `<tbody>${linhas.map((linha) => `<tr>${linha.map((item) => `<td>${escapeHtml(item)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
            + '</body></html>';
        const quadro = document.createElement('iframe');
        quadro.setAttribute('aria-hidden', 'true');
        quadro.tabIndex = -1;
        quadro.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
        document.body.appendChild(quadro);
        quadro.contentDocument.open();
        quadro.contentDocument.write(conteudo);
        quadro.contentDocument.close();
        quadro.contentWindow.addEventListener('afterprint', () => quadro.remove(), { once: true });
        quadro.contentWindow.focus();
        quadro.contentWindow.print();
    }

    /* ---------- Exportar Excel (CSV com ; e BOM) ---------- */
    function exportarExcel() {
        if (!state.dados || !state.dados.resumo) {
            toast('Espere o relatório terminar de carregar para exportar.');
            return;
        }
        const protegerTexto = (valor) => {
            let texto = valor == null ? '' : String(valor);
            // Evita que o Excel trate um texto como fórmula (=, +, -, @).
            if (/^[\s]*[=+\-@]/.test(texto)) texto = `'${texto}`;
            return `"${texto.replace(/"/g, '""')}"`;
        };
        const T = protegerTexto;
        const D = (valor) => (valor == null ? '' : Number(valor).toFixed(2).replace('.', ','));
        const Q = (valor) => (valor == null ? '' : String(Math.round(Number(valor) * 1000) / 1000).replace('.', ','));
        const P = (valor) => (valor == null ? '' : String(Math.round(Number(valor) * 10) / 10).replace('.', ','));
        const linhas = [];
        const dados = state.dados;
        const resumo = dados.resumo;
        const anterior = dados.resumo_anterior || {};
        const pa = dados.periodo_anterior;

        linhas.push([T('Relatório de vendas')]);
        linhas.push([T('Período'), T(`${dataBR(state.de)} a ${dataBR(state.ate)}`)]);
        linhas.push([T('Filial'), T(nomeFilial())]);
        linhas.push([T('Gerado em'), T(new Date().toLocaleString('pt-BR'))]);
        linhas.push([]);
        linhas.push([T('Resumo')]);
        linhas.push([T('Item'), T('Este período'), T(`Período anterior (${dataBR(pa.data_inicio)} a ${dataBR(pa.data_fim)})`)]);
        linhas.push([T('Dinheiro que entrou (R$)'), D(resumo.faturamento), D(anterior.faturamento)]);
        linhas.push([T('Quantidade de vendas'), String(resumo.num_vendas), String(anterior.num_vendas ?? '')]);
        linhas.push([T('Média por venda (R$)'), D(resumo.media_venda), D(anterior.media_venda)]);
        if (state.acesso.lucro && resumo.lucro !== undefined) {
            linhas.push([T('Lucro estimado (R$)'), D(resumo.lucro), D(anterior.lucro)]);
        }

        if (dados.comparacao_filiais) {
            linhas.push([]);
            linhas.push([T('Comparação entre filiais')]);
            linhas.push([T('Filial'), T('Dinheiro que entrou (R$)'), T('Vendas'), T('Média por venda (R$)')]
                .concat(state.acesso.lucro ? [T('Lucro estimado (R$)')] : []));
            dados.comparacao_filiais.forEach((linha) => linhas.push(
                [T(linha.nome), D(linha.faturamento), String(linha.num_vendas), D(linha.media_venda)]
                    .concat(state.acesso.lucro ? [D(linha.lucro)] : [])
            ));
        }

        const comFilial = mostraColunaFilial();
        blocosMarcados().forEach((id) => {
            const bloco = dados[id];
            if (!bloco) return;
            const titulo = BLOCOS.find((item) => item.id === id).titulo;
            linhas.push([]);
            linhas.push([T(titulo)]);
            if (id === 'mais_vendidos') {
                linhas.push([T('Posição'), T('Produto'), T('Quanto vendeu'), T('Unidade'), T('Dinheiro que entrou (R$)'), T('% do total')]);
                bloco.itens.forEach((item) => linhas.push([T(`${item.posicao}º`), T(item.nome), Q(item.quantidade), T(item.unidade), D(item.faturamento), P(item.percentual)]));
            } else if (id === 'dia_a_dia') {
                linhas.push([T('Data'), T('Dia da semana'), T('Vendas'), T('Total do dia (R$)'), T('Produto campeão'), T('Quanto vendeu dele'), T('Unidade')]);
                bloco.dias.forEach((dia) => linhas.push([
                    T(dataBR(dia.data)), T(dia.dia_semana), String(dia.num_vendas), D(dia.total),
                    T(dia.campeao ? dia.campeao.nome : ''), dia.campeao ? Q(dia.campeao.quantidade) : '', T(dia.campeao ? dia.campeao.unidade : ''),
                ]));
                linhas.push([T('Total do período'), '', String(bloco.total.num_vendas), D(bloco.total.total)]);
            } else if (id === 'horarios') {
                linhas.push([T('Parte do dia'), T('Dinheiro que entrou (R$)'), T('Vendas'), T('% do dinheiro')]);
                bloco.forEach((faixa) => linhas.push([T(faixa.rotulo), D(faixa.valor), String(faixa.num_vendas), P(faixa.percentual)]));
            } else if (id === 'pagamentos') {
                linhas.push([T('Forma de pagamento'), T('Valor (R$)'), T('% do total')]);
                bloco.forEach((forma) => linhas.push([T(FORMAS[forma.forma] || forma.forma), D(forma.valor), P(forma.percentual)]));
            } else if (id === 'parados') {
                linhas.push([T('Produto')].concat(comFilial ? [T('Filial')] : [], [T('Estoque agora'), T('Unidade'), T('Vendas no período'), T('Dinheiro parado (R$)'), T('Calculado pelo')]));
                bloco.itens.forEach((item) => linhas.push([T(item.nome)].concat(comFilial ? [T(item.filial)] : [], [
                    Q(item.estoque), T(item.unidade), String(item.num_vendas), D(item.valor_parado), T(item.sem_custo ? 'preço de venda' : 'preço de custo'),
                ])));
            } else if (id === 'vai_acabar') {
                linhas.push([T('Produto')].concat(comFilial ? [T('Filial')] : [], [T('Estoque agora'), T('Unidade'), T('Vende por dia (média)'), T('Quando acaba')]));
                bloco.itens.forEach((item) => linhas.push([T(item.nome)].concat(comFilial ? [T(item.filial)] : [], [
                    Q(item.estoque), T(item.unidade), Q(item.media_diaria), T(textoAcabaEm(item).texto),
                ])));
            } else if (id === 'operadores') {
                linhas.push([T('Operador'), T('Vendas'), T('Dinheiro que entrou (R$)'), T('Vendas canceladas')]);
                bloco.forEach((linha) => linhas.push([T(linha.nome), String(linha.num_vendas), D(linha.valor), String(linha.cancelamentos)]));
            }
        });

        if (state.mostrarCancelamentos && dados.cancelamentos && dados.cancelamentos.itens.length) {
            linhas.push([]);
            linhas.push([T('Vendas canceladas')]);
            linhas.push([T('Venda nº')].concat(comFilial ? [T('Filial')] : [], [T('Cancelada em'), T('Valor (R$)'), T('Quem vendeu'), T('Quem autorizou'), T('Motivo')]));
            dados.cancelamentos.itens.forEach((item) => linhas.push([String(item.numero_venda)].concat(comFilial ? [T(item.filial)] : [], [
                T(dataHoraBR(item.data_cancelamento)), D(item.valor), T(item.operador), T(item.autorizador), T(item.motivo || ''),
            ])));
        }

        const conteudo = `﻿${linhas.map((linha) => linha.join(';')).join('\r\n')}\r\n`;
        const endereco = URL.createObjectURL(new Blob([conteudo], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = endereco;
        link.download = `relatorio-vendas_${dataBR(state.de).replace(/\//g, '-')}_a_${dataBR(state.ate).replace(/\//g, '-')}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(endereco), 1000);
    }

    function ligarEventos() {
        botoesPeriodo.forEach((botao) => botao.addEventListener('click', () => escolherPeriodo(botao.dataset.periodo)));
        dom.aplicarDatas.addEventListener('click', aplicarDatas);
        [dom.dataInicio, dom.dataFim].forEach((campo) => campo.addEventListener('keydown', (evento) => {
            if (evento.key === 'Enter') aplicarDatas();
        }));

        dom.chips.addEventListener('change', (evento) => {
            const caixa = evento.target.closest('input[type="checkbox"]');
            if (!caixa) return;
            if (caixa.checked) state.blocos.add(caixa.value);
            else state.blocos.delete(caixa.value);
            definirBlocos(Array.from(state.blocos));
        });
        dom.marcarTudo.addEventListener('click', () => definirBlocos(state.disponiveis.slice()));
        dom.soEssencial.addEventListener('click', () => definirBlocos(ESSENCIAL.slice()));

        dom.filial.addEventListener('change', () => {
            state.filial = dom.filial.value;
            carregarTudo();
        });

        dom.blocos.addEventListener('click', (evento) => {
            const pagina = evento.target.closest('[data-rv-pagina]');
            if (pagina && !pagina.disabled) {
                carregarBlocos(['mais_vendidos'], Number(pagina.dataset.rvPagina)).then(() => {
                    const titulo = $('rvTitulo-mais_vendidos');
                    if (titulo) titulo.focus();
                });
                return;
            }
            const recarregar = evento.target.closest('[data-rv-recarregar]');
            if (recarregar) carregarBlocos([recarregar.dataset.rvRecarregar]);
        });

        dom.verCancelamentos.addEventListener('click', () => {
            state.mostrarCancelamentos = true;
            renderizarCancelamentos();
            carregarBlocos(['cancelamentos']);
            dom.cancelamentos.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        dom.imprimirCompras.addEventListener('click', () => imprimirLista('lista_compras', dom.imprimirCompras));
        dom.imprimirValidade.addEventListener('click', () => imprimirLista('validade', dom.imprimirValidade));
        dom.imprimir.addEventListener('click', () => window.print());
        dom.exportar.addEventListener('click', exportarExcel);

        // No papel sai sempre o tema claro: o tema escuro (css/tema-escuro.css,
        // carregado por último) venceria as cores de impressão e deixaria
        // texto claro em folha branca. Vale também para o Ctrl+P.
        let estavaEscuro = false;
        window.addEventListener('beforeprint', () => {
            estavaEscuro = document.documentElement.dataset.hydraTheme === 'dark';
            if (estavaEscuro) delete document.documentElement.dataset.hydraTheme;
        });
        window.addEventListener('afterprint', () => {
            if (estavaEscuro) document.documentElement.dataset.hydraTheme = 'dark';
            estavaEscuro = false;
        });
    }

    /* ================= Início ================= */

    function montarSeletorDeFilial(idAtiva) {
        const opcoes = [];
        if (state.acesso.todas_filiais && state.filiais.length > 1) {
            opcoes.push('<option value="todas">Todas as filiais</option>');
        }
        state.filiais.forEach((filial) => {
            opcoes.push(`<option value="${filial.id_filial}">${escapeHtml(filial.nome)}</option>`);
        });
        dom.filial.innerHTML = opcoes.join('');
        if (state.acesso.todas_filiais && state.filiais.length > 1) state.filial = 'todas';
        else state.filial = String(idAtiva);
        dom.filial.value = state.filial;
        // Gerente e funcionário só veem a filial em que estão trabalhando.
        dom.filial.disabled = opcoes.length <= 1;
    }

    function modoVisitante() {
        state.visitante = true;
        situacao('aviso', 'Entre com seu usuário para ver os relatórios do seu mercado. <a href="login.html">Entrar no sistema</a>');
        dom.filial.innerHTML = '<option>Entre para escolher</option>';
        renderizarTudo();
    }

    async function iniciar() {
        ligarEventos();
        [state.de, state.ate] = intervaloDoPeriodo(state.periodo);
        dom.dataInicio.max = hoje();
        dom.dataFim.max = hoje();
        marcarPeriodo(state.periodo);
        sincronizarChips();
        renderizarConfirmacao();

        let usuario;
        try {
            ({ usuario } = await window.hydraSessao());
        } catch (erro) {
            if (erro && erro.status === 401) {
                modoVisitante();
                return;
            }
            situacao('erro', 'Não foi possível conferir o seu acesso. Confira a internet e atualize a página.', () => window.location.reload());
            return;
        }

        window.hydraAplicarMenuPorPermissao(usuario);
        const nome = $('hydroUserName');
        if (nome) nome.textContent = (usuario.nome || '').split(' ')[0];
        const linkAlertas = $('hydroAlertasSettingsLink');
        if (linkAlertas && window.hydraPode(usuario, ['relatorios.visualizar'])) linkAlertas.hidden = false;
        if (!window.hydraGuardaDeTela(usuario, ['relatorios.visualizar'])) return;

        try {
            situacao('carregando', 'Carregando suas preferências…');
            const preferencias = await window.hydraApi('/relatorios/preferencias');
            state.acesso = preferencias.acesso;
            state.disponiveis = preferencias.blocos_disponiveis;
            state.blocos = new Set(preferencias.blocos);
            state.filiais = preferencias.filiais || [];
            montarSeletorDeFilial(preferencias.id_filial_ativa);
            sincronizarChips();
            state.pronto = true;
            carregarTudo();
        } catch (erro) {
            situacao('erro', mensagemDeErro(erro), () => window.location.reload());
        }
    }

    iniciar();
})();
