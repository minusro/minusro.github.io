// Visual effects: text scramble, the interactive dot field behind the hero,
// and the floating preview that follows the cursor in list view.
// All of them stand down when the visitor prefers reduced motion.

const FX = (() => {
  'use strict';

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const darkMode = matchMedia('(prefers-color-scheme: dark)');

  // ---- Text scramble --------------------------------------------------------
  // Characters resolve left to right through random glyphs of the same kind
  // (upper/lower/digit), which keeps the text width roughly stable.

  const GLYPHS = [
    [/[A-Z]/, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'],
    [/[a-z]/, 'abcdefghijklmnopqrstuvwxyz'],
    [/[0-9]/, '0123456789'],
  ];
  const SYMBOLS = '#%&*+=/<>_';
  const scrambling = new WeakMap();

  function randomLike(ch) {
    if (/\s/.test(ch)) return ch;
    for (const [re, set] of GLYPHS) if (re.test(ch)) return set[(Math.random() * set.length) | 0];
    return SYMBOLS[(Math.random() * SYMBOLS.length) | 0];
  }

  function scramble(el, duration = 450) {
    if (!el || reduceMotion.matches) return;
    const chars = Array.from(el.dataset.text ?? (el.dataset.text = el.textContent));
    cancelAnimationFrame(scrambling.get(el));
    const start = performance.now();
    let noise = [];
    let lastSwap = -Infinity;

    const frame = () => {
      const now = performance.now();
      const p = Math.min(1, (now - start) / duration);
      const revealed = Math.floor(p * chars.length);
      if (now - lastSwap > 45) {
        noise = chars.map(randomLike);
        lastSwap = now;
      }
      el.textContent = chars.slice(0, revealed).join('') + noise.slice(revealed).join('');
      if (p < 1) scrambling.set(el, requestAnimationFrame(frame));
    };
    scrambling.set(el, requestAnimationFrame(frame));
  }

  // ---- Hero dot field -------------------------------------------------------
  // A grid of points on springs. The cursor pushes them away, clicks send out a
  // ripple in one of the category colours, and a slow wave keeps it breathing.

  function field(canvas) {
    const noop = { setPalette() {} };
    if (!canvas?.getContext) return noop;

    const ctx = canvas.getContext('2d');
    const host = canvas.parentElement;
    const SPACING = 26;
    const RADIUS = 140;
    const SPRING = 0.06;
    const DAMPING = 0.82;
    const RIPPLE_SPEED = 420; // px per second
    const RIPPLE_LIFE = 2.2; // seconds
    const AUTO_PULSE = 4.5; // seconds between idle pulses

    let w = 0;
    let h = 0;
    let hx, hy, ox, oy, vx, vy, bucket;
    let rawPalette = ['#ff7a45', '#3fd5ff', '#c18bff', '#ffd04a'];
    let colors = readColors();
    let pointer = { x: -1e4, y: -1e4 };
    let ripples = [];
    let rippleCount = 0;
    let lastPulse = 0;
    let onScreen = true;
    let raf = 0;

    function readColors() {
      const cs = getComputedStyle(document.documentElement);
      const shade = darkMode.matches ? 1 : 0.78;
      return {
        dot: cs.getPropertyValue('--field-dot').trim(),
        hot: cs.getPropertyValue('--accent').trim(),
        palette: rawPalette.map((hex) => scaleHex(hex, shade)),
      };
    }

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = host.clientWidth;
      h = host.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cols = Math.ceil(w / SPACING) + 1;
      const rows = Math.ceil(h / SPACING) + 1;
      const n = cols * rows;
      hx = new Float32Array(n);
      hy = new Float32Array(n);
      ox = new Float32Array(n);
      oy = new Float32Array(n);
      vx = new Float32Array(n);
      vy = new Float32Array(n);
      bucket = new Uint8Array(n);
      const x0 = (w - (cols - 1) * SPACING) / 2;
      const y0 = (h - (rows - 1) * SPACING) / 2;
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          hx[i] = x0 + c * SPACING;
          hy[i] = y0 + r * SPACING;
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
    darkMode.addEventListener('change', () => {
      colors = readColors();
      draw();
    });

    resize();
    schedule();

    return {
      setPalette(hexes) {
        if (!hexes.length) return;
        rawPalette = hexes;
        colors = readColors();
      },
    };
  }

  function scaleHex(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
    return `rgb(${c.join(',')})`;
  }

  // ---- Cursor preview (list view) -------------------------------------------
  // A media card that trails the cursor with a little lag and tilts with speed.

  function hoverPreview(el) {
    const inner = el.firstElementChild;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    let shown = false;
    let jump = true;
    let key = null;
    let raf = 0;

    function loop() {
      const px = x;
      x += (tx - x) * 0.18;
      y += (ty - y) * 0.18;
      const tilt = Math.max(-8, Math.min(8, (x - px) * 0.5));
      el.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${tilt}deg)`;
      const moving = Math.abs(tx - x) > 0.3 || Math.abs(ty - y) > 0.3;
      raf = shown && moving ? requestAnimationFrame(loop) : 0;
    }

    return {
      show(id, html) {
        if (reduceMotion.matches) return;
        if (id !== key) {
          inner.innerHTML = html;
          key = id;
          inner.querySelector('video')?.play().catch(() => {});
        }
        if (!shown) {
          shown = true;
          jump = true;
          el.classList.add('is-visible');
        }
      },
      move(clientX, clientY) {
        if (!shown) return;
        const W = el.offsetWidth;
        const H = el.offsetHeight;
        tx = clientX + 28 + W > innerWidth - 16 ? clientX - W - 28 : clientX + 28;
        ty = Math.max(16, Math.min(innerHeight - H - 16, clientY - H / 2));
        if (jump) {
          x = tx;
          y = ty;
          jump = false;
        }
        if (!raf) raf = requestAnimationFrame(loop);
      },
      hide() {
        if (!shown) return;
        shown = false;
        el.classList.remove('is-visible');
        inner.querySelector('video')?.pause();
      },
    };
  }

  return { scramble, field, hoverPreview };
})();
