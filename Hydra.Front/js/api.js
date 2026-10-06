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
 * Guarda de tela: manda o usuario para a casa dele se faltar a permissao.
 * Devolve true quando o acesso e permitido, para a tela poder interromper
 * o carregamento (`if (!hydraGuardaDeTela(...)) return;`).
 */
window.hydraGuardaDeTela = function hydraGuardaDeTela(usuario, permissoes) {
  if (window.hydraPode(usuario, permissoes)) return true;
  window.location.href = window.hydraHomePorPermissao(usuario);
  return false;
};
