// ===== Mobile menu toggle =====
const hamburger = document.getElementById('hamburger');
const nav = document.getElementById('nav');

hamburger.addEventListener('click', () => {
  nav.classList.toggle('is-open');
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

    nav.classList.remove('is-open');
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
const heroForm = document.getElementById('hero-form');
const toast = document.getElementById('toast');
let toastTimer;

heroForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const input = heroForm.querySelector('.hero__input');
  if (!input.value.trim()) return;

  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3500);

  input.value = '';
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

// ===== Accessibility: font size adjustment =====

let size = parseFloat(localStorage.getItem("fontSize")) || 16;

document.documentElement.style.fontSize = size + "px";

document.getElementById("font-plus").onclick = () => {

  if (size < 22) {

    size++;

    document.documentElement.style.fontSize = size + "px";

    localStorage.setItem("fontSize", size);
  }

}

document.getElementById("font-minus").onclick = () => {

  if (size > 12) {

    size--;

    document.documentElement.style.fontSize = size + "px";

    localStorage.setItem("fontSize", size);
  }

}