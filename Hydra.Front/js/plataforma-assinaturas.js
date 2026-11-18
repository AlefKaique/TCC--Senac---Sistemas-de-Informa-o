/*
 * Painel da plataforma → Assinaturas.
 *   assinaturas.html : todas as assinaturas, indicadores e filtros.
 *   assinatura.html  : um mercado — lançar pagamento, alterar plano ou
 *                      vencimento, cancelar, suspender, conferir no
 *                      Mercado Pago, histórico e contato do titular.
 * API: /api/plataforma/assinaturas (PlataformaAssinaturaController).
 * Linhas clicáveis e "Copiar e-mail" vêm do plataforma-app.js.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const shell = document.querySelector('.plataforma-shell');
  if (!shell) return;
  const page = shell.dataset.page;
  if (page !== 'assinaturas' && page !== 'assinatura') return;
  try {
    await window.plataformaSessaoPromise;
  } catch (_) {
    return;
  }

  const erroBox = document.getElementById('plataforma-erro');
  const sucessoBox = document.getElementById('plataforma-sucesso');

  /* ================= Utilitários ================= */

  const escapeHtml = (valor) => String(valor ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseData = (valor) => {
    if (!valor) return null;
    const raw = String(valor);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const dataBR = (valor) => {
    const d = valor instanceof Date ? valor : parseData(valor);
    return d ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(d) : '—';
  };
  const dataHoraBR = (valor) => {
    const d = parseData(valor);
    return d ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(d) : '—';
  };
  const dinheiro = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v || 0));
  const numero = (v) => Number(v || 0).toLocaleString('pt-BR');
  const plural = (n, um, varios) => `${numero(n)} ${Number(n) === 1 ? um : varios}`;
  const duracao = (meses) => (meses % 12 === 0
    ? plural(meses / 12, 'ano', 'anos')
    : plural(meses, 'mês', 'meses'));

  /** Soma meses como o DATE_ADD do MySQL: 31/01 + 1 mês = último dia de fevereiro. */
  function somarMeses(data, meses) {
    const d = new Date(data.getTime());
    const dia = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + meses);
    const ultimoDia = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dia, ultimoDia));
    return d;
  }

  const SITUACOES = {
    ativa: 'Ativa',
    vencendo: 'Vence em breve',
    atrasada: 'Atrasada',
    cancelada: 'Cancelada',
    finalizada: 'Finalizada',
    gratuito: 'Plano gratuito',
    conta_encerrada: 'Conta encerrada',
  };

  /** "Ativa" que vence em até 7 dias aparece como "Vence em breve". */
  const situacaoVisual = (a) => (a.situacao === 'ativa' && a.dias !== null && a.dias <= 7 ? 'vencendo' : a.situacao);
  const seloSituacao = (a) => {
    const s = situacaoVisual(a);
    return `<span class="plataforma-badge sit-${s}">${SITUACOES[s] || escapeHtml(s)}</span>`;
  };

  /** Data de vencimento e o texto curto que a acompanha. */
  function vencimento(a) {
    if (a.plano_contratado === 'start' || !a.valido_ate) return { data: '—', detalhe: '' };
    const dias = Number(a.dias);
    let detalhe = '';
    if (a.situacao === 'atrasada') {
      detalhe = dias === 0 ? '<span class="plataforma-atraso">venceu hoje</span>'
        : `<span class="plataforma-atraso">${plural(-dias, 'dia', 'dias')} em atraso</span>`;
    } else if (a.situacao === 'ativa' || a.situacao === 'cancelada') {
      detalhe = dias <= 0 ? 'vence hoje' : dias === 1 ? 'vence amanhã' : `faltam ${numero(dias)} dias`;
    } else if (a.situacao === 'finalizada' || a.situacao === 'conta_encerrada') {
      detalhe = 'encerrada';
    }
    return { data: dataBR(a.valido_ate), detalhe };
  }

  function limparMensagens() {
    if (erroBox) erroBox.textContent = '';
    if (sucessoBox) {
      sucessoBox.textContent = '';
      sucessoBox.classList.remove('is-info');
    }
  }

  function mostrarMensagem(texto, tipo = 'sucesso') {
    if (!sucessoBox) return;
    sucessoBox.textContent = texto;
    sucessoBox.classList.toggle('is-info', tipo === 'info');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function carregar(url) {
    try {
      if (erroBox) erroBox.textContent = '';
      return await window.hydraApi(url);
    } catch (falha) {
      if (erroBox) erroBox.textContent = falha.message || 'Não foi possível carregar as informações. Tente novamente.';
      throw falha;
    }
  }

  function setQuery(valores) {
    const params = new URLSearchParams(window.location.search);
    Object.entries(valores).forEach(([chave, valor]) => {
      if (valor === '' || valor === null || valor === undefined) params.delete(chave);
      else params.set(chave, String(valor));
    });
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }

  /* ================= Lista (assinaturas.html) ================= */

  const CHIPS = [
    ['', 'Todas', null],
    ['ativa', 'Ativas', 'ativas'],
    ['vencendo', 'Vencem em 7 dias', 'vencendo_7_dias'],
    ['atrasada', 'Atrasadas', 'atrasadas'],
    ['cancelada', 'Canceladas', 'canceladas'],
    ['finalizada', 'Finalizadas', 'finalizadas'],
    ['gratuito', 'Plano gratuito', 'gratuitas'],
    ['conta_encerrada', 'Contas encerradas', 'contas_encerradas'],
  ];

  function desenharIndicadores(r) {
    const mes = new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(new Date());
    const cards = [
      { rotulo: 'Assinaturas ativas', valor: numero(r.ativas), ajuda: 'Pagas e dentro do período', filtro: 'ativa' },
      { rotulo: 'Vencem em 7 dias', valor: numero(r.vencendo_7_dias), ajuda: 'Lembre o titular de renovar', filtro: 'vencendo' },
      { rotulo: 'Atrasadas', valor: numero(r.atrasadas), ajuda: `${dinheiro(r.valor_em_atraso)} em aberto`, filtro: 'atrasada' },
      { rotulo: 'Canceladas', valor: numero(r.canceladas), ajuda: 'Valem até o fim do período', filtro: 'cancelada' },
      { rotulo: 'Receita recorrente / mês', valor: dinheiro(r.receita_mensal), ajuda: 'Ativas; o Premium entra como 1/12', pequeno: true },
      { rotulo: `Recebido em ${mes}`, valor: dinheiro(r.recebido_no_mes), ajuda: 'Pagamentos aprovados no mês', pequeno: true },
      { rotulo: 'Pagamentos em andamento', valor: numero(r.checkouts_pendentes), ajuda: 'PIX ou boleto do Mercado Pago aguardando' },
      { rotulo: 'Plano gratuito', valor: numero(r.gratuitas), ajuda: 'Mercados no Hydra Start', filtro: 'gratuito' },
    ];
    document.getElementById('assinaturas-cards').innerHTML = cards.map((c) => {
      const conteudo = `<span class="plataforma-card-label">${escapeHtml(c.rotulo)}</span><strong class="plataforma-card-value${c.pequeno ? ' plataforma-kpi-small' : ''}">${c.valor}</strong><span class="plataforma-card-help">${escapeHtml(c.ajuda)}</span>`;
      return c.filtro
        ? `<a class="plataforma-card" href="assinaturas.html?situacao=${c.filtro}" data-situacao="${c.filtro}">${conteudo}</a>`
        : `<div class="plataforma-card">${conteudo}</div>`;
    }).join('');

    const devolver = document.getElementById('assinaturas-devolver');
    const qtd = Number(r.pagamentos_a_devolver || 0);
    devolver.hidden = qtd === 0;
    if (qtd > 0) {
      devolver.innerHTML = `<strong>${plural(qtd, 'pagamento precisa', 'pagamentos precisam')} ser devolvido${qtd === 1 ? '' : 's'}.</strong> `
        + 'Foram aprovados no Mercado Pago depois de o titular encerrar a conta, por isso o plano não foi liberado. '
        + 'Devolva o valor pelo painel do Mercado Pago. Eles aparecem com o selo “Devolver valor” no histórico do mercado (filtro Contas encerradas).';
    }
  }

  async function carregarLista() {
    const params = new URLSearchParams(window.location.search);
    const situacao = params.get('situacao') || '';
    document.getElementById('filtro-busca').value = params.get('busca') || '';
    document.getElementById('filtro-plano').value = params.get('plano') || '';
    document.getElementById('filtro-ordem').value = params.get('ordem') || 'prioridade';

    const query = new URLSearchParams();
    ['situacao', 'plano', 'busca', 'ordem', 'pagina'].forEach((chave) => {
      const valor = params.get(chave);
      if (valor) query.set(chave, valor);
    });
    const data = await carregar(`/plataforma/assinaturas?${query.toString()}`);
    const r = data.resumo;

    desenharIndicadores(r);
    document.getElementById('filtro-situacao').innerHTML = CHIPS.map(([valor, rotulo, chave]) => {
      const total = chave ? `<span class="plataforma-chip-total">${numero(r[chave])}</span>` : '';
      return `<button type="button" class="plataforma-chip" data-situacao="${valor}" aria-pressed="${situacao === valor}">${rotulo}${total}</button>`;
    }).join('');

    const tbody = document.getElementById('assinaturas-body');
    document.getElementById('assinaturas-vazio').hidden = data.assinaturas.length > 0;
    tbody.innerHTML = data.assinaturas.map((a) => {
      const href = `assinatura.html?id=${encodeURIComponent(a.id)}${window.location.search ? `&voltar=${encodeURIComponent(window.location.search.slice(1))}` : ''}`;
      const suspenso = a.status_loja === 'suspensa' ? '<span class="plataforma-sub plataforma-atraso">Mercado suspenso</span>' : '';
      const v = vencimento(a);
      const u = a.ultimo_pagamento;
      const ultimo = u
        ? `${dataBR(u.pago_em)}<span class="plataforma-sub">${dinheiro(u.valor)} · ${escapeHtml(u.nome_forma || (u.origem === 'manual' ? 'Lançado pela equipe' : 'Mercado Pago'))}</span>`
        : '<span class="plataforma-sub">Nenhum</span>';
      const plano = a.plano_contratado === 'start'
        ? 'Hydra Start'
        : `${escapeHtml(a.nome_plano)}<span class="plataforma-sub">${dinheiro(a.valor_plano)} · ${escapeHtml(String(a.periodo_plano).toLowerCase())}</span>`;
      return `<tr data-href="${escapeHtml(href)}">
        <td><a href="${escapeHtml(href)}">${escapeHtml(a.nome)}</a><span class="plataforma-sub">${escapeHtml(a.titular_nome || 'Sem titular')}${a.titular_email ? ` · ${escapeHtml(a.titular_email)}` : ''}</span></td>
        <td>${plano}</td>
        <td>${seloSituacao(a)}${suspenso}${a.pagamento_pendente ? '<span class="plataforma-sub">Pagamento em andamento</span>' : ''}</td>
        <td>${v.data}${v.detalhe ? `<span class="plataforma-sub">${v.detalhe}</span>` : ''}</td>
        <td>${ultimo}</td>
      </tr>`;
    }).join('');

    const pg = data.paginacao;
    document.getElementById('assinaturas-paginacao').innerHTML = `<span>${numero(pg.total)} mercado(s) · página ${pg.pagina} de ${Math.max(1, pg.total_paginas)}</span>`
      + `<div class="plataforma-actions"><button type="button" class="plataforma-btn" data-pagina="${pg.pagina - 1}" ${pg.pagina <= 1 ? 'disabled' : ''}>Anterior</button>`
      + `<button type="button" class="plataforma-btn" data-pagina="${pg.pagina + 1}" ${pg.pagina >= pg.total_paginas ? 'disabled' : ''}>Próxima</button></div>`;
  }

  async function recarregarLista() {
    try {
      await carregarLista();
    } catch (_) {
      // A mensagem já foi mostrada por carregar().
    }
  }

  if (page === 'assinaturas') {
    document.getElementById('filtros-assinaturas').addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const form = new FormData(evento.currentTarget);
      setQuery({ busca: String(form.get('busca') || '').trim(), plano: form.get('plano'), ordem: form.get('ordem') === 'prioridade' ? '' : form.get('ordem'), pagina: '' });
      await recarregarLista();
    });
    document.getElementById('limpar-filtros').addEventListener('click', async () => {
      window.history.replaceState(null, '', window.location.pathname);
      await recarregarLista();
    });
    document.addEventListener('click', async (evento) => {
      const filtro = evento.target.closest('[data-situacao]');
      if (filtro) {
        evento.preventDefault();
        setQuery({ situacao: filtro.dataset.situacao, pagina: '' });
        await recarregarLista();
        return;
      }
      const pagina = evento.target.closest('[data-pagina]');
      if (pagina && !pagina.disabled) {
        setQuery({ pagina: pagina.dataset.pagina });
        await recarregarLista();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
    await recarregarLista();
    return;
  }

  /* ================= Um mercado (assinatura.html) ================= */

  const params = new URLSearchParams(window.location.search);
  const idLoja = params.get('id');
  const alvo = document.getElementById('detalhe-assinatura');
  let dados = null;

  const ACOES = {
    assinatura_paga_titular: 'Titular pagou pelo Mercado Pago',
    assinatura_cancelada_titular: 'Titular cancelou a assinatura',
    assinatura_reativada_titular: 'Titular desfez o cancelamento',
    assinatura_pagamento_registrado: 'Pagamento registrado pela equipe',
    assinatura_ajustada: 'Plano ou vencimento alterado',
    assinatura_cancelada_plataforma: 'Assinatura cancelada pela equipe',
    assinatura_reativada_plataforma: 'Cancelamento desfeito pela equipe',
    assinatura_pagamento_conferido: 'Pagamento conferido no Mercado Pago',
    mercado_suspenso: 'Mercado suspenso',
    mercado_reativado: 'Mercado reativado',
    conta_encerrada_titular: 'Titular encerrou a conta',
  };

  const STATUS_PAGAMENTO = {
    aprovado: ['Aprovado', 'status-ativa'],
    pendente: ['Aguardando pagamento', 'status-pendente'],
    rejeitado: ['Recusado', 'status-suspenso'],
    cancelado: ['Checkout abandonado', 'status-inativo'],
  };

  const planoPorCodigo = (codigo) => dados.planos.find((p) => p.codigo === codigo);

  function mensagemContato(a) {
    const nome = a.titular_nome ? a.titular_nome.split(' ')[0] : '';
    const inicio = `Olá${nome ? `, ${nome}` : ''}! Aqui é da equipe Hydra.`;
    if (a.situacao === 'atrasada') {
      return `${inicio} A assinatura do ${a.nome_plano} do ${a.nome} venceu em ${dataBR(a.valido_ate)} e ainda não identificamos o pagamento. Podemos ajudar a regularizar?`;
    }
    if (a.situacao === 'ativa') {
      return `${inicio} A assinatura do ${a.nome_plano} do ${a.nome} vence em ${dataBR(a.valido_ate)}. Para continuar sem interrupção, renove pela tela Privacidade do sistema ou fale com a gente.`;
    }
    return `${inicio} Estamos entrando em contato sobre a assinatura do ${a.nome}.`;
  }

  function desenharDetalhe() {
    const a = dados.assinatura;
    const podeGerenciar = Boolean(dados.pode_gerenciar);
    const contaAberta = a.situacao !== 'conta_encerrada';
    const voltar = params.get('voltar');
    const voltarUrl = `assinaturas.html${voltar ? `?${voltar}` : ''}`;
    const v = vencimento(a);
    const visual = situacaoVisual(a);
    const devolver = dados.pagamentos.filter((p) => p.devolver).length;
    const ultimoPago = dados.pagamentos.find((p) => p.status === 'aprovado');

    const avisos = [];
    if (!contaAberta) {
      avisos.push(`<div class="plataforma-alerta"><strong>O titular encerrou a conta em ${dataBR(a.conta_encerrada_em)}.</strong> Os dados foram anonimizados e a assinatura não pode mais ser alterada.</div>`);
    }
    if (devolver > 0) {
      avisos.push(`<div class="plataforma-alerta"><strong>${plural(devolver, 'pagamento precisa', 'pagamentos precisam')} ser devolvido${devolver === 1 ? '' : 's'}.</strong> Foi aprovado no Mercado Pago depois do encerramento da conta e não liberou plano. Devolva pelo painel do Mercado Pago.</div>`);
    }
    if (a.situacao === 'atrasada') {
      avisos.push(`<div class="plataforma-alerta"><strong>Pagamento em atraso desde ${dataBR(a.valido_ate)}${a.dias < 0 ? ` (${plural(-a.dias, 'dia', 'dias')})` : ''}.</strong> Até regularizar, o mercado usa o Hydra Start (gratuito). Registre o pagamento quando ele chegar, encerre a cobrança se o mercado desistiu do plano ou, se preferir, suspenda o mercado.</div>`);
    } else if (visual === 'vencendo') {
      avisos.push(`<div class="plataforma-alerta plataforma-alerta-aviso"><strong>Vence ${a.dias <= 0 ? 'hoje' : a.dias === 1 ? 'amanhã' : `em ${a.dias} dias`} (${dataBR(a.valido_ate)}).</strong> Não há cobrança automática: lembre o titular de renovar.</div>`);
    } else if (a.situacao === 'cancelada') {
      avisos.push(`<div class="plataforma-alerta plataforma-alerta-aviso"><strong>Cancelada em ${dataBR(a.cancelada_em)}: não será renovada.</strong> O ${escapeHtml(a.nome_plano)} vale até ${dataBR(a.valido_ate)}; depois o mercado volta ao Hydra Start.</div>`);
    }
    if (a.status_loja === 'suspensa') {
      avisos.push(`<div class="plataforma-suspenso-aviso"><strong>Este mercado está suspenso.</strong><br>Motivo: ${escapeHtml(a.motivo_status || 'Não informado')} · ${dataHoraBR(a.status_alterado_em)}</div>`);
    }

    let acoes;
    if (!podeGerenciar) {
      acoes = '<p class="plataforma-note">Seu nível de acesso permite apenas consultar. Lançar pagamentos e alterar assinaturas é para Administrador, Proprietário ou Gestor.</p>';
    } else if (!contaAberta) {
      acoes = '<p class="plataforma-note">Conta encerrada: não há ações disponíveis.</p>';
    } else {
      const botoes = ['<button type="button" class="plataforma-btn plataforma-btn-success" data-acao="pagamento">Registrar pagamento</button>',
        '<button type="button" class="plataforma-btn" data-acao="ajuste">Alterar plano ou vencimento</button>'];
      if (a.situacao === 'ativa') botoes.push('<button type="button" class="plataforma-btn plataforma-btn-danger" data-acao="cancelar">Cancelar assinatura</button>');
      if (a.situacao === 'atrasada') botoes.push('<button type="button" class="plataforma-btn plataforma-btn-danger" data-acao="cancelar">Encerrar cobrança em atraso</button>');
      if (a.situacao === 'cancelada') botoes.push('<button type="button" class="plataforma-btn" data-acao="reativar">Desfazer cancelamento</button>');
      if (a.status_loja === 'suspensa') botoes.push('<button type="button" class="plataforma-btn plataforma-btn-success" data-acao="reativar-mercado">Reativar mercado</button>');
      if (a.status_loja === 'ativa') botoes.push('<button type="button" class="plataforma-btn plataforma-btn-danger" data-acao="suspender">Suspender mercado</button>');
      const ajuda = ['<li><strong>Registrar pagamento:</strong> libera o plano para um valor recebido fora do sistema (PIX direto, transferência, dinheiro) ou como cortesia.</li>',
        '<li><strong>Alterar plano ou vencimento:</strong> corrige um lançamento, dá dias extras ou passa o mercado para o plano gratuito.</li>'];
      if (a.situacao === 'atrasada') ajuda.push('<li><strong>Encerrar cobrança:</strong> o mercado desistiu; a assinatura sai das atrasadas e ele fica no plano gratuito.</li>');
      if (a.situacao === 'ativa') ajuda.push('<li><strong>Cancelar assinatura:</strong> não renova; o plano vale até o vencimento.</li>');
      if (a.status_loja === 'ativa') ajuda.push('<li><strong>Suspender mercado:</strong> bloqueia o acesso de toda a equipe do mercado até a reativação, sem apagar dados.</li>');
      acoes = `<div class="plataforma-acoes-grade">${botoes.join('')}</div><ul class="plataforma-acoes-ajuda">${ajuda.join('')}</ul>`;
    }

    const telefone = String(a.telefone || '').replace(/\D/g, '');
    const whatsapp = telefone.length >= 10 && telefone.length <= 11
      ? `https://wa.me/55${telefone}?text=${encodeURIComponent(mensagemContato(a))}` : null;
    const mailto = a.titular_email
      ? `mailto:${encodeURIComponent(a.titular_email)}?subject=${encodeURIComponent(`Assinatura Hydra - ${a.nome}`)}&body=${encodeURIComponent(mensagemContato(a))}` : null;
    const contato = contaAberta && (a.titular_email || a.telefone)
      ? `<div class="plataforma-info"><span>Titular</span><strong>${escapeHtml(a.titular_nome || '—')}</strong></div>
         ${a.titular_email ? `<div class="plataforma-info"><span>E-mail</span><strong><a href="${escapeHtml(mailto)}">${escapeHtml(a.titular_email)}</a> <button class="plataforma-btn" type="button" data-copiar="${escapeHtml(a.titular_email)}">Copiar e-mail</button></strong></div>` : ''}
         ${a.telefone ? `<div class="plataforma-info"><span>Telefone do mercado</span><strong>${escapeHtml(a.telefone)}${whatsapp ? ` <a class="plataforma-btn" href="${escapeHtml(whatsapp)}" target="_blank" rel="noopener">Mensagem no WhatsApp</a>` : ''}</strong></div>` : ''}`
      : '<p class="plataforma-empty">Não há contato disponível.</p>';

    const linhasPagamento = dados.pagamentos.map((p) => {
      const [rotulo, classe] = p.devolver ? ['Devolver valor', 'sit-atrasada'] : (STATUS_PAGAMENTO[p.status] || [p.status, 'status-inativo']);
      const periodo = p.valido_de && p.valido_ate ? `${dataBR(p.valido_de)} a ${dataBR(p.valido_ate)}` : duracao(p.meses);
      const forma = p.nome_forma || (p.origem === 'mercado_pago' ? 'Mercado Pago' : '—');
      const registro = p.origem === 'manual'
        ? `Equipe: ${escapeHtml(p.registrado_por || 'membro removido')}${p.observacao ? `<span class="plataforma-sub">${escapeHtml(p.observacao)}</span>` : ''}`
        : `Titular, pelo Mercado Pago${p.id_mp ? `<span class="plataforma-sub">Nº ${escapeHtml(p.id_mp)}</span>` : ''}`;
      const conferir = podeGerenciar && dados.pagamento_online && p.origem === 'mercado_pago' && p.status !== 'aprovado'
        ? `<button type="button" class="plataforma-btn" data-conferir="${escapeHtml(p.id)}">Conferir no Mercado Pago</button>` : '';
      return `<tr>
        <td>${dataBR(p.pago_em || p.criado_em)}${p.pago_em ? '' : '<span class="plataforma-sub">checkout aberto</span>'}</td>
        <td>${escapeHtml(p.nome_plano)}<span class="plataforma-sub">${periodo}</span></td>
        <td>${dinheiro(p.valor)}<span class="plataforma-sub">${escapeHtml(forma)}</span></td>
        <td><span class="plataforma-badge ${classe}">${escapeHtml(rotulo)}</span>${conferir ? `<br>${conferir}` : ''}</td>
        <td class="plataforma-celula-texto">${registro}</td>
      </tr>`;
    }).join('');

    const historico = dados.historico.map((h) => {
      const quem = h.membro || (String(h.acao).endsWith('_titular') ? 'Titular do mercado' : 'Equipe Hydra');
      return `<div class="plataforma-timeline-item"><strong>${escapeHtml(ACOES[h.acao] || h.acao)}</strong><time>${dataHoraBR(h.data)} · ${escapeHtml(quem)}</time>${h.detalhe ? `<span class="plataforma-sub">${escapeHtml(h.detalhe)}</span>` : ''}</div>`;
    }).join('');

    alvo.innerHTML = `
      <div class="plataforma-page-heading">
        <div>
          <a class="plataforma-btn" href="${escapeHtml(voltarUrl)}">← Voltar para Assinaturas</a>
          <h2 style="margin-top:14px">${escapeHtml(a.nome)}</h2>
          <p>${seloSituacao(a)} <a href="mercado.html?id=${encodeURIComponent(a.id)}">Ver dados do mercado</a></p>
        </div>
      </div>
      ${avisos.join('')}
      <section class="plataforma-cards" aria-label="Resumo da assinatura">
        <div class="plataforma-card"><span class="plataforma-card-label">Plano</span><strong class="plataforma-card-value plataforma-kpi-small">${escapeHtml(a.nome_plano)}</strong><span class="plataforma-card-help">${a.plano_contratado === 'start' ? 'Gratuito' : `${dinheiro(a.valor_plano)} · ${escapeHtml(String(a.periodo_plano).toLowerCase())}`}</span></div>
        <div class="plataforma-card"><span class="plataforma-card-label">Situação</span><strong class="plataforma-card-value plataforma-kpi-small">${SITUACOES[visual] || escapeHtml(visual)}</strong><span class="plataforma-card-help">${a.plano !== a.plano_contratado ? 'Usando o Hydra Start agora' : 'Plano em uso'}</span></div>
        <div class="plataforma-card"><span class="plataforma-card-label">Vencimento</span><strong class="plataforma-card-value plataforma-kpi-small">${v.data}</strong><span class="plataforma-card-help">${v.detalhe || 'Sem vencimento'}</span></div>
        <div class="plataforma-card"><span class="plataforma-card-label">Último pagamento</span><strong class="plataforma-card-value plataforma-kpi-small">${ultimoPago ? dinheiro(ultimoPago.valor) : '—'}</strong><span class="plataforma-card-help">${ultimoPago ? `${dataBR(ultimoPago.pago_em)} · ${escapeHtml(ultimoPago.nome_forma || 'Mercado Pago')}` : 'Nenhum pagamento aprovado'}</span></div>
      </section>
      <div class="plataforma-grid-2">
        <section class="plataforma-panel"><h2>Ações</h2>${acoes}</section>
        <section class="plataforma-panel"><h2>Contato do titular</h2><div class="plataforma-contato">${contato}</div></section>
      </div>
      <section class="plataforma-panel">
        <div class="plataforma-panel-heading"><div><h2>Pagamentos</h2><p>Pelo Mercado Pago (feitos pelo titular na tela Privacidade) e lançados pela equipe.</p></div></div>
        ${dados.pagamentos.length ? `<div class="plataforma-table-wrap"><table class="plataforma-table"><thead><tr><th>Data</th><th>Plano e período</th><th>Valor e forma</th><th>Situação</th><th>Registro</th></tr></thead><tbody>${linhasPagamento}</tbody></table></div>` : '<p class="plataforma-empty">Nenhum pagamento registrado para este mercado.</p>'}
        ${podeGerenciar && !dados.pagamento_online ? '<p class="plataforma-note" style="margin-top:12px">O pagamento online (MERCADOPAGO_ACCESS_TOKEN) não está configurado no servidor: o titular não consegue pagar pelo sistema e os pagamentos precisam ser lançados aqui.</p>' : ''}
      </section>
      <section class="plataforma-panel"><h2>Histórico da assinatura</h2>
        ${historico ? `<div class="plataforma-timeline">${historico}</div>` : '<p class="plataforma-empty">Ainda não há alterações registradas.</p>'}
      </section>`;
  }

  async function recarregarDetalhe() {
    if (!idLoja || !/^\d+$/.test(idLoja)) {
      alvo.innerHTML = '<div class="plataforma-error">O endereço não contém um número de mercado válido. <a href="assinaturas.html">Voltar para Assinaturas</a></div>';
      return;
    }
    try {
      dados = await carregar(`/plataforma/assinaturas/${encodeURIComponent(idLoja)}`);
      desenharDetalhe();
    } catch (falha) {
      if (!dados) alvo.innerHTML = '<p class="plataforma-empty"><a href="assinaturas.html">Voltar para Assinaturas</a></p>';
    }
  }

  /* ---------- Janelas ---------- */

  let focoAnterior = null;
  function abrirModal(modal, foco) {
    focoAnterior = document.activeElement;
    modal.querySelectorAll('[role="alert"]').forEach((el) => { el.textContent = ''; });
    modal.hidden = false;
    (foco || modal.querySelector('input, select, textarea, button')).focus();
  }
  function fecharModal(modal) {
    modal.hidden = true;
    if (focoAnterior && document.contains(focoAnterior)) focoAnterior.focus();
  }
  document.querySelectorAll('.plataforma-dialog [data-fechar-modal]').forEach((botao) => {
    botao.addEventListener('click', () => fecharModal(botao.closest('.plataforma-dialog')));
  });
  document.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Escape') return;
    const aberto = document.querySelector('.plataforma-dialog:not([hidden])');
    if (aberto) fecharModal(aberto);
  });

  async function enviar(botao, caixaErro, acao) {
    caixaErro.textContent = '';
    botao.disabled = true;
    try {
      await acao();
      return true;
    } catch (falha) {
      caixaErro.textContent = falha.message || 'Não foi possível concluir. Tente novamente.';
      return false;
    } finally {
      botao.disabled = false;
    }
  }

  /* ---------- Registrar pagamento ---------- */

  const modalPagamento = document.getElementById('modal-pagamento');
  const formPagamento = document.getElementById('form-pagamento');
  const pgPlano = document.getElementById('pagamento-plano');
  const pgPeriodos = document.getElementById('pagamento-periodos');
  const pgForma = document.getElementById('pagamento-forma');
  const pgValor = document.getElementById('pagamento-valor');
  const pgData = document.getElementById('pagamento-data');
  const pgObs = document.getElementById('pagamento-observacao');
  const pgInicio = document.getElementById('pagamento-inicio');
  const pgPrevia = document.getElementById('pagamento-previa');
  const pgErro = document.getElementById('pagamento-erro');
  let valorEditado = false;

  const formatarValor = (v) => Number(v).toFixed(2).replace('.', ',');
  /** "1.000,50" ou "1000.50" → 1000.5; null se não for um valor. */
  function lerValor(texto) {
    let t = String(texto || '').trim().replace(/^R\$\s*/, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    return /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : null;
  }

  function preencherPeriodos() {
    const p = planoPorCodigo(pgPlano.value);
    const [um, varios] = p.meses === 12 ? ['ano', 'anos'] : ['mês', 'meses'];
    pgPeriodos.innerHTML = Array.from({ length: p.max_periodos }, (_, i) => i + 1)
      .map((n) => `<option value="${n}">${n} ${n === 1 ? um : varios}</option>`).join('');
    pgPeriodos.value = '1';
  }

  function atualizarPagamento() {
    const a = dados.assinatura;
    const p = planoPorCodigo(pgPlano.value);
    const periodos = Number(pgPeriodos.value || 1);
    const cortesia = pgForma.value === 'cortesia';
    pgValor.disabled = cortesia;
    if (cortesia) pgValor.value = '0,00';
    else if (!valorEditado) pgValor.value = formatarValor(p.valor * periodos);

    const vigente = a.situacao === 'ativa' || a.situacao === 'cancelada';
    const inicioEscolhido = formPagamento.querySelector('input[name="inicio"]:checked');
    const doVencimento = a.situacao === 'atrasada' && inicioEscolhido && inicioEscolhido.value === 'vencimento';
    const base = (vigente || doVencimento) ? parseData(a.valido_ate) : new Date();
    const fim = somarMeses(base, periodos * p.meses);
    const continuaAtrasada = fim < new Date();

    let texto = `Depois do registro: <strong>${escapeHtml(p.nome)}</strong> válido até <strong>${dataBR(fim)}</strong>.`;
    if (vigente) texto += ` O período novo começa no vencimento atual (${dataBR(a.valido_ate)}), sem perder dias.`;
    if (a.situacao === 'cancelada') texto += ' O cancelamento é desfeito.';
    if (continuaAtrasada) texto += ' Mesmo assim a assinatura continua atrasada: aumente o período pago ou escolha começar hoje.';
    pgPrevia.classList.toggle('is-alerta', continuaAtrasada);
    pgPrevia.innerHTML = texto;
  }

  function abrirPagamento() {
    const a = dados.assinatura;
    pgPlano.innerHTML = dados.planos.filter((p) => p.codigo !== 'start')
      .map((p) => `<option value="${p.codigo}">${escapeHtml(p.nome)} — ${dinheiro(p.valor)} por ${p.meses === 12 ? 'ano' : 'mês'}</option>`).join('');
    pgPlano.value = a.plano_contratado !== 'start' ? a.plano_contratado : 'flex';
    pgForma.innerHTML = dados.formas.map((f) => `<option value="${f.codigo}">${escapeHtml(f.nome)}</option>`).join('');
    pgForma.value = 'pix';
    pgForma.dataset.anterior = 'pix';
    const hoje = isoLocal(new Date());
    pgData.value = hoje;
    pgData.max = hoje;
    pgObs.value = '';
    valorEditado = false;
    preencherPeriodos();
    pgInicio.hidden = a.situacao !== 'atrasada';
    document.getElementById('pagamento-inicio-vencimento').textContent = `No vencimento (${dataBR(a.valido_ate)})`;
    formPagamento.querySelector('input[name="inicio"][value="vencimento"]').checked = true;
    atualizarPagamento();
    abrirModal(modalPagamento, pgPlano);
  }

  pgPlano.addEventListener('change', () => { preencherPeriodos(); valorEditado = false; atualizarPagamento(); });
  pgPeriodos.addEventListener('change', () => { valorEditado = false; atualizarPagamento(); });
  pgForma.addEventListener('change', () => {
    // Saindo da cortesia, o valor volta a ser o preço do plano.
    if (pgForma.dataset.anterior === 'cortesia') valorEditado = false;
    pgForma.dataset.anterior = pgForma.value;
    atualizarPagamento();
  });
  pgValor.addEventListener('input', () => { valorEditado = true; });
  pgInicio.addEventListener('change', atualizarPagamento);

  formPagamento.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const cortesia = pgForma.value === 'cortesia';
    const valor = cortesia ? 0 : lerValor(pgValor.value);
    if (!cortesia && (valor === null || valor <= 0)) {
      pgErro.textContent = 'Informe o valor recebido, por exemplo 100,00. Para liberar sem cobrança, escolha "Cortesia".';
      pgValor.focus();
      return;
    }
    if (!pgData.value) {
      pgErro.textContent = 'Informe a data do pagamento.';
      pgData.focus();
      return;
    }
    if (cortesia && pgObs.value.trim().length < 10) {
      pgErro.textContent = 'Explique na observação o motivo da cortesia (mínimo de 10 caracteres).';
      pgObs.focus();
      return;
    }
    const inicio = formPagamento.querySelector('input[name="inicio"]:checked');
    let resposta = null;
    const ok = await enviar(document.getElementById('pagamento-confirmar'), pgErro, async () => {
      resposta = await window.hydraApi(`/plataforma/assinaturas/${idLoja}/pagamentos`, {
        method: 'POST',
        body: {
          plano: pgPlano.value,
          periodos: Number(pgPeriodos.value),
          valor,
          forma: pgForma.value,
          pago_em: pgData.value,
          observacao: pgObs.value.trim(),
          inicio: inicio ? inicio.value : 'vencimento',
        },
      });
    });
    if (!ok) return;
    fecharModal(modalPagamento);
    limparMensagens();
    await recarregarDetalhe();
    mostrarMensagem(`Pagamento registrado. ${planoPorCodigo(pgPlano.value).nome} válido até ${dataBR(resposta.valido_ate)}.`);
  });

  /* ---------- Alterar plano ou vencimento ---------- */

  const modalAjuste = document.getElementById('modal-ajuste');
  const formAjuste = document.getElementById('form-ajuste');
  const ajPlano = document.getElementById('ajuste-plano');
  const ajVencimento = document.getElementById('ajuste-vencimento');
  const ajCampoVencimento = document.getElementById('ajuste-vencimento-campo');
  const ajPrevia = document.getElementById('ajuste-previa');
  const ajMotivo = document.getElementById('ajuste-motivo');
  const ajErro = document.getElementById('ajuste-erro');

  function atualizarAjuste() {
    const a = dados.assinatura;
    const gratuito = ajPlano.value === 'start';
    ajCampoVencimento.hidden = gratuito;
    let texto;
    if (gratuito) {
      texto = 'O mercado passa para o Hydra Start (gratuito), sem vencimento, e sai das listas de ativas e atrasadas.';
    } else if (!ajVencimento.value) {
      texto = 'Escolha até quando o plano vale.';
    } else if (ajVencimento.value < isoLocal(new Date())) {
      texto = `Com essa data, a assinatura fica <strong>atrasada</strong> desde ${dataBR(ajVencimento.value)}.`;
    } else {
      texto = `O ${escapeHtml(planoPorCodigo(ajPlano.value).nome)} passa a valer até <strong>${dataBR(ajVencimento.value)}</strong> (inclusive).`;
    }
    if (!gratuito && a.cancelada_em && (a.situacao === 'cancelada' || a.situacao === 'finalizada')) {
      texto += ' A assinatura continua cancelada (não será renovada); se for o caso, use "Desfazer cancelamento" depois.';
    }
    const atrasara = !gratuito && ajVencimento.value && ajVencimento.value < isoLocal(new Date());
    ajPrevia.classList.toggle('is-alerta', Boolean(atrasara));
    ajPrevia.innerHTML = texto;
  }

  function abrirAjuste() {
    const a = dados.assinatura;
    ajPlano.innerHTML = dados.planos.map((p) => `<option value="${p.codigo}">${p.codigo === 'start' ? 'Hydra Start (gratuito)' : escapeHtml(p.nome)}</option>`).join('');
    ajPlano.value = a.plano_contratado;
    ajVencimento.value = a.valido_ate ? String(a.valido_ate).slice(0, 10) : isoLocal(somarMeses(new Date(), 1));
    ajMotivo.value = '';
    atualizarAjuste();
    abrirModal(modalAjuste, ajPlano);
  }

  ajPlano.addEventListener('change', atualizarAjuste);
  ajVencimento.addEventListener('input', atualizarAjuste);

  formAjuste.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const motivo = ajMotivo.value.trim();
    if (ajPlano.value !== 'start' && !ajVencimento.value) {
      ajErro.textContent = 'Informe até quando o plano vale.';
      ajVencimento.focus();
      return;
    }
    if (motivo.length < 10) {
      ajErro.textContent = 'Explique o motivo com pelo menos 10 caracteres.';
      ajMotivo.focus();
      return;
    }
    const ok = await enviar(document.getElementById('ajuste-confirmar'), ajErro, () => window.hydraApi(`/plataforma/assinaturas/${idLoja}/ajustar`, {
      method: 'POST',
      body: { plano: ajPlano.value, valido_ate: ajPlano.value === 'start' ? null : ajVencimento.value, motivo },
    }));
    if (!ok) return;
    fecharModal(modalAjuste);
    limparMensagens();
    await recarregarDetalhe();
    mostrarMensagem('Assinatura alterada.');
  });

  /* ---------- Confirmações com motivo ---------- */

  const modalConfirmar = document.getElementById('modal-confirmar');
  const formConfirmar = document.getElementById('form-confirmar');
  const cfMotivo = document.getElementById('confirmar-motivo');
  const cfCampoMotivo = document.getElementById('confirmar-motivo-campo');
  const cfBotao = document.getElementById('confirmar-acao');
  const cfErro = document.getElementById('confirmar-erro');
  let confirmacao = null;

  function abrirConfirmacao(opcoes) {
    confirmacao = opcoes;
    document.getElementById('modal-confirmar-titulo').textContent = opcoes.titulo;
    document.getElementById('modal-confirmar-texto').textContent = opcoes.texto;
    cfCampoMotivo.hidden = !opcoes.pedirMotivo;
    cfMotivo.value = opcoes.motivoInicial || '';
    cfBotao.textContent = opcoes.botao;
    cfBotao.className = `plataforma-btn ${opcoes.classe || 'plataforma-btn-danger'}`;
    abrirModal(modalConfirmar, opcoes.pedirMotivo ? cfMotivo : cfBotao);
  }

  formConfirmar.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (!confirmacao) return;
    const motivo = cfMotivo.value.trim();
    if (confirmacao.pedirMotivo && motivo.length < 10) {
      cfErro.textContent = 'Explique o motivo com pelo menos 10 caracteres.';
      cfMotivo.focus();
      return;
    }
    const atual = confirmacao;
    const ok = await enviar(cfBotao, cfErro, () => atual.executar(motivo));
    if (!ok) return;
    fecharModal(modalConfirmar);
    limparMensagens();
    await recarregarDetalhe();
    mostrarMensagem(atual.sucesso);
  });

  function confirmarAcao(acao) {
    const a = dados.assinatura;
    const post = (rota, body) => window.hydraApi(rota, { method: 'POST', body });
    const opcoes = {
      cancelar: a.situacao === 'atrasada' ? {
        titulo: 'Encerrar cobrança em atraso?',
        texto: `A assinatura em atraso desde ${dataBR(a.valido_ate)} é encerrada e o mercado fica no Hydra Start (gratuito). Ela deixa de aparecer como atrasada. Para voltar a um plano pago, basta registrar um novo pagamento.`,
        botao: 'Encerrar cobrança',
        pedirMotivo: true,
        sucesso: 'Cobrança encerrada. O mercado está no plano gratuito.',
        executar: (motivo) => post(`/plataforma/assinaturas/${idLoja}/cancelar`, { motivo }),
      } : {
        titulo: 'Cancelar assinatura?',
        texto: `A assinatura não será renovada. O ${a.nome_plano} continua valendo até ${dataBR(a.valido_ate)}; depois o mercado volta ao Hydra Start (gratuito). O titular vê o cancelamento na tela Privacidade e pode desfazê-lo até lá.`,
        botao: 'Confirmar cancelamento',
        pedirMotivo: true,
        sucesso: `Assinatura cancelada. Vale até ${dataBR(a.valido_ate)}.`,
        executar: (motivo) => post(`/plataforma/assinaturas/${idLoja}/cancelar`, { motivo }),
      },
      reativar: {
        titulo: 'Desfazer cancelamento?',
        texto: `A assinatura volta a contar como ativa até ${dataBR(a.valido_ate)}. Para continuar depois disso, o mercado precisa pagar de novo.`,
        botao: 'Desfazer cancelamento',
        classe: 'plataforma-btn-success',
        pedirMotivo: false,
        sucesso: 'Cancelamento desfeito.',
        executar: () => post(`/plataforma/assinaturas/${idLoja}/reativar`, {}),
      },
      suspender: {
        titulo: 'Suspender mercado?',
        texto: 'Os usuários deste mercado não conseguirão entrar no sistema até a reativação. Nenhum dado é apagado. O motivo aparece para a equipe Hydra.',
        botao: 'Confirmar suspensão',
        pedirMotivo: true,
        motivoInicial: a.situacao === 'atrasada' ? `Assinatura em atraso desde ${dataBR(a.valido_ate)}.` : '',
        sucesso: 'Mercado suspenso.',
        executar: (motivo) => post(`/plataforma/lojas/${idLoja}/suspender`, { motivo }),
      },
      'reativar-mercado': {
        titulo: 'Reativar mercado?',
        texto: 'Os usuários deste mercado voltam a entrar no sistema. Os dados continuam intactos.',
        botao: 'Confirmar reativação',
        classe: 'plataforma-btn-success',
        pedirMotivo: true,
        motivoInicial: '',
        sucesso: 'Mercado reativado.',
        executar: (motivo) => post(`/plataforma/lojas/${idLoja}/reativar`, { motivo }),
      },
    }[acao];
    if (opcoes) abrirConfirmacao(opcoes);
  }

  /* ---------- Cliques na página ---------- */

  alvo.addEventListener('click', async (evento) => {
    const botaoAcao = evento.target.closest('[data-acao]');
    if (botaoAcao && dados) {
      limparMensagens();
      const acao = botaoAcao.dataset.acao;
      if (acao === 'pagamento') abrirPagamento();
      else if (acao === 'ajuste') abrirAjuste();
      else confirmarAcao(acao);
      return;
    }

    const conferir = evento.target.closest('[data-conferir]');
    if (conferir) {
      limparMensagens();
      const texto = conferir.textContent;
      conferir.disabled = true;
      conferir.textContent = 'Conferindo…';
      try {
        const r = await window.hydraApi(`/plataforma/assinaturas/pagamentos/${encodeURIComponent(conferir.dataset.conferir)}/conferir`, { method: 'POST' });
        const mensagens = {
          aprovado: ['Pagamento aprovado no Mercado Pago. O plano foi liberado.', 'sucesso'],
          pendente: ['O Mercado Pago ainda aguarda este pagamento (PIX ou boleto gerado e não pago).', 'info'],
          rejeitado: ['O Mercado Pago recusou as tentativas de pagamento deste checkout.', 'info'],
          nao_encontrado: ['O titular abriu o checkout, mas não fez nenhuma tentativa de pagamento.', 'info'],
        };
        await recarregarDetalhe();
        const [mensagem, tipo] = mensagens[r.status] || ['Consulta concluída.', 'info'];
        mostrarMensagem(mensagem, tipo);
      } catch (falha) {
        conferir.disabled = false;
        conferir.textContent = texto;
        if (erroBox) erroBox.textContent = falha.message || 'Não foi possível consultar o Mercado Pago.';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  });

  await recarregarDetalhe();
});
