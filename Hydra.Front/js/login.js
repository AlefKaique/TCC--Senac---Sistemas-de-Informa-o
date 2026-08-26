document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  if (!form) return;

  function showError(message) {
    let err = form.querySelector('.form__error');
    if (!err) {
      err = document.createElement('p');
      err.className = 'form__error';
      err.style.color = '#E24C4C';
      err.style.fontSize = '0.85rem';
      err.style.margin = '-4px 0 4px';
      form.querySelector('.btn--block').insertAdjacentElement('beforebegin', err);
    }
    err.textContent = message;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!form.checkValidity()){
      form.reportValidity();
      return;
    }

    const btn = form.querySelector('.btn--block');
    const originalText = btn.textContent;
    btn.textContent = 'Entrando...';
    btn.disabled = true;

    try {
      await window.hydraApi('/auth/login', {
        method: 'POST',
        body: {
          email: document.getElementById('email').value.trim(),
          senha: document.getElementById('senha').value,
          lembrar: document.getElementById('lembrar').checked,
        },
      });

      window.location.href = 'controle-estoque.html';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      showError(err.message);
    }
  });
});
