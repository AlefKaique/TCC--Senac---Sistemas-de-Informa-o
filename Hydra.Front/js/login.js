document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const codigoForm = document.getElementById('codigo-form');
  const stepForm = document.getElementById('step-form');
  const stepCodigo = document.getElementById('step-codigo');
  const codigoInput = document.getElementById('codigo');
  const resendLink = document.getElementById('resend-code');
  const backLink = document.getElementById('back-to-login');
  if (!form) return;

  function showError(targetForm, message) {
    let err = targetForm.querySelector('.form__error');
    if (!err) {
      err = document.createElement('p');
      err.className = 'form__error';
      err.style.color = '#E24C4C';
      err.style.fontSize = '0.85rem';
      err.style.margin = '-4px 0 4px';
      targetForm.querySelector('.btn--block').insertAdjacentElement('beforebegin', err);
    }
    err.textContent = message;
  }

  function clearError(targetForm) {
    const err = targetForm.querySelector('.form__error');
    if (err) err.remove();
  }

  function entrar(usuario) {
    /* Antes todo login caía em controle-estoque.html. Com as permissoes
       separadas por area, um operador de caixa seria mandado para uma tela
       que a guarda dela recusa — e voltaria para ca. A resposta do login ja
       traz as permissoes, entao da para ir direto para a tela certa. */
    window.location.href = window.hydraHomePorPermissao(usuario);
  }

  /* Segunda etapa: o back-end pede o codigo enviado por e-mail quando a
     conta ainda nao confirmou o e-mail ou quando o usuario e Administrador
     (ver AuthController::login). */
  function mostrarEtapaCodigo(resposta) {
    const verificacao = resposta.motivo === 'verificacao';
    document.getElementById('codigo-titulo').textContent = verificacao
      ? 'Confirme seu e-mail'
      : 'Verificação em duas etapas';
    document.getElementById('codigo-texto').textContent = verificacao
      ? 'Antes do primeiro acesso, confirme seu e-mail com o código de 6 dígitos que enviamos para'
      : 'Por segurança, o acesso de administrador exige o código de 6 dígitos que enviamos para';
    document.getElementById('sent-to-email').textContent = resposta.email;

    codigoForm.reset();
    clearError(codigoForm);
    // Facilidade de teste local: sem servico de e-mail configurado, o
    // back-end devolve o codigo na resposta (so com APP_ENV=local).
    if (resposta.codigo_dev) codigoInput.value = resposta.codigo_dev;

    stepForm.classList.add('is-hidden');
    stepCodigo.classList.remove('is-hidden');
    codigoInput.focus();
  }

  function voltarParaLogin() {
    stepCodigo.classList.add('is-hidden');
    stepForm.classList.remove('is-hidden');
    document.getElementById('senha').value = '';
    document.getElementById('senha').focus();
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
      const resposta = await window.hydraApi('/auth/login', {
        method: 'POST',
        body: {
          email: document.getElementById('email').value.trim(),
          senha: document.getElementById('senha').value,
        },
      });

      btn.disabled = false;
      btn.textContent = originalText;

      if (resposta.requer_codigo) {
        clearError(form);
        mostrarEtapaCodigo(resposta);
        return;
      }

      entrar(resposta.usuario);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      showError(form, err.message);
    }
  });

  codigoInput.addEventListener('input', () => {
    codigoInput.value = codigoInput.value.replace(/\D/g, '').slice(0, 6);
    clearError(codigoForm);
  });

  codigoForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!/^\d{6}$/.test(codigoInput.value)) {
      showError(codigoForm, 'Digite os 6 dígitos do código.');
      return;
    }

    const btn = codigoForm.querySelector('.btn--block');
    const originalText = btn.textContent;
    btn.textContent = 'Verificando...';
    btn.disabled = true;

    try {
      const { usuario } = await window.hydraApi('/auth/login/codigo', {
        method: 'POST',
        body: { codigo: codigoInput.value },
      });
      entrar(usuario);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      // 401: a etapa pendente expirou — precisa digitar a senha de novo.
      if (err.status === 401) {
        voltarParaLogin();
        showError(form, err.message);
        return;
      }
      showError(codigoForm, err.message);
    }
  });

  resendLink.addEventListener('click', async (e) => {
    e.preventDefault();
    resendLink.textContent = 'Reenviando...';
    try {
      const resposta = await window.hydraApi('/auth/login/reenviar', { method: 'POST' });
      if (resposta.codigo_dev) codigoInput.value = resposta.codigo_dev;
      clearError(codigoForm);
      resendLink.textContent = 'Código reenviado!';
    } catch (err) {
      resendLink.textContent = 'Reenviar código';
      if (err.status === 401) {
        voltarParaLogin();
        showError(form, err.message);
        return;
      }
      showError(codigoForm, err.message);
    } finally {
      setTimeout(() => { resendLink.textContent = 'Reenviar código'; }, 3000);
    }
  });

  backLink.addEventListener('click', (e) => {
    e.preventDefault();
    voltarParaLogin();
  });
});
