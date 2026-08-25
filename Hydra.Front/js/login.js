document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    if (!form.checkValidity()){
      form.reportValidity();
      return;
    }

    const btn = form.querySelector('.btn--block');
    btn.textContent = 'Entrando...';
    btn.disabled = true;

    setTimeout(() => {
      window.location.href = 'index.html';
    }, 1200);
  });
});