// Menú móvil, sombra del encabezado y aparición de secciones al hacer scroll
(function () {
  const nav = document.querySelector('.nav');
  const toggle = document.querySelector('.nav__toggle');

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open);
    toggle.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
  });

  document.querySelectorAll('.nav__links a').forEach((link) => {
    link.addEventListener('click', () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });

  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (!('IntersectionObserver' in window)) return;
  const targets = document.querySelectorAll('.card, .step, .example, .feature, .compare__col, .faq details, .cta__inner');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  targets.forEach((el) => { el.classList.add('reveal'); observer.observe(el); });
})();
