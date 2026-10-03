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
      const resposta = await window.hydraApi('/auth/registro', {
        method: 'POST',
        body: {
          nome: document.getElementById('nome').value.trim(),
          email: document.getElementById('email').value.trim(),
          senha: senha.value,
          nome_loja: document.getElementById('nome-loja').value.trim(),
        },
      });

      // A conta foi criada, mas o e-mail ainda precisa ser confirmado com
      // o código enviado (ver AuthController::registro).
      mostrarEtapaCodigo(resposta);
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

  /* ===== Etapa 2: confirmação do e-mail ===== */
  const codigoForm = document.getElementById('codigo-form');
  const codigoInput = document.getElementById('codigo');
  const resendLink = document.getElementById('resend-code');
  let emailCadastrado = '';

  function mostrarEtapaCodigo(resposta) {
    emailCadastrado = resposta.usuario.email;
    document.getElementById('sent-to-email').textContent = emailCadastrado;
    // Facilidade de teste local: sem serviço de e-mail configurado, o
    // back-end devolve o código na resposta (só com APP_ENV=local).
    if (resposta.codigo_dev) codigoInput.value = resposta.codigo_dev;

    document.getElementById('step-form').classList.add('is-hidden');
    document.getElementById('step-codigo').classList.remove('is-hidden');
    codigoInput.focus();
  }

  codigoInput.addEventListener('input', () => {
    codigoInput.value = codigoInput.value.replace(/\D/g, '').slice(0, 6);
    clearError(codigoInput);
  });

  codigoForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!/^\d{6}$/.test(codigoInput.value)) {
      setError(codigoInput, 'Digite os 6 dígitos do código.');
      return;
    }

    const btn = codigoForm.querySelector('.btn--block');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Verificando...';

    try {
      await window.hydraApi('/auth/verificar-email', {
        method: 'POST',
        body: { email: emailCadastrado, codigo: codigoInput.value },
      });

      // O cadastro não abre sessão (ver AuthController::registro): o
      // usuário entra pela tela de Login com a senha que acabou de criar.
      btn.textContent = 'E-mail confirmado!';
      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1200);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      setError(codigoInput, err.message);
    }
  });

  resendLink.addEventListener('click', async (e) => {
    e.preventDefault();
    resendLink.textContent = 'Reenviando...';
    try {
      const resposta = await window.hydraApi('/auth/reenviar-verificacao', {
        method: 'POST',
        body: { email: emailCadastrado },
      });
      if (resposta.codigo_dev) codigoInput.value = resposta.codigo_dev;
      clearError(codigoInput);
      resendLink.textContent = 'Código reenviado!';
    } catch (err) {
      resendLink.textContent = 'Reenviar código';
      setError(codigoInput, err.message);
    } finally {
      setTimeout(() => { resendLink.textContent = 'Reenviar código'; }, 3000);
    }
  });
});
