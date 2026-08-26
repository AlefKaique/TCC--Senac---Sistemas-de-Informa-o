document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('signup-form');
  const senha = document.getElementById('senha');
  const confirmarSenha = document.getElementById('confirmar-senha');

  if (!form) return;

  function setError(input, message){
    input.style.borderColor = '#E24C4C';
    let err = input.parentElement.querySelector('.field__error');
    if (!err){
      err = document.createElement('span');
      err.className = 'field__error';
      err.style.color = '#E24C4C';
      err.style.fontSize = '0.78rem';
      err.style.marginTop = '2px';
      input.parentElement.appendChild(err);
    }
    err.textContent = message;
  }

  function clearError(input){
    input.style.borderColor = '';
    const err = input.parentElement.querySelector('.field__error');
    if (err) err.remove();
  }

  [senha, confirmarSenha].forEach(input => {
    input.addEventListener('input', () => clearError(input));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let valid = true;

    if (senha.value.length < 6){
      setError(senha, 'A senha deve ter pelo menos 6 caracteres.');
      valid = false;
    }

    if (confirmarSenha.value !== senha.value){
      setError(confirmarSenha, 'As senhas não coincidem.');
      valid = false;
    }

    if (!form.checkValidity()){
      form.reportValidity();
      return;
    }

    if (!valid) return;

    const btn = form.querySelector('.btn--block');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Criando conta...';

    try {
      await window.hydraApi('/auth/registro', {
        method: 'POST',
        body: {
          nome: document.getElementById('nome').value.trim(),
          email: document.getElementById('email').value.trim(),
          senha: senha.value,
          nome_loja: document.getElementById('nome-loja').value.trim(),
        },
      });

      btn.textContent = 'Conta criada com sucesso!';
      setTimeout(() => {
        window.location.href = 'controle-estoque.html';
      }, 1200);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      if (err.status === 409) {
        setError(document.getElementById('email'), err.data.erro);
      } else {
        alert(err.message);
      }
    }
  });
});
