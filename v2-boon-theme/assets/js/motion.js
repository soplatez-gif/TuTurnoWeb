// Movimiento con GSAP: entrada del Hero, revelados por línea, notas que cruzan y apariciones al hacer scroll
(function () {
  const root = document.documentElement;
  if (!window.gsap || !window.ScrollTrigger) { root.classList.remove('js-anim'); return; }
  gsap.registerPlugin(ScrollTrigger);

  // Cada línea de titular se envuelve para subirla desde detrás de su máscara
  document.querySelectorAll('.display .line').forEach((line) => {
    const inner = document.createElement('span');
    inner.className = 'line__in';
    while (line.firstChild) inner.appendChild(line.firstChild);
    line.appendChild(inner);
  });

  const mm = gsap.matchMedia();

  // ----- Frase fijada con notas que cruzan la pantalla (solo en escritorio) -----
  // Va primero: los disparadores de más abajo se calculan contando el tramo fijado
  mm.add('(min-width: 941px) and (prefers-reduced-motion: no-preference)', () => {
    const section = document.querySelector('#confianza');
    const travel = () => window.innerHeight * .9;
    const tl = gsap.timeline({
      scrollTrigger: { trigger: section, start: 'top top', end: '+=140%', pin: true, scrub: 1, invalidateOnRefresh: true },
    });
    section.querySelectorAll('.note').forEach((note, i) => {
      tl.fromTo(note, { y: travel }, { y: () => -travel(), ease: 'sine.inOut', duration: 1 }, i * .35);
    });
  });
  mm.add('(prefers-reduced-motion: no-preference)', () => {
    // ----- Entrada del Hero -----
    const intro = gsap.timeline({ defaults: { ease: 'power3.out' } });
    intro
      .call(() => root.classList.remove('js-anim'))
      .from('.hero__title .line__in', { yPercent: 115, duration: 1.1, ease: 'power4.out', stagger: .1 })
      .from('.bar__row', { y: -24, autoAlpha: 0, duration: .8 }, .2)
      .from('.hero__text > *', { y: 24, autoAlpha: 0, duration: .8, stagger: .07 }, .45)
      .from('.hero__media img', { y: 56, scale: .96, autoAlpha: 0, duration: 1.2 }, .4)
      .from('.hero__scroll', { autoAlpha: 0, duration: .8 }, 1.1);

    // Los celulares se quedan un poco atrás al bajar
    gsap.to('.hero__media', {
      yPercent: -10, ease: 'sine.inOut',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 1 },
    });

    // ----- Titulares grandes: línea por línea -----
    gsap.utils.toArray('.bigtext, .sock').forEach((section) => {
      const tl = gsap.timeline({
        defaults: { ease: 'power3.out' },
        scrollTrigger: { trigger: section, start: 'top 65%', once: true },
      });
      tl.from(section.querySelectorAll('.line__in'), { yPercent: 115, duration: 1.1, ease: 'power4.out', stagger: .12 });
      const rest = section.querySelectorAll('.lead, .stores');
      if (rest.length) tl.from(rest, { y: 24, autoAlpha: 0, duration: .8, stagger: .1 }, .35);
    });

    // ----- Apariciones por grupos -----
    const reveal = '.statement__text, .statement > .btn, .section__label, .section__sub, .card, .frame > .cell, .faq, .section > .fineprint, .section > .center, .footer .cell, .footer__legal';
    gsap.set(reveal, { y: 32, autoAlpha: 0 });
    ScrollTrigger.batch(reveal, {
      start: 'top 88%',
      once: true,
      onEnter: (batch) => gsap.to(batch, { y: 0, autoAlpha: 1, duration: .9, ease: 'power3.out', stagger: .08, overwrite: true }),
    });

    // La cadena del ejemplo se enciende semana a semana
    gsap.from('.chain i.on', {
      scale: 0, duration: .6, ease: 'back.out(2.2)', stagger: .14,
      scrollTrigger: { trigger: '.chain', start: 'top 75%', once: true },
    });
  });
})();
