/**
 * Tela Relatório de Vendas (pages/dashboard.html).
 *
 * Fluxo:
 *   1. GET /api/relatorios/preferencias — blocos que o usuário deixou
 *      marcados, o que o cargo dele pode ver e a filial em que ele está
 *      trabalhando (o relatório mostra só essa filial);
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
    /** Quantos meses (contando o atual) aparecem na lista do Passo 1. */
    const MESES_NA_LISTA = 12;
    const NOMES_MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

    const moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
    const umaCasa = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
    const tresCasas = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

    /* ================= Elementos ================= */

    const $ = (id) => document.getElementById(id);
    const dom = {
        periodo: $('rvPeriodo'),
        dataInicio: $('rvDataInicio'),
        dataFim: $('rvDataFim'),
        aplicarDatas: $('rvAplicarDatas'),
        datasAjuda: $('rvDatasAjuda'),
        chips: $('rvChips'),
        chipOperadores: $('rvChipOperadores'),
        marcarTudo: $('rvMarcarTudo'),
        multi: $('rvMulti'),
        multiBotao: $('rvMultiBotao'),
        multiTexto: $('rvMultiTexto'),
        multiPainel: $('rvMultiPainel'),
        multiPronto: $('rvMultiPronto'),
        confirmacao: $('rvConfirmacao'),
        situacao: $('rvSituacao'),
        resumo: $('rvResumo'),
        comparando: $('rvComparando'),
        cartoes: $('rvCartoes'),
        avisoCusto: $('rvAvisoCusto'),
        blocos: $('rvBlocos'),
        nenhumBloco: $('rvNenhumBloco'),
        cancelamentos: $('rvCancelamentos'),
        cancelamentosConteudo: $('rvCancelamentosConteudo'),
        verCancelamentos: $('rvVerCancelamentos'),
        ferramentas: $('rvFerramentas'),
    };

    /* ================= Estado ================= */

    const state = {
        periodo: '7dias',
        de: '',
        ate: '',
        filial: '',
        blocos: new Set(ESSENCIAL),
        disponiveis: BLOCOS.map((bloco) => bloco.id),
        acesso: { nivel: 'funcionario', operadores: false, cancelamentos: false, lucro: false },
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

    /**
     * Períodos do Passo 1: 'hoje', 'ontem', '7dias' ou 'mes:AAAA-MM'.
     * O mês atual vai do dia 1 até hoje; os outros meses, do dia 1 ao último.
     */
    function intervaloDoPeriodo(periodo) {
        const dia = hoje();
        const mes = /^mes:(\d{4})-(\d{2})$/.exec(periodo || '');
        if (mes) {
            const ano = Number(mes[1]);
            const indice = Number(mes[2]) - 1;
            const primeiro = chaveData(new Date(ano, indice, 1));
            const ultimo = chaveData(new Date(ano, indice + 1, 0));
            return [primeiro, ultimo > dia ? dia : ultimo];
        }
        switch (periodo) {
            case 'hoje':
                return [dia, dia];
            case 'ontem':
                return [somarDias(dia, -1), somarDias(dia, -1)];
            case '7dias':
            default:
                return [somarDias(dia, -6), dia];
        }
    }

    /** Monta o dropdown do Passo 1: atalhos, os últimos meses e "outras datas". */
    function montarOpcoesDePeriodo() {
        const agora = new Date(`${hoje()}T12:00:00`);
        const meses = [];
        for (let i = 0; i < MESES_NA_LISTA; i += 1) {
            const data = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
            const valor = `mes:${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
            const nome = `${NOMES_MESES[data.getMonth()]} de ${data.getFullYear()}`;
            const extra = i === 0 ? ' (este mês)' : (i === 1 ? ' (mês passado)' : '');
            meses.push(`<option value="${valor}">${nome}${extra}</option>`);
        }
        dom.periodo.innerHTML = '<optgroup label="Atalhos">'
            + '<option value="hoje">Hoje</option>'
            + '<option value="ontem">Ontem</option>'
            + '<option value="7dias">Últimos 7 dias</option>'
            + '</optgroup>'
            + `<optgroup label="Mês">${meses.join('')}</optgroup>`
            + '<optgroup label="Outro período">'
            + '<option value="escolher">Outras datas (use os campos ao lado)</option>'
            + '</optgroup>';
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
        const filial = state.filiais.find((item) => String(item.id_filial) === String(state.filial));
        return filial ? `filial ${filial.nome}` : 'filial atual';
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
        return state.periodo === '7dias' ? 'Tente escolher um mês na lista do Passo 1.' : 'Tente Últimos 7 dias.';
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
        dom.ferramentas.hidden = !pode;
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

    function ajudaDatas(texto, erro) {
        dom.datasAjuda.textContent = texto || `Você pode escolher até ${MAX_DIAS} dias de uma vez.`;
        dom.datasAjuda.classList.toggle('rv-erro', Boolean(erro));
    }

    /** Deixa o dropdown e os campos de data mostrando o período atual. */
    function marcarPeriodo(periodo) {
        dom.periodo.value = periodo;
        dom.dataInicio.value = state.de;
        dom.dataFim.value = state.ate;
    }

    function escolherPeriodo(periodo) {
        ajudaDatas();
        if (periodo === 'escolher') {
            dom.dataInicio.focus();
            return;
        }
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
            ajudaDatas(erro, true);
            return;
        }
        ajudaDatas();
        // Se as datas batem com um item da lista, o dropdown mostra esse item.
        const opcao = Array.from(dom.periodo.options).find((item) => {
            if (item.value === 'escolher') return false;
            const [inicio, fim] = intervaloDoPeriodo(item.value);
            return inicio === de && fim === ate;
        });
        state.periodo = opcao ? opcao.value : 'escolher';
        state.de = de;
        state.ate = ate;
        marcarPeriodo(state.periodo);
        carregarTudo();
    }

    /* ---------- Dropdown do Passo 2 ---------- */
    function textoDoDropdown() {
        const marcados = blocosMarcados();
        const total = state.disponiveis.length;
        if (!marcados.length) return 'Nenhuma parte escolhida — toque para escolher';
        if (marcados.length === total) return `Todas as partes (${total})`;
        if (marcados.length <= 2) {
            return marcados.map((id) => {
                const caixa = dom.chips.querySelector(`input[value="${id}"]`);
                return caixa ? caixa.nextElementSibling.textContent : id;
            }).join(' + ');
        }
        return `${marcados.length} de ${total} partes escolhidas`;
    }

    function abrirDropdown(abrir) {
        dom.multiPainel.hidden = !abrir;
        dom.multiBotao.setAttribute('aria-expanded', String(abrir));
        if (abrir) {
            const primeira = dom.chips.querySelector('.rv-opcao:not([hidden]) input');
            if (primeira) primeira.focus();
        }
    }

    function sincronizarChips() {
        dom.chips.querySelectorAll('input[type="checkbox"]').forEach((caixa) => {
            caixa.checked = state.blocos.has(caixa.value);
        });
        dom.chipOperadores.hidden = !state.disponiveis.includes('operadores');
        dom.multiTexto.textContent = textoDoDropdown();
    }

    function definirBlocos(lista) {
        state.blocos = new Set(lista.filter((id) => state.disponiveis.includes(id)));
        sincronizarChips();
        salvarPreferencias();
        renderizarConfirmacao();
        renderizarBlocos();
        buscarBlocosQueFaltam();
    }

    function ligarEventos() {
        dom.periodo.addEventListener('change', () => escolherPeriodo(dom.periodo.value));
        dom.aplicarDatas.addEventListener('click', aplicarDatas);
        [dom.dataInicio, dom.dataFim].forEach((campo) => {
            campo.addEventListener('keydown', (evento) => {
                if (evento.key === 'Enter') aplicarDatas();
            });
            // Mexeu numa data: o dropdown passa a dizer "Outras datas" até aplicar.
            campo.addEventListener('input', () => {
                if (campo.value) dom.periodo.value = 'escolher';
            });
        });

        dom.multiBotao.addEventListener('click', () => abrirDropdown(dom.multiPainel.hidden));
        dom.multiPronto.addEventListener('click', () => {
            abrirDropdown(false);
            dom.multiBotao.focus();
        });
        document.addEventListener('click', (evento) => {
            if (!dom.multiPainel.hidden && !dom.multi.contains(evento.target)) abrirDropdown(false);
        });
        dom.multi.addEventListener('keydown', (evento) => {
            if (evento.key === 'Escape' && !dom.multiPainel.hidden) {
                abrirDropdown(false);
                dom.multiBotao.focus();
            }
        });

        dom.chips.addEventListener('change', (evento) => {
            const caixa = evento.target.closest('input[type="checkbox"]');
            if (!caixa) return;
            if (caixa.checked) state.blocos.add(caixa.value);
            else state.blocos.delete(caixa.value);
            definirBlocos(Array.from(state.blocos));
        });
        dom.marcarTudo.addEventListener('click', () => definirBlocos(state.disponiveis.slice()));

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

    function modoVisitante() {
        state.visitante = true;
        situacao('aviso', 'Entre com seu usuário para ver os relatórios do seu mercado. <a href="login.html">Entrar no sistema</a>');
        renderizarTudo();
    }

    async function iniciar() {
        montarOpcoesDePeriodo();
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
            // O relatório é sempre da filial em que a pessoa está trabalhando
            // (para ver outra, ela troca de filial no menu).
            state.filial = String(preferencias.id_filial_ativa);
            sincronizarChips();
            state.pronto = true;
            carregarTudo();
        } catch (erro) {
            situacao('erro', mensagemDeErro(erro), () => window.location.reload());
        }
    }

    iniciar();
})();
