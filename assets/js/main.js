// Menú móvil, sombra del encabezado y aparición de secciones (respaldo si GSAP no carga)
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

  // Ejemplo de la cadena: cambia cuota y total según el botón elegido
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-pressed', t === tab);
      });
      document.querySelectorAll('span[data-cuota], strong[data-cuota]').forEach((el) => { el.textContent = tab.dataset.cuota; });
      document.querySelectorAll('span[data-total], strong[data-total]').forEach((el) => { el.textContent = tab.dataset.total; });
    });
  });

  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Con GSAP disponible las apariciones las hace scroll.js; esto queda solo como respaldo
  if (window.gsap || !('IntersectionObserver' in window)) return;
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
