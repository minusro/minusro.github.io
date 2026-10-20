(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const SLUG = /^[a-z0-9][a-z0-9-]*$/;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const canHover = matchMedia('(hover: hover) and (pointer: fine)');
  const baseTitle = document.title;

  const els = {
    toolbar: $('#toolbar'),
    filters: $('#filters'),
    list: $('#projects'),
    count: $('#result-count'),
    dialog: $('#project'),
  };

  const field = FX.field($('#field'));
  const preview = FX.hoverPreview($('#preview'));

  let categories = [];
  let catById = {};
  let projects = [];
  let state;

  FX.scramble($('h1 [data-scramble]'), 900);
  scrambleOnReveal();
  scrambleOnHover();

  fetch('content.json', { cache: 'no-cache' })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(start)
    .catch((err) => {
      console.error(err);
      els.list.outerHTML =
        '<p class="placeholder">Couldn’t load content.json. To preview the site locally, run <code>npm run dev</code> instead of opening index.html directly.</p>';
    });

  function start(content) {
    categories = (content.categories ?? []).filter((c) => SLUG.test(c.id));
    catById = Object.fromEntries(categories.map((c) => [c.id, c]));
    injectCategoryColours();
    field.setPalette(categories.map((c) => c.color).filter(isHex));

    // Number projects chronologically (oldest = 01). Undated projects keep
    // their order from content.json and go last.
    projects = (content.projects ?? [])
      .filter((p) => SLUG.test(p.id))
      .map((p, order) => ({
        year: null, role: '', studio: '', platforms: [], tech: [], summary: '', links: [], cover: '', video: '',
        ...p,
        tags: (p.tags ?? []).filter((t) => catById[t]),
        cover: safeMedia(p.cover),
        video: safeMedia(p.video),
        order,
      }))
      .sort((a, b) => compare(a, b, 1))
      .map((p, i) => ({ ...p, num: pad(i + 1) }));

    // Filter, sort and layout live in the query string so views can be linked to.
    const params = new URLSearchParams(location.search);
    state = {
      tag: pick(params.get('tag'), ['all', ...categories.map((c) => c.id)]),
      sort: pick(params.get('sort'), ['newest', 'oldest']),
      view: pick(params.get('view'), ['grid', 'list']),
    };

    renderSite(content.site ?? {});
    renderStats();
    renderFilters();
    update({ syncUrl: false, animate: false });
    route();
    bindEvents();

    // The browser jumped to #about / #contact before the projects rendered and
    // pushed those sections down; jump again now that the layout is final.
    if (/^#[a-z][\w-]*$/.test(location.hash)) $(location.hash)?.scrollIntoView({ behavior: 'instant' });
  }

  // ---- Events --------------------------------------------------------------

  function bindEvents() {
    els.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const viewChange = b.dataset.view && b.dataset.view !== state.view;
      if (b.dataset.cat) state.tag = b.dataset.cat;
      if (b.dataset.sort) state.sort = b.dataset.sort;
      if (b.dataset.view) state.view = b.dataset.view;
      preview.hide();
      update({ animate: !viewChange });
    });

    // Hover: scramble the title, play the card's video, and in list view show
    // the floating preview; in grid view a spotlight follows the cursor.
    let hovered = null;
    const setHovered = (card) => {
      if (card === hovered) return;
      if (hovered) leave(hovered);
      hovered = card;
      if (card) enter(card);
    };

    els.list.addEventListener('pointermove', (e) => {
      const card = e.target.closest('.card');
      setHovered(card);
      if (!card) return;
      if (state.view === 'list') {
        preview.move(e.clientX, e.clientY);
      } else {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      }
    });
    els.list.addEventListener('pointerleave', () => setHovered(null));
    window.addEventListener('scroll', () => setHovered(null), { passive: true });
    els.list.addEventListener('focusin', (e) => FX.scramble($('[data-scramble]', e.target.closest('.card'))));

    // Project panel: opened by #/<id> links, closed by Esc, the close button or the backdrop.
    window.addEventListener('hashchange', route);

    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#/"]');
      // Re-clicking the current hash doesn't fire hashchange.
      if (a && a.getAttribute('href') === location.hash) {
        e.preventDefault();
        route();
      }
    });

    els.dialog.addEventListener('click', (e) => {
      if (e.target === els.dialog || e.target.closest('[data-close]')) closeProject();
    });

    els.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') els.dialog.querySelector('[data-prev]')?.click();
      if (e.key === 'ArrowRight') els.dialog.querySelector('[data-next]')?.click();
    });

    // Esc closes the dialog natively; tidy up after it too. The event is async, so
    // ignore it if another project was opened in the meantime.
    els.dialog.addEventListener('close', () => {
      if (!els.dialog.open) closeProject();
    });
  }

  function enter(card) {
    const p = projects.find((x) => x.id === card.dataset.id);
    FX.scramble($('[data-scramble]', card));
    if (state.view === 'list' && canHover.matches) {
      preview.show(p.id, `<div class="preview-media" data-cat="${primary(p)}">${mediaHTML(p, { autoplay: true })}</div>`);
    } else {
      playVideo(card, true);
    }
  }

  function leave(card) {
    playVideo(card, false);
    preview.hide();
  }

  function playVideo(card, on) {
    const v = $('video', card);
    if (!v) return;
    card.classList.toggle('is-playing', on && !reduceMotion.matches);
    if (on && !reduceMotion.matches) v.play().catch(() => {});
    else v.pause();
  }

  // ---- State ---------------------------------------------------------------

  function update({ syncUrl = true, animate = true } = {}) {
    const apply = () => {
      for (const b of els.toolbar.querySelectorAll('button')) {
        const pressed =
          b.dataset.cat === state.tag || b.dataset.sort === state.sort || b.dataset.view === state.view;
        b.setAttribute('aria-pressed', pressed);
      }
      renderProjects();
    };

    // Cards slide to their new places when the filter or sort changes.
    if (animate && document.startViewTransition && !reduceMotion.matches) {
      // A quick second click skips the running transition, which rejects `ready`.
      document.startViewTransition(apply).ready.catch(() => {});
    } else {
      apply();
    }

    if (syncUrl) {
      const q = new URLSearchParams();
      if (state.tag !== 'all') q.set('tag', state.tag);
      if (state.sort !== 'newest') q.set('sort', state.sort);
      if (state.view !== 'grid') q.set('view', state.view);
      const qs = q.toString();
      replaceUrl(location.pathname + (qs ? `?${qs}` : '') + location.hash);
    }
  }

  function visible() {
    const dir = state.sort === 'oldest' ? 1 : -1;
    return projects
      .filter((p) => state.tag === 'all' || p.tags.includes(state.tag))
      .sort((a, b) => compare(a, b, dir));
  }

  function compare(a, b, dir) {
    if (a.year !== b.year) {
      if (a.year == null) return 1;
      if (b.year == null) return -1;
      return (a.year - b.year) * dir;
    }
    return a.order - b.order;
  }

  function route() {
    const m = location.hash.match(/^#\/([\w-]+)$/);
    const p = m && projects.find((x) => x.id === m[1]);
    if (p) openProject(p);
    else if (els.dialog.open) closeProject();
  }

  function closeProject() {
    if (els.dialog.open) els.dialog.close();
    document.title = baseTitle;
    if (location.hash.startsWith('#/')) replaceUrl(location.pathname + location.search);
  }

  // ---- Rendering -----------------------------------------------------------

  function injectCategoryColours() {
    const style = document.createElement('style');
    style.textContent = categories
      .filter((c) => isHex(c.color))
      .map((c) => `[data-cat="${c.id}"] { --c-raw: ${c.color}; }`)
      .join('\n');
    document.head.append(style);
  }

  function renderSite(site) {
    if (site.tagline) $('#tagline').textContent = site.tagline;

    const paragraphs = String(site.about ?? '')
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (paragraphs.length) {
      $('#about-body').innerHTML = paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
    }

    const links = (site.links ?? []).filter((l) => l.label && safeUrl(l.url));
    if (site.email || links.length) {
      $('#contact-body').innerHTML = `
        ${site.email
          ? `<a class="contact-email scramble-hover" href="mailto:${esc(site.email)}"><span class="sr-only">${esc(site.email)}</span><span aria-hidden="true" data-scramble>${esc(site.email)}</span></a>`
          : ''}
        ${links.length
          ? `<ul class="contact-links">${links.map((l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} ↗</a></li>`).join('')}</ul>`
          : ''}`;
    }
  }

  function renderStats() {
    const years = projects.map((p) => p.year).filter(Number.isFinite);
    const stats = {
      '#stat-projects': projects.length,
      '#stat-categories': categories.length,
      '#stat-span': years.length ? `${Math.min(...years)}–${Math.max(...years)}` : '—',
    };
    for (const [sel, value] of Object.entries(stats)) {
      const el = $(sel);
      el.textContent = value;
      FX.scramble(el, 700);
    }
    $('#year').textContent = new Date().getFullYear();
  }

  function renderFilters() {
    const options = [{ id: 'all', label: 'All' }, ...categories];
    els.filters.innerHTML = options
      .map((c) => {
        const n = c.id === 'all' ? projects.length : projects.filter((p) => p.tags.includes(c.id)).length;
        return `
          <button type="button" class="chip" data-cat="${c.id}">
            <span class="dot" aria-hidden="true"></span>${esc(c.label)}<span class="chip-count">${n}</span>
          </button>`;
      })
      .join('');
  }

  function renderProjects() {
    const list = visible();
    els.list.dataset.view = state.view;
    els.list.innerHTML = list.map(cardHTML).join('');
    els.count.textContent = `${list.length} of ${projects.length}`;
  }

  function cardHTML(p) {
    return `
      <li class="card" data-id="${p.id}" data-cat="${primary(p)}" style="view-transition-name: card-${p.id}">
        <a class="card-link" href="#/${p.id}">
          <div class="card-media" aria-hidden="true">${mediaHTML(p)}</div>
          <span class="card-num">${p.num}</span>
          <h3 class="card-title"><span class="sr-only">${esc(p.title)}</span><span aria-hidden="true" data-scramble>${esc(p.title)}</span></h3>
          <span class="card-year">${p.year ?? '—'}</span>
          <ul class="tags">${tagsHTML(p)}</ul>
          <span class="card-arrow" aria-hidden="true">→</span>
        </a>
      </li>`;
  }

  function tagsHTML(p) {
    return p.tags
      .map((t) => `<li class="tag" data-cat="${t}"><span class="dot" aria-hidden="true"></span>${esc(catById[t].short || catById[t].label)}</li>`)
      .join('');
  }

  // Cover image (or a pattern seeded from the project id) plus an optional video loop.
  function mediaHTML(p, { autoplay = false } = {}) {
    const h = hash(p.id);
    const still = p.cover
      ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">`
      : `<span class="ph" style="--a:${h % 180}deg;--x:${(h >>> 8) % 100}%;--y:${(h >>> 16) % 100}%;--gap:${6 + ((h >>> 24) % 9)}px"></span>`;
    const video = p.video
      ? `<video src="${esc(p.video)}" muted loop playsinline preload="${autoplay ? 'auto' : 'none'}"${autoplay ? ' autoplay' : ''}></video>`
      : '';
    return still + video;
  }

  function openProject(p) {
    // Prev/next follow the current filter, unless the project is filtered out (direct link).
    let nav = visible();
    if (!nav.includes(p)) nav = [...projects].sort((a, b) => compare(a, b, state.sort === 'oldest' ? 1 : -1));
    const i = nav.indexOf(p);
    const prev = nav[i - 1];
    const next = nav[i + 1];

    const meta = [
      ['Year', p.year],
      ['Role', p.role],
      ['Studio', p.studio],
      ['Platforms', p.platforms.join(', ')],
      ['Tech', p.tech.join(', ')],
    ];
    const links = p.links.filter((l) => l.label && safeUrl(l.url));
    const media = p.video
      ? `<video src="${esc(p.video)}"${p.cover ? ` poster="${esc(p.cover)}"` : ''} muted loop playsinline autoplay controls></video>`
      : mediaHTML(p);

    els.dialog.innerHTML = `
      <div class="sheet-inner" data-cat="${primary(p)}">
        <div class="sheet-bar">
          <span>${p.num} / ${pad(projects.length)}</span>
          <button type="button" class="sheet-close" data-close>Close <kbd>Esc</kbd></button>
        </div>
        <div class="sheet-media">${media}</div>
        <ul class="tags sheet-tags">${tagsHTML(p)}</ul>
        <h2 id="sheet-title" class="sheet-title"><span class="sr-only">${esc(p.title)}</span><span aria-hidden="true" data-scramble>${esc(p.title)}</span></h2>
        <dl class="sheet-meta">
          ${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v ? esc(v) : '<span class="todo">TODO</span>'}</dd></div>`).join('')}
        </dl>
        <div class="sheet-body">
          ${p.summary
            ? p.summary.split(/\n\s*\n/).map((s) => `<p>${esc(s.trim())}</p>`).join('')
            : '<p class="placeholder">TODO: what it is, what you built, the interesting technical problem, and the outcome.</p>'}
        </div>
        ${links.length
          ? `<ul class="sheet-links">${links.map((l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} ↗</a></li>`).join('')}</ul>`
          : ''}
        <nav class="sheet-nav" aria-label="More projects">
          ${prev ? `<a href="#/${prev.id}" data-prev>← ${esc(prev.title)}</a>` : '<span></span>'}
          ${next ? `<a href="#/${next.id}" data-next>${esc(next.title)} →</a>` : '<span></span>'}
        </nav>
      </div>`;

    if (!els.dialog.open) els.dialog.showModal();
    els.dialog.scrollTop = 0;
    els.dialog.querySelector('[data-close]').focus();
    FX.scramble(els.dialog.querySelector('[data-scramble]'), 600);
    document.title = `${p.title} — Daniel Stanciu`;
  }

  // Section headings decode once as they scroll into view.
  function scrambleOnReveal() {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        FX.scramble(entry.target, 600);
        io.unobserve(entry.target);
      }
    }, { threshold: 1 });
    document.querySelectorAll('.section-head [data-scramble]').forEach((el) => io.observe(el));
  }

  // Anything marked .scramble-hover decodes its text on hover.
  function scrambleOnHover() {
    document.addEventListener('pointerover', (e) => {
      const host = e.target.closest('.scramble-hover');
      if (host && !host.contains(e.relatedTarget)) FX.scramble($('[data-scramble]', host));
    });
  }

  // ---- Helpers -------------------------------------------------------------

  function primary(p) {
    return p.tags[0] ?? 'none';
  }

  function pick(value, allowed) {
    return allowed.includes(value) ? value : allowed[0];
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function isHex(s) {
    return /^#[0-9a-f]{6}$/i.test(s ?? '');
  }

  function safeUrl(url) {
    return /^(https?:|mailto:)/i.test(url ?? '') ? url : '';
  }

  function safeMedia(path) {
    return /^(media\/[\w.-]+|https?:\/\/\S+)$/i.test(path ?? '') ? path : '';
  }

  // Some browsers refuse history updates on file:// pages; the page still works without them.
  function replaceUrl(url) {
    try {
      history.replaceState(null, '', url);
    } catch {}
  }

  function hash(s) {
    let h = 2166136261;
    for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return h >>> 0;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();
