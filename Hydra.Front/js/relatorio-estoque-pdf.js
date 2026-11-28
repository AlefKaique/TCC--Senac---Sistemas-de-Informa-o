/**
 * PDF do Relatório de Estoque, gerado no próprio navegador com jsPDF e
 * jsPDF-AutoTable (js/vendor/, licença MIT). Nada sai da máquina: os dados
 * vêm da mesma API da tela (GET /api/relatorios/estoque-produtos?completo=1)
 * e o arquivo é baixado direto.
 *
 * Ordem do PDF: cabeçalho (filial, período, filtros, quem gerou), resumo,
 * entradas e saídas por produto, em falta, vencendo e, por último, a lista
 * de movimentações (a parte mais longa).
 *
 * Usa as fontes padrão do PDF (Helvetica), que cobrem os acentos do
 * português. Caracteres fora dessa tabela (como o sinal de menos "−") são
 * trocados por equivalentes antes de escrever.
 */
(function (global) {
    'use strict';

    const AZUL = [21, 46, 109];
    const TEXTO = [22, 33, 62];
    const CINZA = [90, 99, 120];
    const BORDA = [220, 224, 236];
    const FUNDO = [245, 247, 252];
    const VERMELHO = [180, 35, 53];
    const AMBAR = [138, 90, 0];
    const VERDE = [17, 112, 59];

    const MARGEM = 14;
    const UNIDADES_FRACIONADAS = ['kg', 'g', 'l', 'ml'];
    const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
    const tresCasas = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

    /* ---------- Formatação (mesmas regras da tela) ---------- */

    function limpar(texto) {
        return String(texto == null ? '' : texto)
            .replace(/−/g, '-')
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, '"')
            .replace(/…/g, '...')
            .replace(/[–—]/g, '-');
    }

    function dataBR(chave) {
        const [ano, mes, dia] = String(chave).slice(0, 10).split('-');
        return `${dia}/${mes}/${ano}`;
    }

    function numero(valor) {
        return inteiro.format(Number(valor || 0));
    }

    function plural(qtd, singular, pluralTexto) {
        return Number(qtd) === 1 ? singular : pluralTexto;
    }

    function quantidade(valor, unidade) {
        const sigla = String(unidade || 'un').toLowerCase();
        const numeroValor = Number(valor || 0);
        const formato = UNIDADES_FRACIONADAS.includes(sigla) || !Number.isInteger(numeroValor) ? tresCasas : inteiro;
        return `${formato.format(numeroValor)} ${sigla}`;
    }

    function qtdOuTraco(valor, unidade, sinal) {
        if (!Number(valor)) return '-';
        return `${sinal && Number(valor) > 0 ? sinal : ''}${quantidade(valor, unidade)}`;
    }

    function textoEstoque(situacao) {
        return {
            acabou: 'Acabou',
            abaixo: 'Abaixo do mínimo',
            no_minimo: 'No mínimo',
            inativo: 'Inativo',
        }[situacao] || '';
    }

    function textoValidade(dias) {
        if (dias == null) return '';
        if (dias < 0) return `Vencido há ${numero(-dias)} ${plural(-dias, 'dia', 'dias')}`;
        if (dias === 0) return 'Vence hoje';
        if (dias === 1) return 'Vence amanhã';
        return `Vence em ${numero(dias)} dias`;
    }

    /** Cor do texto da coluna "Situação": vermelho para o urgente, âmbar para o atenção. */
    function corSituacao(texto) {
        if (/^(Acabou|Vencido|Vence hoje)/.test(texto)) return VERMELHO;
        if (/^(Abaixo|No mínimo|Vence)/.test(texto)) return AMBAR;
        if (texto === 'Normal') return VERDE;
        return null;
    }

    /* ---------- Montagem ---------- */

    function gerar(dados, opcoes) {
        const config = opcoes || {};
        const { jsPDF } = global.jspdf;
        const autoTable = global.autoTable;
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
        const largura = doc.internal.pageSize.getWidth();
        const altura = doc.internal.pageSize.getHeight();
        const util = largura - MARGEM * 2;
        const filial = (dados.filial && dados.filial.nome) || '';
        const de = dados.periodo.data_inicio;
        const ate = dados.periodo.data_fim;
        const agora = config.agora || new Date();
        let y = 18;

        const escrever = (texto, x, posY, estilo) => {
            const e = estilo || {};
            doc.setFont('helvetica', e.negrito ? 'bold' : 'normal');
            doc.setFontSize(e.tamanho || 10);
            doc.setTextColor(...(e.cor || TEXTO));
            doc.text(limpar(texto), x, posY, e.alinhar ? { align: e.alinhar } : undefined);
        };

        /** Garante espaço para um título + algumas linhas; senão, nova página. */
        const espaco = (necessario) => {
            if (y + necessario > altura - 18) {
                doc.addPage();
                y = 18;
            }
        };

        const titulo = (texto, ajuda) => {
            espaco(30);
            escrever(texto, MARGEM, y, { negrito: true, tamanho: 13, cor: AZUL });
            y += 5;
            if (ajuda) {
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(8.5);
                const linhas = doc.splitTextToSize(limpar(ajuda), util);
                doc.setTextColor(...CINZA);
                doc.text(linhas, MARGEM, y);
                y += linhas.length * 3.8;
            }
            y += 1.5;
        };

        const semDados = (texto) => {
            escrever(texto, MARGEM, y + 2, { tamanho: 9.5, cor: CINZA });
            y += 10;
        };

        const tabela = (head, body, colunas, indiceSituacao) => {
            autoTable(doc, {
                startY: y,
                head: [head.map(limpar)],
                body: body.map((linha) => linha.map(limpar)),
                margin: { left: MARGEM, right: MARGEM, top: 18, bottom: 18 },
                theme: 'grid',
                styles: {
                    font: 'helvetica',
                    fontSize: 8.5,
                    cellPadding: { top: 1.8, bottom: 1.8, left: 2.2, right: 2.2 },
                    textColor: TEXTO,
                    lineColor: BORDA,
                    lineWidth: 0.2,
                    valign: 'middle',
                },
                headStyles: { fillColor: AZUL, textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
                alternateRowStyles: { fillColor: FUNDO },
                columnStyles: colunas || {},
                didParseCell: (hook) => {
                    if (hook.section !== 'body' || indiceSituacao == null || hook.column.index !== indiceSituacao) return;
                    const cor = corSituacao(String(hook.cell.raw || ''));
                    if (cor) {
                        hook.cell.styles.textColor = cor;
                        hook.cell.styles.fontStyle = 'bold';
                    }
                },
            });
            y = doc.lastAutoTable.finalY + 9;
        };

        /* ----- Cabeçalho ----- */
        escrever('Hydra PDV', largura - MARGEM, y, { negrito: true, tamanho: 10, cor: AZUL, alinhar: 'right' });
        escrever('Relatório de Estoque', MARGEM, y, { negrito: true, tamanho: 19, cor: AZUL });
        y += 7;
        const intervalo = de === ate ? `no dia ${dataBR(de)}` : `de ${dataBR(de)} a ${dataBR(ate)}`;
        escrever(`${filial ? `Filial ${filial} · ` : ''}Movimentações ${intervalo}`, MARGEM, y, { tamanho: 10.5 });
        y += 5;
        const filtros = [];
        if (config.busca) filtros.push(`produto "${config.busca}"`);
        if (config.categoria) filtros.push(`categoria ${config.categoria}`);
        if (filtros.length) {
            escrever(`Filtros: ${filtros.join(' · ')}`, MARGEM, y, { tamanho: 9.5, cor: CINZA });
            y += 4.6;
        }
        const quando = `${agora.toLocaleDateString('pt-BR')} às ${agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
        escrever(`Gerado em ${quando}${config.geradoPor ? ` por ${config.geradoPor}` : ''}`, MARGEM, y, { tamanho: 9.5, cor: CINZA });
        y += 4;
        doc.setDrawColor(...BORDA);
        doc.setLineWidth(0.4);
        doc.line(MARGEM, y, largura - MARGEM, y);
        y += 7;

        /* ----- Resumo (4 quadros) ----- */
        const r = dados.resumo;
        const quadros = [
            {
                rotulo: 'Entradas no período',
                valor: numero(r.entradas.registros),
                detalhe: r.entradas.registros
                    ? `${plural(r.entradas.registros, 'registro', 'registros')} em ${numero(r.entradas.produtos)} ${plural(r.entradas.produtos, 'produto', 'produtos')}`
                    : 'nenhuma entrada',
                cor: VERDE,
            },
            {
                rotulo: 'Saídas no período',
                valor: numero(r.saidas.registros),
                detalhe: r.saidas.registros
                    ? `${numero(r.saidas.por_venda)} por venda, ${numero(r.saidas.registros - r.saidas.por_venda)} por outros motivos`
                    : 'nenhuma saída',
                cor: AZUL,
            },
            {
                rotulo: 'Em falta agora',
                valor: numero(r.em_falta.total),
                detalhe: r.em_falta.total
                    ? `${numero(r.em_falta.acabou)} ${plural(r.em_falta.acabou, 'acabou', 'acabaram')}, ${numero(r.em_falta.total - r.em_falta.acabou)} no mínimo ou abaixo`
                    : 'nenhum produto faltando',
                cor: r.em_falta.total ? VERMELHO : TEXTO,
            },
            {
                rotulo: `Vencendo (até ${dados.dias_validade} dias)`,
                valor: numero(r.vencendo.lotes),
                detalhe: r.vencendo.lotes
                    ? `${plural(r.vencendo.lotes, 'lote', 'lotes')}, ${numero(r.vencendo.vencidos)} ${plural(r.vencendo.vencidos, 'vencido', 'vencidos')}`
                    : 'nada vencendo',
                cor: r.vencendo.lotes ? AMBAR : TEXTO,
            },
        ];
        const vao = 4;
        const larguraQuadro = (util - vao * 3) / 4;
        const alturaQuadro = 23;
        quadros.forEach((quadro, indice) => {
            const x = MARGEM + indice * (larguraQuadro + vao);
            doc.setFillColor(...FUNDO);
            doc.setDrawColor(...BORDA);
            doc.setLineWidth(0.3);
            doc.roundedRect(x, y, larguraQuadro, alturaQuadro, 2.5, 2.5, 'FD');
            escrever(quadro.rotulo, x + 3.5, y + 5.5, { negrito: true, tamanho: 8, cor: CINZA });
            escrever(quadro.valor, x + 3.5, y + 13.2, { negrito: true, tamanho: 17, cor: quadro.cor });
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.2);
            doc.setTextColor(...CINZA);
            doc.text(doc.splitTextToSize(limpar(quadro.detalhe), larguraQuadro - 7).slice(0, 2), x + 3.5, y + 17.6);
        });
        y += alturaQuadro + 10;

        /* ----- Entradas e saídas por produto ----- */
        titulo('Entradas e saídas por produto',
            '"Vendido" já desconta as vendas canceladas. "Outras saídas" são perdas, vencimentos, ajustes e devoluções. "Estoque agora" é a quantidade no momento em que o PDF foi gerado.');
        const porProduto = dados.por_produto || [];
        if (porProduto.length) {
            tabela(
                ['Produto', 'Categoria', 'Entradas', 'Vendido', 'Outras saídas', 'Estoque agora', 'Situação'],
                porProduto.map((item) => {
                    const situacoes = [textoEstoque(item.situacao_estoque), textoValidade(item.vence_em_dias)].filter(Boolean);
                    return [
                        item.nome,
                        item.categoria || '',
                        qtdOuTraco(item.entradas, item.unidade, '+'),
                        qtdOuTraco(item.vendido, item.unidade),
                        qtdOuTraco(item.outras_saidas, item.unidade),
                        quantidade(item.estoque, item.unidade),
                        situacoes.length ? situacoes.join(' / ') : 'Normal',
                    ];
                }),
                {
                    0: { cellWidth: 42, fontStyle: 'bold' },
                    1: { cellWidth: 23 },
                    2: { halign: 'right' },
                    3: { halign: 'right' },
                    4: { halign: 'right' },
                    5: { halign: 'right' },
                    6: { cellWidth: 35 },
                },
                6
            );
            if (dados.por_produto_limitado) semDados('A lista mostra os primeiros 1.000 produtos. Use a busca para ver outros.');
        } else {
            semDados('Nenhuma entrada ou saída de produto nesse período.');
        }

        /* ----- Em falta ----- */
        titulo('Produtos em falta ou no estoque mínimo', 'Situação no momento em que o PDF foi gerado.');
        const emFalta = dados.em_falta || [];
        if (emFalta.length) {
            tabela(
                ['Produto', 'Categoria', 'Tem agora', 'Mínimo', 'Falta para o mínimo', 'Última entrada', 'Situação'],
                emFalta.map((item) => [
                    item.nome,
                    item.categoria || '',
                    quantidade(item.estoque, item.unidade),
                    item.estoque_minimo ? quantidade(item.estoque_minimo, item.unidade) : '-',
                    item.falta ? quantidade(item.falta, item.unidade) : '-',
                    item.ultima_entrada ? dataBR(item.ultima_entrada) : '-',
                    textoEstoque(item.situacao),
                ]),
                {
                    0: { cellWidth: 44, fontStyle: 'bold' },
                    2: { halign: 'right' },
                    3: { halign: 'right' },
                    4: { halign: 'right' },
                    6: { cellWidth: 31 },
                },
                6
            );
        } else {
            semDados('Nenhum produto em falta: todos estão acima do estoque mínimo.');
        }

        /* ----- Vencendo ----- */
        titulo(`Lotes vencidos ou que vencem em até ${dados.dias_validade} dias`, 'Lotes com produto na prateleira. Situação no momento em que o PDF foi gerado.');
        const vencendo = dados.vencendo || [];
        if (vencendo.length) {
            tabela(
                ['Produto', 'Categoria', 'Lote', 'Quantidade', 'Validade', 'Situação'],
                vencendo.map((item) => [
                    item.nome,
                    item.categoria || '',
                    item.lote && item.lote !== 'SEM-LOTE' ? item.lote : 'Sem lote',
                    quantidade(item.quantidade, item.unidade),
                    dataBR(item.validade),
                    textoValidade(item.dias),
                ]),
                {
                    0: { cellWidth: 50, fontStyle: 'bold' },
                    3: { halign: 'right' },
                },
                5
            );
        } else {
            semDados(`Nenhum lote vencido ou vencendo nos próximos ${dados.dias_validade} dias.`);
        }

        /* ----- Movimentações ----- */
        const mov = dados.movimentacoes || { itens: [], total: 0 };
        titulo('Movimentações do período', mov.total > mov.itens.length
            ? `Da mais recente para a mais antiga. Mostrando as ${numero(mov.itens.length)} mais recentes de ${numero(mov.total)}.`
            : 'Da mais recente para a mais antiga.');
        if (mov.itens.length) {
            tabela(
                ['Data e hora', 'Produto', 'Tipo', 'Motivo', 'Quantidade', 'Quem registrou'],
                mov.itens.map((item) => [
                    `${dataBR(item.data)} ${String(item.data).slice(11, 16)}`,
                    item.produto,
                    item.tipo === 'entrada' ? 'Entrada' : 'Saída',
                    item.detalhe ? `${item.motivo}\n${item.detalhe}` : item.motivo,
                    `${item.tipo === 'entrada' ? '+' : '-'}${quantidade(item.quantidade, item.unidade)}`,
                    item.responsavel || '-',
                ]),
                {
                    0: { cellWidth: 27 },
                    1: { cellWidth: 38, fontStyle: 'bold' },
                    2: { cellWidth: 15 },
                    4: { halign: 'right', cellWidth: 22 },
                    5: { cellWidth: 28 },
                }
            );
        } else {
            semDados('Nenhuma movimentação nesse período.');
        }

        /* ----- Rodapé em todas as páginas ----- */
        const paginas = doc.getNumberOfPages();
        for (let pagina = 1; pagina <= paginas; pagina += 1) {
            doc.setPage(pagina);
            doc.setDrawColor(...BORDA);
            doc.setLineWidth(0.3);
            doc.line(MARGEM, altura - 12, largura - MARGEM, altura - 12);
            escrever(`Hydra PDV · Relatório de Estoque${filial ? ` · Filial ${filial}` : ''}`, MARGEM, altura - 7.5, { tamanho: 8, cor: CINZA });
            escrever(`Página ${pagina} de ${paginas}`, largura - MARGEM, altura - 7.5, { tamanho: 8, cor: CINZA, alinhar: 'right' });
        }

        if (config.retornar) return doc;
        doc.save(`relatorio-estoque_${dataBR(de).replace(/\//g, '-')}_a_${dataBR(ate).replace(/\//g, '-')}.pdf`);
        return doc;
    }

    global.hydraRelatorioEstoquePdf = gerar;
})(typeof window !== 'undefined' ? window : globalThis);
