(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const SLUG = /^[a-z0-9][a-z0-9-]*$/;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const els = {
    page: $('.page'),
    main: $('.page-main'),
    toolbar: $('#toolbar'),
    filters: $('#filters'),
    list: $('#projects'),
  };

  const field = FX.field($('#field'));
  // The grid step, in px (smaller in mid-size windows; see styles.css)
  const readG = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--g')) || 24;
  let G = readG();
  window.addEventListener('resize', () => (G = readG()));
  // The wide layout (side column) or the narrow one (phones, tablets)
  const wide = matchMedia('(min-width: 1024px)');
  // How far below the top of the window About's heading sits once it's in
  // place: where jumping to it puts it (its scroll margin, styles.css)
  const aboutGap = () => parseFloat(getComputedStyle($('#about')).scrollMarginTop) || G * 3;

  let site = {};
  let categories = [];
  let catById = {};
  let projects = [];
  let tag = 'all';
  let expandedId = null;
  let hovered = null;
  // Touch screens can't hover, so there an opened project's video plays while
  // its picture is on screen, stops as it scrolls away and starts again from
  // the beginning when it comes back: scrolling stands in for hovering off
  // and on.
  const noHover = matchMedia('(hover: none)');
  const onScreen = new IntersectionObserver((entries) => {
    if (!noHover.matches) return;
    for (const entry of entries) {
      const card = entry.target.closest('.card.is-expanded');
      if (card) setHovered(entry.isIntersecting ? card : null);
    }
  }, { threshold: 0.25 });
  let jumpNext = false; // the next project opens without a smooth scroll
  // Card grid, in grid squares (see layoutGrid)
  let grid = { cols: 1, cells: 14, mediaRows: 9 };

  // (index.html starts this request before the scripts load)
  (window.contentRequest ?? fetch('content.json', { cache: 'no-cache' }))
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(start)
    .catch((err) => {
      console.error(err);
      els.list.outerHTML =
        '<p class="placeholder">Couldn’t load content.json. To preview the site locally, run <code>npm run dev</code> instead of opening index.html directly.</p>';
    })
    .finally(() => document.documentElement.classList.remove('is-loading'));

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
        personal: p.personal === true,
        // A personal project's own page (a bare address gets https://)
        url: webUrl(p.url),
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
    update({ syncUrl: false });
    route();
    bindEvents();
    NAV.init(navApi());
    // Text widths change once the web fonts arrive
    // Scrolling by the visitor, from here on
    let scrolledByHand = false;
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
      window.addEventListener(type, () => (scrolledByHand = true), { once: true, passive: true });
    }
    document.fonts?.ready.then(() => {
      snapWidths();
      alignNavNames();
      alignLinkArrows();
      placeContact();
      // Headings settle to their exact height with the web fonts too, so a
      // project opened from its link is glided back exactly into place
      // (touch screens don't snap to the grid afterwards)
      const card = !scrolledByHand && els.list.querySelector('.card.is-expanded');
      if (card) card.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    });

    // The browser jumped to #about before the projects rendered and
    // pushed those sections down; jump again now that the layout is final.
    if (/^#[a-z][\w-]*$/.test(location.hash)) instantly(() => $(location.hash)?.scrollIntoView());
  }

  // ---- Events --------------------------------------------------------------

  function bindEvents() {
    $('.side-nav').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-section]');
      if (a) holdSection(a.dataset.section);
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
    // An opened card's extra space differs between the wide and narrow layouts
    wide.addEventListener('change', placeCards);

    // Cards scrolled into view land below the sticky filters, however many
    // rows of buttons they wrap to.
    new ResizeObserver(() => {
      const h = els.toolbar.getBoundingClientRect().height + parseFloat(getComputedStyle(els.toolbar).marginBottom);
      els.page.style.setProperty('--sticky-h', `${Math.ceil(h / G - 0.01) * G}px`);
    }).observe(els.toolbar);

    // Re-fit the page length when the content or the window changes height.
    let lengthening = 0;
    const refit = () => {
      cancelAnimationFrame(lengthening);
      lengthening = requestAnimationFrame(fitPageLength);
    };
    new ResizeObserver(refit).observe(els.main);
    window.addEventListener('resize', refit);

    settleOnGrid();

    let following = 0;
    const follow = () => {
      if (following) return;
      following = requestAnimationFrame(() => {
        following = 0;
        followScroll();
      });
    };
    window.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('resize', follow);
    window.addEventListener('resize', alignLinkArrows);
    window.addEventListener('scrollend', () => {
      heldSection = null;
      followScroll();
    });
    followScroll();

    els.toolbar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cat]');
      if (b) selectTag(b.dataset.cat);
    });

    // A card's tags pick that filter too, instead of opening the card (caught
    // on the way down, before the card's link or the page's handlers see it)
    els.list.addEventListener('click', (e) => {
      const t = e.target.closest('.card-link .tag');
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      selectTag(t.dataset.cat);
    }, { capture: true });

    // Hovering means a mouse (or pen). A finger on the screen is a scroll or
    // a tap, which would otherwise start and stop videos as it goes; on
    // touch screens an opened project's video plays while it's in view
    // instead (see onScreen).
    els.list.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch') setHovered(e.target.closest('.card'));
    });
    els.list.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch') setHovered(null);
    });
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
      // The x on an opened card closes it (as does clicking the card itself, below)
      if (e.target.closest('[data-close]')) {
        closeAll({ scrollBack: true });
        return;
      }
      // The name loads the page afresh: no filter, no open project, at the
      // top (scrolling there first, so the reload doesn't put it back)
      if (e.target.closest('[data-home]') && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
        e.preventDefault();
        instantly(() => window.scrollTo(0, 0));
        location.assign(new URL('./', location.href));
        return;
      }
      // The ^^ buttons in the section title rows go back to the top
      if (e.target.closest('[data-to-top]')) {
        window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
        return;
      }
      const a = e.target.closest('a[href^="#/"]');
      // Re-clicking the current hash doesn't fire hashchange: clicking an open
      // card again folds it back up.
      if (a && a.getAttribute('href') === location.hash) {
        e.preventDefault();
        if (expandedId && a.getAttribute('href') === `#/${expandedId}`) closeAll({ scrollBack: true });
        else route();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (expandedId) closeAll({ scrollBack: true });
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
    // Each hover starts from the beginning
    if (v.tagName !== 'VIDEO') {
      // GIFs can't be paused; a fresh address (same file, new #fragment)
      // makes the browser restart the animation
      if (play) v.src = `${v.dataset.src}#${Date.now()}`;
    } else if (play) {
      v.currentTime = 0;
      v.play().catch(() => {});
    } else {
      v.pause();
      // Standing in for the cover: back to the first frame
      if (v.classList.contains('is-still')) v.currentTime = 0;
    }
  }

  // The filters hide once About is in place (its heading three squares from
  // the top, or as far up as the page's end lets it come) and below that.
  // The side links follow them: Work while the filters are on screen (or
  // still to come further down), About once they've gone. In the narrow
  // layout Work is only lit while the Work section is actually on screen,
  // and neither is above it, in the intro. A clicked link stays lit until
  // its scroll has ended. Also keeps the stuck filter bar's grid background
  // lined up with the page's.
  let heldSection = null;
  let heldTimer = 0;

  function followScroll() {
    const page = document.scrollingElement;
    const about = $('#about .section-head').getBoundingClientRect();
    const atEnd = page.scrollHeight > innerHeight + 1 && page.scrollTop + innerHeight >= page.scrollHeight - 1;
    const aboutInPlace = about.top <= aboutGap() + 0.5 || (atEnd && about.top < innerHeight);
    els.toolbar.classList.toggle('is-gone', aboutInPlace);
    const t = els.toolbar.getBoundingClientRect();
    const stuck = t.top > els.toolbar.parentElement.getBoundingClientRect().top + 0.5;
    els.toolbar.classList.toggle('is-stuck', stuck);
    if (stuck) {
      els.toolbar.style.setProperty('--bg-x', `${-t.left}px`);
      els.toolbar.style.setProperty('--bg-y', `${-t.top}px`);
    }
    let lit = !aboutInPlace && t.bottom > 0 ? 'work' : 'about';
    if (lit === 'work' && !wide.matches && $('#work .section-head').getBoundingClientRect().top >= innerHeight) lit = null;
    if (!heldSection) markSection(lit);
    placeContact();
  }

  // Beside the projects, the email and links sit at the bottom of the side
  // column, but never lower than the last line of the About text: as that
  // scrolls up into view they rise with it, at most to a square below the
  // About link (or below the tagline, when short windows hide the links).
  function placeContact() {
    const box = $('#side-contact');
    const last = $('#about-body').lastElementChild;
    if (!wide.matches || !last) {
      box.style.removeProperty('--lift');
      return;
    }
    const lift = parseFloat(box.style.getPropertyValue('--lift')) || 0;
    const r = box.getBoundingClientRect();
    const aboutLink = $('.side-nav a[data-section="about"]');
    const above = aboutLink.getClientRects().length ? aboutLink : $('#tagline');
    const highest = above.getBoundingClientRect().bottom + G - (r.top - lift);
    const level = last.getBoundingClientRect().bottom - (r.bottom - lift);
    box.style.setProperty('--lift', `${Math.min(0, Math.max(level, highest))}px`);
  }

  function holdSection(id) {
    heldSection = id;
    markSection(id);
    clearTimeout(heldTimer);
    // In case the scroll's end isn't reported (or there was nothing to scroll)
    heldTimer = setTimeout(() => {
      heldSection = null;
      followScroll();
    }, 1500);
  }

  // (null clears it)
  function markSection(id) {
    const links = [...document.querySelectorAll('.side-nav a')];
    if (id != null && !links.some((a) => a.dataset.section === id)) return;
    for (const a of links) {
      if (a.dataset.section === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  }

  // ---- Keeping things on the grid ------------------------------------------

  // Fit as many cards across as will go, up to three (at least 12 squares
  // wide, at most 16), one free square between them; the picture, half a
  // square in from the card's top and sides, is roughly 4:3 (mediaRows + 1
  // squares tall). With three columns the cards only grow
  // past 12 squares as far as still leaves the year timeline its five free
  // squares to the right (see nav.js). Returns true if anything changed.
  function layoutGrid() {
    const across = Math.floor(els.list.clientWidth / G + 0.01);
    const cols = Math.min(3, Math.max(1, Math.floor((across + 1) / 13)));
    let cells = Math.max(6, Math.min(16, Math.floor((across + 1) / cols) - 1));
    if (cols === 3) {
      const room = Math.floor((document.documentElement.clientWidth - els.list.getBoundingClientRect().left) / G + 0.01);
      cells = Math.max(12, Math.min(cells, Math.floor((room - 5 - 2) / 3)));
    }
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

  // The previous/next names start and end exactly on gridlines (the arrows
  // sit outside them): each name is pulled out by its first or last letter's
  // own side spacing, measured in the font.
  const measure = document.createElement('canvas').getContext('2d');

  function alignNavNames(root = els.list) {
    for (const name of root.querySelectorAll('.detail-nav .nav-name')) {
      const cs = getComputedStyle(name);
      measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = name.textContent.trim().toUpperCase();
      if (name.parentElement.classList.contains('nav-prev')) {
        name.style.marginLeft = `${measure.measureText(text[0]).actualBoundingBoxLeft}px`;
      } else {
        const m = measure.measureText(text.at(-1));
        name.style.marginRight = `${m.actualBoundingBoxRight - m.width}px`;
      }
    }
  }

  // Scroll without animation. The page asks for smooth scrolling in CSS (for
  // its # links), and not every browser reliably lets a script opt out per
  // call with behavior: 'instant', so it's switched off around the scroll
  // instead.
  function instantly(scroll) {
    document.documentElement.classList.add('jump');
    scroll();
    document.documentElement.classList.remove('jump');
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
  // The page is also long enough for the About heading to scroll up to where
  // a jump to it puts it (three squares from the top, two in the narrow
  // layout: level with the page's first row), however short About is.
  // (innerHeight rather than clientHeight: on phones it follows the browser
  // bars sliding away, and so does how far the page can scroll.)
  function fitPageLength() {
    const page = document.scrollingElement;
    const tail = parseFloat(els.main.style.paddingBottom) || 0;
    const over = page.scrollHeight - tail - window.innerHeight;
    const about = $('#about .section-head').getBoundingClientRect().top + scrollY;
    const need = Math.max(over, about - aboutGap());
    const pad = need > 0 ? need - over + ((G - (need % G)) % G) : 0;
    if (Math.abs(pad - tail) > 0.5) els.main.style.paddingBottom = pad ? `${pad}px` : '';
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
      if (reduceMotion.matches) return instantly(() => window.scrollTo(0, target));
      let last = 0;
      const step = (now) => {
        y = target + (y - target) * Math.exp(-(last ? now - last : 16) / 40);
        last = now;
        const done = Math.abs(target - y) < 0.5;
        instantly(() => window.scrollTo(0, done ? target : y));
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

  // Picking a filter (even the one already selected) closes any opened
  // project. With the filters pinned to the
  // top, jump to the first project of the new selection (as the timeline's
  // newest year would); otherwise stay.
  function selectTag(cat) {
    closeAll();
    tag = cat;
    const pinned = els.toolbar.getBoundingClientRect().top <= 0.5;
    update({ then: pinned ? () => instantly(() => els.list.querySelector('.card')?.scrollIntoView({ block: 'start' })) : null });
  }

  function update({ syncUrl = true, then = null } = {}) {
    for (const b of els.filters.querySelectorAll('button')) b.setAttribute('aria-pressed', b.dataset.cat === tag);
    renderProjects();
    then?.();

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
      holdSection(location.hash.slice(1));
      return closeAll({ scrollBack: !location.hash });
    }
    expandCard(p);
  }

  // Closing a project by hand scrolls back to its card, which lands a square
  // below the filters like any card scrolled to. The card first keeps its
  // place on screen while the cards around it rearrange, so the page doesn't
  // jump; then it glides the rest of the way (usually just that square).
  function closeAll({ scrollBack = false } = {}) {
    const card = expandedId && els.list.querySelector(`.card[data-id="${expandedId}"]`);
    const before = card?.getBoundingClientRect();
    collapse();
    NAV.markYear();
    if (location.hash.startsWith('#/')) replaceUrl(location.pathname + location.search);
    if (!scrollBack || !card) return;
    const keep = scrollY + card.getBoundingClientRect().top - before.top;
    // Where the filters start sticking to the top of the window
    const pinned = els.toolbar.parentElement.getBoundingClientRect().top + scrollY;
    if (keep >= pinned - 0.5 || reduceMotion.matches) {
      instantly(() => window.scrollTo(0, keep));
      card.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    } else {
      // Near the top of the list, holding the card in place would pull the
      // filters loose for a moment. Go straight to the end position (the
      // filters stay put) and let just the card glide up the last stretch.
      instantly(() => card.scrollIntoView({ block: 'start' }));
      const dy = before.top - card.getBoundingClientRect().top;
      if (dy > 0) card.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 250, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }
  }

  function expandCard(p) {
    if (!els.list.querySelector(`.card[data-id="${p.id}"]`)) {
      // Filtered out: show everything so the card exists.
      tag = 'all';
      expandedId = p.id;
      update();
    }
    // The clicked card keeps its place on screen while the cards around it
    // rearrange (so nothing jumps under the pointer), then glides into
    // position. The previous/next links jump straight there instead.
    const before = els.list.querySelector(`.card[data-id="${p.id}"]`)?.getBoundingClientRect().top;
    collapse();
    expandedId = p.id;
    const card = attachDetail(p);
    if (card && before != null && !jumpNext) instantly(() => window.scrollBy(0, card.getBoundingClientRect().top - before));
    if (card && jumpNext) instantly(() => card.scrollIntoView({ block: 'start' }));
    else card?.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    jumpNext = false;
    // The year timeline follows (the glide there updates it too, but a card
    // already in place doesn't scroll at all)
    NAV.markYear();
    // Its video keeps playing (or starts) while the project is open
    if (card) {
      setHovered(card);
      onScreen.observe(card.querySelector('.card-media'));
    }
  }

  function attachDetail(p) {
    const card = els.list.querySelector(`.card[data-id="${p.id}"]`);
    if (!card) return null;
    card.classList.add('is-expanded');
    card.insertAdjacentHTML('beforeend', `<div class="card-detail" data-cat="${primary(p)}">${detailHTML(p)}</div>`);
    placeCards();
    snapWidths(card.querySelector('.card-detail'));
    alignNavNames(card);
    return card;
  }

  function collapse() {
    onScreen.disconnect();
    for (const card of els.list.querySelectorAll('.card.is-expanded')) {
      card.classList.remove('is-expanded');
      card.querySelector('.card-detail')?.remove();
    }
    expandedId = null;
    placeCards();
  }

  function detailHTML(p) {
    const nav = visible();
    const i = nav.indexOf(p);
    // The list runs newest first: < goes to the project before this one (the
    // newer, higher number), > to the one after it (older, lower number)
    const prev = nav[i - 1];
    const next = nav[i + 1];

    // Role gets a full row, studio and platforms share the next, and tech
    // gets a full row last. (The year is on the card.)
    const meta = [
      ['Role', p.role, 'wide'],
      ['Studio', p.studio],
      ['Platforms', p.platforms.join(', ')],
      ['Tech', p.tech.join(', '), 'wide'],
    ];
    const links = p.links.filter((l) => l.label && safeUrl(l.url));

    return `
      <button type="button" class="detail-close" data-close aria-label="Close project"></button>
      <nav class="detail-nav" aria-label="More projects">
        ${prev ? `<a href="#/${prev.id}" class="nav-prev"><span class="nav-arrow" aria-hidden="true">&lt;</span><span class="nav-name">${esc(prev.title)}</span></a>` : '<span></span>'}
        ${next ? `<a href="#/${next.id}" class="nav-next"><span class="nav-name">${esc(next.title)}</span><span class="nav-arrow" aria-hidden="true">&gt;</span></a>` : '<span></span>'}
      </nav>
      <div class="detail-info">
        <div class="detail-body${p.summary ? '' : ' is-todo'}">
          ${p.summary
            ? p.summary.split(/\n\s*\n/).map((s) => `<p>${esc(s.trim())}</p>`).join('')
            : '<p>TODO: what it is, what you built, the interesting technical problem, and the outcome.</p>'}
        </div>
        <dl class="detail-meta">
          ${meta.map(([k, v, wide]) => k === 'Studio' && p.personal
            // Personal projects say so, on two rows, instead of naming a studio,
            // and link to their own page when they have one
            ? p.url
              ? `<div><dt class="meta-value"><a class="meta-link" href="${esc(p.url)}" target="_blank" rel="noopener">Personal<br>project <span class="meta-arrow" aria-hidden="true">↗</span></a></dt><dd></dd></div>`
              : '<div><dt class="meta-value">Personal<br>project</dt><dd></dd></div>'
            : `<div${wide ? ' class="meta-wide"' : ''}><dt>${k}</dt><dd>${v ? esc(v) : '<span class="todo">TODO</span>'}</dd></div>`).join('')}
        </dl>
        ${links.length
          ? `<ul class="detail-links">${links.map((l) => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} ↗</a></li>`).join('')}</ul>`
          : ''}
      </div>`;
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

    // In the side column, and on narrow screens again after the About text
    const links = (site.links ?? []).filter((l) => l.label && safeUrl(l.url));
    const contact = [
      ...links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)} <span class="link-arrow" aria-hidden="true">↗</span></a>`),
      site.email ? `<a href="mailto:${esc(site.email)}">${esc(site.email)}</a>` : '',
    ].join('');
    $('#side-contact').innerHTML = contact;
    $('#about-contact').innerHTML = contact;
    alignLinkArrows();
  }

  // The side column's link arrows sit in their squares exactly where the
  // arrow after an opened personal project's "Personal project" does (see
  // .meta-arrow in styles.css): as far short of a gridline, as far down
  // their row, on whole pixels, where a small nudge gets them there.
  function alignLinkArrows() {
    const arrows = [...document.querySelectorAll('#side-contact .link-arrow, #about-contact .link-arrow')].filter((a) => a.getClientRects().length);
    if (!arrows.length) return;
    const px = G / 24;
    const lede = parseFloat(getComputedStyle(arrows[0]).fontSize);
    const font = (el) => {
      const cs = getComputedStyle(el);
      return `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    };
    // Where the browser puts a line's baseline, below the line's top
    const baseline = (line) => {
      const mark = document.createElement('span');
      mark.style.cssText = 'display:inline-block;width:0;height:0';
      line.append(mark);
      const y = mark.getBoundingClientRect().top - line.getBoundingClientRect().top;
      mark.remove();
      return y;
    };
    measure.font = font(arrows[0]);
    const ink = measure.measureText('↗');
    // The project arrow: its start, from the label's gridline, and its tip
    const start = Math.round(8 * 0.72 * 11 * px - 0.3 * 11 * px - G / 5);
    const gap = Math.ceil((start + ink.actualBoundingBoxRight) / G) * G - (start + ink.actualBoundingBoxRight);
    const label = document.createElement('div');
    label.style.cssText = `position:absolute;visibility:hidden;font:400 ${11 * px}px/${G}px var(--font-mono)`;
    label.textContent = 'project';
    document.body.append(label);
    const tip = baseline(label) + Math.round(0.4224 * lede - 0.698 * 11 * px);
    label.remove();
    // Moving an arrow far would leave it touching its word or adrift from it
    // (with smaller text, as on phones, the nearest spot can be up to half a
    // square away). So it moves at most 70% of a space towards the word and
    // a quarter of a space away from it, and otherwise stays where it falls.
    const space = measure.measureText(' ').width + (parseFloat(getComputedStyle(arrows[0]).letterSpacing) || 0);
    for (const arrow of arrows) {
      arrow.style.left = '';
      arrow.style.top = '';
      const right = arrow.getBoundingClientRect().left + ink.actualBoundingBoxRight;
      const spots = [Math.floor((right + gap) / G), Math.ceil((right + gap) / G)].map((k) => k * G - gap - right);
      const move = spots.find((d) => d >= -0.7 * space && d <= 0.25 * space);
      if (move != null) arrow.style.left = `${move}px`;
      arrow.style.top = `${tip - baseline(arrow.parentElement)}px`;
    }
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
    els.list.innerHTML = list.map((p, i) => cardHTML(p, i)).join('');
    if (expandedId) {
      const p = projects.find((x) => x.id === expandedId);
      if (!p || !attachDetail(p)) closeAll();
    }
    placeCards();
    snapWidths(els.list);
    NAV.refresh();
  }

  // Rows fill left to right, the newest project top left. Every card gets its
  // row and column explicitly: an opened card takes a whole row of its own,
  // with two squares to the rows above and below it (and to the filters,
  // when it's first); in the narrow layout (phones, tablets) just the usual
  // one.
  function placeCards() {
    let slot = 0;
    const cards = [...els.list.querySelectorAll('.card')];
    const extra = wide.matches ? G : 0;
    for (const [i, card] of cards.entries()) {
      card.style.margin = '';
      if (card.classList.contains('is-expanded')) {
        slot = Math.ceil(slot / grid.cols) * grid.cols;
        card.style.gridArea = `${slot / grid.cols + 1} / 1 / auto / -1`;
        card.style.margin = `${extra}px 0 ${i < cards.length - 1 ? extra : 0}px`;
        slot += grid.cols;
      } else {
        card.style.gridArea = `${Math.floor(slot / grid.cols) + 1} / ${(slot % grid.cols) + 1}`;
        slot += 1;
      }
    }
  }

  // The first row's covers load straight away (the first one first); the
  // rest as they're scrolled near.
  function cardHTML(p, i = Infinity) {
    return `
      <li class="card" data-id="${p.id}" data-cat="${primary(p)}" data-year="${p.year ?? ''}">
        <a class="card-link" href="#/${p.id}">
          <div class="card-media" aria-hidden="true">${mediaHTML(p, i < grid.cols ? (i === 0 ? 'first' : 'eager') : 'lazy')}</div>
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
  // The placeholder's circle is centred on a grid crossing inside the picture
  // (which starts half a square in from the card's corner).
  function mediaHTML(p, load = 'lazy') {
    const h = hash(p.id);
    const x = G * (1 + (h % Math.max(1, grid.cells - 1))) - G / 2;
    const y = G * (1 + ((h >>> 8) % Math.max(1, grid.mediaRows))) - G / 2;
    const gap = [6, 8, 12][(h >>> 24) % 3];
    const fit = `object-position: 50% ${(1 - p.mediaAlign) * 50}%`;
    const gif = /\.gif$/i.test(p.video);
    // With no cover, a video stands in for it, paused on its first frame
    // (#t= makes browsers draw that frame without loading the whole file)
    if (!p.cover && p.video && !gif) {
      return `<video class="is-still" src="${esc(p.video)}#t=0.001" muted loop playsinline preload="metadata" style="${fit}"></video>`;
    }
    const still = p.cover
      ? `<img src="${esc(p.cover)}" alt=""${load === 'lazy' ? ' loading="lazy"' : ''}${load === 'first' ? ' fetchpriority="high"' : ''} decoding="async" style="${fit}">`
      : `<span class="ph" style="--a:${h % 180}deg;--x:${x}px;--y:${y}px;--gap:${gap}px"></span>`;
    // An animated GIF stands in for a video; it loads the first time it's shown
    const video = !p.video
      ? ''
      : gif
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
        closeAll();
        tag = next;
        update();
      },
      goto(section) {
        closeAll();
        holdSection(section);
        const smooth = reduceMotion.matches ? 'auto' : 'smooth';
        if (section === 'top') window.scrollTo({ top: 0, behavior: smooth });
        else document.getElementById(section)?.scrollIntoView({ behavior: smooth });
      },
      close: () => closeAll({ scrollBack: true }),
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

  function webUrl(url) {
    const u = String(url ?? '').trim();
    if (!u) return '';
    return /^[a-z][\w+.-]*:/i.test(u) ? (/^https?:/i.test(u) ? u : '') : `https://${u}`;
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
