window.plataformaSessaoPromise = window.hydraApi('/plataforma/auth/me');

document.addEventListener('DOMContentLoaded', async () => {
  const shell = document.querySelector('.plataforma-shell');
  const erro = document.getElementById('plataforma-erro');
  try {
    const resposta = await window.plataformaSessaoPromise;
    const admin = resposta.admin;
    window.plataformaAdmin = admin;

    const niveisPermitidos = (document.body.dataset.niveis || '').split(',').filter(Boolean);
    if (niveisPermitidos.length && !niveisPermitidos.includes(admin.nivel)) {
      window.location.replace('visao-geral.html');
      return;
    }

    document.querySelectorAll('[data-niveis]').forEach((item) => {
      const niveis = item.dataset.niveis.split(',').filter(Boolean);
      item.hidden = !niveis.includes(admin.nivel);
    });

    const nome = document.getElementById('plataforma-admin-nome');
    const nivel = document.getElementById('plataforma-admin-nivel');
    if (nome) nome.textContent = admin.nome;
    if (nivel) {
      const nomes = { administrador: 'Administrador', proprietario: 'Proprietário', gestor: 'Gestor', analista: 'Analista' };
      nivel.textContent = nomes[admin.nivel] || 'Equipe Hydra';
    }
    if (shell) shell.classList.add('plataforma-autenticada');
  } catch (falha) {
    if (falha.status === 401) {
      window.location.replace('login.html');
      return;
    }
    if (shell) shell.classList.add('plataforma-autenticada');
    if (erro) erro.textContent = falha.message || 'Não foi possível verificar seu acesso. Tente novamente.';
    return;
  }

  const sair = document.getElementById('plataforma-sair');
  if (sair) {
    sair.addEventListener('click', async () => {
      sair.disabled = true;
      try {
        await window.hydraApi('/plataforma/auth/logout', { method: 'POST' });
        window.location.replace('login.html');
      } catch (falha) {
        sair.disabled = false;
        if (erro) erro.textContent = falha.message || 'Não foi possível sair agora. Tente novamente.';
      }
    });
  }

  // Menu lateral do celular: window.hydraMenuLateral (api.js).
});
