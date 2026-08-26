/**
 * Cliente HTTP para a API do Hydra.Back. Ajuste HYDRA_API_BASE se o
 * back-end estiver rodando em outro host/porta.
 */
window.HYDRA_API_BASE = window.HYDRA_API_BASE || 'http://localhost:8080/api';

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
