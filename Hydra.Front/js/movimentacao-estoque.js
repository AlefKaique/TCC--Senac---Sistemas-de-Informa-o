/**
 * Telas "Nova entrada de estoque" e "Nova saída de estoque"
 * (pages/entrada-estoque.html e pages/saida-estoque.html; o modo vem de
 * <main data-tipo="entrada|saida">).
 *
 * Fluxo: edição (documento, itens, justificativa) → revisão ("Confira antes
 * de gravar") → concluída (com opção de estorno). Quem grava e valida de
 * verdade é a API (DocumentoEstoqueController); aqui as mesmas regras
 * aparecem antes, campo a campo.
 *
 * Entrada: cada linha é produto + lote + validade + quantidade + custo.
 * Lote que já existe soma ao saldo dele; lote novo é criado.
 * Saída: cada item é produto + quantidade; os lotes saem por FEFO (vence
 * primeiro, sai primeiro), com opção de redistribuir à mão.
 *
 * Rascunho fica no navegador (localStorage), por usuário, filial e tipo.
 */
(function () {
    'use strict';

    const app = document.getElementById('movApp');
    if (!app) return;

    const TIPO = app.dataset.tipo === 'saida' ? 'saida' : 'entrada';
    const ENTRADA = TIPO === 'entrada';
    const MIN_JUST = 10;
    const DIAS_VALIDADE_CURTA = 30;
    const TIPOS_ENTRADA = {
        compra: 'Compra (com nota fiscal)',
        devolucao_cliente: 'Devolução de cliente',
        transferencia: 'Transferência entre filiais',
        ajuste_inventario: 'Ajuste de inventário',
    };
    const EXIGE_JUSTIFICATIVA = ['devolucao_cliente', 'ajuste_inventario'];
    const PERFIS = { administrador: 'ADM', operador: 'Caixa', estoquista: 'Estoque' };

    const $ = (id) => document.getElementById(id);
    const el = {
        subtipo: $('movSubtipo'),
        fornecedor: $('movFornecedor'),
        nota: $('movNota'),
        data: $('movData'),
        responsavel: $('movResponsavel'),
        motivo: $('movMotivo'),
        justificativa: $('movJustificativa'),
        justStatus: $('movJustStatus'),
        justContador: $('movJustContador'),
        busca: $('movBusca'),
        resultados: $('movResultados'),
        itens: $('movItens'),
        tabela: $('movTabela'),
        vazio: $('movVazio'),
        contagem: $('movContagem'),
        totItens: $('movTotItens'),
        totUnidades: $('movTotUnidades'),
        totCusto: $('movTotCusto'),
        pendencias: $('movPendencias'),
        revisar: $('movRevisar'),
        etapaEdicao: $('movEtapaEdicao'),
        etapaRevisao: $('movEtapaRevisao'),
        etapaConcluida: $('movEtapaConcluida'),
        trilha: $('movTrilha'),
        titulo: $('movTitulo'),
        subtitulo: $('movSubtitulo'),
        salvarRascunho: $('movSalvarRascunho'),
        cancelar: $('movCancelar'),
        avisoRascunho: $('movAvisoRascunho'),
        avisoRascunhoTexto: $('movAvisoRascunhoTexto'),
        confirmar: $('movConfirmar'),
        erroConfirmar: $('movErroConfirmar'),
    };

    let usuario = null;
    let filialNome = '';
    let produtos = [];
    const porId = new Map();
    const lotesCache = new Map(); // id_produto → array de lotes (FEFO) | 'carregando'
    let itens = [];
    let seq = 0;
    let alterado = false;
    let documentoGravado = null;

    /* ================= Formatação ================= */

    const moeda = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const qtd = (q, unidade) => (window.hydraFormatarQuantidade
        ? window.hydraFormatarQuantidade(q, unidade)
        : `${Number(q) || 0} ${unidade || 'un'}`);
    const hojeIso = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const dataBr = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
    const diasAte = (iso) => {
        const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
        const [ha, hm, hd] = hojeIso().split('-').map(Number);
        return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ha, hm - 1, hd)) / 86400000);
    };
    const num = (v) => {
        if (v === null || v === undefined || String(v).trim() === '') return null;
        const n = Number(String(v).replace(',', '.'));
        return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
    };
    const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
    const normaliza = (s) => String(s || '').toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '');

    /** Cria elemento: h('span', { class: 'x' }, 'texto', outroEl). Texto sempre como texto, nunca HTML. */
    function h(tag, attrs, ...filhos) {
        const no = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => {
            if (v === null || v === undefined || v === false) return;
            if (k === 'class') no.className = v;
            else if (k === 'text') no.textContent = v;
            else if (k.startsWith('on')) no.addEventListener(k.slice(2), v);
            else if (v === true) no.setAttribute(k, '');
            else no.setAttribute(k, v);
        });
        filhos.flat().forEach((f) => {
            if (f === null || f === undefined || f === false) return;
            no.append(f instanceof Node ? f : document.createTextNode(String(f)));
        });
        return no;
    }

    let toastTimer = null;
    function toast(msg) {
        const t = $('hydroToast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('hydro-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.classList.remove('hydro-show'), 3200);
    }

    function marcarAlterado() {
        alterado = true;
    }

    /* ================= Lotes ================= */

    function lotesDe(idProduto) {
        const l = lotesCache.get(idProduto);
        return Array.isArray(l) ? l : null;
    }

    async function carregarLotes(idProduto) {
        if (lotesCache.has(idProduto)) return;
        lotesCache.set(idProduto, 'carregando');
        try {
            const { lotes } = await window.hydraApi(`/estoque/lotes?id_produto=${idProduto}`);
            lotesCache.set(idProduto, lotes || []);
        } catch (err) {
            lotesCache.set(idProduto, []);
            toast(`Não foi possível carregar os lotes: ${err.message}`);
        }
        itens.filter((i) => i.id_produto === idProduto).forEach(atualizarItem);
        atualizarResumo();
    }

    /* ================= Busca de produto ================= */

    let resultados = [];
    let destaque = -1;

    function buscar(termo) {
        const t = normaliza(termo.trim());
        if (!t) return [];
        const digitos = t.replace(/\D/g, '');
        return produtos.filter((p) => normaliza(p.nome).includes(t)
            || normaliza(p.sku).includes(t)
            || (digitos.length >= 3 && String(p.codigo_barras || '').includes(digitos))).slice(0, 8);
    }

    function exato(termo) {
        const t = normaliza(termo.trim());
        if (!t) return null;
        return produtos.find((p) => String(p.codigo_barras || '') === t || normaliza(p.sku) === t) || null;
    }

    function renderResultados() {
        el.resultados.replaceChildren();
        const aberto = resultados.length > 0 || el.busca.value.trim().length > 0;
        el.resultados.hidden = !aberto;
        el.busca.setAttribute('aria-expanded', String(aberto));
        if (!resultados.length) {
            if (el.busca.value.trim()) el.resultados.append(h('li', { class: 'mov-resultado-vazio', role: 'presentation' }, 'Nenhum produto encontrado.'));
            el.busca.removeAttribute('aria-activedescendant');
            return;
        }
        resultados.forEach((p, i) => {
            const meta = [p.sku ? `SKU ${p.sku}` : null, p.codigo_barras ? `EAN ${p.codigo_barras}` : null, p.categoria].filter(Boolean).join(' · ');
            el.resultados.append(h('li', {
                id: `movOpcao${i}`,
                role: 'option',
                class: `mov-resultado${i === destaque ? ' is-destaque' : ''}`,
                'aria-selected': String(i === destaque),
                onmousedown: (e) => { e.preventDefault(); adicionar(p); },
            },
            h('span', { class: 'mov-resultado-texto' }, h('strong', { text: p.nome }), h('small', { text: meta })),
            h('span', { class: 'mov-resultado-saldo', text: `saldo ${qtd(p.quantidade, p.unidade)}` })));
        });
        if (destaque >= 0) el.busca.setAttribute('aria-activedescendant', `movOpcao${destaque}`);
        else el.busca.removeAttribute('aria-activedescendant');
    }

    function fecharResultados() {
        resultados = [];
        destaque = -1;
        el.resultados.hidden = true;
        el.busca.setAttribute('aria-expanded', 'false');
        el.busca.removeAttribute('aria-activedescendant');
    }

    el.busca.addEventListener('input', () => {
        resultados = buscar(el.busca.value);
        destaque = resultados.length ? 0 : -1;
        renderResultados();
    });
    el.busca.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!resultados.length) return;
            e.preventDefault();
            destaque = (destaque + (e.key === 'ArrowDown' ? 1 : -1) + resultados.length) % resultados.length;
            renderResultados();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            // Leitor de código de barras digita o EAN e manda Enter: o exato ganha.
            const p = exato(el.busca.value) || resultados[destaque];
            if (p) adicionar(p);
            else if (el.busca.value.trim()) toast('Nenhum produto com esse nome, SKU ou código de barras.');
        } else if (e.key === 'Escape') {
            fecharResultados();
        }
    });
    el.busca.addEventListener('blur', () => setTimeout(fecharResultados, 120));

    function adicionar(produto) {
        el.busca.value = '';
        fecharResultados();
        if (!ENTRADA) {
            const existente = itens.find((i) => i.id_produto === produto.id_produto);
            if (existente) {
                existente.ref.qtd.focus();
                toast(`"${produto.nome}" já está na lista. Ajuste a quantidade.`);
                return;
            }
        }
        const item = ENTRADA
            ? { uid: ++seq, id_produto: produto.id_produto, lote: '', validade: '', quantidade: '', custo: produto.preco_custo !== null && produto.preco_custo !== undefined ? String(produto.preco_custo) : '', observacao: '', obsAberta: false }
            : { uid: ++seq, id_produto: produto.id_produto, quantidade: '', manual: false, alocacoes: {} };
        itens.push(item);
        montarItem(item);
        carregarLotes(produto.id_produto);
        atualizarItem(item);
        atualizarResumo();
        marcarAlterado();
        el.busca.focus();
    }

    function remover(item) {
        itens = itens.filter((i) => i !== item);
        item.ref.nos.forEach((n) => n.remove());
        atualizarResumo();
        marcarAlterado();
        el.busca.focus();
    }

    /* ================= Entrada: linhas da tabela ================= */

    function montarItem(item) {
        if (ENTRADA) montarLinhaEntrada(item);
        else montarCartaoSaida(item);
    }

    function montarLinhaEntrada(item) {
        const p = porId.get(item.id_produto);
        const ref = {};
        const rotulo = (texto) => ({ 'aria-label': `${texto} de ${p.nome}` });

        ref.lote = h('input', { type: 'text', class: 'mov-in mov-in-lote', maxlength: '50', placeholder: 'Ex.: L2419', value: item.lote, ...rotulo('Lote') });
        ref.loteStatus = h('small', { class: 'mov-lote-status' });
        ref.validade = h('input', { type: 'date', class: 'mov-in mov-in-data', value: item.validade, min: hojeIso(), ...rotulo('Validade') });
        ref.qtd = h('input', { type: 'number', class: 'mov-in mov-in-qtd', min: '0', step: 'any', inputmode: 'decimal', value: item.quantidade, ...rotulo('Quantidade') });
        ref.custo = h('input', { type: 'number', class: 'mov-in mov-in-custo', min: '0', step: '0.01', inputmode: 'decimal', value: item.custo, placeholder: '0,00', ...rotulo('Custo unitário') });
        ref.total = h('strong', { class: 'mov-total' });
        ref.obsBotao = h('button', { type: 'button', class: 'mov-obs-botao', 'data-demo-allow': true });
        ref.remover = h('button', { type: 'button', class: 'mov-remover', 'aria-label': `Remover ${p.nome}`, 'data-demo-allow': true, onclick: () => remover(item) }, iconeX());

        ref.linha = h('tr', { class: 'mov-linha' },
            h('td', {}, h('strong', { class: 'mov-produto-nome', text: p.nome }),
                h('small', { class: 'mov-produto-meta', text: [p.sku ? `SKU ${p.sku}` : null, p.categoria].filter(Boolean).join(' · ') })),
            h('td', {}, ref.lote, ref.loteStatus),
            h('td', {}, ref.validade),
            h('td', {}, ref.qtd),
            h('td', {}, h('span', { class: 'mov-prefixo' }, h('span', { 'aria-hidden': 'true', text: 'R$' }), ref.custo)),
            h('td', {}, ref.total),
            h('td', {}, ref.obsBotao),
            h('td', { class: 'mov-td-acao' }, ref.remover));

        ref.obsTexto = h('textarea', { class: 'mov-in mov-obs-texto', rows: '2', maxlength: '255', placeholder: 'Ex.: caixa amassada, conferido com o motorista', 'aria-label': `Observação de ${p.nome}` });
        ref.obsTexto.value = item.observacao;
        ref.obsLinha = h('tr', { class: 'mov-linha-extra' }, h('td', { colspan: '8' }, ref.obsTexto));
        ref.avisoLinha = h('tr', { class: 'mov-linha-extra' }, h('td', { colspan: '8' }));
        ref.nos = [ref.linha, ref.obsLinha, ref.avisoLinha];
        item.ref = ref;

        const ligar = (input, campo) => input.addEventListener('input', () => {
            item[campo] = input.value;
            marcarAlterado();
            atualizarItem(item);
            atualizarResumo();
        });
        ligar(ref.lote, 'lote');
        ligar(ref.validade, 'validade');
        ligar(ref.qtd, 'quantidade');
        ligar(ref.custo, 'custo');
        ligar(ref.obsTexto, 'observacao');
        ref.obsBotao.addEventListener('click', () => {
            item.obsAberta = !item.obsAberta;
            atualizarItem(item);
            if (item.obsAberta) ref.obsTexto.focus();
        });

        el.itens.append(...ref.nos);
    }

    /** Erros e avisos de uma linha de entrada (o que impede gravar e o que só alerta). */
    function analisarEntrada(item) {
        const p = porId.get(item.id_produto);
        const lotes = lotesDe(item.id_produto);
        const erros = [];
        const avisos = [];
        const codigo = item.lote.trim();
        const existente = lotes && codigo ? lotes.find((l) => normaliza(l.codigo) === normaliza(codigo)) : null;
        const validade = existente && existente.validade ? existente.validade : item.validade;
        const q = num(item.quantidade);
        const custo = num(item.custo);

        if (q === null || q <= 0) erros.push('Informe a quantidade.');
        if (el.subtipo.value === 'compra' && custo === null) erros.push('Compra exige o custo unitário.');
        if (custo !== null && custo < 0) erros.push('Custo unitário inválido.');
        if (validade && !existente && diasAte(validade) < 0) erros.push('A validade informada já passou.');
        if (codigo && itens.some((o) => o !== item && o.id_produto === item.id_produto && normaliza(o.lote.trim()) === normaliza(codigo))) {
            erros.push(`O lote ${codigo} aparece duas vezes para este produto. Junte as quantidades numa linha.`);
        }
        if (validade && lotes) {
            const depois = lotes.filter((l) => normaliza(l.codigo) !== normaliza(codigo) && l.quantidade > 0 && l.validade && l.validade > validade)
                .sort((a, b) => (a.validade < b.validade ? -1 : 1))[0];
            if (depois) {
                avisos.push({ lote: depois.codigo, data: dataBr(depois.validade) });
            }
        }
        return { p, existente, validade, q, custo, erros, avisos, codigo };
    }

    function atualizarItem(item) {
        if (ENTRADA) atualizarLinhaEntrada(item);
        else atualizarCartaoSaida(item);
    }

    function atualizarLinhaEntrada(item) {
        const ref = item.ref;
        const a = analisarEntrada(item);
        const carregando = lotesCache.get(item.id_produto) === 'carregando';

        // Lote: existente (validade travada) ou novo.
        if (carregando) {
            ref.loteStatus.textContent = 'verificando…';
            ref.loteStatus.className = 'mov-lote-status';
        } else if (a.existente) {
            ref.loteStatus.textContent = 'lote existente';
            ref.loteStatus.title = `Saldo atual do lote: ${qtd(a.existente.quantidade, a.p.unidade)}`;
            ref.loteStatus.className = 'mov-lote-status';
        } else if (a.codigo) {
            ref.loteStatus.textContent = 'novo lote';
            ref.loteStatus.className = 'mov-lote-status is-novo';
        } else {
            ref.loteStatus.textContent = 'código gerado ao confirmar';
            ref.loteStatus.className = 'mov-lote-status';
        }
        if (a.existente && a.existente.validade) {
            ref.validade.value = a.existente.validade;
            ref.validade.readOnly = true;
            ref.validade.title = 'Validade do lote que já está em estoque';
        } else {
            if (ref.validade.readOnly) ref.validade.value = item.validade;
            ref.validade.readOnly = false;
            ref.validade.removeAttribute('title');
        }
        const dias = a.validade ? diasAte(a.validade) : null;
        ref.validade.classList.toggle('is-curta', dias !== null && dias >= 0 && dias <= DIAS_VALIDADE_CURTA);
        ref.validade.classList.toggle('is-erro', dias !== null && dias < 0 && !a.existente);
        ref.qtd.classList.toggle('is-erro', item.quantidade !== '' && (a.q === null || a.q <= 0));

        ref.total.textContent = moeda((a.q || 0) * (a.custo || 0));

        const temObs = item.observacao.trim() !== '';
        ref.obsBotao.replaceChildren(temObs
            ? h('span', { class: 'mov-selo mov-selo-ok', text: 'preenchida' })
            : h('span', { text: item.obsAberta ? '− fechar' : '+ adicionar' }));
        ref.obsBotao.setAttribute('aria-expanded', String(item.obsAberta));
        ref.obsBotao.setAttribute('aria-label', `${temObs ? 'Editar' : 'Adicionar'} observação de ${a.p.nome}`);
        ref.obsLinha.hidden = !item.obsAberta;

        const celula = ref.avisoLinha.firstChild;
        celula.replaceChildren();
        a.avisos.forEach((av) => celula.append(h('p', { class: 'mov-aviso mov-aviso-atencao' }, iconeAlerta(),
            h('span', {}, 'Esta validade é anterior à do lote ', h('strong', { text: av.lote }),
                ` já em estoque (${av.data}). Confira a mercadoria antes de confirmar — a saída por FEFO passará a puxar este lote primeiro.`))));
        // "Informe a quantidade" só depois de o campo ter sido tocado.
        a.erros.filter((e) => item.quantidade !== '' || e !== 'Informe a quantidade.').forEach((e) => celula.append(
            h('p', { class: 'mov-aviso mov-aviso-erro' }, iconeErro(), h('span', { text: e }))));
        ref.avisoLinha.hidden = !celula.childNodes.length;
    }

    /* ================= Saída: cartões por produto ================= */

    function montarCartaoSaida(item) {
        const p = porId.get(item.id_produto);
        const ref = {};
        ref.qtd = h('input', { type: 'number', class: 'mov-in mov-qtd-grande', min: '0', step: 'any', inputmode: 'decimal', value: item.quantidade, 'aria-label': `Quantidade de ${p.nome}` });
        ref.unidade = h('span', { class: 'mov-qtd-unidade', text: p.unidade || 'un' });
        ref.lotes = h('div', { class: 'mov-lotes' });
        ref.rodape = h('div', { class: 'mov-cartao-rodape' });
        ref.cartao = h('article', { class: 'mov-cartao', 'aria-label': p.nome },
            h('header', { class: 'mov-cartao-topo' },
                h('div', {}, h('strong', { class: 'mov-produto-nome', text: p.nome }),
                    h('small', { class: 'mov-produto-meta', text: [p.sku ? `SKU ${p.sku}` : null, `saldo total ${qtd(p.quantidade, p.unidade)}`].filter(Boolean).join(' · ') })),
                h('div', { class: 'mov-cartao-qtd' }, h('span', { class: 'mov-rotulo-mini', text: 'Quantidade' }), h('div', { class: 'mov-qtd-linha' }, ref.qtd, ref.unidade)),
                h('button', { type: 'button', class: 'mov-remover', 'aria-label': `Remover ${p.nome}`, 'data-demo-allow': true, onclick: () => remover(item) }, iconeX())),
            ref.lotes, ref.rodape);
        ref.nos = [ref.cartao];
        item.ref = ref;
        ref.qtd.addEventListener('input', () => {
            if (item.manual) return;
            item.quantidade = ref.qtd.value;
            marcarAlterado();
            atualizarItem(item);
            atualizarResumo();
        });
        el.itens.append(ref.cartao);
    }

    /** Alocação por lote ({id_lote: qtd}), saldo e erros do item de saída. */
    function analisarSaida(item) {
        const p = porId.get(item.id_produto);
        const lotes = (lotesDe(item.id_produto) || []).filter((l) => l.quantidade > 0);
        const saldo = lotes.reduce((s, l) => s + l.quantidade, 0);
        const erros = [];
        let alocacoes = {};
        let q;
        if (item.manual) {
            alocacoes = { ...item.alocacoes };
            q = Object.values(alocacoes).reduce((s, v) => s + (num(v) || 0), 0);
            lotes.forEach((l) => {
                const v = num(alocacoes[l.id_lote]);
                if (v !== null && v > l.quantidade + 0.0005) erros.push(`O lote ${l.codigo} tem só ${qtd(l.quantidade, p.unidade)}.`);
                if (v !== null && v < 0) erros.push(`Quantidade do lote ${l.codigo} inválida.`);
            });
        } else {
            q = num(item.quantidade) || 0;
            let falta = q;
            lotes.forEach((l) => {
                if (falta <= 0.0005) return;
                const tira = Math.min(falta, l.quantidade);
                alocacoes[l.id_lote] = Math.round(tira * 1000) / 1000;
                falta = Math.round((falta - tira) * 1000) / 1000;
            });
        }
        const excesso = q > saldo + 0.0005;
        if (lotesDe(item.id_produto) && saldo <= 0) erros.push('Este produto não tem saldo em estoque.');
        if ((item.manual || item.quantidade !== '') && q <= 0 && saldo > 0) erros.push('Informe a quantidade.');
        let custo = 0;
        lotes.forEach((l) => {
            const v = num(alocacoes[l.id_lote]) || 0;
            custo += v * (l.custo_unitario !== null && l.custo_unitario !== undefined ? l.custo_unitario : Number(p.preco_custo) || 0);
        });
        return { p, lotes, saldo, q, alocacoes, excesso, erros, custo };
    }

    function atualizarCartaoSaida(item) {
        const ref = item.ref;
        const a = analisarSaida(item);
        const carregando = lotesCache.get(item.id_produto) === 'carregando';
        const unidade = a.p.unidade || 'un';
        ref.cartao.classList.toggle('is-erro', a.excesso || a.erros.some((e) => e.includes('saldo')));
        if (item.manual) ref.qtd.value = String(a.q);
        ref.qtd.readOnly = item.manual;
        ref.qtd.title = item.manual ? 'Soma das quantidades por lote' : '';
        ref.lotes.replaceChildren();
        ref.rodape.replaceChildren();

        if (carregando) {
            ref.lotes.append(h('p', { class: 'mov-cartao-nota', text: 'Carregando lotes…' }));
            return;
        }

        if (a.excesso) {
            const lote = a.lotes.length === 1 ? a.lotes[0] : null;
            const vence = lote && lote.validade ? ` (${diasAte(lote.validade) < 0 ? 'venceu' : 'vence'} ${dataBr(lote.validade)})` : '';
            ref.rodape.append(h('p', { class: 'mov-aviso mov-aviso-erro' }, iconeErro(),
                h('span', {}, 'Quantidade maior que o saldo: ',
                    lote ? ['o lote ', h('strong', { text: lote.codigo }), `${vence} tem apenas ${qtd(a.saldo, unidade)}.`]
                        : `há apenas ${qtd(a.saldo, unidade)} em ${plural(a.lotes.length, 'lote', 'lotes')}.`,
                    ` Ajuste para ${qtd(a.saldo, unidade).replace(/ \S+$/, '')} ou remova o item. `,
                    a.saldo > 0 ? h('button', { type: 'button', class: 'mov-link', 'data-demo-allow': true, onclick: () => {
                        item.manual = false;
                        item.quantidade = String(a.saldo);
                        ref.qtd.value = item.quantidade;
                        marcarAlterado();
                        atualizarItem(item);
                        atualizarResumo();
                    } }, `Ajustar para ${qtd(a.saldo, unidade)}`) : null)));
            return;
        }

        const ordem = a.lotes.filter((l) => item.manual || (num(a.alocacoes[l.id_lote]) || 0) > 0);
        ordem.forEach((l, i) => {
            const vencido = l.validade && diasAte(l.validade) < 0;
            const selo = i === 0
                ? h('span', { class: 'mov-selo mov-selo-primeiro', text: '1º a vencer' })
                : h('span', { class: 'mov-selo mov-selo-ordem', text: `${i + 1}º` });
            const descricao = h('span', { class: 'mov-lote-desc' }, 'Lote ', h('strong', { text: l.codigo }),
                l.validade ? ` · ${vencido ? 'venceu' : 'vence'} ${dataBr(l.validade)}` : ' · sem validade',
                ` · saldo ${qtd(l.quantidade, unidade)}`);
            let direita;
            if (item.manual) {
                const input = h('input', { type: 'number', class: 'mov-in mov-in-lote-qtd', min: '0', max: String(l.quantidade), step: 'any', inputmode: 'decimal', 'aria-label': `Quantidade do lote ${l.codigo}` });
                input.value = item.alocacoes[l.id_lote] !== undefined ? item.alocacoes[l.id_lote] : '';
                input.addEventListener('input', () => {
                    item.alocacoes[l.id_lote] = input.value;
                    marcarAlterado();
                    const b = analisarSaida(item);
                    ref.qtd.value = String(b.q);
                    atualizarRodapeSaida(item, b);
                    atualizarResumo();
                });
                direita = h('span', { class: 'mov-lote-acao' }, input, h('span', { class: 'mov-qtd-unidade', text: unidade }));
            } else {
                direita = h('span', { class: 'mov-lote-acao' }, h('strong', { text: qtd(a.alocacoes[l.id_lote], unidade) }),
                    h('button', { type: 'button', class: 'mov-link', 'data-demo-allow': true, onclick: () => trocarParaManual(item, a) }, 'trocar lote'));
            }
            ref.lotes.append(h('div', { class: `mov-lote${vencido ? ' is-vencido' : ''}` }, selo, descricao, direita));
        });
        atualizarRodapeSaida(item, a);
    }

    function atualizarRodapeSaida(item, a) {
        const ref = item.ref;
        ref.rodape.replaceChildren();
        const unidade = a.p.unidade || 'un';
        const usados = Object.values(a.alocacoes).filter((v) => (num(v) || 0) > 0).length;
        if (item.manual) {
            ref.rodape.append(h('p', { class: 'mov-cartao-nota' }, 'Distribuição feita à mão. ',
                h('button', { type: 'button', class: 'mov-link', 'data-demo-allow': true, onclick: () => {
                    item.manual = false;
                    item.quantidade = String(a.q || '');
                    marcarAlterado();
                    atualizarItem(item);
                    atualizarResumo();
                } }, 'Voltar ao FEFO automático')));
        } else if (usados > 1) {
            ref.rodape.append(h('p', { class: 'mov-cartao-nota', text: `O sistema dividiu ${qtd(a.q, unidade)} entre ${usados} lotes automaticamente. Você pode redistribuir à mão.` }));
        } else if (usados === 1) {
            ref.rodape.append(h('p', { class: 'mov-cartao-nota', text: 'Saindo do lote que vence primeiro. Você pode trocar o lote à mão.' }));
        }
        a.erros.forEach((e) => ref.rodape.append(h('p', { class: 'mov-aviso mov-aviso-erro' }, iconeErro(), h('span', { text: e }))));
    }

    function trocarParaManual(item, a) {
        item.manual = true;
        item.alocacoes = {};
        a.lotes.forEach((l) => { item.alocacoes[l.id_lote] = a.alocacoes[l.id_lote] ? String(a.alocacoes[l.id_lote]) : ''; });
        marcarAlterado();
        atualizarItem(item);
        const primeiro = item.ref.lotes.querySelector('input');
        if (primeiro) primeiro.focus();
    }

    /* ================= Justificativa e pendências ================= */

    function todosComObservacao() {
        return ENTRADA && itens.length > 0 && itens.every((i) => i.observacao.trim() !== '');
    }

    function atualizarJustificativa() {
        const n = el.justificativa.value.trim().length;
        el.justContador.textContent = `${n} / ${MIN_JUST}`;
        const obs = todosComObservacao();
        const exige = !ENTRADA || EXIGE_JUSTIFICATIVA.includes(el.subtipo.value);
        let texto = '';
        let classe = '';
        if (n >= MIN_JUST) {
            texto = 'Justificativa válida — vale para todos os itens.';
            classe = 'is-ok';
        } else if (obs) {
            texto = 'Observação preenchida em todos os itens — a descrição é opcional.';
            classe = 'is-ok';
        } else if (n > 0) {
            const falta = MIN_JUST - n;
            texto = `Faltam ${plural(falta, 'caractere', 'caracteres')}${ENTRADA ? ' — ou preencha a observação de todos os itens.' : '.'}`;
            classe = 'is-erro';
        } else if (exige) {
            texto = ENTRADA
                ? `${TIPOS_ENTRADA[el.subtipo.value]} exige justificativa: escreva 10 caracteres ou preencha a observação de todos os itens.`
                : 'Obrigatória: descreva a saída em pelo menos 10 caracteres.';
            classe = 'is-erro';
        } else {
            texto = 'Opcional para este tipo de entrada.';
        }
        el.justStatus.textContent = texto;
        el.justStatus.className = `mov-just-status ${classe}`;
        return classe !== 'is-erro';
    }

    function pendencias() {
        const lista = [];
        if (!itens.length) lista.push('Adicione pelo menos um produto');
        if (ENTRADA) {
            if (el.subtipo.value === 'compra' && !el.fornecedor.value.trim()) lista.push('fornecedor obrigatório');
            if (el.subtipo.value === 'compra' && !el.nota.value.trim()) lista.push('nº da nota obrigatório');
            if (el.data.value && el.data.value > hojeIso()) lista.push('data de entrada no futuro');
            if (!el.motivo.value) lista.push('escolha o motivo');
        } else if (!el.subtipo.value) {
            lista.push('escolha o motivo da saída');
        }
        if (!atualizarJustificativa()) {
            const semObs = ENTRADA ? itens.filter((i) => !i.observacao.trim()).length : 0;
            const n = el.justificativa.value.trim().length;
            lista.push((n > 0 ? 'Justificativa incompleta' : 'Justificativa obrigatória')
                + (semObs ? ` e ${plural(semObs, 'item sem observação', 'itens sem observação')}` : ''));
        }
        const comErro = itens.filter((i) => (ENTRADA ? analisarEntrada(i).erros.length : (analisarSaida(i).excesso || analisarSaida(i).erros.length || analisarSaida(i).q <= 0))).length;
        if (!ENTRADA) {
            const acima = itens.filter((i) => analisarSaida(i).excesso).length;
            if (acima) lista.push(`${plural(acima, 'item', 'itens')} com quantidade acima do saldo`);
            const outros = comErro - acima;
            if (outros > 0) lista.push(`${plural(outros, 'item', 'itens')} sem quantidade válida`);
        } else if (comErro) {
            lista.push(`${plural(comErro, 'item precisa', 'itens precisam')} de correção`);
        }
        if (itens.some((i) => lotesCache.get(i.id_produto) === 'carregando')) lista.push('carregando lotes');
        return lista;
    }

    function atualizarResumo() {
        let unidades = 0;
        let custo = 0;
        itens.forEach((i) => {
            if (ENTRADA) {
                const a = analisarEntrada(i);
                unidades += a.q || 0;
                custo += (a.q || 0) * (a.custo || 0);
            } else {
                const a = analisarSaida(i);
                unidades += a.q || 0;
                custo += a.custo;
            }
        });
        unidades = Math.round(unidades * 1000) / 1000;
        el.totItens.textContent = String(itens.length);
        el.totUnidades.textContent = unidades.toLocaleString('pt-BR');
        el.totCusto.textContent = moeda(custo);
        if (el.contagem) el.contagem.textContent = itens.length ? `${plural(itens.length, 'produto', 'produtos')} · ${unidades.toLocaleString('pt-BR')} unidades` : 'Nenhum produto';
        el.vazio.hidden = itens.length > 0;
        if (el.tabela) el.tabela.hidden = itens.length === 0;

        const p = pendencias();
        el.pendencias.textContent = p.length ? p.join(' · ').replace(/^./, (c) => c.toUpperCase()) : '';
        el.revisar.disabled = p.length > 0;
        return { unidades, custo };
    }

    function atualizarObrigatorios() {
        if (!ENTRADA) return;
        const compra = el.subtipo.value === 'compra';
        document.querySelectorAll('[data-obrig-compra]').forEach((s) => { s.hidden = !compra; });
        el.fornecedor.required = compra;
        el.nota.required = compra;
        itens.forEach(atualizarItem);
    }

    [el.subtipo, el.fornecedor, el.nota, el.data, el.motivo, el.justificativa].filter(Boolean).forEach((campo) => {
        campo.addEventListener('input', () => {
            marcarAlterado();
            if (campo === el.subtipo) atualizarObrigatorios();
            atualizarResumo();
        });
        campo.addEventListener('change', () => {
            if (campo === el.subtipo) atualizarObrigatorios();
            atualizarResumo();
        });
    });

    /* ================= Revisão ================= */

    function irPara(etapa) {
        el.etapaEdicao.hidden = etapa !== 'edicao';
        el.etapaRevisao.hidden = etapa !== 'revisao';
        el.etapaConcluida.hidden = etapa !== 'concluida';
        const Nome = ENTRADA ? 'Entrada' : 'Saída';
        el.trilha.textContent = etapa === 'revisao' ? `${Nome} › Revisão` : Nome;
        el.titulo.textContent = etapa === 'revisao' ? 'Confira antes de gravar'
            : etapa === 'concluida' ? `${Nome} registrada` : `Nova ${ENTRADA ? 'entrada' : 'saída'} de estoque`;
        el.subtitulo.hidden = etapa !== 'revisao';
        el.salvarRascunho.hidden = etapa === 'concluida';
        el.cancelar.hidden = etapa === 'concluida';
        window.scrollTo({ top: 0 });
        (etapa === 'concluida' ? $('movConcluidaTitulo') : el.titulo).focus();
    }

    function linhaResumo(rotulo, valor, largo) {
        return h('div', { class: largo ? 'mov-resumo-largo' : '' }, h('dt', { text: rotulo }), h('dd', {}, valor || '—'));
    }

    function nomeUsuario() {
        if (!usuario) return '';
        const partes = String(usuario.nome || '').trim().split(/\s+/);
        const curto = partes.length > 1 ? `${partes[0]} ${partes[partes.length - 1][0]}.` : partes[0];
        const perfil = PERFIS[usuario.perfil];
        return perfil ? `${curto} (${perfil})` : curto;
    }

    async function revisar() {
        if (pendencias().length) return;
        el.erroConfirmar.hidden = true;
        const doc = $('movResumoDoc');
        const lista = $('movResumoItens');
        const efeitos = $('movEfeitos');
        doc.replaceChildren();
        lista.replaceChildren();
        efeitos.replaceChildren();
        const { unidades, custo } = atualizarResumo();
        const justificativa = el.justificativa.value.trim();

        if (ENTRADA) {
            const motivo = el.motivo.options[el.motivo.selectedIndex].text;
            doc.append(
                linhaResumo('Tipo', TIPOS_ENTRADA[el.subtipo.value]),
                linhaResumo('Fornecedor', el.fornecedor.value.trim()),
                linhaResumo('Nota fiscal', el.nota.value.trim()),
                linhaResumo('Filial', filialNome),
                linhaResumo('Data de entrada', dataBr(el.data.value || hojeIso())),
                linhaResumo('Motivo e justificativa', [h('strong', { text: motivo }), justificativa ? ` — ${justificativa}` : ''], true));
        } else {
            doc.append(
                linhaResumo('Motivo', el.subtipo.options[el.subtipo.selectedIndex].text),
                linhaResumo('Responsável', nomeUsuario()),
                linhaResumo('Data', dataBr(hojeIso())),
                linhaResumo('Filial', filialNome),
                linhaResumo('Justificativa', justificativa, true));
        }
        $('movResumoItensTitulo').textContent = `${plural(itens.length, 'item', 'itens')} · ${unidades.toLocaleString('pt-BR')} unidades`;
        $('movResumoTotal').textContent = moeda(custo);

        const efeito = (cor, ...conteudo) => efeitos.append(h('li', { class: `mov-efeito mov-efeito-${cor}` }, h('span', {}, ...conteudo)));
        const rotulos = window.HYDRA_SITUACAO_ROTULOS || {};
        const somaPorProduto = new Map();

        if (ENTRADA) {
            const novos = [];
            const atualizados = [];
            const curtos = new Set();
            itens.forEach((i) => {
                const a = analisarEntrada(i);
                const codigo = a.codigo || 'gerado ao confirmar';
                const dias = a.validade ? diasAte(a.validade) : null;
                const curta = dias !== null && dias <= DIAS_VALIDADE_CURTA;
                if (curta) curtos.add(a.p.nome);
                if (a.existente) atualizados.push(`${a.existente.codigo}: ${a.existente.quantidade.toLocaleString('pt-BR')} → ${(a.existente.quantidade + a.q).toLocaleString('pt-BR')} un`);
                else novos.push(codigo);
                somaPorProduto.set(a.p.id_produto, (somaPorProduto.get(a.p.id_produto) || 0) + a.q);
                const detalhe = [`Lote ${codigo} (${a.existente ? 'existente' : 'novo'})`, a.validade ? `vence ${dataBr(a.validade)}` : 'sem validade', curta ? `${dias} dias` : null].filter(Boolean).join(' · ');
                lista.append(h('li', {},
                    h('div', {}, h('strong', { text: a.p.nome }), h('small', { class: curta ? 'is-curta' : '', text: detalhe })),
                    h('div', { class: 'mov-resumo-valores' }, h('strong', { text: qtd(a.q, a.p.unidade) }), h('small', { text: moeda(a.q * (a.custo || 0)) }))));
            });
            if (novos.length) efeito('verde', h('strong', { text: plural(novos.length, 'lote novo criado', 'lotes novos criados') }), ` (${novos.join(', ')}) com validade própria`);
            if (atualizados.length) efeito('verde', h('strong', { text: plural(atualizados.length, 'lote atualizado', 'lotes atualizados') }), ` (${atualizados.join('; ')})`);
            somaPorProduto.forEach((soma, id) => {
                const p = porId.get(id);
                const antes = Number(p.quantidade) || 0;
                const depois = Math.round((antes + soma) * 1000) / 1000;
                const sa = window.hydraSituacaoEstoque(antes, p.estoque_minimo);
                const sd = window.hydraSituacaoEstoque(depois, p.estoque_minimo);
                if (sa !== sd) {
                    efeito('azul', `${p.nome} `, sd === 'ok' ? ['sai do status ', h('strong', { text: rotulos[sa] || sa })] : ['passa de ', h('strong', { text: rotulos[sa] || sa }), ' para ', h('strong', { text: rotulos[sd] || sd })],
                        ` (${antes.toLocaleString('pt-BR')} → ${depois.toLocaleString('pt-BR')} ${p.unidade || 'un'}, mínimo ${Number(p.estoque_minimo).toLocaleString('pt-BR')})`);
                }
            });
            if (curtos.size) efeito('amarelo', `${plural(curtos.size, 'alerta', 'alertas')} de validade curta ${curtos.size === 1 ? 'será aberto' : 'serão abertos'} para ${[...curtos].join(', ')}`);
        } else {
            itens.forEach((i) => {
                const a = analisarSaida(i);
                somaPorProduto.set(a.p.id_produto, a.q);
                const usados = a.lotes.filter((l) => (num(a.alocacoes[l.id_lote]) || 0) > 0);
                lista.append(h('li', {},
                    h('div', {}, h('strong', { text: a.p.nome }),
                        h('small', { text: usados.map((l) => `Lote ${l.codigo}: ${qtd(num(a.alocacoes[l.id_lote]), a.p.unidade)}${l.validade ? ` · ${diasAte(l.validade) < 0 ? 'venceu' : 'vence'} ${dataBr(l.validade)}` : ''}`).join(' | ') })),
                    h('div', { class: 'mov-resumo-valores' }, h('strong', { text: qtd(a.q, a.p.unidade) }), h('small', { class: 'mov-perda', text: moeda(a.custo) }))));
                usados.forEach((l) => {
                    const depois = Math.round((l.quantidade - num(a.alocacoes[l.id_lote])) * 1000) / 1000;
                    efeito('azul', 'Lote ', h('strong', { text: l.codigo }), ` de ${a.p.nome}: ${l.quantidade.toLocaleString('pt-BR')} → ${depois.toLocaleString('pt-BR')} ${a.p.unidade || 'un'}${depois <= 0 ? ' (zerado)' : ''}`);
                });
                const antes = Number(a.p.quantidade) || 0;
                const depois = Math.round((antes - a.q) * 1000) / 1000;
                const sa = window.hydraSituacaoEstoque(antes, a.p.estoque_minimo);
                const sd = window.hydraSituacaoEstoque(depois, a.p.estoque_minimo);
                if (sa !== sd && sd !== 'ok') {
                    efeito('vermelho', `${a.p.nome} entra no status `, h('strong', { text: rotulos[sd] || sd }), ` (${antes.toLocaleString('pt-BR')} → ${depois.toLocaleString('pt-BR')} ${a.p.unidade || 'un'}, mínimo ${Number(a.p.estoque_minimo).toLocaleString('pt-BR')})`);
                }
            });
            efeito('amarelo', h('strong', { text: moeda(custo) }), ` entram como perda no relatório (motivo: ${el.subtipo.options[el.subtipo.selectedIndex].text})`);
        }
        if (!efeitos.childNodes.length) efeito('azul', 'Nenhum efeito além da soma ao estoque.');

        const auditoria = $('movAuditoria');
        const agora = new Date();
        const numero = h('span', { text: 'calculando…' });
        auditoria.replaceChildren(
            h('div', {}, h('dt', { text: 'Usuário:' }), h('dd', { text: nomeUsuario() })),
            h('div', {}, h('dt', { text: 'Data e hora:' }), h('dd', { text: `${agora.toLocaleDateString('pt-BR')} ${agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` })),
            h('div', {}, h('dt', { text: 'Filial:' }), h('dd', { text: filialNome || '—' })),
            h('div', {}, h('dt', { text: 'Movimentação:' }), h('dd', {}, numero, h('small', { class: 'mov-previa', text: ' (prévia)' }))));
        irPara('revisao');
        try {
            const r = await window.hydraApi(`/estoque/documentos/proximo-numero?tipo=${TIPO}`);
            numero.textContent = r.numero;
        } catch (err) {
            numero.textContent = 'definido ao confirmar';
        }
    }

    el.revisar.addEventListener('click', revisar);
    document.querySelectorAll('[data-mov-voltar]').forEach((b) => b.addEventListener('click', () => irPara('edicao')));

    /* ================= Gravar ================= */

    function corpoDocumento() {
        if (ENTRADA) {
            return {
                tipo: 'entrada',
                subtipo: el.subtipo.value,
                motivo: el.motivo.value,
                fornecedor: el.fornecedor.value.trim(),
                nota_fiscal: el.nota.value.trim(),
                data_documento: el.data.value || hojeIso(),
                justificativa: el.justificativa.value.trim(),
                itens: itens.map((i) => {
                    const a = analisarEntrada(i);
                    return {
                        id_produto: i.id_produto,
                        lote: a.codigo,
                        validade: a.validade || null,
                        quantidade: a.q,
                        custo_unitario: a.custo,
                        observacao: i.observacao.trim(),
                    };
                }),
            };
        }
        return {
            tipo: 'saida',
            subtipo: el.subtipo.value,
            justificativa: el.justificativa.value.trim(),
            itens: itens.map((i) => {
                const a = analisarSaida(i);
                return {
                    id_produto: i.id_produto,
                    quantidade: a.q,
                    alocacoes: Object.entries(a.alocacoes)
                        .map(([id, v]) => ({ id_lote: Number(id), quantidade: num(v) || 0 }))
                        .filter((x) => x.quantidade > 0),
                };
            }),
        };
    }

    el.confirmar.addEventListener('click', async () => {
        el.confirmar.disabled = true;
        el.erroConfirmar.hidden = true;
        const texto = el.confirmar.textContent;
        el.confirmar.textContent = 'Gravando…';
        try {
            const { documento } = await window.hydraApi('/estoque/documentos', { method: 'POST', body: corpoDocumento() });
            documentoGravado = documento;
            alterado = false;
            apagarRascunho();
            const unidades = (documento.itens || []).reduce((s, it) => s + Number(it.quantidade), 0);
            $('movConcluidaTitulo').textContent = `${ENTRADA ? 'Entrada' : 'Saída'} ${documento.numero} registrada`;
            $('movConcluidaTexto').textContent = `${plural(itens.length, 'produto', 'produtos')} · ${unidades.toLocaleString('pt-BR')} unidades `
                + `gravados na filial ${filialNome || 'atual'}. ${ENTRADA ? 'Custo' : 'Perda'}: ${moeda(documento.custo_total)}.`;
            irPara('concluida');
        } catch (err) {
            el.erroConfirmar.textContent = err.status === undefined
                ? 'Não foi possível falar com o servidor. Nada foi gravado — tente de novo.'
                : err.message;
            el.erroConfirmar.hidden = false;
            // Saldo ou lote mudou desde que a tela abriu: relê os lotes.
            if (err.status === 422 || err.status === 409) {
                lotesCache.clear();
                itens.forEach((i) => carregarLotes(i.id_produto));
            }
        } finally {
            el.confirmar.disabled = false;
            el.confirmar.textContent = texto;
        }
    });

    /* ================= Estorno ================= */

    $('movAbrirEstorno').addEventListener('click', () => {
        const painel = $('movEstorno');
        painel.hidden = !painel.hidden;
        if (!painel.hidden) $('movEstornoTexto').focus();
    });
    $('movConfirmarEstorno').addEventListener('click', async () => {
        const erro = $('movErroEstorno');
        const texto = $('movEstornoTexto').value.trim();
        erro.hidden = true;
        if (texto.length < MIN_JUST) {
            erro.textContent = 'Explique o estorno em pelo menos 10 caracteres.';
            erro.hidden = false;
            return;
        }
        const botao = $('movConfirmarEstorno');
        botao.disabled = true;
        try {
            const { documento } = await window.hydraApi(`/estoque/documentos/${documentoGravado.id_documento}/estornar`, { method: 'POST', body: { justificativa: texto } });
            $('movEstorno').hidden = true;
            $('movAbrirEstorno').hidden = true;
            $('movConcluidaTitulo').textContent = `${documentoGravado.numero} estornada`;
            $('movConcluidaTexto').textContent = `O estorno ${documento.numero} desfez a movimentação. As duas ficam no histórico.`;
            toast(`Estorno ${documento.numero} registrado.`);
        } catch (err) {
            erro.textContent = err.message;
            erro.hidden = false;
            botao.disabled = false;
        }
    });

    /* ================= Rascunho (navegador) ================= */

    const chaveRascunho = () => `hydra-rascunho-${TIPO}-${usuario ? usuario.id_usuario : 'anon'}-${usuario ? usuario.id_filial : ''}`;

    function salvarRascunho() {
        const rascunho = {
            versao: 1,
            salvoEm: new Date().toISOString(),
            cabecalho: {
                subtipo: el.subtipo.value,
                fornecedor: el.fornecedor ? el.fornecedor.value : '',
                nota: el.nota ? el.nota.value : '',
                data: ENTRADA ? el.data.value : '',
                motivo: el.motivo ? el.motivo.value : '',
                justificativa: el.justificativa.value,
            },
            itens: itens.map(({ ref, uid, ...resto }) => resto),
        };
        try {
            localStorage.setItem(chaveRascunho(), JSON.stringify(rascunho));
            alterado = false;
            toast('Rascunho salvo neste navegador.');
        } catch (err) {
            toast('Não foi possível salvar o rascunho neste navegador.');
        }
    }

    function lerRascunho() {
        try {
            const r = JSON.parse(localStorage.getItem(chaveRascunho()) || 'null');
            return r && r.versao === 1 ? r : null;
        } catch (err) {
            return null;
        }
    }

    function apagarRascunho() {
        try { localStorage.removeItem(chaveRascunho()); } catch (err) { /* sem armazenamento */ }
        el.avisoRascunho.hidden = true;
    }

    function restaurarRascunho(r) {
        const c = r.cabecalho || {};
        el.subtipo.value = c.subtipo || el.subtipo.value;
        if (el.fornecedor) el.fornecedor.value = c.fornecedor || '';
        if (el.nota) el.nota.value = c.nota || '';
        if (ENTRADA && c.data) el.data.value = c.data;
        if (el.motivo) el.motivo.value = c.motivo || '';
        el.justificativa.value = c.justificativa || '';
        itens.forEach((i) => i.ref.nos.forEach((n) => n.remove()));
        itens = [];
        (r.itens || []).filter((i) => porId.has(i.id_produto)).forEach((salvo) => {
            const item = { ...salvo, uid: ++seq };
            itens.push(item);
            montarItem(item);
            carregarLotes(item.id_produto);
            atualizarItem(item);
        });
        el.avisoRascunho.hidden = true;
        atualizarObrigatorios();
        atualizarResumo();
        toast('Rascunho restaurado.');
    }

    el.salvarRascunho.addEventListener('click', salvarRascunho);
    el.cancelar.addEventListener('click', () => {
        if (alterado && !window.confirm('Descartar o que foi preenchido? O rascunho salvo (se houver) continua guardado.')) return;
        alterado = false;
        window.location.href = 'controle-estoque.html';
    });
    window.addEventListener('beforeunload', (e) => {
        if (!alterado) return;
        e.preventDefault();
        e.returnValue = '';
    });

    /* ================= Ícones ================= */

    function svg(d, classe) {
        const ns = 'http://www.w3.org/2000/svg';
        const s = document.createElementNS(ns, 'svg');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('width', '18');
        s.setAttribute('height', '18');
        s.setAttribute('fill', 'none');
        s.setAttribute('stroke', 'currentColor');
        s.setAttribute('stroke-width', '2');
        s.setAttribute('stroke-linecap', 'round');
        s.setAttribute('stroke-linejoin', 'round');
        s.setAttribute('aria-hidden', 'true');
        s.setAttribute('focusable', 'false');
        if (classe) s.setAttribute('class', classe);
        d.forEach((caminho) => {
            const p = document.createElementNS(ns, 'path');
            p.setAttribute('d', caminho);
            s.append(p);
        });
        return s;
    }
    const iconeX = () => svg(['M18 6 6 18', 'M6 6l12 12']);
    const iconeAlerta = () => svg(['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'], 'mov-aviso-icone');
    const iconeErro = () => svg(['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 8v4', 'M12 16h.01'], 'mov-aviso-icone');

    /* ================= Início ================= */
    (async function iniciar() {
        if (ENTRADA) {
            el.data.value = hojeIso();
            el.data.max = hojeIso();
        } else {
            el.data.value = dataBr(hojeIso());
        }
        atualizarObrigatorios();
        atualizarResumo();
        if (!window.hydraApi) return;

        try {
            ({ usuario } = await window.hydraSessao());
        } catch (err) {
            el.vazio.textContent = 'Entre no sistema para lançar movimentações de estoque.';
            el.busca.disabled = true;
            return;
        }
        const nome = $('hydroUserName');
        if (nome) nome.textContent = (usuario.nome || '').split(' ')[0];
        window.hydraAplicarMenuPorPermissao(usuario);
        if (!window.hydraGuardaDeTela(usuario, ['estoque.lancar'])) return;
        if (el.responsavel) el.responsavel.value = nomeUsuario();

        try {
            const [lista, minhas] = await Promise.all([
                window.hydraApi('/produtos'),
                window.hydraApi('/filiais/minhas').catch(() => null),
            ]);
            produtos = (lista.produtos || []).map((p) => ({
                ...p,
                id_produto: Number(p.id_produto),
                quantidade: Number(p.quantidade) || 0,
                estoque_minimo: Number(p.estoque_minimo) || 0,
                preco_custo: p.preco_custo !== null && p.preco_custo !== undefined ? Number(p.preco_custo) : null,
            }));
            produtos.forEach((p) => porId.set(p.id_produto, p));
            filialNome = (minhas && minhas.filial_ativa && minhas.filial_ativa.nome) || '';
            usuario.id_filial = minhas && minhas.filial_ativa ? minhas.filial_ativa.id_filial : usuario.id_filial;
        } catch (err) {
            el.vazio.textContent = err.status === 409
                ? 'Escolha a filial em que vai trabalhar para lançar movimentações.'
                : `Não foi possível carregar os produtos: ${err.message}`;
            return;
        }
        if (!produtos.length) {
            el.vazio.textContent = 'Nenhum produto cadastrado nesta filial. Cadastre produtos antes de lançar movimentações.';
        }

        const rascunho = lerRascunho();
        if (rascunho) {
            const quando = new Date(rascunho.salvoEm);
            el.avisoRascunhoTexto.textContent = `Você tem um rascunho salvo em ${quando.toLocaleDateString('pt-BR')} às `
                + `${quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (${plural((rascunho.itens || []).length, 'item', 'itens')}).`;
            el.avisoRascunho.hidden = false;
            $('movRestaurar').addEventListener('click', () => restaurarRascunho(rascunho), { once: true });
            $('movDescartar').addEventListener('click', apagarRascunho, { once: true });
        }
        el.busca.focus();
    })();
})();
