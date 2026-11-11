document.addEventListener('DOMContentLoaded', () => {
  const formLogin = document.getElementById('login-form');
  const formCodigo = document.getElementById('codigo-form');
  const stepLogin = document.getElementById('step-login');
  const stepCodigo = document.getElementById('step-codigo');
  const codigoInput = document.getElementById('codigo');
  const emailInput = document.getElementById('email');
  let emailVerificado = '';
  if (!formLogin || !formCodigo) return;

  if (new URLSearchParams(window.location.search).get('senha_criada') === '1') {
    const notice = document.getElementById('login-notice');
    if (notice) {
      notice.textContent = 'Senha criada! Faça seu login.';
      notice.hidden = false;
    }
  }

  function limparErro(form) {
    const erro = form.querySelector('.form__error');
    if (erro) erro.remove();
  }

  function mostrarErro(form, mensagem) {
    limparErro(form);
    const erro = document.createElement('p');
    erro.className = 'form__error';
    erro.style.color = '#E24C4C';
    erro.style.fontSize = '0.85rem';
    erro.textContent = mensagem;
    form.querySelector('.btn--block').insertAdjacentElement('beforebegin', erro);
  }

  function alternarParaLogin() {
    stepCodigo.classList.add('is-hidden');
    stepLogin.classList.remove('is-hidden');
    document.getElementById('senha').value = '';
    document.getElementById('senha').focus();
  }

  async function enviarFormulario(form, botao, textoCarregando, acao) {
    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.textContent = textoCarregando;
    limparErro(form);
    try {
      await acao();
      return true;
    } catch (erro) {
      mostrarErro(form, erro.message);
      return false;
    } finally {
      botao.disabled = false;
      botao.textContent = textoOriginal;
    }
  }

  formLogin.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!formLogin.reportValidity()) return;

    const botao = formLogin.querySelector('.btn--block');
    enviarFormulario(formLogin, botao, 'Entrando...', async () => {
      const resposta = await window.hydraApi('/plataforma/auth/login', {
        method: 'POST',
        body: { email: emailInput.value.trim(), senha: document.getElementById('senha').value },
      });
      // Conta com login sem código (ex.: Administrador da apresentação):
      // a sessão já foi criada, então vai direto para o painel.
      if (!resposta.requer_codigo) {
        if (resposta.admin) window.location.href = 'visao-geral.html';
        return;
      }

      emailVerificado = resposta.email;
      document.getElementById('sent-to-email').textContent = emailVerificado;
      stepLogin.classList.add('is-hidden');
      stepCodigo.classList.remove('is-hidden');
      codigoInput.focus();
    });
  });

  codigoInput.addEventListener('input', () => {
    codigoInput.value = codigoInput.value.replace(/\D/g, '').slice(0, 6);
    limparErro(formCodigo);
  });

  formCodigo.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(codigoInput.value)) {
      mostrarErro(formCodigo, 'Digite os 6 dígitos do código.');
      return;
    }

    const botao = formCodigo.querySelector('.btn--block');
    enviarFormulario(formCodigo, botao, 'Verificando...', async () => {
      await window.hydraApi('/plataforma/auth/codigo', {
        method: 'POST',
        body: { email: emailVerificado, codigo: codigoInput.value },
      });
      window.location.href = 'visao-geral.html';
    });
  });

  document.getElementById('reenviar-codigo').addEventListener('click', (event) => {
    const botao = event.currentTarget;
    enviarFormulario(formCodigo, botao, 'Reenviando...', async () => {
      await window.hydraApi('/plataforma/auth/reenviar', { method: 'POST' });
      codigoInput.value = '';
    }).then((sucesso) => {
      if (!sucesso) return;
      botao.textContent = 'Código reenviado';
      window.setTimeout(() => { botao.textContent = 'Reenviar código'; }, 3000);
    });
  });

  document.getElementById('voltar-login').addEventListener('click', () => {
    alternarParaLogin();
  });
});
