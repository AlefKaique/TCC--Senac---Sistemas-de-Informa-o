document.addEventListener('DOMContentLoaded', () => {
  const stepEmail = document.getElementById('step-email');
  const stepCode = document.getElementById('step-code');
  const stepSenha = document.getElementById('step-senha');
  const recoverForm = document.getElementById('recover-form');
  const codeForm = document.getElementById('code-form');
  const resetForm = document.getElementById('reset-form');
  const codigoInput = document.getElementById('codigo');
  const novaSenha = document.getElementById('nova-senha');
  const confirmarNovaSenha = document.getElementById('confirmar-nova-senha');
  const sentToEmail = document.getElementById('sent-to-email');
  const resendLink = document.getElementById('resend-code');
  const useAnotherEmailLink = document.getElementById('use-another-email');

  if (!recoverForm || !codeForm || !resetForm) return;

  let email = '';
  // Código já conferido em /auth/verificar-codigo-recuperacao. Ele vai de
  // novo junto com a nova senha, porque o back-end revalida (ver
  // AuthController::redefinirSenha).
  let codigoValidado = '';

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

  function mostrarEtapa(etapa){
    [stepEmail, stepCode, stepSenha].forEach((el) => el.classList.toggle('is-hidden', el !== etapa));
  }

  function showStepCode(){
    sentToEmail.textContent = email;
    mostrarEtapa(stepCode);
    codigoInput.focus();
  }

  function showStepEmail(){
    codigoValidado = '';
    codeForm.reset();
    resetForm.reset();
    clearError(codigoInput);
    mostrarEtapa(stepEmail);
    document.getElementById('email').focus();
  }

  function showStepSenha(){
    document.getElementById('reset-email').textContent = email;
    mostrarEtapa(stepSenha);
    novaSenha.focus();
  }

  async function enviarCodigo(){
    const resposta = await window.hydraApi('/auth/esqueci-senha', {
      method: 'POST',
      body: { email },
    });
    // Facilidade de teste local: sem serviço de e-mail configurado, o
    // back-end devolve o código na resposta (só com APP_ENV=local).
    if (resposta.codigo_dev) codigoInput.value = resposta.codigo_dev;
  }

  // Checklist de senha ao vivo + botão de mostrar/ocultar senha — o mesmo
  // componente do Cadastro (ver ../js/password-rules.js).
  if (window.HydraPasswordRules) {
    window.HydraPasswordRules.ligarChecklist(novaSenha, document.getElementById('nova-senha-regras'));
    window.HydraPasswordRules.ligarToggleSenha(novaSenha, document.getElementById('nova-senha-toggle'));
    window.HydraPasswordRules.ligarToggleSenha(confirmarNovaSenha, document.getElementById('confirmar-nova-senha-toggle'));
  }

  [novaSenha, confirmarNovaSenha].forEach(input => {
    input.addEventListener('input', () => clearError(input));
  });

  codigoInput.addEventListener('input', () => {
    codigoInput.value = codigoInput.value.replace(/\D/g, '').slice(0, 6);
    clearError(codigoInput);
  });

  /* ===== Etapa 1: e-mail ===== */
  recoverForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!recoverForm.checkValidity()){
      recoverForm.reportValidity();
      return;
    }

    email = document.getElementById('email').value.trim();
    const btn = recoverForm.querySelector('.btn--block');
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      await enviarCodigo();
      btn.disabled = false;
      btn.textContent = 'Enviar código de verificação';
      showStepCode();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Enviar código de verificação';
      alert(err.message);
    }
  });

  /* ===== Etapa 2: código ===== */
  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!/^\d{6}$/.test(codigoInput.value)){
      setError(codigoInput, 'Digite os 6 dígitos do código.');
      return;
    }

    const btn = codeForm.querySelector('.btn--block');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Verificando...';

    try {
      await window.hydraApi('/auth/verificar-codigo-recuperacao', {
        method: 'POST',
        body: { email, codigo: codigoInput.value },
      });
      codigoValidado = codigoInput.value;
      showStepSenha();
    } catch (err) {
      setError(codigoInput, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  resendLink.addEventListener('click', async (e) => {
    e.preventDefault();
    resendLink.textContent = 'Reenviando...';
    try {
      await enviarCodigo();
      clearError(codigoInput);
      resendLink.textContent = 'Código reenviado!';
    } catch (err) {
      resendLink.textContent = 'Reenviar código';
      setError(codigoInput, err.message);
    } finally {
      setTimeout(() => { resendLink.textContent = 'Reenviar código'; }, 3000);
    }
  });

  useAnotherEmailLink.addEventListener('click', (e) => {
    e.preventDefault();
    showStepEmail();
  });

  /* ===== Etapa 3: nova senha (mesmas validações do Cadastro) ===== */
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    let valid = true;

    const erroSenha = window.HydraPasswordRules
      ? window.HydraPasswordRules.primeiraRegraFalha(novaSenha.value)
      : null;
    if (erroSenha) {
      setError(novaSenha, erroSenha);
      valid = false;
    }

    if (confirmarNovaSenha.value !== novaSenha.value){
      setError(confirmarNovaSenha, 'As senhas não coincidem.');
      valid = false;
    }

    if (!resetForm.checkValidity()){
      resetForm.reportValidity();
      return;
    }

    if (!valid) return;

    const btn = resetForm.querySelector('.btn--block');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Redefinindo...';

    try {
      await window.hydraApi('/auth/redefinir-senha', {
        method: 'POST',
        body: {
          email,
          codigo: codigoValidado,
          senha: novaSenha.value,
        },
      });

      btn.textContent = 'Senha redefinida!';
      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1200);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      // 400: o código expirou (ou foi trocado por um reenvio) entre as
      // etapas — volta para digitar um código válido.
      if (err.status === 400) {
        codigoValidado = '';
        codeForm.reset();
        showStepCode();
        setError(codigoInput, err.message);
        return;
      }
      if (err.status === 422) {
        setError(novaSenha, err.message);
        return;
      }
      alert(err.message);
    }
  });
});
