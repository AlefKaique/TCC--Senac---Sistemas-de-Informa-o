/**
 * Cliente HTTP para a API do Hydra.Back. Ajuste HYDRA_API_BASE se o
 * back-end estiver rodando em outro host/porta.
 */
const defaultApiBase = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:8080/api'
  : `${window.location.origin}/api`;

window.HYDRA_API_BASE = window.HYDRA_API_BASE || defaultApiBase;

window.hydraApi = async function hydraApi(path, options = {}) {
  const res = await fetch(window.HYDRA_API_BASE + path, {
    method: options.method || 'GET',
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }

  if (!res.ok) {
    // Sessão sem filial ativa (ou com uma que foi desativada/desvinculada):
    // abre a janela de escolha de filial (js/trocar-filial.js), se a tela
    // a carregou. O erro continua sendo lançado para a tela tratar.
    if (res.status === 409 && data.codigo === 'filial_nao_selecionada' && window.hydraTrocarFilial) {
      window.hydraTrocarFilial.abrir({ obrigatorio: true });
    }
    const err = new Error(data.erro || 'Erro ao comunicar com o servidor');
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
};

/**
 * Usuário logado (GET /api/auth/me), buscado UMA vez por página.
 *
 * Antes cada script pedia o seu: public-demo.js, o script da tela e, no
 * Relatório, mais duas vezes. Eram 2 a 3 chamadas idênticas por tela, cada
 * uma com duas consultas ao banco. Agora todos recebem a mesma Promise.
 * Não guarda nada entre páginas: cargo e permissões podem mudar, e o
 * back-end revalida a cada requisição.
 */
let hydraSessaoPromise = null;
window.hydraSessao = function hydraSessao() {
  if (!hydraSessaoPromise) {
    hydraSessaoPromise = window.hydraApi('/auth/me');
    // Assim que o usuário chega, o avatar do topo troca o ícone genérico
    // pelas iniciais (ou foto). Fica aqui para nenhuma tela precisar chamar.
    hydraSessaoPromise.then(
      (resposta) => window.hydraRenderizarAvatar(resposta && resposta.usuario),
      () => {}
    );
    // Falha de rede não pode ficar em cache: a próxima chamada tenta de novo.
    hydraSessaoPromise.catch((err) => {
      if (!err || err.status === undefined) hydraSessaoPromise = null;
    });
  }
  return hydraSessaoPromise;
};

/**
 * Avatar do topo no estilo do Microsoft Teams.
 *
 * Antes era uma foto fixa de um banco de imagens (i.pravatar.cc), igual
 * para todo mundo. Agora:
 *   - se o usuário tem foto (campo `foto_url` vindo de /auth/me), mostra a foto;
 *   - senão, mostra as iniciais do primeiro e do último nome ("Ana Paula
 *     Souza" → "AS") sobre uma cor suave derivada do nome — a mesma pessoa
 *     tem sempre a mesma cor, em qualquer tela.
 * Se a foto não carregar, volta para as iniciais.
 */
const HYDRA_AVATAR_CORES = [
  // [fundo, texto] — tons claros com texto escuro, legíveis (contraste AA).
  ['#dbe4ff', '#1d3a86'],
  ['#d3f2e3', '#0f6b3a'],
  ['#fde4cf', '#8a4b0f'],
  ['#f6d9e8', '#8c2457'],
  ['#e5dcfa', '#4b2a99'],
  ['#d2eff4', '#0c5c6b'],
  ['#fbe3e3', '#9b2230'],
  ['#ece9d6', '#5c5418'],
];

window.hydraIniciais = function hydraIniciais(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return '';
  const primeira = partes[0][0];
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
  return (primeira + ultima).toUpperCase();
};

window.hydraRenderizarAvatar = function hydraRenderizarAvatar(usuario) {
  const el = document.getElementById('hydroUserAvatar');
  if (!el || !usuario) return;

  const nome = String(usuario.nome || '').trim();
  const iniciais = window.hydraIniciais(nome);

  // Cor estável por nome (hash simples da string).
  let hash = 0;
  for (let i = 0; i < nome.length; i++) hash = (hash * 31 + nome.charCodeAt(i)) >>> 0;
  const [fundo, texto] = HYDRA_AVATAR_CORES[hash % HYDRA_AVATAR_CORES.length];

  const mostrarIniciais = () => {
    el.textContent = iniciais;
    el.style.setProperty('--avatar-bg', fundo);
    el.style.setProperty('--avatar-fg', texto);
  };

  el.setAttribute('aria-label', nome || 'Usuário');
  el.title = nome;

  const foto = usuario.foto_url || usuario.foto;
  if (foto) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = foto;
    img.addEventListener('error', mostrarIniciais, { once: true });
    el.replaceChildren(img);
  } else {
    mostrarIniciais();
  }
};
window.hydraSessao.limpar = function limparSessao() {
  hydraSessaoPromise = null;
};

/**
 * Telas do sistema, cada uma com a(s) permissao(oes) que dao acesso a ela.
 * Basta UMA das permissoes da lista.
 *
 * `view` e o valor de data-view do link na barra lateral (bloco "Menu");
 * `li` e o id do <li> (bloco "Admin", onde os ids ja existem). A ordem e a
 * usada por hydraHomePorPermissao() para escolher a tela inicial.
 */
const HYDRA_TELAS = [
  { pagina: 'controle-estoque.html', view: 'estoque', permissoes: ['estoque.consultar'] },
  { pagina: 'caixa.html', view: 'caixa', permissoes: ['vendas.operar', 'vendas.historico'] },
  { pagina: 'dashboard.html', view: 'dashboard', permissoes: ['relatorios.visualizar'] },
  { pagina: 'gerenciar-usuarios.html', li: 'hydroLiEquipe', permissoes: ['equipe.gerenciar'] },
  { pagina: 'configuracoes-loja.html', li: 'hydroLiConfig', permissoes: ['loja.configurar'] },
  { pagina: 'cargos.html', li: 'hydroLiCargos', permissoes: ['equipe.gerenciar'] },
  { pagina: 'promocoes.html', li: 'hydroLiPromocoes', permissoes: ['produtos.editar_preco'] },
];

/** Verdadeiro se o usuario tem ao menos uma das permissoes informadas. */
window.hydraPode = function hydraPode(usuario, permissoes) {
  const doUsuario = (usuario && usuario.permissoes) || [];
  return permissoes.some((p) => doUsuario.includes(p));
};

/**
 * Mostra ou esconde os itens da barra lateral conforme as permissoes do
 * usuario.
 *
 * Antes cada tela decidia isso por `usuario.perfil === 'administrador'`,
 * o perfil legado. Desde que o controle de acesso passou a ser por
 * permissao, os dois modelos divergiam: um cargo com apenas
 * "loja.configurar" era classificado como administrador e via os tres
 * itens, inclusive Cargos, que respondia 403 ao ser aberto.
 *
 * O bloco "Menu" (Estoque, Vendas, Relatorio) tambem passou a ser filtrado.
 * Antes so o bloco "Admin" era: o Estoquista enxergava e abria a tela do
 * Caixa e o Operador de Caixa enxergava e abria a de Estoque — e, como a
 * API respondia 403, a tela caia no catalogo de demonstracao e mostrava
 * dados falsos. Aqueles <li> nao tem id, mas os links tem data-view, que
 * serve igualmente de ancora e evita editar os sete HTML.
 *
 * Equipe e Cargos dependem da mesma permissao e aparecem ou desaparecem
 * juntas: sao duas vistas da mesma autoridade. O item Cargos tambem e a
 * UNICA entrada para aquela tela — o botao "Gerenciar cargos" que existia
 * na tela de Equipe foi removido, para nao duplicar o menu.
 *
 * Recebe o objeto devolvido por GET /api/auth/me.
 */
window.hydraAplicarMenuPorPermissao = function hydraAplicarMenuPorPermissao(usuario) {
  let algumAdminVisivel = false;

  for (const tela of HYDRA_TELAS) {
    let el = null;
    if (tela.li) {
      el = document.getElementById(tela.li);
    } else {
      const link = document.querySelector(`.hydro-menu a[data-view="${tela.view}"]`);
      el = link && link.closest('li');
    }
    if (!el) continue;

    const pode = window.hydraPode(usuario, tela.permissoes);
    el.style.display = pode ? '' : 'none';
    if (pode && tela.li) algumAdminVisivel = true;
  }

  // O rotulo "Admin" so faz sentido se sobrou algum item embaixo dele.
  const rotulo = document.getElementById('hydroMenuAdminLabel');
  if (rotulo) rotulo.style.display = algumAdminVisivel ? '' : 'none';

  /* A logo da barra lateral aponta para controle-estoque.html no HTML das
     sete telas. Para quem nao consulta o estoque isso seria um pulo ate uma
     tela que a guarda dela recusa, so para ser mandado de volta — entao o
     destino passa a ser a casa do proprio usuario. */
  const marca = document.querySelector('.hydro-brand');
  if (marca) marca.setAttribute('href', window.hydraHomePorPermissao(usuario));
};

/**
 * Primeira tela que o usuario consegue abrir — a "casa" dele.
 *
 * Todo redirecionamento do sistema apontava para controle-estoque.html.
 * Isso funcionava quando todo cargo tinha acesso ao estoque; com o catalogo
 * atual, um cargo so de Caixa seria mandado para uma tela que a guarda dela
 * rejeita, que o mandaria de volta — laco infinito.
 *
 * O login.html e o destino de quem nao pode abrir nada: sem permissao
 * alguma nao ha sistema para usar, e a mensagem certa vem da tela de login.
 */
window.hydraHomePorPermissao = function hydraHomePorPermissao(usuario) {
  const tela = HYDRA_TELAS.find((t) => window.hydraPode(usuario, t.permissoes));
  return tela ? tela.pagina : 'login.html';
};

/**
 * Situacao do estoque de um produto — regra UNICA do sistema, usada pelo
 * Controle de Estoque e pelo Relatorio. Antes cada tela tinha a sua, e o
 * mesmo produto aparecia como "Baixo" numa e "Atencao" na outra.
 *   empty    Esgotado    quantidade zero
 *   critical Critico     ate 40% do estoque minimo
 *   low      Baixo       abaixo do estoque minimo
 *   warning  Atencao     no minimo ou ate 20% acima dele
 *   ok       Em estoque  acima disso (ou sem estoque minimo definido)
 */
window.HYDRA_SITUACAO_ROTULOS = {
  empty: 'Esgotado', critical: 'Crítico', low: 'Baixo', warning: 'Atenção', ok: 'Em estoque',
};
window.hydraSituacaoEstoque = function hydraSituacaoEstoque(quantidade, estoqueMinimo) {
  const qtd = Number(quantidade) || 0;
  const minimo = Number(estoqueMinimo) || 0;
  if (qtd <= 0) return 'empty';
  if (minimo <= 0) return 'ok';
  if (qtd <= minimo * 0.4) return 'critical';
  if (qtd < minimo) return 'low';
  if (qtd <= minimo * 1.2) return 'warning';
  return 'ok';
};

/**
 * Quantidade como o usuario le: virgula decimal e unidade ("17,25 kg",
 * "22 un"). Antes aparecia "17.25", sem dizer se era quilo ou unidade.
 */
window.hydraFormatarQuantidade = function hydraFormatarQuantidade(quantidade, unidade) {
  const qtd = Number(quantidade) || 0;
  const texto = qtd.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  return `${texto} ${unidade || 'un'}`;
};

/**
 * Guarda de tela: manda o usuario para a casa dele se faltar a permissao.
 * Devolve true quando o acesso e permitido, para a tela poder interromper
 * o carregamento (`if (!hydraGuardaDeTela(...)) return;`).
 */
window.hydraGuardaDeTela = function hydraGuardaDeTela(usuario, permissoes) {
  if (window.hydraPode(usuario, permissoes)) return true;
  window.location.href = window.hydraHomePorPermissao(usuario);
  return false;
};
