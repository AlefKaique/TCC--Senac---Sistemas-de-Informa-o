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

  const nomeInput = document.getElementById('nome');
  const emailInput = document.getElementById('email');
  const nomeLojaInput = document.getElementById('nome-loja');

  // E-mail digitado no "Criar conta grátis" da página inicial.
  try {
    const emailDaHome = new URLSearchParams(window.location.search).get('email');
    if (emailDaHome && emailInput && !emailInput.value) emailInput.value = emailDaHome.trim();
  } catch (e) { /* sem parâmetro: segue o formulário vazio */ }

  [senha, confirmarSenha, nomeInput, emailInput, nomeLojaInput].forEach(input => {
    if (input) input.addEventListener('input', () => clearError(input));
  });

  /* Mesma regra de Hydra\Support\Validacao::erroNomePessoa() no back-end:
     ao menos duas letras e só letras, espaços, apóstrofo, hífen e ponto
     (aceita "D'Ávila" e "Maria-Clara", recusa "122323" — QA 003). */
  function erroNomePessoa(nome) {
    if (!nome) return 'Informe seu nome.';
    if (nome.length > 100) return 'O nome pode ter no máximo 100 caracteres.';
    if (!/^[\p{L}\p{M}\s'’.-]+$/u.test(nome)) return 'O nome deve conter apenas letras, espaços, apóstrofo e hífen.';
    if ((nome.match(/\p{L}/gu) || []).length < 2) return 'Informe um nome com pelo menos duas letras.';
    return null;
  }

  /* Campo que o back-end aponta em "campo" -> input da tela. */
  const CAMPOS_API = { nome: nomeInput, email: emailInput, nome_loja: nomeLojaInput, senha };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let valid = true;
    let primeiroInvalido = null;
    // Limpa os erros da tentativa anterior (inclusive o do botão).
    form.querySelectorAll('.field__error').forEach((el) => el.remove());
    form.querySelectorAll('input').forEach((el) => { el.style.borderColor = ''; });
    const marcar = (input, msg) => {
      setError(input, msg);
      valid = false;
      if (!primeiroInvalido) primeiroInvalido = input;
    };

    /* Validação junto de cada campo, no lugar do alerta nativo do
       navegador que só dizia "Preencha nome, e-mail e nome da loja" (QA 002). */
    const erroNome = erroNomePessoa(nomeInput.value.trim());
    if (erroNome) marcar(nomeInput, erroNome);
    const email = emailInput.value.trim();
    if (!email) marcar(emailInput, 'Informe seu e-mail.');
    else if (!emailInput.checkValidity()) marcar(emailInput, 'Informe um e-mail válido.');
    if (!nomeLojaInput.value.trim()) marcar(nomeLojaInput, 'Informe o nome da loja.');

    const erroSenha = window.HydraPasswordRules
      ? window.HydraPasswordRules.primeiraRegraFalha(senha.value)
      : null;
    if (erroSenha) marcar(senha, erroSenha);

    if (confirmarSenha.value !== senha.value) marcar(confirmarSenha, 'As senhas não coincidem.');

    if (!valid) {
      primeiroInvalido.focus();
      return;
    }

    // O que sobrar do HTML (ex.: aceite dos Termos) continua com a
    // validação nativa do navegador, que já aparece junto do campo.
    if (!form.checkValidity()){
      form.reportValidity();
      return;
    }

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
          importar_hortifruti: document.getElementById('importar-hortifruti').checked,
        },
      });

      // Nada foi criado ainda: a conta só nasce quando o código enviado ao
      // e-mail for confirmado (ver AuthController::registro).
      mostrarEtapaCodigo(resposta);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      const campo = err.status === 409 ? emailInput : CAMPOS_API[err.data && err.data.campo];
      if (campo) {
        setError(campo, err.message);
        campo.focus();
      } else {
        // Erro sem campo (servidor fora do ar, falha de rede): mensagem
        // junto do botão, sem alerta bloqueante.
        setError(btn, err.message);
      }
    }
  });

  /* ===== Etapa 2: confirmação do e-mail ===== */
  const codigoForm = document.getElementById('codigo-form');
  const codigoInput = document.getElementById('codigo');
  const resendLink = document.getElementById('resend-code');
  let emailCadastrado = '';

  function mostrarEtapaCodigo(resposta) {
    emailCadastrado = resposta.email;
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

      // Conta criada agora. O cadastro não abre sessão: o usuário entra
      // pela tela de Login com a senha que acabou de criar.
      btn.textContent = 'Conta criada!';
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
