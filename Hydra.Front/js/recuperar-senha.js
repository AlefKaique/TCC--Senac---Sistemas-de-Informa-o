document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('recover-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    if (!form.checkValidity()){
      form.reportValidity();
      return;
    }

    const btn = form.querySelector('.btn--block');
    btn.textContent = 'Link enviado! Verifique seu e-mail.';
    btn.disabled = true;
  });
});