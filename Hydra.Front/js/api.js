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
    const err = new Error(data.erro || 'Erro ao comunicar com o servidor');
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
};

/**
 * Mostra ou esconde os itens administrativos da barra lateral conforme as
 * permissoes do usuario.
 *
 * Antes cada tela decidia isso por `usuario.perfil === 'administrador'`,
 * o perfil legado. Desde que o controle de acesso passou a ser por
 * permissao, os dois modelos divergiam: um cargo com apenas
 * "loja.configurar" era classificado como administrador e via os tres
 * itens, inclusive Cargos, que respondia 403 ao ser aberto; e um cargo
 * com "usuarios.visualizar" nao via Equipe, embora a API o autorizasse.
 *
 * Equipe e Cargos dependem da mesma permissao e aparecem ou desaparecem
 * juntas: sao duas vistas da mesma autoridade. O item Cargos tambem e a
 * UNICA entrada para aquela tela — o botao "Gerenciar cargos" que existia
 * na tela de Equipe foi removido, para nao duplicar o menu.
 *
 * Recebe o objeto devolvido por GET /api/auth/me.
 */
window.hydraAplicarMenuPorPermissao = function hydraAplicarMenuPorPermissao(usuario) {
  const permissoes = (usuario && usuario.permissoes) || [];
  const itens = [
    ['hydroLiEquipe', 'equipe.gerenciar'],
    ['hydroLiConfig', 'loja.configurar'],
    ['hydroLiCargos', 'equipe.gerenciar'],
  ];

  let algumVisivel = false;
  for (const [id, permissao] of itens) {
    const el = document.getElementById(id);
    if (!el) continue;
    const pode = permissoes.includes(permissao);
    el.style.display = pode ? '' : 'none';
    if (pode) algumVisivel = true;
  }

  // O rotulo "Admin" so faz sentido se sobrou algum item embaixo dele.
  const rotulo = document.getElementById('hydroMenuAdminLabel');
  if (rotulo) rotulo.style.display = algumVisivel ? '' : 'none';
};
