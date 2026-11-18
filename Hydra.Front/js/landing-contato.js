/**
 * Formulário "Entre em Contato" da página inicial (seção #contato).
 *
 * Valida no navegador com as mesmas regras do ContatoController e envia
 * POST /api/contato pelo hydraApi (js/api.js). Durante o envio o botão
 * mostra "Enviando…"; se der certo, o formulário dá lugar à confirmação; se
 * der errado, a mensagem aparece acima do botão e nada do que foi digitado
 * se perde.
 *
 * O botão não fica "disabled" durante o envio: um botão desabilitado perde
 * o foco, e quem usa teclado voltaria ao topo da página. Ele recebe
 * aria-disabled/aria-busy e o envio repetido é ignorado.
 */
(function () {
  'use strict';

  const form = document.getElementById('form-contato');
  if (!form) return;

  const sucesso = document.getElementById('contato-sucesso');
  const tituloSucesso = document.getElementById('contato-sucesso-titulo');
  const botaoNovo = document.getElementById('contato-novo');
  const erroGeral = document.getElementById('contato-erro');
  const status = document.getElementById('contato-status');
  const botao = form.querySelector('.contato__enviar');
  const textoBotao = botao.querySelector('.contato__enviar-texto');
  const contador = document.getElementById('contato-mensagem-contador');

  const MAX_MENSAGEM = 1000;
  const CONTATO_EQUIPE = 'Se preferir, fale com a gente pelo WhatsApp (11) 95820-6969 ou pelo e-mail hydra.pdv@gmail.com.';

  const campos = {
    nome: document.getElementById('contato-nome'),
    email: document.getElementById('contato-email'),
    telefone: document.getElementById('contato-telefone'),
    estabelecimento: document.getElementById('contato-estabelecimento'),
    tipo_comercio: document.getElementById('contato-tipo'),
    plano_interesse: document.getElementById('contato-plano'),
    mensagem: document.getElementById('contato-mensagem'),
    aceite_lgpd: document.getElementById('contato-aceite'),
  };
  const isca = document.getElementById('contato-site');

  // Mesmas regras do back-end (Validacao::erroNomePessoa e telefoneValido).
  const NOME_VALIDO = /^[\p{L}\p{M}\s'’.-]+$/u;
  const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const TELEFONE_VALIDO = /^[1-9][1-9](?:[2-8]\d{7}|9\d{8})$/;
  const TIPOS = ['', 'mercado', 'padaria', 'hortifruti', 'outro'];
  const PLANOS = ['nao_sei', 'start', 'flex', 'premium'];

  let enviando = false;

  const digitos = (valor) => valor.replace(/\D/g, '');

  /** "11912345678" → "(11) 91234-5678"; fixo: "(11) 3456-7890". */
  function formatarTelefone(valor) {
    let d = digitos(valor);
    // Número colado com o código do país: "+55 11 9...".
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length === 0) return '';
    if (d.length <= 2) return `(${d}`;
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  /** Mensagem de erro do campo, ou '' se estiver certo. */
  function validarCampo(nome) {
    const el = campos[nome];
    const valor = el.type === 'checkbox' ? el.checked : el.value.trim();

    switch (nome) {
      case 'nome':
        if (!valor) return 'Informe seu nome completo.';
        if (valor.length > 100) return 'O nome pode ter no máximo 100 caracteres.';
        if (!NOME_VALIDO.test(valor)) return 'Use apenas letras, espaços, apóstrofo e hífen no nome.';
        if ((valor.match(/\p{L}/gu) || []).length < 2) return 'Informe um nome com pelo menos duas letras.';
        return '';
      case 'email':
        if (!valor) return 'Informe seu e-mail.';
        if (valor.length > 100 || !EMAIL_VALIDO.test(valor)) return 'Informe um e-mail válido, por exemplo nome@email.com.';
        return '';
      case 'telefone':
        if (!valor) return '';
        return TELEFONE_VALIDO.test(digitos(valor))
          ? ''
          : 'Informe um telefone válido com DDD, por exemplo (11) 91234-5678.';
      case 'estabelecimento':
        return valor.length > 120 ? 'O nome do estabelecimento pode ter no máximo 120 caracteres.' : '';
      case 'tipo_comercio':
        return TIPOS.includes(valor) ? '' : 'Escolha um tipo de comércio da lista.';
      case 'plano_interesse':
        return PLANOS.includes(valor) ? '' : 'Escolha um plano da lista.';
      case 'mensagem':
        return el.value.length > MAX_MENSAGEM ? `A mensagem pode ter no máximo ${MAX_MENSAGEM} caracteres.` : '';
      case 'aceite_lgpd':
        return valor ? '' : 'Para enviar, marque que concorda com a Política de Privacidade.';
      default:
        return '';
    }
  }

  function mostrarErroCampo(nome, mensagem) {
    const el = campos[nome];
    const alvo = document.getElementById(`${el.id}-erro`);
    if (mensagem) {
      el.setAttribute('aria-invalid', 'true');
      alvo.textContent = mensagem;
      alvo.hidden = false;
    } else {
      el.removeAttribute('aria-invalid');
      alvo.textContent = '';
      alvo.hidden = true;
    }
  }

  function mostrarErroGeral(mensagem) {
    erroGeral.textContent = mensagem;
    erroGeral.hidden = !mensagem;
  }

  function atualizarContador() {
    contador.textContent = `${campos.mensagem.value.length} de ${MAX_MENSAGEM} caracteres`;
  }

  function definirEnviando(ativo) {
    enviando = ativo;
    botao.setAttribute('aria-busy', String(ativo));
    botao.setAttribute('aria-disabled', String(ativo));
    textoBotao.textContent = ativo ? 'Enviando…' : 'Enviar dados';
    status.textContent = ativo ? 'Enviando seus dados…' : '';
  }

  function mostrarSucesso() {
    form.hidden = true;
    sucesso.hidden = false;
    tituloSucesso.focus();
  }

  function tratarFalha(erro) {
    const codigo = erro && erro.status;
    const dados = (erro && erro.data) || {};

    // Campo recusado pelo servidor: marca o campo e leva o foco até ele.
    if (codigo === 422 && dados.campo && campos[dados.campo]) {
      mostrarErroCampo(dados.campo, dados.erro || 'Confira este campo.');
      campos[dados.campo].focus();
      return;
    }

    let mensagem;
    if ((codigo === 429 || codigo === 503) && dados.erro) {
      mensagem = dados.erro;
    } else if (!codigo) {
      mensagem = 'Não foi possível enviar agora. Verifique sua conexão com a internet e tente de novo. ' + CONTATO_EQUIPE;
    } else {
      mensagem = 'Não conseguimos enviar seus dados agora. Tente de novo em alguns instantes. ' + CONTATO_EQUIPE;
    }
    mostrarErroGeral(mensagem);
  }

  // ----- Eventos dos campos -----

  campos.telefone.addEventListener('input', () => {
    const formatado = formatarTelefone(campos.telefone.value);
    if (formatado !== campos.telefone.value) campos.telefone.value = formatado;
  });

  campos.mensagem.addEventListener('input', atualizarContador);

  Object.keys(campos).forEach((nome) => {
    const el = campos[nome];
    // Ao sair do campo, avisa só se a pessoa já digitou algo (campo vazio
    // é cobrado no envio, não no primeiro Tab).
    el.addEventListener('blur', () => {
      const preenchido = el.type === 'checkbox' ? el.checked : el.value.trim() !== '';
      if (preenchido || el.getAttribute('aria-invalid') === 'true') mostrarErroCampo(nome, validarCampo(nome));
    });
    // Campo marcado com erro: o aviso some assim que ele fica certo.
    const aoMudar = () => {
      if (el.getAttribute('aria-invalid') === 'true') mostrarErroCampo(nome, validarCampo(nome));
    };
    el.addEventListener('input', aoMudar);
    el.addEventListener('change', aoMudar);
  });

  // ----- Envio -----

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (enviando) return;
    mostrarErroGeral('');

    let primeiroInvalido = null;
    Object.keys(campos).forEach((nome) => {
      const mensagem = validarCampo(nome);
      mostrarErroCampo(nome, mensagem);
      if (mensagem && !primeiroInvalido) primeiroInvalido = campos[nome];
    });
    if (primeiroInvalido) {
      primeiroInvalido.focus();
      return;
    }

    const dados = {
      nome: campos.nome.value.trim(),
      email: campos.email.value.trim(),
      telefone: campos.telefone.value.trim(),
      estabelecimento: campos.estabelecimento.value.trim(),
      tipo_comercio: campos.tipo_comercio.value,
      plano_interesse: campos.plano_interesse.value,
      mensagem: campos.mensagem.value.trim(),
      aceite_lgpd: campos.aceite_lgpd.checked,
      site: isca ? isca.value : '',
    };

    definirEnviando(true);
    try {
      if (typeof window.hydraApi !== 'function') throw new Error('API indisponível');
      await window.hydraApi('/contato', { method: 'POST', body: dados });
      definirEnviando(false);
      mostrarSucesso();
    } catch (erro) {
      definirEnviando(false);
      tratarFalha(erro);
    }
  });

  // "Enviar outra mensagem": formulário limpo de novo, foco no primeiro campo.
  botaoNovo.addEventListener('click', () => {
    form.reset();
    Object.keys(campos).forEach((nome) => mostrarErroCampo(nome, ''));
    mostrarErroGeral('');
    atualizarContador();
    sucesso.hidden = true;
    form.hidden = false;
    campos.nome.focus();
  });

  atualizarContador();
})();
