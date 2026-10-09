// Apariciones al hacer scroll (GSAP + ScrollTrigger) para todo lo que está debajo del Hero.
// Cada bloque se anima una sola vez al entrar en pantalla. Igual que en hero.js, todo vive en
// gsap.matchMedia: con prefers-reduced-motion no se anima nada y mm.revert() limpia al salir.
(function () {
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);

  // Al terminar se quitan los estilos en línea para que vuelvan los :hover y transitions del CSS
  const CLEAR = 'transform,opacity,visibility,transition';
  const START = 'top 85%';

  // Aparición de un elemento (o grupo) cuando su disparador entra en pantalla
  const reveal = (targets, vars, trigger) => {
    const els = gsap.utils.toArray(targets);
    if (!els.length) return null;
    gsap.set(els, { transition: 'none' });
    return gsap.from(els, {
      y: 40, autoAlpha: 0, duration: 0.9, ease: 'power3.out', clearProps: CLEAR,
      ...vars,
      scrollTrigger: { trigger: trigger || els[0], start: START, once: true }
    });
  };

  // Elementos repetidos (tarjetas, preguntas…): se agrupan los que entran juntos y se escalonan
  const batch = (selector, vars) => {
    const els = gsap.utils.toArray(selector);
    if (!els.length) return;
    gsap.set(els, { y: 40, autoAlpha: 0, transition: 'none', ...vars });
    ScrollTrigger.batch(els, {
      start: START, once: true,
      onEnter: (group) => gsap.to(group, {
        y: 0, x: 0, scale: 1, autoAlpha: 1, duration: 0.9, ease: 'power3.out',
        stagger: 0.12, overwrite: true, clearProps: CLEAR
      })
    });
  };

  const mm = gsap.matchMedia();

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    // Títulos de sección: el h2 y luego su bajada
    gsap.utils.toArray('.section__head').forEach((head) => {
      reveal(head.children, { stagger: 0.12 }, head);
    });

    // Cita: el ícono aparece con un pequeño rebote y la frase sube detrás
    const quote = document.querySelector('.quote__inner');
    if (quote) {
      gsap.timeline({ scrollTrigger: { trigger: quote, start: START, once: true } })
        .from('.quote__icon', { scale: 0.6, rotate: -12, autoAlpha: 0, duration: 0.8, ease: 'back.out(1.8)' })
        .from('.quote blockquote', { y: 24, autoAlpha: 0, duration: 0.9, ease: 'power3.out' }, '-=0.5');
    }

    // ¿Por qué TuTurno?
    batch('.card', { y: 50, scale: 0.96 });

    // Cómo funciona: tarjetas de pasos y, dentro, el ícono con rebote
    batch('.step');
    gsap.utils.toArray('.step__icon').forEach((icon, i) => {
      gsap.from(icon, {
        scale: 0.4, rotate: -20, duration: 0.8, ease: 'back.out(2)', delay: 0.25 + i * 0.12,
        scrollTrigger: { trigger: icon.closest('.step'), start: START, once: true }
      });
    });

    // Ejemplo: el texto entra por la izquierda, la cadena por la derecha y luego
    // se "enciende" semana a semana quién recibe, terminando en tu turno
    const example = document.querySelector('.example');
    if (example) {
      const fromSide = window.matchMedia('(min-width: 961px)').matches ? 40 : 0;
      gsap.set(example, { transition: 'none' });
      gsap.timeline({ scrollTrigger: { trigger: example, start: 'top 80%', once: true } })
        .from(example, { y: 50, autoAlpha: 0, duration: 0.9, ease: 'power3.out', clearProps: CLEAR })
        .from('.example__text > *', { x: -fromSide, y: fromSide ? 0 : 20, autoAlpha: 0, duration: 0.8, ease: 'power3.out', stagger: 0.08 }, '-=0.5')
        .from('.chain', { x: fromSide, y: fromSide ? 0 : 20, autoAlpha: 0, duration: 0.9, ease: 'power3.out' }, '<0.1')
        .from('.chain__row', { autoAlpha: 0, y: 10, duration: 0.5, ease: 'power2.out', stagger: 0.08 }, '-=0.5')
        .from('.dots i.on', { scale: 0, duration: 0.5, ease: 'back.out(2.4)', stagger: 0.14 }, '-=0.2')
        .from('.chain__legend', { autoAlpha: 0, y: 10, duration: 0.6, ease: 'power2.out' }, '-=0.1');
    }

    // Respaldo: Tutu entra con un leve giro y las garantías se escalonan
    reveal('.split__media img', { y: 60, scale: 0.9, rotate: -6, duration: 1.1 });
    reveal('.split__text > h2, .split__text > p', { stagger: 0.12 }, '.split__text');
    batch('.feature', { y: 0, x: 30 });

    // Sí es / No es: cada columna desde su lado y luego sus puntos uno a uno
    const compare = document.querySelector('.compare');
    if (compare) {
      const side = window.matchMedia('(min-width: 821px)').matches ? 50 : 0;
      gsap.timeline({ scrollTrigger: { trigger: compare, start: START, once: true } })
        .from('.compare__col--yes', { x: -side, y: side ? 0 : 30, autoAlpha: 0, duration: 0.9, ease: 'power3.out' })
        .from('.compare__col--no', { x: side, y: side ? 0 : 30, autoAlpha: 0, duration: 0.9, ease: 'power3.out' }, '<0.1')
        .from('.compare__col li', { x: -12, autoAlpha: 0, duration: 0.5, ease: 'power2.out', stagger: 0.05 }, '-=0.5');
    }

    // Preguntas frecuentes
    batch('.faq details', { y: 24 });

    // Descarga: la tarjeta crece un poco, luego texto, tiendas y el logo con giro
    const cta = document.querySelector('.cta__inner');
    if (cta) {
      gsap.timeline({ scrollTrigger: { trigger: cta, start: 'top 80%', once: true } })
        .from(cta, { y: 50, scale: 0.96, autoAlpha: 0, duration: 1, ease: 'power3.out' })
        .from('.cta__text > h2, .cta__text > p', { y: 24, autoAlpha: 0, duration: 0.8, ease: 'power3.out', stagger: 0.1 }, '-=0.6')
        .from('.stores a', { y: 20, autoAlpha: 0, duration: 0.7, ease: 'power3.out', stagger: 0.1 }, '-=0.5')
        .from('.cta__logo', { rotate: -30, scale: 0.7, autoAlpha: 0, duration: 1.1, ease: 'back.out(1.6)' }, '-=0.9');
    }
  });

  // Las imágenes con loading="lazy" cambian el alto de la página al cargar: se recalculan posiciones
  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  window.addEventListener('pagehide', () => mm.revert(), { once: true });
})();
