// Menú desplegable, encabezado que se esconde al bajar y ejemplo de la cadena
(function () {
  const bar = document.querySelector('.bar');
  const toggle = document.querySelector('.bar__toggle');
  const toggleText = document.querySelector('.bar__toggle-text');
  const menu = document.querySelector('.bar__menu');

  const setMenu = (open) => {
    menu.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open);
    toggleText.textContent = open ? 'Cerrar' : 'Menú';
  };

  toggle.addEventListener('click', () => setMenu(!menu.classList.contains('is-open')));
  menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('click', (e) => { if (!bar.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menu.classList.contains('is-open')) return;
    setMenu(false);
    toggle.focus();
  });

  // El encabezado se esconde al bajar y vuelve al subir; con el menú abierto no se mueve
  let lastY = window.scrollY;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    const down = y > lastY && y > 200;
    bar.classList.toggle('is-hidden', down && !menu.classList.contains('is-open'));
    lastY = y;
  }, { passive: true });

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
})();
