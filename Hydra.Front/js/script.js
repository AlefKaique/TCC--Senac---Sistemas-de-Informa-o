// ===== Logo/header: ajusta destino e some com Login/Cadastre-se para quem já está logado =====
(function () {
  const homeLink = document.getElementById('hydroHomeLink');
  const loginBtn = document.getElementById('hydroLoginBtn');
  const signupBtn = document.getElementById('hydroSignupBtn');
  if (!window.hydraApi) return;

  window.hydraSessao()
    .then(({ usuario }) => {
      // Cada cargo tem uma "casa" diferente: mandar todo mundo para o
      // Estoque levava quem só opera o caixa a uma tela que a guarda dela
      // recusa.
      if (homeLink) homeLink.setAttribute('href', window.hydraHomePorPermissao(usuario));
      if (loginBtn) loginBtn.remove();
      if (signupBtn) signupBtn.remove();
      document.getElementById('hydroLoginBtnMobile')?.remove();
      document.getElementById('hydroSignupBtnMobile')?.remove();
    })
    .catch(() => { });
})();

// ===== Mobile menu toggle =====
const hamburger = document.getElementById('hamburger');
const nav = document.getElementById('nav');

function setMenuAberto(aberto) {
  nav.classList.toggle('is-open', aberto);
  hamburger.setAttribute('aria-expanded', String(aberto));
  hamburger.setAttribute('aria-label', aberto ? 'Fechar menu' : 'Abrir menu');
}

hamburger.addEventListener('click', () => {
  setMenuAberto(!nav.classList.contains('is-open'));
});

// Fecha com Esc e ao tocar fora do cabeçalho.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && nav.classList.contains('is-open')) {
    setMenuAberto(false);
    hamburger.focus();
  }
});
document.addEventListener('click', (event) => {
  if (nav.classList.contains('is-open') && !event.target.closest('.header')) {
    setMenuAberto(false);
  }
});

// ===== Links internos (#secao): rolagem suave + destaque imediato no menu =====
const navLinks = document.querySelectorAll('[data-nav-link]');
const menosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)');

document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const targetId = link.getAttribute('href');
    if (targetId.length < 2) return;
    const target = document.querySelector(targetId);
    if (!target) return;

    e.preventDefault();

    // instant visual feedback, scroll spy will keep it in sync afterwards
    if (link.hasAttribute('data-nav-link')) {
      navLinks.forEach(l => l.classList.remove('nav__link--active'));
      link.classList.add('nav__link--active');
    }

    target.scrollIntoView({ behavior: menosMovimento.matches ? 'auto' : 'smooth', block: 'start' });

    // O foco vai junto para a seção: quem usa teclado ou leitor de tela
    // continua a partir dela, e não do menu lá em cima.
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });

    setMenuAberto(false);
  });
});

// ===== FAQ accordion =====
// Uma pergunta aberta por vez. aria-expanded diz ao leitor de tela se a
// resposta está visível; o "+" gira e vira "×" quando ela abre (CSS).
const accordionItems = document.querySelectorAll('.accordion__item');

function definirPergunta(item, aberta) {
  item.classList.toggle('is-open', aberta);
  item.querySelector('.accordion__trigger').setAttribute('aria-expanded', String(aberta));
}

accordionItems.forEach(item => {
  const trigger = item.querySelector('.accordion__trigger');
  trigger.addEventListener('click', () => {
    const abrir = !item.classList.contains('is-open');
    accordionItems.forEach(i => definirPergunta(i, false));
    if (abrir) definirPergunta(item, true);
  });
});

// ===== Scroll Spy: keeps the matching nav item highlighted while scrolling =====
const spySections = ['home', 'recursos', 'planos', 'contato', 'termos']
  .map(id => document.getElementById(id))
  .filter(Boolean);

const spyObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.getAttribute('id');
      navLinks.forEach(link => {
        link.classList.toggle('nav__link--active', link.getAttribute('href') === `#${id}`);
      });
    }
  });
}, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

spySections.forEach(section => spyObserver.observe(section));

// ===== Planos: alternar Mensal / Anual =====
// O Flex é cobrado todo mês e o Premium uma vez por ano. O seletor mostra os
// dois no mesmo período (por mês ou por ano) e a economia do anual:
// 12 × Flex − Premium. Os preços vêm dos atributos data-preco-* da seção
// #planos; o HTML já traz pronta a visão "Mensal", que é a inicial.
(function () {
  const secao = document.getElementById('planos');
  const seletor = document.getElementById('planos-periodo');
  const resumo = document.getElementById('planos-resumo');
  if (!secao || !seletor || !resumo) return;

  const flex = Number(secao.dataset.precoFlex);
  const premium = Number(secao.dataset.precoPremium);
  if (!(flex > 0) || !(premium > 0)) return;

  const reais = (valor) => valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  // "R$ 200" quando o valor é redondo; com centavos, "R$ 83,33".
  const reaisCurto = (valor) => (Number.isInteger(valor) ? `R$ ${valor.toLocaleString('pt-BR')}` : reais(valor));

  const flexAno = flex * 12;
  const premiumMes = Math.round((premium / 12) * 100) / 100;
  const economia = Math.round((flexAno - premium) * 100) / 100;

  const visoes = {
    mensal: {
      flex: [reais(flex), '/mês', 'Cobrança mensal, sem fidelidade'],
      premium: [reais(premiumMes), '/mês', `Pagamento anual de ${reais(premium)}`],
      resumo: economia > 0
        ? `Prefere pagar uma vez por ano? No anual são ${reaisCurto(economia)} a menos.`
        : '',
    },
    anual: {
      flex: [reais(flexAno), '/ano', `12 × ${reais(flex)}, cobrança mensal, sem fidelidade`],
      premium: [reais(premium), '/ano', `Equivale a ${reais(premiumMes)} por mês`],
      resumo: economia > 0
        ? `No anual: ${reais(premium)} por ano, em vez de ${reais(flexAno)} no mensal.`
        : '',
    },
  };

  // Sem economia (se os preços mudarem um dia), os avisos de economia somem.
  secao.querySelectorAll('[data-economia]').forEach((el) => { el.hidden = !(economia > 0); });
  secao.querySelectorAll('[data-economia-valor]').forEach((el) => { el.textContent = reaisCurto(economia); });

  function mostrar(periodo) {
    const visao = visoes[periodo] || visoes.mensal;
    ['flex', 'premium'].forEach((plano) => {
      const cartao = secao.querySelector(`[data-plano="${plano}"]`);
      if (!cartao) return;
      const [valor, vez, nota] = visao[plano];
      cartao.querySelector('.plan-card__value').textContent = valor;
      cartao.querySelector('.plan-card__times').textContent = vez;
      cartao.querySelector('.plan-card__note').textContent = nota;
    });
    resumo.textContent = visao.resumo;
    secao.dataset.periodo = periodo;
  }

  seletor.addEventListener('change', (evento) => {
    if (evento.target.name === 'planos-periodo') mostrar(evento.target.value);
  });

  // Ao voltar para a página, o navegador pode restaurar a opção marcada.
  const marcada = seletor.querySelector('input[name="planos-periodo"]:checked');
  mostrar(marcada ? marcada.value : 'mensal');
  seletor.hidden = false;
})();

