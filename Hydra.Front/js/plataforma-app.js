document.addEventListener('DOMContentLoaded', async () => {
  const shell = document.querySelector('.plataforma-shell');
  if (!shell) return;
  try {
    await window.plataformaSessaoPromise;
  } catch (_) {
    return;
  }

  const page = shell.dataset.page;
  const errorBox = document.getElementById('plataforma-erro');
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const dateTime = (value) => {
    if (!value) return 'Nunca';
    const date = new Date(String(value).replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
  };
  const dateOnly = (value) => {
    if (!value) return '—';
    const raw = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(`${raw}T12:00:00`)
      : new Date(raw.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(date);
  };
  const relativeDate = (value) => {
    if (!value) return 'Nunca';
    const date = new Date(String(value).replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) return '—';
    const dias = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
    if (dias === 0) return 'Hoje';
    if (dias === 1) return 'Há 1 dia';
    if (dias < 30) return `Há ${dias} dias`;
    const meses = Math.floor(dias / 30);
    if (meses === 1) return 'Há 1 mês';
    return `Há ${meses} meses`;
  };
  const currency = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
  const labelsStatus = { ativo: 'Ativo', novo: 'Novo', ocioso: 'Ocioso', inativo: 'Inativo', suspenso: 'Suspenso', pendente: 'Pendente', ativa: 'Ativa', inativa: 'Inativa' };
  const labelsNivel = { administrador: 'Administrador', proprietario: 'Proprietário', gestor: 'Gestor', analista: 'Analista' };
  const statusBadge = (value) => `<span class="plataforma-badge status-${escapeHtml(value)}">${escapeHtml(labelsStatus[value] || value || '—')}</span>`;
  const actionLabels = {
    login_ok: 'Entrou no sistema', login_ok_sem_codigo: 'Entrou no sistema (sem código)',
    login_falha_senha: 'Errou a senha',
    login_falha_codigo: 'Errou o código', logout: 'Saiu do sistema',
    mercado_suspenso: 'Suspendeu o mercado', mercado_reativado: 'Reativou o mercado',
    equipe_convidada: 'Convidou um membro', equipe_alterada: 'Alterou um membro',
    equipe_convite_reenviado: 'Reenviou convite', equipe_primeiro_acesso: 'Concluiu primeiro acesso',
  };

  async function carregar(url, options) {
    try {
      if (errorBox) errorBox.textContent = '';
      return await window.hydraApi(url, options);
    } catch (falha) {
      if (errorBox) errorBox.textContent = falha.message || 'Não foi possível carregar as informações. Tente novamente.';
      throw falha;
    }
  }

  function setQuery(values) {
    const params = new URLSearchParams(window.location.search);
    Object.entries(values).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) params.delete(key);
      else params.set(key, String(value));
    });
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }

  function drawChart(monthRows) {
    const labels = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const now = new Date();
    const months = [];
    for (let offset = 11; offset >= 0; offset -= 1) {
      const month = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
      const row = monthRows.find((item) => item.mes === key);
      months.push({ name: `${labels[month.getMonth()]} ${String(month.getFullYear()).slice(-2)}`, qty: Number(row ? row.quantidade : 0) });
    }
    const width = 720;
    const height = 230;
    const pad = { top: 24, right: 16, bottom: 40, left: 28 };
    const chartH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...months.map((item) => item.qty));
    const gap = 12;
    const barW = (width - pad.left - pad.right - gap * (months.length - 1)) / months.length;
    const bars = months.map((item, index) => {
      const x = pad.left + index * (barW + gap);
      const barH = item.qty === 0 ? 2 : (item.qty / max) * chartH;
      const y = pad.top + chartH - barH;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="var(--navy-active)" fill-opacity="${item.qty ? 0.8 : 0.15}"/><text x="${(x + barW / 2).toFixed(1)}" y="${Math.max(14, y - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--navy-900)">${item.qty}</text><text x="${(x + barW / 2).toFixed(1)}" y="${height - 16}" text-anchor="middle" font-size="10" fill="var(--muted-soft)">${item.name}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Novos mercados por mês"><line x1="${pad.left}" y1="${pad.top + chartH}" x2="${width - pad.right}" y2="${pad.top + chartH}" stroke="var(--border)"/>${bars}</svg>`;
  }

  function drawRevenueChart(data) {
    const monthly = Number(data.periodo.dias) === 365;
    const values = new Map(data.evolucao.map((item) => [item.periodo, Number(item.faturamento || 0)]));
    const start = new Date(`${data.periodo.inicio}T12:00:00`);
    const end = new Date(`${data.periodo.fim}T12:00:00`);
    const points = [];
    if (monthly) {
      const cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12);
      while (cursor <= end) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
        points.push({ key, label: new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(cursor), value: values.get(key) || 0 });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    } else {
      const cursor = new Date(start);
      while (cursor <= end) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        points.push({ key, label: `${cursor.getDate()}/${String(cursor.getMonth() + 1).padStart(2, '0')}`, value: values.get(key) || 0 });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const width = Math.max(720, points.length * 38);
    const height = 250;
    const pad = { top: 24, right: 16, bottom: 42, left: 16 };
    const chartH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...points.map((point) => point.value));
    const gap = Math.min(12, Math.max(3, width / points.length * 0.22));
    const barW = (width - pad.left - pad.right - gap * (points.length - 1)) / points.length;
    const stride = Math.max(1, Math.ceil(points.length / 12));
    const bars = points.map((point, index) => {
      const x = pad.left + index * (barW + gap);
      const barH = point.value === 0 ? 2 : (point.value / max) * chartH;
      const y = pad.top + chartH - barH;
      const label = index % stride === 0 || index === points.length - 1
        ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 15}" text-anchor="middle" font-size="10" fill="var(--muted-soft)">${escapeHtml(point.label)}</text>`
        : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barW).toFixed(1)}" height="${barH.toFixed(1)}" rx="3" fill="var(--navy-active)" fill-opacity="${point.value ? 0.82 : 0.15}"><title>${escapeHtml(point.label)}: ${currency(point.value)}</title></rect>${label}`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" style="width:${width}px;max-width:none" role="img" aria-label="Faturamento por ${monthly ? 'mês' : 'dia'}"><line x1="${pad.left}" y1="${pad.top + chartH}" x2="${width - pad.right}" y2="${pad.top + chartH}" stroke="var(--border)"/>${bars}</svg>`;
  }

  async function carregarRendimento() {
    const select = document.getElementById('rendimento-dias');
    const params = new URLSearchParams(window.location.search);
    const dias = ['7', '30', '90', '365'].includes(params.get('dias')) ? params.get('dias') : '30';
    select.value = dias;
    const data = await carregar(`/plataforma/rendimento?dias=${encodeURIComponent(dias)}`);
    const summary = data.resumo;
    const variacao = summary.variacao_percentual === null
      ? 'Sem base no período anterior'
      : `${summary.variacao_percentual > 0 ? '+' : ''}${Number(summary.variacao_percentual).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% em relação ao período anterior`;
    const variacaoClass = summary.variacao_percentual > 0 ? 'is-positive' : summary.variacao_percentual < 0 ? 'is-negative' : '';
    document.getElementById('rendimento-cards').innerHTML = [
      ['Faturamento total', currency(summary.faturamento), variacao, variacaoClass],
      ['Vendas concluídas', Number(summary.vendas).toLocaleString('pt-BR'), 'No período selecionado', ''],
      ['Ticket médio', currency(summary.ticket_medio), 'Faturamento por venda', ''],
      ['Mercados com vendas', Number(summary.mercados_com_vendas).toLocaleString('pt-BR'), 'Com ao menos uma venda', ''],
    ].map(([label, value, help, className]) => `<article class="plataforma-card"><span class="plataforma-card-label">${label}</span><strong class="plataforma-card-value">${value}</strong><span class="plataforma-card-help ${className}">${help}</span></article>`).join('');
    document.getElementById('rendimento-periodo').textContent = `${dateOnly(data.periodo.inicio)} a ${dateOnly(data.periodo.fim)}`;
    document.getElementById('rendimento-chart').innerHTML = drawRevenueChart(data);

    const tbody = document.getElementById('rendimento-mercados-body');
    document.getElementById('rendimento-mercados-vazio').hidden = data.mercados.length > 0;
    tbody.innerHTML = data.mercados.map((market, index) => {
      const local = [market.cidade, market.uf].filter(Boolean).map(escapeHtml).join(' / ') || '—';
      return `<tr><td>${index + 1}</td><td><a href="mercado.html?id=${encodeURIComponent(market.id)}">${escapeHtml(market.nome)}</a></td><td>${local}</td><td>${Number(market.vendas).toLocaleString('pt-BR')}</td><td>${currency(market.ticket_medio)}</td><td><strong>${currency(market.faturamento)}</strong></td></tr>`;
    }).join('');
  }

  async function carregarResumo() {
    const data = await carregar('/plataforma/resumo');
    const cards = [
      ['Total de mercados', data.mercados.total, '', ''],
      ['Ativos', data.mercados.ativos, 'ativo', ''],
      ['Ociosos', data.mercados.ociosos, 'ocioso', ''],
      ['Inativos', data.mercados.inativos, 'inativo', ''],
      ['Suspensos', data.mercados.suspensos, 'suspenso', ''],
      ['Novos no mês', data.mercados.novos_mes, 'novo', ''],
      ['Cadastros pendentes', data.cadastros_pendentes, 'pendentes', ''],
    ];
    document.getElementById('resumo-cards').innerHTML = cards.map(([label, count, filter]) => {
      const path = filter === 'pendentes' ? 'cadastros-pendentes.html' : `mercados.html${filter ? `?status=${filter}` : ''}`;
      return `<a class="plataforma-card" href="${path}"><span class="plataforma-card-label">${label}</span><strong class="plataforma-card-value">${Number(count || 0).toLocaleString('pt-BR')}</strong><span class="plataforma-card-help">Abrir ${label.toLowerCase()}</span></a>`;
    }).join('');
    document.getElementById('cadastros-chart').innerHTML = data.novos_cadastros_por_mes.length
      ? drawChart(data.novos_cadastros_por_mes)
      : '<p class="plataforma-empty">Ainda não há cadastros para mostrar neste período.</p>';
    const funil = [
      ['Cadastros iniciados', data.funil.iniciados],
      ['E-mail confirmado', data.funil.confirmados],
      ['Primeira venda', data.funil.primeira_venda],
    ];
    const max = Math.max(1, Number(data.funil.iniciados || 0));
    document.getElementById('cadastros-funil').innerHTML = funil.map(([label, count]) => {
      const value = Number(count || 0);
      const percent = Math.min(100, Math.round((value / max) * 100));
      return `<div class="plataforma-funnel-row"><span>${label}</span><strong>${value.toLocaleString('pt-BR')} · ${percent}%</strong><div class="plataforma-funnel-bar"><span style="width:${percent}%"></span></div></div>`;
    }).join('');
    const attention = document.getElementById('mercados-atencao');
    attention.innerHTML = data.precisam_atencao.length
      ? data.precisam_atencao.map((market) => `<a href="mercado.html?id=${encodeURIComponent(market.id_loja)}"><span>${escapeHtml(market.nome_loja)}<small>${escapeHtml([market.cidade, market.estado].filter(Boolean).join(' / '))}</small></span><small>${relativeDate(market.ultima_venda || market.ultimo_acesso)}</small></a>`).join('')
      : '<p class="plataforma-empty">Nenhum mercado ocioso precisa de atenção agora.</p>';
  }

  const statusOptions = [
    ['', 'Todos'], ['ativo', 'Ativo'], ['novo', 'Novo'], ['ocioso', 'Ocioso'], ['inativo', 'Inativo'], ['suspenso', 'Suspenso'],
  ];

  async function carregarLojas() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status') || '';
    document.getElementById('filtro-busca').value = params.get('busca') || '';
    document.getElementById('filtro-uf').value = params.get('uf') || '';
    document.getElementById('filtro-ordem').value = params.get('ordem') || 'recentes';
    document.getElementById('filtro-status').innerHTML = statusOptions.map(([value, label]) => `<button type="button" class="plataforma-chip" data-status="${value}" aria-pressed="${status === value}">${label}</button>`).join('');
    const query = new URLSearchParams();
    ['status', 'busca', 'uf', 'ordem', 'pagina'].forEach((key) => {
      const value = params.get(key);
      if (value) query.set(key, value);
    });
    const data = await carregar(`/plataforma/lojas?${query.toString()}`);
    const tbody = document.getElementById('mercados-body');
    document.getElementById('mercados-vazio').hidden = data.lojas.length > 0;
    tbody.innerHTML = data.lojas.map((market) => {
      const local = [market.cidade, market.uf].filter(Boolean).map(escapeHtml).join('/');
      return `<tr data-href="mercado.html?id=${encodeURIComponent(market.id)}${window.location.search ? `&voltar=${encodeURIComponent(window.location.search.slice(1))}` : ''}" tabindex="0"><td><strong>${escapeHtml(market.nome)}</strong></td><td>${local || '—'}</td><td>${statusBadge(market.status)}</td><td>${Number(market.total_filiais || 0)}</td><td>${Number(market.total_usuarios || 0)}</td><td>${relativeDate(market.ultimo_acesso)}</td><td>${dateOnly(market.ultima_venda)}</td><td>${dateOnly(market.data_criacao)}</td></tr>`;
    }).join('');
    const pagination = data.paginacao;
    document.getElementById('mercados-paginacao').innerHTML = `<span>${pagination.total.toLocaleString('pt-BR')} mercado(s) · página ${pagination.pagina} de ${Math.max(1, pagination.total_paginas)}</span><div class="plataforma-actions"><button type="button" class="plataforma-btn" data-pagina="${pagination.pagina - 1}" ${pagination.pagina <= 1 ? 'disabled' : ''}>Anterior</button><button type="button" class="plataforma-btn" data-pagina="${pagination.pagina + 1}" ${pagination.pagina >= pagination.total_paginas ? 'disabled' : ''}>Próxima</button></div>`;
  }

  async function carregarDetalhe() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const target = document.getElementById('detalhe-mercado');
    if (!id || !/^\d+$/.test(id)) {
      target.innerHTML = '<div class="plataforma-error">O endereço não contém um número de mercado válido.</div>';
      return;
    }
    const data = await carregar(`/plataforma/lojas/${encodeURIComponent(id)}`);
    const market = data.loja;
    const podeGerenciar = ['administrador', 'proprietario', 'gestor'].includes(window.plataformaAdmin.nivel);
    const suspenso = market.status_loja === 'suspensa';
    const voltar = params.get('voltar');
    const voltarUrl = `mercados.html${voltar ? `?${encodeURIComponent(voltar).replace(/%3D/g, '=').replace(/%26/g, '&')}` : ''}`;
    const admins = data.administradores.length
      ? data.administradores.map((admin) => `<div class="plataforma-info"><span>${escapeHtml(admin.nome)}</span><strong><a href="mailto:${encodeURIComponent(admin.email)}">${escapeHtml(admin.email)}</a> <button class="plataforma-btn" type="button" data-copiar="${escapeHtml(admin.email)}">Copiar e-mail</button></strong></div>`).join('')
      : '<p class="plataforma-empty">Não há um administrador ativo cadastrado para contato.</p>';
    const timeLines = [
      ['Mercado cadastrado', data.linha_do_tempo.cadastro],
      ['Primeira venda', data.linha_do_tempo.primeira_venda],
      ['Último acesso de usuário', data.linha_do_tempo.ultimo_acesso],
      ...(data.linha_do_tempo.alteracoes_status || []).map((item) => [actionLabels[item.acao] || item.acao, item.data, item.detalhe]),
    ].filter((item) => item[1]);
    target.innerHTML = `
      <div class="plataforma-page-heading"><div><a class="plataforma-btn" href="${voltarUrl}">← Voltar para Mercados</a><h2 style="margin-top:14px">${escapeHtml(market.nome)}</h2><p>${statusBadge(market.status)}</p></div>
      ${podeGerenciar ? `<button class="plataforma-btn ${suspenso ? 'plataforma-btn-success' : 'plataforma-btn-danger'}" type="button" id="abrir-modal-status">${suspenso ? 'Reativar mercado' : 'Suspender mercado'}</button>` : ''}</div>
      ${suspenso ? `<div class="plataforma-suspenso-aviso"><strong>Este mercado está suspenso.</strong><br>Motivo: ${escapeHtml(market.motivo_status || 'Não informado')} · ${dateTime(market.status_alterado_em)}</div>` : ''}
      <section class="plataforma-cards">
        <div class="plataforma-card"><span class="plataforma-card-label">Filiais</span><strong class="plataforma-card-value">${Number(market.total_filiais || 0)}</strong></div>
        <div class="plataforma-card"><span class="plataforma-card-label">Usuários</span><strong class="plataforma-card-value">${Number(market.total_usuarios || 0)}</strong></div>
        <div class="plataforma-card"><span class="plataforma-card-label">Produtos ativos</span><strong class="plataforma-card-value">${data.produtos_ativos}</strong></div>
        <div class="plataforma-card"><span class="plataforma-card-label">Vendas em 30 dias</span><strong class="plataforma-card-value">${data.vendas_30_dias.quantidade}</strong></div>
        <div class="plataforma-card"><span class="plataforma-card-label">Faturamento em 30 dias</span><strong class="plataforma-card-value plataforma-kpi-small">${currency(data.vendas_30_dias.total)}</strong></div>
      </section>
      <div class="plataforma-grid-2">
        <section class="plataforma-panel"><h2>Dados do mercado</h2><div class="plataforma-info-grid">
          ${[['CNPJ', market.cnpj], ['Telefone', market.telefone], ['Endereço', market.endereco], ['Cidade / UF', [market.cidade, market.uf].filter(Boolean).join(' / ')], ['CEP', market.cep], ['Cadastro', dateTime(market.data_criacao)]].map(([label, value]) => `<div class="plataforma-info"><span>${label}</span><strong>${escapeHtml(value || '—')}</strong></div>`).join('')}
        </div></section>
        <section class="plataforma-panel"><h2>Contato do administrador</h2>${admins}</section>
      </div>
      <div class="plataforma-grid-2">
        <section class="plataforma-panel"><h2>Filiais</h2><div class="plataforma-table-wrap"><table class="plataforma-table"><thead><tr><th>Nome</th><th>Cidade/UF</th><th>Status</th></tr></thead><tbody>${data.filiais.map((branch) => `<tr><td>${escapeHtml(branch.nome)}</td><td>${escapeHtml([branch.cidade, branch.uf].filter(Boolean).join(' / ') || '—')}</td><td>${statusBadge(branch.status)}</td></tr>`).join('')}</tbody></table></div>${data.filiais.length ? '' : '<p class="plataforma-empty">Este mercado ainda não cadastrou filiais.</p>'}</section>
        <section class="plataforma-panel"><h2>Usuários por cargo</h2><div class="plataforma-table-wrap"><table class="plataforma-table"><thead><tr><th>Cargo</th><th>Usuários ativos</th></tr></thead><tbody>${data.usuarios_por_cargo.map((row) => `<tr><td>${escapeHtml(row.cargo)}</td><td>${Number(row.quantidade)}</td></tr>`).join('')}</tbody></table></div>${data.usuarios_por_cargo.length ? '' : '<p class="plataforma-empty">Não há usuários ativos cadastrados.</p>'}</section>
      </div>
      <section class="plataforma-panel"><h2>Linha do tempo</h2><div class="plataforma-timeline">${timeLines.length ? timeLines.map(([label, date, detail]) => `<div class="plataforma-timeline-item"><strong>${escapeHtml(label)}</strong><time>${dateTime(date)}${detail ? ` · ${escapeHtml(detail)}` : ''}</time></div>`).join('') : '<p class="plataforma-empty">Ainda não há atividades para mostrar.</p>'}</div></section>`;

    const button = document.getElementById('abrir-modal-status');
    if (button) {
      const modal = document.getElementById('modal-status-loja');
      const form = document.getElementById('form-status-loja');
      const suspender = !suspenso;
      document.getElementById('modal-status-titulo').textContent = suspender ? 'Suspender mercado?' : 'Reativar mercado?';
      document.getElementById('modal-status-explicacao').textContent = suspender
        ? 'Os usuários deste mercado não conseguirão entrar no sistema. Nenhum dado será apagado.'
        : 'Os usuários deste mercado poderão voltar a entrar no sistema. Os dados continuam intactos.';
      const confirmButton = document.getElementById('confirmar-status');
      confirmButton.textContent = suspender ? 'Confirmar suspensão' : 'Confirmar reativação';
      confirmButton.classList.toggle('plataforma-btn-danger', suspender);
      confirmButton.classList.toggle('plataforma-btn-success', !suspender);
      button.addEventListener('click', () => { modal.hidden = false; document.getElementById('motivo-status').focus(); });
      modal.querySelectorAll('[data-fechar-modal]').forEach((close) => close.addEventListener('click', () => { modal.hidden = true; }));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const motivo = document.getElementById('motivo-status').value.trim();
        const modalError = document.getElementById('modal-status-erro');
        if (motivo.length < 10) { modalError.textContent = 'Explique o motivo com pelo menos 10 caracteres.'; return; }
        confirmButton.disabled = true;
        try {
          await window.hydraApi(`/plataforma/lojas/${id}/${suspender ? 'suspender' : 'reativar'}`, { method: 'POST', body: { motivo } });
          window.location.reload();
        } catch (falha) {
          modalError.textContent = falha.message || 'Não foi possível alterar o status.';
          confirmButton.disabled = false;
        }
      });
    }
  }

  async function carregarPendentes() {
    const data = await carregar('/plataforma/cadastros-pendentes');
    const tbody = document.getElementById('pendentes-body');
    document.getElementById('pendentes-vazio').hidden = data.cadastros.length > 0;
    tbody.innerHTML = data.cadastros.map((item) => `<tr><td>${escapeHtml(item.nome)}</td><td>${escapeHtml(item.email)} <button type="button" class="plataforma-btn" data-copiar="${escapeHtml(item.email)}">Copiar e-mail</button></td><td>${escapeHtml(item.loja)}</td><td>${dateTime(item.criado_em)}</td><td>${Number(item.dias)} ${Number(item.dias) === 1 ? 'dia' : 'dias'}</td></tr>`).join('');
  }

  async function carregarAuditoria() {
    const params = new URLSearchParams(window.location.search);
    const fields = {
      acao: document.getElementById('auditoria-acao'),
      id_admin: document.getElementById('auditoria-membro'),
      de: document.getElementById('auditoria-de'),
      ate: document.getElementById('auditoria-ate'),
    };
    Object.entries(fields).forEach(([key, input]) => { if (params.has(key)) input.value = params.get(key); });
    const query = new URLSearchParams();
    ['acao', 'id_admin', 'de', 'ate', 'pagina'].forEach((key) => { if (params.has(key)) query.set(key, params.get(key)); });
    const data = await carregar(`/plataforma/auditoria?${query.toString()}`);
    fields.id_admin.innerHTML = '<option value="">Todos os membros</option>' + data.membros
      .map((member) => `<option value="${member.id_admin}">${escapeHtml(member.nome)}</option>`).join('');
    fields.id_admin.value = params.get('id_admin') || '';
    const tbody = document.getElementById('auditoria-body');
    document.getElementById('auditoria-vazio').hidden = data.registros.length > 0;
    tbody.innerHTML = data.registros.map((row) => `<tr><td>${dateTime(row.data)}</td><td>${escapeHtml(row.membro || 'Membro inativo/removido')}</td><td>${escapeHtml(actionLabels[row.acao] || row.acao)}</td><td>${escapeHtml(row.mercado || '—')}</td><td>${escapeHtml(row.detalhe || '—')}</td><td>${escapeHtml(row.ip || '—')}</td></tr>`).join('');
    const pageData = data.paginacao;
    document.getElementById('auditoria-paginacao').innerHTML = `<span>${pageData.total.toLocaleString('pt-BR')} registro(s) · página ${pageData.pagina} de ${Math.max(1, pageData.total_paginas)}</span><div class="plataforma-actions"><button class="plataforma-btn" type="button" data-auditoria-pagina="${pageData.pagina - 1}" ${pageData.pagina <= 1 ? 'disabled' : ''}>Anterior</button><button class="plataforma-btn" type="button" data-auditoria-pagina="${pageData.pagina + 1}" ${pageData.pagina >= pageData.total_paginas ? 'disabled' : ''}>Próxima</button></div>`;
  }

  let acaoEquipePendente = null;
  async function carregarEquipe() {
    const data = await carregar('/plataforma/equipe');
    const tbody = document.getElementById('equipe-body');
    document.getElementById('equipe-vazio').hidden = data.membros.length > 0;
    tbody.innerHTML = data.membros.map((member) => {
      const self = Number(member.id_admin) === Number(window.plataformaAdmin.id);
      const roleOptions = ['analista', 'gestor', 'proprietario', 'administrador'].map((role) => `<option value="${role}" ${role === member.nivel ? 'selected' : ''}>${labelsNivel[role]}</option>`).join('');
      const situation = Number(member.senha_definida) === 1
        ? 'Senha criada'
        : '<span class="plataforma-badge status-pendente">Aguardando primeiro acesso</span>';
      const actions = self
        ? '<span>Você</span>'
        : `<div class="plataforma-actions"><label class="plataforma-field">Nível<select data-nivel-membro="${member.id_admin}">${roleOptions}</select></label><button class="plataforma-btn" type="button" data-alterar-nivel="${member.id_admin}">Alterar nível</button><button class="plataforma-btn ${member.status === 'ativo' ? 'plataforma-btn-danger' : 'plataforma-btn-success'}" type="button" data-alterar-status="${member.id_admin}" data-status-atual="${member.status}">${member.status === 'ativo' ? 'Inativar' : 'Reativar'}</button>${Number(member.senha_definida) === 0 ? `<button class="plataforma-btn" type="button" data-reenviar-convite="${member.id_admin}">Reenviar convite</button>` : ''}</div>`;
      return `<tr><td>${escapeHtml(member.nome)}</td><td>${escapeHtml(member.email)}</td><td>${escapeHtml(labelsNivel[member.nivel] || member.nivel)}</td><td>${statusBadge(member.status)}</td><td>${dateTime(member.ultimo_acesso)}</td><td>${situation}</td><td>${actions}</td></tr>`;
    }).join('');
  }

  function confirmarEquipe(mensagem, action) {
    const modal = document.getElementById('modal-confirmar-equipe');
    document.getElementById('confirmar-equipe-texto').textContent = mensagem;
    document.getElementById('confirmar-equipe-erro').textContent = '';
    acaoEquipePendente = action;
    modal.hidden = false;
  }

  async function confirmarAcaoEquipe() {
    const button = document.getElementById('confirmar-equipe-acao');
    const modalError = document.getElementById('confirmar-equipe-erro');
    if (!acaoEquipePendente) return;
    button.disabled = true;
    try {
      await acaoEquipePendente();
      document.getElementById('modal-confirmar-equipe').hidden = true;
      await carregarEquipe();
    } catch (falha) {
      modalError.textContent = falha.message || 'Não foi possível alterar o membro.';
    } finally {
      button.disabled = false;
    }
  }

  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copiar]');
    if (copy) {
      try {
        await navigator.clipboard.writeText(copy.dataset.copiar);
        const original = copy.textContent;
        copy.textContent = 'E-mail copiado';
        window.setTimeout(() => { copy.textContent = original; }, 1800);
      } catch (_) {
        if (errorBox) errorBox.textContent = 'Não foi possível copiar. Selecione e copie o endereço de e-mail.';
      }
      return;
    }

    const row = event.target.closest('tr[data-href]');
    if (row && !event.target.closest('a,button,input,select')) {
      window.location.href = row.dataset.href;
      return;
    }
    if (page === 'mercados') {
      const chip = event.target.closest('[data-status]');
      if (chip) { setQuery({ status: chip.dataset.status, pagina: '' }); await carregarLojas(); return; }
      const next = event.target.closest('[data-pagina]');
      if (next && !next.disabled) { setQuery({ pagina: next.dataset.pagina }); await carregarLojas(); return; }
    }
    if (page === 'auditoria') {
      const next = event.target.closest('[data-auditoria-pagina]');
      if (next && !next.disabled) { setQuery({ pagina: next.dataset.auditoriaPagina }); await carregarAuditoria(); return; }
    }
    if (page === 'equipe') {
      const levelButton = event.target.closest('[data-alterar-nivel]');
      if (levelButton) {
        const id = levelButton.dataset.alterarNivel;
        const nextLevel = document.querySelector(`[data-nivel-membro="${id}"]`).value;
        confirmarEquipe(`Confirma alterar o nível deste membro para ${nextLevel}?`, async () => {
          await window.hydraApi(`/plataforma/equipe/${id}`, { method: 'PUT', body: { nivel: nextLevel } });
        });
        return;
      }
      const statusButton = event.target.closest('[data-alterar-status]');
      if (statusButton) {
        const id = statusButton.dataset.alterarStatus;
        const nextStatus = statusButton.dataset.statusAtual === 'ativo' ? 'inativo' : 'ativo';
        confirmarEquipe(`${nextStatus === 'inativo' ? 'Inativar' : 'Reativar'} este membro? ${nextStatus === 'inativo' ? 'A sessão dele será encerrada na próxima ação.' : ''}`, async () => {
          await window.hydraApi(`/plataforma/equipe/${id}`, { method: 'PUT', body: { status: nextStatus } });
        });
        return;
      }
      const resend = event.target.closest('[data-reenviar-convite]');
      if (resend) {
        resend.disabled = true;
        try {
          await window.hydraApi(`/plataforma/equipe/${resend.dataset.reenviarConvite}/reenviar-convite`, { method: 'POST' });
          if (errorBox) errorBox.textContent = 'Convite reenviado com sucesso.';
        } catch (falha) {
          if (errorBox) errorBox.textContent = falha.message;
        } finally { resend.disabled = false; }
      }
    }
  });

  if (page === 'mercados') {
    document.getElementById('filtros-mercados').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setQuery({ busca: form.get('busca'), uf: form.get('uf'), ordem: form.get('ordem'), pagina: '' });
      await carregarLojas();
    });
    document.getElementById('limpar-filtros').addEventListener('click', async () => {
      window.history.replaceState(null, '', window.location.pathname);
      await carregarLojas();
    });
  }
  if (page === 'auditoria') {
    document.getElementById('filtros-auditoria').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setQuery({ acao: form.get('acao'), id_admin: form.get('id_admin'), de: form.get('de'), ate: form.get('ate'), pagina: '' });
      await carregarAuditoria();
    });
    document.getElementById('limpar-auditoria').addEventListener('click', async () => {
      window.history.replaceState(null, '', window.location.pathname);
      await carregarAuditoria();
    });
  }
  if (page === 'equipe') {
    const inviteModal = document.getElementById('modal-convite');
    document.getElementById('abrir-convite').addEventListener('click', () => { inviteModal.hidden = false; });
    inviteModal.querySelectorAll('[data-fechar-modal]').forEach((button) => button.addEventListener('click', () => { inviteModal.hidden = true; }));
    document.getElementById('form-convite').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const submit = form.querySelector('button[type="submit"]');
      const inviteError = document.getElementById('convite-erro');
      inviteError.textContent = '';
      submit.disabled = true;
      try {
        await window.hydraApi('/plataforma/equipe', {
          method: 'POST',
          body: { nome: formData.get('nome'), email: formData.get('email'), nivel: formData.get('nivel') },
        });
        inviteModal.hidden = true;
        form.reset();
        await carregarEquipe();
        if (errorBox) errorBox.textContent = 'Convite enviado com sucesso.';
      } catch (falha) {
        inviteError.textContent = falha.message || 'Não foi possível enviar o convite.';
      } finally { submit.disabled = false; }
    });
    document.querySelectorAll('#modal-confirmar-equipe [data-fechar-modal]').forEach((button) => button.addEventListener('click', () => {
      document.getElementById('modal-confirmar-equipe').hidden = true;
      acaoEquipePendente = null;
    }));
    document.getElementById('confirmar-equipe-acao').addEventListener('click', confirmarAcaoEquipe);
  }
  if (page === 'rendimento') {
    document.getElementById('filtro-rendimento').addEventListener('submit', async (event) => {
      event.preventDefault();
      const dias = document.getElementById('rendimento-dias').value;
      setQuery({ dias });
      try {
        await carregarRendimento();
      } catch (_) {
        // A mensagem detalhada já foi apresentada pelo helper carregar().
      }
    });
  }

  try {
    if (page === 'visao-geral') await carregarResumo();
    if (page === 'rendimento') await carregarRendimento();
    if (page === 'mercados') await carregarLojas();
    if (page === 'mercado') await carregarDetalhe();
    if (page === 'pendentes') await carregarPendentes();
    if (page === 'auditoria') await carregarAuditoria();
    if (page === 'equipe') await carregarEquipe();
  } catch (_) {
    // A mensagem detalhada já foi apresentada pelo helper carregar().
  }
});
