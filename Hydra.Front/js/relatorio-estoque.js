/**
 * Tela Relatório de Estoque (pages/relatorio.html).
 *
 * Jornada pensada: o mercado cadastrou o estoque, vendeu, e abre o
 * relatório para ver o que entrou e o que saiu de cada produto, o que está
 * faltando e o que está para vencer. Sem valores em dinheiro: a parte
 * financeira fica para um módulo futuro.
 *
 * Fluxo:
 *   GET /api/relatorios/estoque-produtos  — tudo de uma vez (cartões e conteúdo);
 *   ... &secao=movimentacoes              — só a lista de movimentações,
 *                                           ao trocar de página ou de tipo;
 *   ... &completo=1                       — tudo, com a lista inteira, para o PDF
 *                                           (montado por js/relatorio-estoque-pdf.js,
 *                                           só com a parte aberta na tela).
 *
 * O relatório é sempre da filial em que a pessoa está trabalhando (a da
 * sessão, decidida no back-end). Tudo é formatado em pt-BR.
 */
(function () {
    'use strict';

    /* ================= Constantes ================= */

    const MAX_DIAS = 366;
    /** Linhas da tabela "Entradas e saídas" mostradas de cada vez. */
    const LINHAS_POR_VEZ = 50;
    const UNIDADES_FRACIONADAS = ['kg', 'g', 'l', 'ml'];
    /** Os cartões do topo são as abas da tela (ver pages/relatorio.html). */
    const ABAS = ['movimento', 'falta', 'vencendo'];

    const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
    const tresCasas = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

    /* ================= Elementos ================= */

    const $ = (id) => document.getElementById(id);
    const dom = {
        de: $('reDe'),
        ate: $('reAte'),
        busca: $('reBusca'),
        categoria: $('reCategoria'),
        pdf: $('rePdf'),
        info: $('reInfo'),
        situacao: $('reSituacao'),
        cartoes: $('reCartoes'),
        valorEntradas: $('reValorEntradas'),
        detalheEntradas: $('reDetalheEntradas'),
        valorSaidas: $('reValorSaidas'),
        detalheSaidas: $('reDetalheSaidas'),
        valorFalta: $('reValorFalta'),
        detalheFalta: $('reDetalheFalta'),
        valorVencendo: $('reValorVencendo'),
        detalheVencendo: $('reDetalheVencendo'),
        painel: $('rePainel'),
        nomeFalta: $('reNomeFalta'),
        nomeVencendo: $('reNomeVencendo'),
        ajudaMovimento: $('reAjudaMovimento'),
        tipos: $('reTipos'),
        diasValidade: $('reDiasValidade'),
        conteudo: {
            produtos: $('reConteudo-produtos'),
            movimentacoes: $('reConteudo-movimentacoes'),
            falta: $('reConteudo-falta'),
            vencendo: $('reConteudo-vencendo'),
        },
    };
    const abas = Array.from(document.querySelectorAll('.re-cartao[role="tab"]'));
    const segmentosVisao = Array.from(document.querySelectorAll('.re-segmento[data-visao]'));
    const segmentosTipo = Array.from(document.querySelectorAll('.re-segmento[data-tipo]'));

    /* ================= Estado ================= */

    const state = {
        de: '',
        ate: '',
        busca: '',
        categoria: '',
        diasValidade: 30,
        tipo: 'todas',
        pagina: 1,
        aba: 'movimento',
        /** Dentro de "Entradas e saídas": 'produtos' (por produto) ou 'lista' (cada movimentação). */
        visao: 'produtos',
        dados: null,
        movimentacoes: null,
        carregando: false,
        carregandoMov: false,
        erro: '',
        requisicao: 0,
        requisicaoMov: 0,
        ordem: { coluna: 'nome', direcao: 'asc' },
        linhasVisiveis: LINHAS_POR_VEZ,
        usuario: null,
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

    function diasEntre(de, ate) {
        return Math.round((new Date(`${ate}T12:00:00`) - new Date(`${de}T12:00:00`)) / 86400000) + 1;
    }

    /** "2026-11-26" → "26/11/2026" (sem passar por Date, para não sofrer com fuso). */
    function dataBR(chave) {
        const [ano, mes, dia] = String(chave).slice(0, 10).split('-');
        return `${dia}/${mes}/${ano}`;
    }

    function horaBR(valor) {
        return String(valor).slice(11, 16);
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

    function numero(valor) {
        return inteiro.format(Number(valor || 0));
    }

    function plural(qtd, singular, pluralTexto) {
        return Number(qtd) === 1 ? singular : pluralTexto;
    }

    /** Quantidade com a unidade certa, em texto puro: "12,5 kg", "30 un". */
    function quantidade(valor, unidade) {
        const sigla = String(unidade || 'un').toLowerCase();
        const numeroValor = Number(valor || 0);
        const formato = UNIDADES_FRACIONADAS.includes(sigla) || !Number.isInteger(numeroValor) ? tresCasas : inteiro;
        return `${formato.format(numeroValor)} ${sigla}`;
    }

    /** Situação do estoque → selo. null quando está tudo bem. */
    function seloEstoque(situacao) {
        switch (situacao) {
            case 'acabou': return { texto: 'Acabou', cor: 'vermelho', peso: 0 };
            case 'abaixo': return { texto: 'Abaixo do mínimo', cor: 'ambar', peso: 2 };
            case 'no_minimo': return { texto: 'No mínimo', cor: 'ambar', peso: 3 };
            case 'inativo': return { texto: 'Inativo', cor: 'neutro', peso: 6 };
            default: return null;
        }
    }

    /** Dias até a validade → selo. */
    function seloValidade(dias) {
        if (dias == null) return null;
        if (dias < 0) {
            const qtd = -dias;
            return { texto: `Vencido há ${numero(qtd)} ${plural(qtd, 'dia', 'dias')}`, cor: 'vermelho', peso: 1 };
        }
        if (dias === 0) return { texto: 'Vence hoje', cor: 'vermelho', peso: 1 };
        if (dias === 1) return { texto: 'Vence amanhã', cor: 'ambar', peso: 4 };
        return { texto: `Vence em ${numero(dias)} dias`, cor: 'ambar', peso: 4 };
    }

    function selo(info) {
        return info ? `<span class="re-selo re-selo-${info.cor}">${escapeHtml(info.texto)}</span>` : '';
    }

    function textoFiltros() {
        const partes = [];
        if (state.busca) partes.push(`produto “${escapeHtml(state.busca)}”`);
        if (state.categoria) partes.push(`categoria ${escapeHtml(state.categoria)}`);
        return partes;
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

    /** Faixa acima dos cartões: carregando, aviso ou erro. */
    function situacao(tipo, html, tentarDeNovo) {
        dom.situacao.className = 're-situacao';
        dom.situacao.innerHTML = '';
        if (!tipo) return;
        if (tipo === 'carregando') dom.situacao.classList.add('re-carregando');
        if (tipo === 'erro') dom.situacao.classList.add('re-erro');
        const texto = document.createElement('span');
        texto.innerHTML = html;
        dom.situacao.appendChild(texto);
        if (tentarDeNovo) {
            const botao = document.createElement('button');
            botao.type = 'button';
            botao.className = 're-btn';
            botao.textContent = 'Tentar de novo';
            botao.addEventListener('click', tentarDeNovo);
            dom.situacao.appendChild(botao);
        }
    }

    function mensagemDeErro(erro) {
        if (erro && erro.status && erro.message) return escapeHtml(erro.message);
        return 'Não foi possível carregar o relatório. Confira a internet e tente de novo.';
    }

    function vazio(titulo, texto, neutro) {
        return `<div class="re-vazio${neutro ? ' re-vazio-neutro' : ''}">`
            + `<span class="re-vazio-icone" aria-hidden="true">${neutro ? '—' : '✓'}</span>`
            + `<strong>${titulo}</strong>${texto ? `<span>${texto}</span>` : ''}</div>`;
    }

    function dicaSemMovimento() {
        const dicas = ['Mude a data inicial e a data final'];
        if (state.busca || state.categoria) dicas.push('ou limpe a busca e a categoria');
        return `${dicas.join(' ')}.`;
    }

    /* ================= API ================= */

    function parametros(extra) {
        const lista = new URLSearchParams({
            data_inicio: state.de,
            data_fim: state.ate,
            dias_validade: String(state.diasValidade),
            tipo: state.tipo,
            pagina: String(state.pagina),
        });
        if (state.busca) lista.set('busca', state.busca);
        if (state.categoria) lista.set('categoria', state.categoria);
        Object.entries(extra || {}).forEach(([chave, valor]) => lista.set(chave, valor));
        return lista.toString();
    }

    async function carregar() {
        if (state.visitante || !state.pronto) return;
        const id = ++state.requisicao;
        state.requisicaoMov += 1;
        state.carregando = true;
        state.erro = '';
        situacao('carregando', 'Carregando o relatório…');
        renderizarTudo();
        try {
            const resposta = await window.hydraApi(`/relatorios/estoque-produtos?${parametros()}`);
            if (id !== state.requisicao) return;
            state.dados = resposta;
            state.movimentacoes = resposta.movimentacoes;
            state.carregando = false;
            state.linhasVisiveis = LINHAS_POR_VEZ;
            montarCategorias(resposta.categorias || []);
            situacao(null);
        } catch (erro) {
            if (id !== state.requisicao) return;
            state.carregando = false;
            state.dados = null;
            state.movimentacoes = null;
            state.erro = mensagemDeErro(erro);
            situacao('erro', state.erro, carregar);
        }
        renderizarTudo();
    }

    async function carregarMovimentacoes() {
        if (!state.dados) return;
        const id = ++state.requisicaoMov;
        state.carregandoMov = true;
        renderizarMovimentacoes();
        try {
            const resposta = await window.hydraApi(`/relatorios/estoque-produtos?${parametros({ secao: 'movimentacoes' })}`);
            if (id !== state.requisicaoMov) return;
            state.movimentacoes = resposta.movimentacoes;
        } catch (erro) {
            if (id !== state.requisicaoMov) return;
            toast(erro && erro.message ? erro.message : 'Não foi possível carregar as movimentações.');
        } finally {
            if (id === state.requisicaoMov) {
                state.carregandoMov = false;
                renderizarMovimentacoes();
            }
        }
    }

    /* ================= Renderização ================= */

    function renderizarTudo() {
        renderizarInfo();
        renderizarCartoes();
        renderizarVisao();
        renderizarProdutos();
        renderizarMovimentacoes();
        renderizarFalta();
        renderizarVencendo();
    }

    function renderizarInfo() {
        if (dom.info.classList.contains('re-erro')) return;
        if (state.visitante) {
            dom.info.textContent = '';
            return;
        }
        const filial = state.dados && state.dados.filial && state.dados.filial.nome;
        const intervalo = state.de === state.ate
            ? `no dia <strong>${dataBR(state.de)}</strong>`
            : `de <strong>${dataBR(state.de)}</strong> a <strong>${dataBR(state.ate)}</strong>`;
        const partes = [];
        if (filial) partes.push(`Filial <strong>${escapeHtml(filial)}</strong>`);
        partes.push(`Movimentações ${intervalo}`);
        dom.info.innerHTML = partes.concat(textoFiltros()).join(' · ');
    }

    function renderizarCartoes() {
        const resumo = state.dados && state.dados.resumo;
        const espera = state.carregando ? '…' : '—';
        const falta = dom.cartoes.querySelector('.re-cartao-falta');
        const vence = dom.cartoes.querySelector('.re-cartao-vencendo');
        if (!resumo) {
            [dom.valorEntradas, dom.valorSaidas, dom.valorFalta, dom.valorVencendo].forEach((el) => { el.textContent = espera; });
            [dom.detalheEntradas, dom.detalheSaidas, dom.detalheFalta, dom.detalheVencendo].forEach((el) => { el.textContent = ''; });
            dom.nomeFalta.textContent = 'produtos';
            dom.nomeVencendo.textContent = 'lotes';
            falta.classList.remove('re-com-alerta');
            vence.classList.remove('re-com-alerta');
            return;
        }

        const { entradas, saidas, em_falta: emFalta, vencendo } = resumo;
        dom.valorEntradas.textContent = numero(entradas.registros);
        dom.detalheEntradas.textContent = entradas.registros
            ? `em ${numero(entradas.produtos)} ${plural(entradas.produtos, 'produto', 'produtos')}`
            : 'nenhuma no período';

        dom.valorSaidas.textContent = numero(saidas.registros);
        dom.detalheSaidas.textContent = saidas.registros
            ? `${numero(saidas.por_venda)} por venda · ${numero(saidas.registros - saidas.por_venda)} outras`
            : 'nenhuma no período';

        dom.valorFalta.textContent = numero(emFalta.total);
        dom.nomeFalta.textContent = plural(emFalta.total, 'produto', 'produtos');
        dom.detalheFalta.textContent = emFalta.total
            ? `${numero(emFalta.acabou)} ${plural(emFalta.acabou, 'acabou', 'acabaram')} · ${numero(emFalta.total - emFalta.acabou)} no mínimo`
            : 'tudo acima do mínimo';
        falta.classList.toggle('re-com-alerta', emFalta.total > 0);

        dom.valorVencendo.textContent = numero(vencendo.lotes);
        dom.nomeVencendo.textContent = plural(vencendo.lotes, 'lote', 'lotes');
        dom.detalheVencendo.textContent = vencendo.lotes
            ? `${numero(vencendo.vencidos)} ${plural(vencendo.vencidos, 'vencido', 'vencidos')} · em até ${state.diasValidade} dias`
            : `nada vence em ${state.diasValidade} dias`;
        vence.classList.toggle('re-com-alerta', vencendo.lotes > 0);
    }

    /** "Entradas e saídas": mostra a tabela por produto ou a lista de movimentações. */
    function renderizarVisao() {
        const lista = state.visao === 'lista';
        segmentosVisao.forEach((botao) => botao.setAttribute('aria-pressed', String(botao.dataset.visao === state.visao)));
        dom.tipos.hidden = !lista;
        dom.conteudo.produtos.hidden = lista;
        dom.conteudo.movimentacoes.hidden = !lista;
        dom.ajudaMovimento.innerHTML = lista
            ? 'Cada entrada e saída do período, da mais recente para a mais antiga, com o motivo e quem registrou.'
            : 'Quanto entrou e quanto saiu de cada produto no período. <strong>Vendido</strong> já desconta as vendas canceladas; '
                + '<strong>Outras saídas</strong> são perdas, vencimentos, ajustes e devoluções. Toque no nome de uma coluna para ordenar.';
    }

    function carregandoOuErro(alvo) {
        if (state.carregando && !state.dados) {
            alvo.innerHTML = '<p class="re-carregando-bloco">Carregando…</p>';
            return true;
        }
        if (!state.dados) {
            alvo.innerHTML = state.visitante
                ? ''
                : vazio('Nada para mostrar ainda', state.erro || 'Escolha um período para ver o relatório.', true);
            return true;
        }
        return false;
    }

    function tabela(cabecalho, linhas) {
        const ths = cabecalho.map((coluna) => {
            const classe = coluna.num ? ' class="re-num"' : '';
            if (!coluna.ordenar) return `<th scope="col"${classe}>${escapeHtml(coluna.texto)}</th>`;
            const ativo = state.ordem.coluna === coluna.ordenar;
            const sort = ativo ? (state.ordem.direcao === 'asc' ? 'ascending' : 'descending') : 'none';
            return `<th scope="col"${classe} aria-sort="${sort}"><button type="button" class="re-ordenar" data-ordenar="${coluna.ordenar}">${escapeHtml(coluna.texto)}</button></th>`;
        }).join('');
        return `<div class="re-tabela-rolagem"><table class="re-tabela"><thead><tr>${ths}</tr></thead>`
            + `<tbody>${linhas.join('')}</tbody></table></div>`;
    }

    function celulaQtd(valor, unidade, comSinal) {
        if (!Number(valor)) return '<td class="re-num re-zero">—</td>';
        const sinal = comSinal && Number(valor) > 0 ? '+' : '';
        return `<td class="re-num${comSinal && Number(valor) > 0 ? ' re-mais' : ''}">${sinal}${escapeHtml(quantidade(valor, unidade))}</td>`;
    }

    function celulaProduto(nome, categoria) {
        return `<td><span class="re-nome">${escapeHtml(nome)}</span>`
            + `${categoria ? `<span class="re-sub">${escapeHtml(categoria)}</span>` : ''}</td>`;
    }

    /* ---------- Entradas e saídas por produto ---------- */

    function selosDoProduto(item) {
        const selos = [seloEstoque(item.situacao_estoque), seloValidade(item.vence_em_dias)].filter(Boolean);
        return selos;
    }

    function pesoDoProduto(item) {
        const selos = selosDoProduto(item);
        return selos.length ? Math.min(...selos.map((s) => s.peso)) : 5;
    }

    function ordenarProdutos(lista) {
        const { coluna, direcao } = state.ordem;
        const fator = direcao === 'asc' ? 1 : -1;
        return lista.slice().sort((a, b) => {
            let comparacao;
            if (coluna === 'nome') comparacao = a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });
            else if (coluna === 'situacao') comparacao = pesoDoProduto(a) - pesoDoProduto(b);
            else comparacao = Number(a[coluna]) - Number(b[coluna]);
            if (comparacao === 0) comparacao = a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }) * fator;
            return comparacao * fator;
        });
    }

    function renderizarProdutos() {
        const alvo = dom.conteudo.produtos;
        if (carregandoOuErro(alvo)) return;
        const lista = state.dados.por_produto || [];
        if (!lista.length) {
            alvo.innerHTML = vazio('Nenhuma entrada ou saída nesse período', dicaSemMovimento(), true);
            return;
        }
        const ordenada = ordenarProdutos(lista);
        const visiveis = ordenada.slice(0, state.linhasVisiveis);
        const linhas = visiveis.map((item) => {
            const selos = selosDoProduto(item);
            return `<tr>${celulaProduto(item.nome, item.categoria)}`
                + `${celulaQtd(item.entradas, item.unidade, true)}`
                + `${celulaQtd(item.vendido, item.unidade)}`
                + `${celulaQtd(item.outras_saidas, item.unidade)}`
                + `<td class="re-num">${escapeHtml(quantidade(item.estoque, item.unidade))}</td>`
                + `<td><div class="re-selos">${selos.length ? selos.map(selo).join('') : selo({ texto: 'Normal', cor: 'verde' })}</div></td></tr>`;
        });
        const restantes = ordenada.length - visiveis.length;
        const rodape = `<div class="re-rodape-lista"><span>${numero(lista.length)} ${plural(lista.length, 'produto movimentado', 'produtos movimentados')}`
            + `${state.dados.por_produto_limitado ? ' (mostrando os primeiros 1.000; use a busca para achar outros)' : ''}</span>`
            + `${restantes > 0 ? `<button type="button" class="re-btn" data-mais-linhas>Mostrar mais ${numero(Math.min(restantes, LINHAS_POR_VEZ))}</button>` : ''}</div>`;
        alvo.innerHTML = tabela([
            { texto: 'Produto', ordenar: 'nome' },
            { texto: 'Entradas', num: true, ordenar: 'entradas' },
            { texto: 'Vendido', num: true, ordenar: 'vendido' },
            { texto: 'Outras saídas', num: true, ordenar: 'outras_saidas' },
            { texto: 'Estoque agora', num: true, ordenar: 'estoque' },
            { texto: 'Situação', ordenar: 'situacao' },
        ], linhas) + rodape;
    }

    /* ---------- Movimentações ---------- */

    function renderizarMovimentacoes() {
        const alvo = dom.conteudo.movimentacoes;
        segmentosTipo.forEach((botao) => botao.setAttribute('aria-pressed', String(botao.dataset.tipo === state.tipo)));
        if (carregandoOuErro(alvo)) return;
        const mov = state.movimentacoes;
        if (state.carregandoMov || !mov) {
            alvo.innerHTML = '<p class="re-carregando-bloco">Carregando…</p>';
            return;
        }
        if (!mov.itens.length) {
            const titulo = state.tipo === 'entrada' ? 'Nenhuma entrada nesse período'
                : (state.tipo === 'saida' ? 'Nenhuma saída nesse período' : 'Nenhuma movimentação nesse período');
            alvo.innerHTML = vazio(titulo, dicaSemMovimento(), true);
            return;
        }
        const linhas = mov.itens.map((item) => {
            const entrada = item.tipo === 'entrada';
            const sinal = entrada ? '+' : '−';
            return `<tr><td class="re-data">${dataBR(item.data)}<span class="re-sub">${horaBR(item.data)}</span></td>`
                + `${celulaProduto(item.produto, item.categoria)}`
                + `<td>${selo({ texto: entrada ? 'Entrada' : 'Saída', cor: entrada ? 'verde' : 'azul' })}</td>`
                + `<td>${escapeHtml(item.motivo)}${item.detalhe ? `<span class="re-sub">${escapeHtml(item.detalhe)}</span>` : ''}</td>`
                + `<td class="re-num${entrada ? ' re-mais' : ''}">${sinal}${escapeHtml(quantidade(item.quantidade, item.unidade))}</td>`
                + `<td>${escapeHtml(item.responsavel || '—')}</td></tr>`;
        });
        const inicio = (mov.pagina - 1) * mov.por_pagina + 1;
        const fim = inicio + mov.itens.length - 1;
        const paginas = Math.max(1, Math.ceil(mov.total / mov.por_pagina));
        const rodape = `<div class="re-rodape-lista"><span>Mostrando ${numero(inicio)} a ${numero(fim)} de ${numero(mov.total)}</span>`
            + (paginas > 1
                ? `<div class="re-paginas"><button type="button" class="re-btn" data-pagina="${mov.pagina - 1}" ${mov.pagina <= 1 ? 'disabled' : ''}>Anterior</button>`
                + `<button type="button" class="re-btn" data-pagina="${mov.pagina + 1}" ${mov.pagina >= paginas ? 'disabled' : ''}>Próxima</button></div>`
                : '')
            + '</div>';
        alvo.innerHTML = tabela([
            { texto: 'Quando' },
            { texto: 'Produto' },
            { texto: 'Tipo' },
            { texto: 'Motivo' },
            { texto: 'Quantidade', num: true },
            { texto: 'Quem registrou' },
        ], linhas) + rodape;
    }

    /* ---------- Em falta ---------- */

    function renderizarFalta() {
        const alvo = dom.conteudo.falta;
        if (carregandoOuErro(alvo)) return;
        const lista = state.dados.em_falta || [];
        if (!lista.length) {
            alvo.innerHTML = vazio('Nenhum produto em falta',
                state.busca || state.categoria ? 'Nenhum produto da busca está no mínimo ou abaixo dele.' : 'Todos os produtos estão acima do estoque mínimo.');
            return;
        }
        const linhas = lista.map((item) => `<tr>${celulaProduto(item.nome, item.categoria)}`
            + `<td class="re-num">${escapeHtml(quantidade(item.estoque, item.unidade))}</td>`
            + `<td class="re-num">${item.estoque_minimo ? escapeHtml(quantidade(item.estoque_minimo, item.unidade)) : '—'}</td>`
            + `<td class="re-num">${item.falta ? escapeHtml(quantidade(item.falta, item.unidade)) : '—'}</td>`
            + `<td class="re-data">${item.ultima_entrada ? dataBR(item.ultima_entrada) : '—'}</td>`
            + `<td>${selo(seloEstoque(item.situacao))}</td></tr>`);
        alvo.innerHTML = tabela([
            { texto: 'Produto' },
            { texto: 'Tem agora', num: true },
            { texto: 'Mínimo', num: true },
            { texto: 'Falta para o mínimo', num: true },
            { texto: 'Última entrada' },
            { texto: 'Situação' },
        ], linhas);
    }

    /* ---------- Vencendo ---------- */

    function renderizarVencendo() {
        const alvo = dom.conteudo.vencendo;
        dom.diasValidade.value = String(state.diasValidade);
        if (carregandoOuErro(alvo)) return;
        const lista = state.dados.vencendo || [];
        if (!lista.length) {
            alvo.innerHTML = vazio(`Nada vencido ou vencendo nos próximos ${state.diasValidade} dias`,
                'Os lotes com produto na prateleira estão dentro da validade.');
            return;
        }
        const linhas = lista.map((item) => `<tr>${celulaProduto(item.nome, item.categoria)}`
            + `<td>${item.lote && item.lote !== 'SEM-LOTE' ? escapeHtml(item.lote) : '<span class="re-zero">Sem lote</span>'}</td>`
            + `<td class="re-num">${escapeHtml(quantidade(item.quantidade, item.unidade))}</td>`
            + `<td class="re-data">${dataBR(item.validade)}</td>`
            + `<td>${selo(seloValidade(item.dias))}</td></tr>`);
        alvo.innerHTML = tabela([
            { texto: 'Produto' },
            { texto: 'Lote' },
            { texto: 'Quantidade', num: true },
            { texto: 'Validade' },
            { texto: 'Situação' },
        ], linhas);
    }

    /* ================= Interações ================= */

    function selecionarAba(nome, focar) {
        if (!ABAS.includes(nome)) return;
        state.aba = nome;
        abas.forEach((aba) => {
            const ativa = aba.dataset.aba === nome;
            aba.setAttribute('aria-selected', String(ativa));
            aba.tabIndex = ativa ? 0 : -1;
            $(aba.getAttribute('aria-controls')).hidden = !ativa;
            if (ativa && focar) aba.focus();
        });
    }

    function mostrarErroDatas(mensagem) {
        dom.info.textContent = mensagem;
        dom.info.classList.add('re-erro');
    }

    function limparErroDatas() {
        dom.info.classList.remove('re-erro');
    }

    let datasTimer = null;
    function aplicarDatas() {
        clearTimeout(datasTimer);
        const de = dom.de.value;
        const ate = dom.ate.value;
        let erro = '';
        if (!de || !ate) erro = 'Preencha a data inicial e a data final.';
        else if (de > ate) erro = 'A data inicial precisa vir antes da data final.';
        else if (diasEntre(de, ate) > MAX_DIAS) erro = `Escolha no máximo ${numero(MAX_DIAS)} dias. Você escolheu ${numero(diasEntre(de, ate))}.`;
        if (erro) {
            mostrarErroDatas(erro);
            return;
        }
        limparErroDatas();
        if (de === state.de && ate === state.ate) {
            renderizarInfo();
            return;
        }
        state.de = de;
        state.ate = ate;
        state.pagina = 1;
        carregar();
    }

    function montarCategorias(categorias) {
        const atual = state.categoria;
        const lista = categorias.slice();
        if (atual && !lista.includes(atual)) lista.push(atual);
        dom.categoria.innerHTML = '<option value="">Todas</option>'
            + lista.map((nome) => `<option value="${escapeHtml(nome)}">${escapeHtml(nome)}</option>`).join('');
        dom.categoria.value = atual;
    }

    async function baixarPdf() {
        if (state.visitante || !state.pronto) return;
        if (!window.jspdf || !window.autoTable || !window.hydraRelatorioEstoquePdf) {
            toast('Não foi possível carregar o gerador de PDF. Atualize a página e tente de novo.');
            return;
        }
        const textoOriginal = dom.pdf.innerHTML;
        dom.pdf.disabled = true;
        dom.pdf.textContent = 'Gerando PDF…';
        try {
            // O PDF traz só o que está aberto na tela: o cartão (aba) escolhido e,
            // em "Entradas e saídas", a visão e o tipo (todas/entradas/saídas).
            const tipo = state.aba === 'movimento' && state.visao === 'lista' ? state.tipo : 'todas';
            const dados = await window.hydraApi(`/relatorios/estoque-produtos?${parametros({ completo: '1', tipo, pagina: '1' })}`);
            dados.por_produto = ordenarProdutos(dados.por_produto || []); // mesma ordem da tabela na tela
            window.hydraRelatorioEstoquePdf(dados, {
                parte: state.aba,
                visao: state.visao,
                tipo,
                busca: state.busca,
                categoria: state.categoria,
                geradoPor: state.usuario ? state.usuario.nome : '',
            });
        } catch (erro) {
            toast(erro && erro.message ? erro.message : 'Não foi possível gerar o PDF. Tente de novo.');
        } finally {
            dom.pdf.disabled = false;
            dom.pdf.innerHTML = textoOriginal;
        }
    }

    function ligarEventos() {
        [dom.de, dom.ate].forEach((campo) => {
            // Espera a pessoa terminar de digitar o ano antes de buscar.
            campo.addEventListener('input', () => {
                clearTimeout(datasTimer);
                datasTimer = setTimeout(aplicarDatas, 800);
            });
            campo.addEventListener('change', () => {
                clearTimeout(datasTimer);
                datasTimer = setTimeout(aplicarDatas, 400);
            });
            campo.addEventListener('keydown', (evento) => {
                if (evento.key === 'Enter') aplicarDatas();
            });
        });

        let buscaTimer = null;
        dom.busca.addEventListener('input', () => {
            clearTimeout(buscaTimer);
            buscaTimer = setTimeout(() => {
                const valor = dom.busca.value.trim();
                if (valor === state.busca) return;
                state.busca = valor;
                state.pagina = 1;
                carregar();
            }, 450);
        });

        dom.categoria.addEventListener('change', () => {
            state.categoria = dom.categoria.value;
            state.pagina = 1;
            carregar();
        });

        dom.diasValidade.addEventListener('change', () => {
            state.diasValidade = Number(dom.diasValidade.value) || 30;
            carregar();
        });

        segmentosVisao.forEach((botao) => botao.addEventListener('click', () => {
            state.visao = botao.dataset.visao;
            renderizarVisao();
        }));

        segmentosTipo.forEach((botao) => botao.addEventListener('click', () => {
            if (state.tipo === botao.dataset.tipo) return;
            state.tipo = botao.dataset.tipo;
            state.pagina = 1;
            carregarMovimentacoes();
        }));

        abas.forEach((aba) => {
            aba.addEventListener('click', () => selecionarAba(aba.dataset.aba));
            aba.addEventListener('keydown', (evento) => {
                const indice = ABAS.indexOf(aba.dataset.aba);
                let proximo = null;
                if (evento.key === 'ArrowRight') proximo = ABAS[(indice + 1) % ABAS.length];
                else if (evento.key === 'ArrowLeft') proximo = ABAS[(indice - 1 + ABAS.length) % ABAS.length];
                else if (evento.key === 'Home') proximo = ABAS[0];
                else if (evento.key === 'End') proximo = ABAS[ABAS.length - 1];
                if (proximo) {
                    evento.preventDefault();
                    selecionarAba(proximo, true);
                }
            });
        });

        dom.conteudo.produtos.addEventListener('click', (evento) => {
            const ordenar = evento.target.closest('[data-ordenar]');
            if (ordenar) {
                const coluna = ordenar.dataset.ordenar;
                if (state.ordem.coluna === coluna) {
                    state.ordem.direcao = state.ordem.direcao === 'asc' ? 'desc' : 'asc';
                } else {
                    // Números começam do maior; nome e situação, do começo.
                    state.ordem = { coluna, direcao: coluna === 'nome' || coluna === 'situacao' ? 'asc' : 'desc' };
                }
                renderizarProdutos();
                const botao = dom.conteudo.produtos.querySelector(`[data-ordenar="${coluna}"]`);
                if (botao) botao.focus();
                return;
            }
            if (evento.target.closest('[data-mais-linhas]')) {
                state.linhasVisiveis += LINHAS_POR_VEZ;
                renderizarProdutos();
            }
        });

        dom.conteudo.movimentacoes.addEventListener('click', (evento) => {
            const botao = evento.target.closest('[data-pagina]');
            if (!botao || botao.disabled) return;
            state.pagina = Number(botao.dataset.pagina);
            carregarMovimentacoes();
            dom.painel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });

        dom.pdf.addEventListener('click', baixarPdf);
    }

    /* ================= Início ================= */

    function modoVisitante() {
        state.visitante = true;
        situacao('aviso', 'Entre com seu usuário para ver o relatório do seu mercado. <a href="login.html">Entrar no sistema</a>');
        [dom.de, dom.ate, dom.busca, dom.categoria, dom.pdf, dom.diasValidade].forEach((el) => { el.disabled = true; });
        renderizarTudo();
    }

    async function iniciar() {
        ligarEventos();
        // Abre no mês atual: do dia 1 até hoje.
        const agora = new Date();
        state.de = chaveData(new Date(agora.getFullYear(), agora.getMonth(), 1));
        state.ate = hoje();
        dom.de.value = state.de;
        dom.ate.value = state.ate;
        dom.de.max = hoje();
        dom.ate.max = hoje();
        renderizarTudo();

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

        state.usuario = usuario;
        state.pronto = true;
        carregar();
    }

    iniciar();
})();
