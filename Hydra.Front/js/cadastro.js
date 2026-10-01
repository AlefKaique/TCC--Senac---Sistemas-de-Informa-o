document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('signup-form');
  const senha = document.getElementById('senha');
  const confirmarSenha = document.getElementById('confirmar-senha');

  if (!form) return;

  function campoDe(input){
    return input.closest('.field') || input.parentElement;
  }

  function setError(input, message){
    input.style.borderColor = '#E24C4C';
    const campo = campoDe(input);
    let err = campo.querySelector('.field__error');
    if (!err){
      err = document.createElement('span');
      err.className = 'field__error';
      err.style.color = '#E24C4C';
      err.style.fontSize = '0.78rem';
      err.style.marginTop = '2px';
      campo.appendChild(err);
    }
    err.textContent = message;
  }

  function clearError(input){
    input.style.borderColor = '';
    const err = campoDe(input).querySelector('.field__error');
    if (err) err.remove();
  }

  // Checklist de senha ao vivo + botão de mostrar/ocultar senha (ver
  // ../js/password-rules.js — mesmas regras aplicadas no back-end em
  // Hydra\Support\PasswordPolicy::validar()).
  if (window.HydraPasswordRules) {
    window.HydraPasswordRules.ligarChecklist(senha, document.getElementById('senha-regras'));
    window.HydraPasswordRules.ligarToggleSenha(senha, document.getElementById('senha-toggle'));
    window.HydraPasswordRules.ligarToggleSenha(confirmarSenha, document.getElementById('confirmar-senha-toggle'));
  }

  [senha, confirmarSenha].forEach(input => {
    input.addEventListener('input', () => clearError(input));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let valid = true;

    const erroSenha = window.HydraPasswordRules
      ? window.HydraPasswordRules.primeiraRegraFalha(senha.value)
      : null;
    if (erroSenha) {
      setError(senha, erroSenha);
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
