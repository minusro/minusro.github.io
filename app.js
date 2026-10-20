(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const SLUG = /^[a-z0-9][a-z0-9-]*$/;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const baseTitle = document.title;

  const els = {
    page: $('.page'),
    main: $('.page-main'),
    toolbar: $('#toolbar'),
    filters: $('#filters'),
    list: $('#projects'),
  };

  const field = FX.field($('#field'));
  const G = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--g')) || 24;

  let site = {};
  let categories = [];
  let catById = {};
  let projects = [];
  let tag = 'all';
  let expandedId = null;
  let hovered = null;
  let jumpNext = false; // the next project opens without a smooth scroll
  // Card grid, in grid squares (see layoutGrid)
  let grid = { cols: 1, cells: 14, mediaRows: 9 };

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
    site = content.site ?? {};
    categories = (content.categories ?? []).filter((c) => SLUG.test(c.id));
    catById = Object.fromEntries(categories.map((c) => [c.id, c]));
    injectCategoryColours();
    field.setCategories(categories.map((c) => c.id));

    // Projects hidden in the editor never reach the page. The rest are
    // numbered chronologically (oldest = 01); undated ones keep their order
    // from content.json and go last.
    projects = (content.projects ?? [])
      .filter((p) => SLUG.test(p.id) && !p.hidden)
      .map((p, order) => ({
        year: null, role: '', studio: '', platforms: [], tech: [], summary: '', links: [], cover: '', video: '',
        ...p,
        tags: (p.tags ?? []).filter((t) => catById[t]),
        cover: safeMedia(p.cover),
        video: safeMedia(p.video),
        // Vertical alignment of the cover and video: 1 top, 0 middle, -1 bottom
        mediaAlign: Math.max(-1, Math.min(1, Number(p.mediaAlign) || 0)),
        order,
      }))
      .sort((a, b) => compare(a, b, 1))
      .map((p, i) => ({ ...p, num: pad(i + 1) }));

    // The category filter lives in the query string so filtered views can be linked to.
    tag = pick(new URLSearchParams(location.search).get('tag'), ['all', ...categories.map((c) => c.id)]);

    renderSite();
    renderFilters();
    markSection(location.hash === '#about' ? 'about' : 'work');
    layoutGrid();
    update({ syncUrl: false, animate: false });
    route();
    bindEvents();
    NAV.init(navApi());
    // Text widths change once the web fonts arrive
    document.fonts?.ready.then(() => snapWidths());

    // The browser jumped to #about before the projects rendered and
    // pushed those sections down; jump again now that the layout is final.
    if (/^#[a-z][\w-]*$/.test(location.hash)) $(location.hash)?.scrollIntoView({ behavior: 'instant' });
  }

  // ---- Events --------------------------------------------------------------

  function bindEvents() {
    $('.side-nav').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-section]');
      if (a) markSection(a.dataset.section);
    });

    // Re-fit the card grid when the space for it changes.
    let fitting = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(fitting);
      fitting = requestAnimationFrame(() => {
        if (layoutGrid()) renderProjects();
        snapWidths();
      });
    }).observe(els.list);

    // Re-fit the page length when the content or the window changes height.
    let lengthening = 0;
    const refit = () => {
      cancelAnimationFrame(lengthening);
      lengthening = requestAnimationFrame(fitPageLength);
    };
    new ResizeObserver(refit).observe(els.main);
    window.addEventListener('resize', refit);

    settleOnGrid();

    let edgeCheck = 0;
    window.addEventListener('scroll', () => {
      if (edgeCheck) return;
      edgeCheck = requestAnimationFrame(() => {
        edgeCheck = 0;
        const page = document.scrollingElement;
        if (page.scrollHeight <= window.innerHeight + 1) return;
        const links = document.querySelectorAll('.side-nav a');
        if (page.scrollTop <= 0) markSection(links[0]?.dataset.section);
        else if (page.scrollTop + window.innerHeight >= page.scrollHeight - 1) markSection(links[links.length - 1]?.dataset.section);
      });
    }, { passive: true });

    els.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cat]');
      if (!b) return;
      tag = b.dataset.cat;
      update();
    });

    els.list.addEventListener('pointermove', (e) => setHovered(e.target.closest('.card')));
    els.list.addEventListener('pointerleave', () => setHovered(null));
    // Scrolling moves cards out from under a still pointer, so their videos
    // stop; an opened card's carries on until the pointer moves off it.
    window.addEventListener('scroll', () => {
      if (!hovered?.classList.contains('is-expanded')) setHovered(null);
    }, { passive: true });

    // Projects open in place via #/<id> links. The previous/next links jump
    // straight to the project rather than scrolling smoothly.
    els.list.addEventListener('click', (e) => {
      const newTab = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
      if (e.target.closest('.detail-nav a') && !newTab) jumpNext = true;
    });
    window.addEventListener('hashchange', route);

    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        e.preventDefault();
        closeAll();
        return;
      }
      const a = e.target.closest('a[href^="#/"]');
      // Re-clicking the current hash doesn't fire hashchange: clicking an open
      // card again folds it back up.
      if (a && a.getAttribute('href') === location.hash) {
        e.preventDefault();
        if (expandedId && a.getAttribute('href') === `#/${expandedId}`) closeAll();
        else route();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (expandedId) closeAll();
    });
  }

  // The card under the pointer (or the one just opened) plays its video, if
  // it has one; the others show their still.
  function setHovered(card) {
    if (card === hovered) return;
    if (hovered) playVideo(hovered, false);
    hovered = card;
    if (card) playVideo(card, true);
  }

  function playVideo(card, on) {
    const v = $('video, .card-anim', card);
    if (!v) return;
    const play = on && !reduceMotion.matches;
    card.classList.toggle('is-playing', play);
    if (v.tagName !== 'VIDEO') {
      // GIFs animate on their own; they're just shown and hidden
      if (play && !v.src) v.src = v.dataset.src;
    } else if (play) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }

  // Highlight a side-nav link. It follows what was clicked, not the scroll
  // position, except that reaching the very top or bottom of the page selects
  // the first or last link.
  function markSection(id) {
    const links = [...document.querySelectorAll('.side-nav a')];
    if (!links.some((a) => a.dataset.section === id)) return;
    for (const a of links) {
      if (a.dataset.section === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  }

  // ---- Keeping things on the grid ------------------------------------------

  // Fit as many cards across as will go (at least 12 squares wide, at most
  // 16), one free square between them; the picture is about 4:3 in whole
  // squares. Returns true if anything changed.
  function layoutGrid() {
    const across = Math.floor(els.list.clientWidth / G + 0.01);
    const cols = Math.max(1, Math.floor((across + 1) / 13));
    const cells = Math.max(6, Math.min(16, Math.floor((across + 1) / cols) - 1));
    const mediaRows = Math.round(((cells - 2) * 3) / 4);
    const changed = cols !== grid.cols || cells !== grid.cells || mediaRows !== grid.mediaRows;
    grid = { cols, cells, mediaRows };
    els.list.style.setProperty('--cols', cols);
    els.list.style.setProperty('--card-cells', cells);
    els.list.style.setProperty('--media-rows', mediaRows);
    els.list.dataset.cols = cols;
    // With more than one column, lines and headings end where the rightmost
    // card does (--rail in styles.css)
    if (cols > 1) els.page.style.setProperty('--rail', `${(cols * (cells + 1) - 1) * G}px`);
    else els.page.style.removeProperty('--rail');
    return changed;
  }

  // Round the width of buttons, tags and links up to whole squares, so the
  // next thing along starts on a gridline too.
  function snapWidths(root = document) {
    const items = root.querySelectorAll('.chip, .tag, .detail-links a');
    for (const el of items) el.style.width = '';
    const widths = [...items].map((el) => el.getBoundingClientRect().width);
    items.forEach((el, i) => {
      el.style.width = `${Math.ceil(widths[i] / G - 0.01) * G}px`;
    });
  }

  // The grid is fixed to the window while the projects scroll, so they only
  // line up when the scroll position is a whole number of squares. Padding
  // under the content keeps the page a whole number of squares taller than
  // the window, which makes the very bottom one of those positions too.
  // (innerHeight rather than clientHeight: on phones it follows the browser
  // bars sliding away, and so does how far the page can scroll.)
  function fitPageLength() {
    const page = document.scrollingElement;
    const tail = parseFloat(els.main.style.paddingBottom) || 0;
    const over = page.scrollHeight - tail - window.innerHeight;
    const pad = over > 0 ? (G - (over % G)) % G : 0;
    if (pad !== tail) els.main.style.paddingBottom = pad ? `${pad}px` : '';
  }

  // After a scroll stops (with a mouse or trackpad, at any window width; not
  // on phones and tablets), glide the last few pixels to the nearest grid
  // position: each frame closes a share of the remaining gap. Any new
  // scrolling by the visitor takes over.
  function settleOnGrid() {
    const mouse = matchMedia('(pointer: fine)');
    const page = document.scrollingElement;
    let glide = 0;
    const stop = () => {
      cancelAnimationFrame(glide);
      glide = 0;
    };
    const settle = () => {
      // Left alone while pinch-zoomed in
      if (glide || !mouse.matches || (window.visualViewport?.scale ?? 1) > 1.01) return;
      const max = page.scrollHeight - window.innerHeight;
      const target = Math.min(Math.round(page.scrollTop / G) * G, max - (max % G));
      let y = page.scrollTop;
      if (Math.abs(target - y) < 0.5) return;
      if (reduceMotion.matches) return window.scrollTo({ top: target, behavior: 'instant' });
      let last = 0;
      const step = (now) => {
        y = target + (y - target) * Math.exp(-(last ? now - last : 16) / 40);
        last = now;
        const done = Math.abs(target - y) < 0.5;
        window.scrollTo({ top: done ? target : y, behavior: 'instant' });
        glide = done ? 0 : requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(type, stop, { passive: true });
    if ('onscrollend' in window) {
      // Fires once the finger is lifted and any fling has run out
      window.addEventListener('scrollend', settle);
    } else {
      // Otherwise: after a pause in scrolling, with no finger on the screen
      let timer = 0;
      let touching = false;
      const later = () => {
        clearTimeout(timer);
        timer = setTimeout(() => touching || settle(), 150);
      };
      window.addEventListener('scroll', later, { passive: true });
      window.addEventListener('touchstart', () => (touching = true), { passive: true });
      for (const type of ['touchend', 'touchcancel']) {
        window.addEventListener(type, (e) => {
          touching = e.touches.length > 0;
          later();
        }, { passive: true });
      }
    }
  }

  // ---- State ---------------------------------------------------------------

  function update({ syncUrl = true, animate = true } = {}) {
    const apply = () => {
      for (const b of els.filters.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.cat === tag);
      renderProjects();
    };

    // Cards slide to their new places when the filter changes.
    if (animate && document.startViewTransition && !reduceMotion.matches) {
      // A quick second click skips the running transition, which rejects `ready`.
      document.startViewTransition(apply).ready.catch(() => {});
    } else {
      apply();
    }

    if (syncUrl) {
      // Keep any other parameters as they are.
      const q = new URLSearchParams(location.search);
      if (tag === 'all') q.delete('tag');
      else q.set('tag', tag);
      const qs = q.toString();
      replaceUrl(location.pathname + (qs ? `?${qs}` : '') + location.hash);
    }
  }

  // Newest first; undated projects last.
  function visible() {
    return projects
      .filter((p) => tag === 'all' || p.tags.includes(tag))
      .sort((a, b) => compare(a, b, -1));
  }

  // Projects from the same year flip along with the years, so newest first
  // is the numbering read backwards.
  function compare(a, b, dir) {
    if (a.year !== b.year) {
      if (a.year == null) return 1;
      if (b.year == null) return -1;
      return (a.year - b.year) * dir;
    }
    return (a.order - b.order) * dir;
  }

  // ---- Opening projects in place -------------------------------------------

  function route() {
    const m = location.hash.match(/^#\/([\w-]+)$/);
    const p = m && projects.find((x) => x.id === m[1]);
    if (!p) {
      // #work / #about (typed, or via Back/Forward) count like a click on that link
      markSection(location.hash.slice(1));
      return closeAll();
    }
    expandCard(p);
    document.title = `${p.title} — Daniel Stanciu`;
  }

  function closeAll() {
    collapse();
    document.title = baseTitle;
    if (location.hash.startsWith('#/')) replaceUrl(location.pathname + location.search);
  }

  function expandCard(p) {
    if (!els.list.querySelector(`.card[data-id="${p.id}"]`)) {
      // Filtered out: show everything so the card exists.
      tag = 'all';
      expandedId = p.id;
      update({ animate: false });
    }
    collapse();
    expandedId = p.id;
    const card = attachDetail(p);
    card?.scrollIntoView({ block: 'start', behavior: jumpNext || reduceMotion.matches ? 'instant' : 'smooth' });
    jumpNext = false;
    // Its video keeps playing (or starts) while the project is open
    if (card) setHovered(card);
  }

  function attachDetail(p) {
    const card = els.list.querySelector(`.card[data-id="${p.id}"]`);
    if (!card) return null;
    card.classList.add('is-expanded');
    card.insertAdjacentHTML('beforeend', `<div class="card-detail" data-cat="${primary(p)}">${detailHTML(p)}</div>`);
    snapWidths(card.querySelector('.card-detail'));
    return card;
  }

  function collapse() {
    for (const card of els.list.querySelectorAll('.card.is-expanded')) {
      card.classList.remove('is-expanded');
      card.querySelector('.card-detail')?.remove();
    }
    expandedId = null;
  }

  function detailHTML(p) {
    const nav = visible();
    const i = nav.indexOf(p);
    // The list runs newest first: < goes back to the older project (the
    // lower number), > on to the newer one
    const prev = nav[i + 1];
    const next = nav[i - 1];

    const meta = [
      ['Year', p.year],
      ['Role', p.role],
      ['Studio', p.studio],
      ['Platforms', p.platforms.join(', ')],
      ['Tech', p.tech.join(', ')],
    ];
    const links = p.links.filter((l) => l.label && safeUrl(l.url));

    return `
      <button type="button" class="detail-close" data-close aria-label="Close project">
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1 1l8 8M9 1l-8 8"/></svg>
      </button>
      <dl class="detail-meta">
        ${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v ? esc(v) : '<span class="todo">TODO</span>'}</dd></div>`).join('')}
      </dl>
      <div class="detail-body${p.summary ? '' : ' is-todo'}">
        ${p.summary
          ? p.summary.split(/\n\s*\n/).map((s) => `<p>${esc(s.trim())}</p>`).join('')
          : '<p>TODO: what it is, what you built, the interesting technical problem, and the outcome.</p>'}
      </div>
      ${links.length
        ? `<ul class="detail-links">${links.map((l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} ↗</a></li>`).join('')}</ul>`
        : ''}
      <nav class="detail-nav" aria-label="More projects">
        ${prev ? `<a href="#/${prev.id}">&lt; ${esc(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a href="#/${next.id}">${esc(next.title)} &gt;</a>` : '<span></span>'}
      </nav>`;
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

  function renderSite() {
    if (site.tagline) $('#tagline').textContent = site.tagline;

    const paragraphs = String(site.about ?? '')
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (paragraphs.length) {
      $('#about-body').innerHTML = paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
    }

    const links = (site.links ?? []).filter((l) => l.label && safeUrl(l.url));
    $('#side-contact').innerHTML = [
      ...links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`),
      site.email ? `<a href="mailto:${esc(site.email)}">${esc(site.email)}</a>` : '',
    ].join('');
  }

  // The categories, then "All" last (still the one selected to begin with).
  // Categories with no (visible) projects get no button.
  function renderFilters() {
    const options = categories
      .map((c) => ({ ...c, n: projects.filter((p) => p.tags.includes(c.id)).length }))
      .concat({ id: 'all', label: 'All', n: projects.length })
      .filter((c) => c.n > 0);
    els.filters.innerHTML = options
      .map((c) => `
        <button type="button" class="chip" data-cat="${c.id}">
          <span class="dot" aria-hidden="true"></span>${esc(c.label)}
        </button>`)
      .join('');
    snapWidths(els.filters);
  }

  function renderProjects() {
    const list = visible();
    els.list.innerHTML = list.map(cardHTML).join('');
    if (expandedId) {
      const p = projects.find((x) => x.id === expandedId);
      if (!p || !attachDetail(p)) closeAll();
    }
    snapWidths(els.list);
    NAV.refresh();
  }

  function cardHTML(p) {
    return `
      <li class="card" data-id="${p.id}" data-cat="${primary(p)}" data-year="${p.year ?? ''}" style="view-transition-name: card-${p.id}">
        <a class="card-link" href="#/${p.id}">
          <div class="card-media" aria-hidden="true">${mediaHTML(p)}</div>
          <span class="card-num">${p.num}</span>
          <h3 class="card-title">${esc(p.title)}</h3>
          <span class="card-year">${p.year ?? '—'}</span>
          <ul class="tags">${tagsHTML(p)}</ul>
        </a>
      </li>`;
  }

  function tagsHTML(p) {
    return p.tags
      .map((t) => `<li class="tag" data-cat="${t}"><span class="dot" aria-hidden="true"></span>${esc(catById[t].short || catById[t].label)}</li>`)
      .join('');
  }

  // Cover image (or a pattern seeded from the project id) plus an optional video loop.
  // The placeholder's circle is centred on a grid crossing inside the picture.
  function mediaHTML(p) {
    const h = hash(p.id);
    const across = grid.cells - 2;
    const x = G * (1 + (h % Math.max(1, across - 1)));
    const y = G * (1 + ((h >>> 8) % Math.max(1, grid.mediaRows - 1)));
    const gap = [6, 8, 12][(h >>> 24) % 3];
    const fit = `object-position: 50% ${(1 - p.mediaAlign) * 50}%`;
    const still = p.cover
      ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async" style="${fit}">`
      : `<span class="ph" style="--a:${h % 180}deg;--x:${x}px;--y:${y}px;--gap:${gap}px"></span>`;
    // An animated GIF stands in for a video; it loads the first time it's shown
    const video = !p.video
      ? ''
      : /\.gif$/i.test(p.video)
        ? `<img class="card-anim" data-src="${esc(p.video)}" alt="" style="${fit}">`
        : `<video src="${esc(p.video)}" muted loop playsinline preload="none" style="${fit}"></video>`;
    return still + video;
  }

  // ---- What the palette, console and keyboard shortcuts can do -------------

  function navApi() {
    return {
      projects: () => projects,
      categories: () => categories,
      site: () => site,
      state: () => ({ tag }),
      open(id) {
        if (location.hash === `#/${id}`) route();
        else location.hash = `#/${id}`;
      },
      filter(next) {
        tag = next;
        update();
      },
      goto(section) {
        closeAll();
        markSection(section);
        const smooth = reduceMotion.matches ? 'auto' : 'smooth';
        if (section === 'top') window.scrollTo({ top: 0, behavior: smooth });
        else document.getElementById(section)?.scrollIntoView({ behavior: smooth });
      },
      close: closeAll,
    };
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
