// Animación de entrada del Hero (GSAP) y parallax suave al salir con el scroll.
// Todo vive dentro de gsap.matchMedia: si el usuario pide menos movimiento no se anima nada,
// y mm.revert() deshace tweens, ScrollTriggers y listeners al salir de la página.
(function () {
  const root = document.documentElement;
  const reveal = () => root.classList.remove('js-anim');

  if (!window.gsap || !window.ScrollTrigger) { reveal(); return; }
  gsap.registerPlugin(ScrollTrigger);

  const hero = document.querySelector('.hero');
  if (!hero) { reveal(); return; }

  // Parte el título en palabras con máscara, conservando el <span class="hl">
  const splitWords = (el) => {
    const words = [];
    const wrap = (text, parent) => {
      text.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) { parent.appendChild(document.createTextNode(part)); return; }
        const mask = document.createElement('span');
        mask.className = 'word';
        const inner = document.createElement('span');
        inner.className = 'word__inner';
        inner.textContent = part;
        mask.appendChild(inner);
        parent.appendChild(mask);
        words.push(inner);
      });
    };
    Array.from(el.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        wrap(node.textContent, frag);
        el.replaceChild(frag, node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const text = node.textContent;
        node.textContent = '';
        wrap(text, node);
      }
    });
    return words;
  };

  const title = hero.querySelector('h1');
  const words = title.dataset.split ? title.querySelectorAll('.word__inner') : splitWords(title);
  title.dataset.split = 'true';

  const mm = gsap.matchMedia();

  // Con reduce no se registra nada y el Hero se muestra tal cual
  mm.add('(prefers-reduced-motion: reduce)', reveal);

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    // En móvil los links viven en el menú desplegable (que ya usa transform): ahí solo se anima el botón
    const desktop = window.matchMedia('(min-width: 821px)').matches;
    const navItems = desktop ? ['.nav__logo', '.nav__links > a'] : ['.nav__logo', '.nav__toggle'];

    const q = gsap.utils.selector(hero);
    const btns = q('.hero__actions .btn');
    const stat = q('.stats strong')[0];
    const media = q('.hero__media')[0];
    const phones = q('.hero__media img')[0];
    const blob = q('.hero__blob')[0];

    // Los botones tienen transition CSS en transform: se apaga mientras GSAP los mueve
    gsap.set(desktop ? [...btns, '.nav__cta'] : btns, { transition: 'none' });

    const tl = gsap.timeline({ defaults: { ease: 'expo.out', duration: 0.8 } });

    tl.from(navItems, {
      y: -16, autoAlpha: 0, duration: 0.7, stagger: 0.05,
      clearProps: 'transform,opacity,visibility,transition'
    }, 0)
      .from(q('.pill'), { y: 14, scale: 0.92, autoAlpha: 0, duration: 0.7, ease: 'back.out(1.6)' }, 0.15)
      .from(words, { yPercent: 110, rotate: 3, duration: 0.85, ease: 'expo.out', stagger: 0.035 }, 0.25)
      .from(q('.lead'), { y: 16, autoAlpha: 0 }, '-=0.6')
      .from(btns, {
        y: 16, autoAlpha: 0, stagger: 0.08,
        clearProps: 'transform,opacity,visibility,transition'
      }, '-=0.6')
      .from(q('.stats > div'), { y: 18, autoAlpha: 0 }, '-=0.6')
      .from(q('.fineprint'), { autoAlpha: 0, duration: 0.8, ease: 'power2.out' }, '-=0.5')
      .from(blob, { scale: 0.6, autoAlpha: 0, duration: 1.4, ease: 'expo.out' }, 0.2)
      .from(media, { y: 48, rotate: -2, autoAlpha: 0, duration: 1.1, ease: 'expo.out' }, 0.35);

    // Contador de descargas: 0 → 500.000 con formato colombiano
    if (stat) {
      const finalText = stat.dataset.final || stat.textContent;
      stat.dataset.final = finalText;
      const target = parseInt(finalText.replace(/\D/g, ''), 10) || 0;
      const counter = { value: 0 };
      tl.to(counter, {
        value: target, duration: 1.6, ease: 'power2.out',
        onUpdate: () => { stat.textContent = '+' + Math.round(counter.value).toLocaleString('es-CO'); },
        onComplete: () => { stat.textContent = finalText; }
      }, '<-0.1');
    }

    // Los estados iniciales ya están aplicados: se puede mostrar el Hero sin parpadeo
    reveal();

    // Flotación continua de los celulares (reemplaza el @keyframes float del CSS)
    const float = gsap.to(phones, {
      y: -12, duration: 3, ease: 'sine.inOut', yoyo: true, repeat: -1, paused: true
    });
    tl.call(() => float.play(), null, '>-0.3');

    // Parallax al bajar: los celulares suben más lento y el texto se desvanece un poco
    const scrollOut = { trigger: hero, start: 'top top', end: 'bottom top', scrub: 0.8 };
    gsap.to(media, { yPercent: -12, ease: 'power1.inOut', scrollTrigger: { ...scrollOut } });
    gsap.to(blob, { scale: 1.15, ease: 'power1.inOut', scrollTrigger: { ...scrollOut } });
    gsap.to(q('.hero__text'), { y: -40, autoAlpha: 0.35, ease: 'power1.in', scrollTrigger: { ...scrollOut } });

    // Fuera de pantalla no tiene sentido seguir flotando: se pausa para ahorrar frames
    ScrollTrigger.create({
      trigger: hero, start: 'top bottom', end: 'bottom top',
      onToggle: (self) => { if (tl.progress() === 1) self.isActive ? float.play() : float.pause(); }
    });

    // Si se revierte a mitad del contador, el número vuelve a su texto original
    return () => { if (stat) stat.textContent = stat.dataset.final || stat.textContent; };
  });

  // Limpieza: al salir (o al entrar al bfcache) se revierten animaciones y ScrollTriggers
  window.addEventListener('pagehide', () => mm.revert(), { once: true });
})();
