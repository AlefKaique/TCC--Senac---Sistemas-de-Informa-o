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

// ===== Nav: smooth scroll (scrollIntoView) + immediate active-state feedback =====
const navLinks = document.querySelectorAll('[data-nav-link]');

navLinks.forEach(link => {
  link.addEventListener('click', (e) => {
    const targetId = link.getAttribute('href');
    const target = document.querySelector(targetId);
    if (!target) return;

    e.preventDefault();

    // instant visual feedback, scroll spy will keep it in sync afterwards
    navLinks.forEach(l => l.classList.remove('nav__link--active'));
    link.classList.add('nav__link--active');

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });

    setMenuAberto(false);
  });
});

// ===== FAQ accordion =====
const accordionItems = document.querySelectorAll('.accordion__item');

accordionItems.forEach(item => {
  const trigger = item.querySelector('.accordion__trigger');
  trigger.addEventListener('click', () => {
    const isOpen = item.classList.contains('is-open');
    accordionItems.forEach(i => i.classList.remove('is-open'));
    if (!isOpen) item.classList.add('is-open');
  });
});

// ===== Hero email form =====
// Leva ao cadastro com o e-mail já preenchido. Antes só mostrava um aviso
// "Cadastro recebido!" sem enviar nada a lugar nenhum.
const heroForm = document.getElementById('hero-form');

heroForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = heroForm.querySelector('.hero__input');
  const email = input.value.trim();
  if (!email) return;
  window.location.href = `cadastro.html?email=${encodeURIComponent(email)}`;
});

// ===== Scroll Spy: keeps the matching nav item highlighted while scrolling =====
const spySections = ['home', 'recursos', 'planos', 'termos']
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

