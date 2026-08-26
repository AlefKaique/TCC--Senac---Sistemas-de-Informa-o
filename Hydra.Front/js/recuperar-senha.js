document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('recover-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!form.checkValidity()){
      form.reportValidity();
      return;
    }

    const btn = form.querySelector('.btn--block');
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      await window.hydraApi('/auth/esqueci-senha', {
        method: 'POST',
        body: { email: document.getElementById('email').value.trim() },
      });
      btn.textContent = 'Link enviado! Verifique seu e-mail.';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Enviar link de recuperação';
      alert(err.message);
    }
  });
});
