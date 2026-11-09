document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('form-primeiro-acesso');
  const email = document.getElementById('primeiro-email');
  const codigo = document.getElementById('primeiro-codigo');
  const senha = document.getElementById('primeiro-senha');
  const confirmacao = document.getElementById('primeiro-confirmacao');
  const erro = document.getElementById('primeiro-erro');
  const regras = document.getElementById('regras-senha');
  const params = new URLSearchParams(window.location.search);

  email.value = params.get('email') || '';
  if (window.HydraPasswordRules && regras) {
    window.HydraPasswordRules.ligarChecklist(senha, regras);
  }
  codigo.addEventListener('input', () => {
    codigo.value = codigo.value.replace(/\D/g, '').slice(0, 6);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    erro.textContent = '';
    if (!form.reportValidity()) return;
    if (senha.value !== confirmacao.value) {
      erro.textContent = 'As senhas não conferem.';
      return;
    }
    if (window.HydraPasswordRules && !window.HydraPasswordRules.senhaAtendeRegras(senha.value)) {
      erro.textContent = 'A senha ainda não atende a todos os requisitos.';
      return;
    }

    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    botao.textContent = 'Salvando…';
    try {
      await window.hydraApi('/plataforma/auth/primeiro-acesso', {
        method: 'POST',
        body: { email: email.value.trim(), codigo: codigo.value, senha: senha.value },
      });
      window.location.href = 'login.html?senha_criada=1';
    } catch (falha) {
      erro.textContent = falha.message || 'Não foi possível criar a senha. Confira os dados e tente novamente.';
      botao.disabled = false;
      botao.textContent = 'Criar senha';
    }
  });
});
