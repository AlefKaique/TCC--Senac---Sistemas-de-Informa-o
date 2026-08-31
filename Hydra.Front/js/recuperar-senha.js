document.addEventListener('DOMContentLoaded', () => {
  const stepEmail = document.getElementById('step-email');
  const stepCode = document.getElementById('step-code');
  const recoverForm = document.getElementById('recover-form');
  const resetForm = document.getElementById('reset-form');
  const sentToEmail = document.getElementById('sent-to-email');
  const resendLink = document.getElementById('resend-code');
  const useAnotherEmailLink = document.getElementById('use-another-email');

  if (!recoverForm || !resetForm) return;

  let email = '';

  function showStepCode(){
    sentToEmail.textContent = email;
    stepEmail.classList.add('is-hidden');
    stepCode.classList.remove('is-hidden');
    document.getElementById('codigo').focus();
  }

  function showStepEmail(){
    stepCode.classList.add('is-hidden');
    stepEmail.classList.remove('is-hidden');
    document.getElementById('email').focus();
  }

  async function enviarCodigo(){
    await window.hydraApi('/auth/esqueci-senha', {
      method: 'POST',
      body: { email },
    });
  }

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

  resendLink.addEventListener('click', async (e) => {
    e.preventDefault();
    resendLink.textContent = 'Reenviando...';
    try {
      await enviarCodigo();
      resendLink.textContent = 'Código reenviado!';
    } catch (err) {
      resendLink.textContent = 'Reenviar código';
      alert(err.message);
    } finally {
      setTimeout(() => { resendLink.textContent = 'Reenviar código'; }, 3000);
    }
  });

  useAnotherEmailLink.addEventListener('click', (e) => {
    e.preventDefault();
    resetForm.reset();
    showStepEmail();
  });

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const novaSenha = document.getElementById('nova-senha');
    const confirmarNovaSenha = document.getElementById('confirmar-nova-senha');

    if (!resetForm.checkValidity()){
      resetForm.reportValidity();
      return;
    }

    if (novaSenha.value !== confirmarNovaSenha.value){
      alert('As senhas não coincidem.');
      return;
    }

    const btn = resetForm.querySelector('.btn--block');
    btn.disabled = true;
    btn.textContent = 'Redefinindo...';

    try {
      await window.hydraApi('/auth/redefinir-senha', {
        method: 'POST',
        body: {
          email,
          codigo: document.getElementById('codigo').value.trim(),
          senha: novaSenha.value,
        },
      });

      btn.textContent = 'Senha redefinida!';
      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1200);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Redefinir senha';
      alert(err.message);
    }
  });
});
