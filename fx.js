// Visual effects: the interactive dot field behind the intro. It stands down
// when the visitor prefers reduced motion.

const FX = (() => {
  'use strict';

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMode = matchMedia('(prefers-color-scheme: dark)');

  // ---- Hero dot field -------------------------------------------------------
  // A grid of points on springs. The cursor pushes them away, clicks send out a
  // ripple in one of the category colours, and a slow wave keeps it breathing.

  function field(canvas) {
    const noop = { setCategories() {} };
    if (!canvas?.getContext) return noop;

    const ctx = canvas.getContext('2d');
    const host = canvas.parentElement;
    // Dots sit on the background grid's crossings: same spacing, and the
    // canvas starts on a gridline (the page keeps it there).
    let spacing = 24;
    const RADIUS = 140;
    const SPRING = 0.06;
    const DAMPING = 0.82;
    const RIPPLE_SPEED = 420; // px per second
    const RIPPLE_LIFE = 2.2; // seconds
    const AUTO_PULSE = 4.5; // seconds between idle pulses

    let w = 0;
    let h = 0;
    let hx, hy, ox, oy, vx, vy, bucket;
    let categoryIds = [];
    const probe = document.body.appendChild(document.createElement('span'));
    probe.hidden = true;
    let colors = readColors();
    let pointer = { x: -1e4, y: -1e4 };
    let ripples = [];
    let rippleCount = 0;
    let lastPulse = 0;
    let onScreen = true;
    let raf = 0;

    // Colours come from the active style's CSS variables. They're resolved
    // through a hidden element because tokens like light-dark() only become
    // real colours once applied to something.
    function resolve(value, cat) {
      if (cat) probe.dataset.cat = cat;
      else delete probe.dataset.cat;
      probe.style.color = value;
      return getComputedStyle(probe).color;
    }

    function readColors() {
      const palette = categoryIds.map((id) => resolve('var(--c)', id));
      return {
        dot: resolve('var(--field-dot)'),
        hot: resolve('var(--accent)'),
        palette: palette.length ? palette : [resolve('var(--accent)')],
      };
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = host.clientWidth;
      h = host.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      spacing = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--g')) || 24;
      const cols = Math.ceil(w / spacing) + 1;
      const rows = Math.ceil(h / spacing) + 1;
      const n = cols * rows;
      hx = new Float32Array(n);
      hy = new Float32Array(n);
      ox = new Float32Array(n);
      oy = new Float32Array(n);
      vx = new Float32Array(n);
      vy = new Float32Array(n);
      bucket = new Uint8Array(n);
      // +0.5: the centre of the 1px gridline
      const x0 = 0.5;
      const y0 = 0.5;
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          hx[i] = x0 + c * spacing;
          hy[i] = y0 + r * spacing;
        }
      }
      draw();
    }

    function addRipple(x, y, now) {
      ripples.push({ x, y, start: now, color: rippleCount++ % colors.palette.length });
      lastPulse = now;
    }

    function step() {
      raf = 0;
      const now = performance.now();
      const t = now / 1000;
      if (now - lastPulse > AUTO_PULSE * 1000) addRipple(w * (0.2 + Math.random() * 0.6), h * (0.2 + Math.random() * 0.6), now);
      ripples = ripples.filter((r) => (now - r.start) / 1000 < RIPPLE_LIFE);

      for (let i = 0; i < hx.length; i++) {
        const x = hx[i];
        const y = hy[i];
        let fx = 0;
        let fy = Math.sin(x * 0.011 + t * 1.2) * Math.cos(y * 0.017 - t * 0.6) * 0.3;
        let b = 0;

        const dx = x + ox[i] - pointer.x;
        const dy = y + oy[i] - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < RADIUS * RADIUS) {
          const d = Math.sqrt(d2) || 1;
          const f = (1 - d / RADIUS) ** 2 * 2.4;
          fx += (dx / d) * f;
          fy += (dy / d) * f;
          if (d < RADIUS * 0.55) b = 1;
        }

        for (const r of ripples) {
          const age = (now - r.start) / 1000;
          const rx = x - r.x;
          const ry = y - r.y;
          const d = Math.sqrt(rx * rx + ry * ry) || 1;
          const band = Math.abs(d - age * RIPPLE_SPEED);
          if (band < 36) {
            const f = (1 - band / 36) * (1 - age / RIPPLE_LIFE) * 3;
            fx += (rx / d) * f;
            fy += (ry / d) * f;
            if (f > 0.5) b = 2 + r.color;
          }
        }

        vx[i] = (vx[i] + fx - ox[i] * SPRING) * DAMPING;
        vy[i] = (vy[i] + fy - oy[i] * SPRING) * DAMPING;
        ox[i] += vx[i];
        oy[i] += vy[i];
        bucket[i] = b;
      }

      draw();
      schedule();
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      const fills = [colors.dot, colors.hot, ...colors.palette];
      for (let b = 0; b < fills.length; b++) {
        ctx.fillStyle = fills[b];
        for (let i = 0; i < hx.length; i++) {
          if (bucket[i] !== b) continue;
          const s = 1.5 + Math.min(Math.hypot(ox[i], oy[i]) * 0.08, 2.2);
          ctx.fillRect(hx[i] + ox[i] - s / 2, hy[i] + oy[i] - s / 2, s, s);
        }
      }
    }

    function schedule() {
      const run = onScreen && !document.hidden && !reduceMotion.matches;
      if (run && !raf) raf = requestAnimationFrame(step);
      if (!run && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    }

    window.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => {
      pointer = { x: -1e4, y: -1e4 };
    });
    host.addEventListener('pointerdown', (e) => {
      if (e.target.closest('a, button, input')) return;
      const r = canvas.getBoundingClientRect();
      addRipple(e.clientX - r.left, e.clientY - r.top, performance.now());
    });

    new ResizeObserver(resize).observe(host);
    new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      schedule();
    }).observe(host);
    document.addEventListener('visibilitychange', schedule);
    reduceMotion.addEventListener('change', () => {
      bucket.fill(0);
      ox.fill(0);
      oy.fill(0);
      draw();
      schedule();
    });
    const refresh = () => {
      colors = readColors();
      draw();
    };
    darkMode.addEventListener('change', refresh);
    // ...and when the page forces a colour scheme on <html> (the local dev switch does)
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

    resize();
    schedule();

    return {
      // Ripple colours follow the project categories.
      setCategories(ids) {
        categoryIds = ids;
        refresh();
      },
    };
  }

  return { field };
})();
