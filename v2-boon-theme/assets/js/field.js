// Campo de puntos en Canvas 2D: una retícula cuyos puntos crecen según la forma de la sección visible
(function () {
  const canvas = document.querySelector('.field');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const css = getComputedStyle(document.documentElement);
  const colorOn = css.getPropertyValue('--blue').trim() || '#0023C3';
  const colorOff = css.getPropertyValue('--dot-off').trim() || '#C9D2F2';

  // Peso de cada forma; GSAP los cruza al cambiar de sección. "calm" es todo en cero
  const mix = { side: 1, halo: 0, swirl: 0, ring: 0 };
  const ALPHAS = [.2, .36, .52, .68];
  const TAU = Math.PI * 2;

  let count = 0, w = 0, h = 0, maxR = 0, ringR = .82, time = 0;
  let x, y, r, a, sideD, seed, phase, weight;

  function build() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const narrow = w < 940;
    const gap = narrow ? 20 : 24;
    maxR = gap * .34;
    // En pantallas angostas el anillo se abre para no pisar el texto
    ringR = narrow ? 1.02 : .82;

    const cols = Math.ceil(w / gap) + 1;
    const rows = Math.ceil(h / gap) + 1;
    count = cols * rows;
    x = new Float32Array(count); y = new Float32Array(count);
    r = new Float32Array(count); a = new Float32Array(count);
    sideD = new Float32Array(count); seed = new Float32Array(count);
    phase = new Float32Array(count); weight = new Float32Array(count);

    // El cúmulo del Hero queda detrás de los celulares
    const sx = narrow ? w * .5 : w * .74;
    const sy = narrow ? h * .8 : h * .62;
    const s = Math.min(w, h) / 2;

    for (let i = 0; i < count; i++) {
      const px = (i % cols) * gap;
      const py = Math.floor(i / cols) * gap;
      // Coordenadas elípticas: las formas siguen la proporción de la pantalla y dejan libre el centro
      const u = (px - w / 2) / (w / 2);
      const v = (py - h / 2) / (h / 2);
      x[i] = px; y[i] = py;
      r[i] = Math.sqrt(u * u + v * v);
      a[i] = Math.atan2(v, u);
      const du = (px - sx) / s, dv = (py - sy) / s;
      sideD[i] = du * du + dv * dv;
      seed[i] = Math.random();
      phase[i] = Math.random() * TAU;
    }
  }

  function render() {
    for (let i = 0; i < count; i++) {
      let v = 0;
      const ri = r[i];
      if (mix.side > .001) v += mix.side * Math.exp(-sideD[i] / .3);
      if (mix.halo > .001) { const d = (ri - 1.08) / .2; v += mix.halo * Math.exp(-d * d); }
      if (mix.ring > .001) { const d = (ri - ringR) / .1; v += mix.ring * Math.exp(-d * d); }
      if (mix.swirl > .001 && ri > .58) {
        const arm = Math.cos(2 * a[i] - ri * 3.2 + time * .12);
        if (arm > .35) v += mix.swirl * ((arm - .35) / .65) * Math.min(1, (ri - .58) / .25);
      }
      v *= (.3 + .7 * seed[i]) * (1 + .18 * Math.sin(time * 1.4 + phase[i]));
      weight[i] = v > 1 ? 1 : v;
    }

    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colorOff;
    ctx.beginPath();
    for (let i = 0; i < count; i++) if (weight[i] < .06) ctx.rect(x[i] - 1, y[i] - 1, 2, 2);
    ctx.fill();

    // Un trazo por nivel de opacidad en vez de uno por punto
    ctx.fillStyle = colorOn;
    for (let b = 0; b < ALPHAS.length; b++) {
      ctx.globalAlpha = ALPHAS[b];
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const wv = weight[i];
        if (wv < .06 || Math.min(ALPHAS.length - 1, Math.floor(wv * ALPHAS.length)) !== b) continue;
        const rad = 1 + wv * maxR;
        ctx.moveTo(x[i] + rad, y[i]);
        ctx.arc(x[i], y[i], rad, 0, TAU);
      }
      ctx.fill();
    }
  }

  build();
  render();

  let lastW = w;
  window.addEventListener('resize', () => {
    // En celular la barra del navegador cambia el alto al hacer scroll: solo se rehace si cambia el ancho
    if (canvas.clientWidth === lastW) return;
    lastW = canvas.clientWidth;
    build();
    render();
  });

  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);

  const show = (name) => {
    gsap.to(mix, {
      side: name === 'side' ? 1 : 0,
      halo: name === 'halo' ? 1 : 0,
      swirl: name === 'swirl' ? 1 : 0,
      ring: name === 'ring' ? 1 : 0,
      duration: reduce ? 0 : 1.4,
      ease: 'power3.inOut',
      overwrite: true,
      onUpdate: reduce ? render : null,
    });
  };

  // Manda la sección que cruza el centro de la pantalla; así también funciona con secciones fijadas
  const sections = document.querySelectorAll('[data-field]');
  let current = 'side';
  const pick = () => {
    const mid = window.innerHeight / 2;
    for (const section of sections) {
      const box = section.getBoundingClientRect();
      if (box.top > mid || box.bottom < mid) continue;
      if (section.dataset.field !== current) show(current = section.dataset.field);
      return;
    }
  };
  ScrollTrigger.create({ start: 0, end: 'max', onUpdate: pick, onRefresh: pick });

  // Con movimiento reducido el campo queda quieto y solo se redibuja al cambiar de sección
  if (reduce) return;
  let still = false;
  gsap.ticker.add((t) => {
    // En las secciones de lectura no hay nada que mover: se dibuja una vez y se deja de pintar
    const calm = mix.side + mix.halo + mix.swirl + mix.ring < .001;
    if (calm && still) return;
    still = calm;
    time = t;
    render();
  });
})();
