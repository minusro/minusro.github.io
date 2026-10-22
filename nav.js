// Ways to get around besides scrolling and clicking:
//   ⌘K / Ctrl+K or /   command palette: jump to a project, a filter or a section
//   `                  drop-down console with shell-style commands (try `help`)
//   j / k              move through the projects, Enter opens
//   year scrubber      a rail of years beside the project index (when there's room)
// app.js calls NAV.init() with an API once the content has loaded.

const NAV = (() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const gridStep = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--g')) || 24;
  const SECTIONS = { top: 'top', work: 'work', about: 'about', '~': 'top' };

  let api = null;

  function init(appApi) {
    api = appApi;
    mountPalette();
    mountConsole();
    mountScrubber();
    bindKeys();
    refresh();
  }

  // ---- Keyboard ------------------------------------------------------------

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();

        if (palette.open) palette.close();
        else openPalette();

        return;
      }

      if (e.key === '`' && !mod && !e.altKey) {
        if (consoleOpen()) {
          e.preventDefault();
          closeConsole();
        } else if (!typing(e) && !document.querySelector('dialog[open]')) {
          e.preventDefault();
          openConsole();
        }

        return;
      }

      if (mod || e.altKey || typing(e) || consoleOpen() || document.querySelector('dialog[open]')) return;

      if (e.key === '/') {
        e.preventDefault();
        openPalette();
      } else if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        step(e.key === 'j' ? 1 : -1);
      }
    });
  }

  function typing(e) {
    return Boolean(e.target.closest?.('input, textarea, select, [contenteditable="true"]'));
  }

  // Move focus to the next/previous project, starting from what's on screen.
  function step(dir) {
    const links = [...document.querySelectorAll('#projects .card:not([data-dup]) > .card-link')].filter((l) => l.offsetParent);

    if (!links.length) return;
    let i = links.indexOf(document.activeElement);

    if (i === -1) {
      i = dir > 0
        ? links.findIndex((l) => l.getBoundingClientRect().top >= 0)
        : links.findLastIndex((l) => l.getBoundingClientRect().bottom <= innerHeight);

      if (i === -1) i = dir > 0 ? 0 : links.length - 1;
    } else {
      i = Math.max(0, Math.min(links.length - 1, i + dir));
    }

    links[i].focus({ preventScroll: true });
    links[i].scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }

  // ---- Command palette -----------------------------------------------------

  let palette;
  let paletteItems = [];
  let paletteShown = [];
  let active = 0;

  function mountPalette() {
    palette = document.createElement('dialog');
    palette.className = 'palette';
    palette.setAttribute('aria-label', 'Search and commands');
    palette.innerHTML = `
      <div class="palette-box">
        <input class="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list"
          aria-autocomplete="list" placeholder="Search projects, filters, sections…" spellcheck="false" autocomplete="off">
        <ul class="palette-list" id="palette-list" role="listbox" aria-label="Results"></ul>
      </div>`;
    document.body.append(palette);

    const input = $('.palette-input', palette);
    input.addEventListener('input', () => renderPalette(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runItem(paletteShown[active]);
      }
    });
    const list = $('.palette-list', palette);
    list.addEventListener('pointermove', (e) => {
      const li = e.target.closest('[data-index]');

      if (li && Number(li.dataset.index) !== active) setActive(Number(li.dataset.index), false);
    });
    list.addEventListener('click', (e) => {
      const li = e.target.closest('[data-index]');

      if (li) runItem(paletteShown[Number(li.dataset.index)]);
    });
    // (The dialog hands focus back to where it was by itself when it closes.)
    palette.addEventListener('click', (e) => {
      if (e.target === palette) palette.close();
    });
  }

  function openPalette() {
    if (!api || palette.open) return;
    paletteItems = commands();
    const input = $('.palette-input', palette);
    input.value = '';
    renderPalette('');
    palette.showModal();
    input.focus();
  }

  function runItem(item) {
    if (!item) return;
    palette.close();
    item.run();
  }

  function commands() {
    const s = api.state();
    const cats = api.categories();
    const label = (id) => cats.find((c) => c.id === id)?.short || id;
    const items = [];
    const add = (group, text, run, extra = {}) => items.push({ group, text, run, ...extra });

    const show = (fn) => () => {
      fn();
      api.goto('work');
    };

    for (const p of api.projects()) {
      add('Projects', p.title, () => api.open(p.id), {
        hint: [p.year, ...p.tags.map(label)].filter(Boolean).join(' · '),
        keywords: [p.id, p.num, p.role, p.studio, ...p.tech, ...p.platforms].join(' '),
        cat: p.tags[0],
      });
    }

    add('Filter', 'Show all projects', show(() => api.filter('all')), { current: s.tag === 'all' });

    for (const c of cats) add('Filter', `Show ${c.label}`, show(() => api.filter(c.id)), { cat: c.id, current: s.tag === c.id });

    for (const [id, text] of [['top', 'Top'], ['work', 'Work'], ['about', 'About']]) {
      add('Go to', text, () => api.goto(id));
    }

    const site = api.site();

    if (site.email) add('Contact', `Email ${site.email}`, () => (location.href = `mailto:${site.email}`));

    for (const l of site.links ?? []) {
      if (l.label && /^https?:/i.test(l.url ?? '')) add('Contact', `Open ${l.label}`, () => window.open(l.url, '_blank', 'noopener'));
    }

    add('More', 'Open console', openConsole);

    return items;
  }

  function renderPalette(query) {
    const q = query.trim().toLowerCase();

    if (q) {
      paletteShown = paletteItems
        .map((item) => ({ item, s: Math.max(score(item.text, q) * 1.5, score(`${item.text} ${item.hint ?? ''} ${item.keywords ?? ''} ${item.group}`, q)) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((x) => x.item);
    } else {
      paletteShown = paletteItems;
    }

    let lastGroup = null;
    $('.palette-list', palette).innerHTML = paletteShown.length
      ? paletteShown
          .map((item, i) => {
            const head = !q && item.group !== lastGroup ? `<li class="palette-group" role="presentation">${item.group}</li>` : '';
            lastGroup = item.group;

            return `${head}<li class="palette-item" id="pal-${i}" role="option" data-index="${i}"${item.cat ? ` data-cat="${item.cat}"` : ''}>
              ${item.cat ? '<span class="dot" aria-hidden="true"></span>' : '<span class="palette-icon" aria-hidden="true">›</span>'}
              <span class="palette-text">${esc(item.text)}</span>
              ${item.current ? '<span class="palette-current mono">current</span>' : ''}
              ${item.hint ? `<span class="palette-hint mono">${esc(item.hint)}</span>` : ''}
            </li>`;
          })
          .join('')
      : '<li class="palette-empty" role="presentation">Nothing matches. Try a project name or a category.</li>';
    setActive(0);
  }

  function setActive(i, scroll = true) {
    if (!paletteShown.length) return;
    active = (i + paletteShown.length) % paletteShown.length;

    for (const li of palette.querySelectorAll('.palette-item')) {
      li.setAttribute('aria-selected', String(Number(li.dataset.index) === active));
    }

    const input = $('.palette-input', palette);
    input.setAttribute('aria-activedescendant', `pal-${active}`);

    if (scroll) document.getElementById(`pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  }

  // Fuzzy match: query letters must appear in order; runs and word starts score higher.
  function score(text, q) {
    const t = text.toLowerCase();
    let from = 0;
    let total = 0;
    let run = 0;

    for (const ch of q) {
      const i = t.indexOf(ch, from);

      if (i < 0) return 0;
      run = i === from ? run + 1 : 0;
      total += 1 + run * 2 + (i === 0 || /[\s\-·/]/.test(t[i - 1]) ? 3 : 0);
      from = i + 1;
    }

    return total - t.length * 0.01;
  }

  // ---- Console -------------------------------------------------------------

  let con;
  let focusBeforeConsole = null;
  const history = [];
  let historyIndex = 0;

  function mountConsole() {
    con = document.createElement('section');
    con.className = 'console';
    con.hidden = true;
    con.setAttribute('aria-label', 'Console');
    con.innerHTML = `
      <div class="console-out" role="log" aria-live="polite"></div>
      <form class="console-form" autocomplete="off">
        <label class="console-prompt" for="console-input">guest@danielstanciu:~$</label>
        <input id="console-input" class="console-input" type="text" spellcheck="false" autocapitalize="off" autocomplete="off">
      </form>`;
    document.body.append(con);

    const input = $('.console-input', con);
    $('.console-form', con).addEventListener('submit', (e) => {
      e.preventDefault();
      const line = input.value;
      input.value = '';
      run(line);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConsole();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        historyIndex = Math.max(0, Math.min(history.length, historyIndex + (e.key === 'ArrowUp' ? -1 : 1)));
        input.value = history[historyIndex] ?? '';
      } else if (e.key === 'Tab') {
        e.preventDefault();
        complete(input);
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        $('.console-out', con).replaceChildren();
      }
    });
    con.addEventListener('click', () => input.focus());
  }

  function consoleOpen() {
    return con && !con.hidden;
  }

  function openConsole() {
    if (!api || consoleOpen()) return;
    focusBeforeConsole = document.activeElement;
    con.hidden = false;

    if (!$('.console-out', con).childElementCount) {
      print('danielstanciu.com — portfolio shell');
      print("Type 'help' for commands or 'ls' to list projects.", 'dim');
    }

    $('.console-input', con).focus();
  }

  function closeConsole() {
    con.hidden = true;

    if (focusBeforeConsole?.isConnected) focusBeforeConsole.focus({ preventScroll: true });
  }

  function print(text, cls = '') {
    const out = $('.console-out', con);
    const line = document.createElement('div');
    line.className = `console-line ${cls}`;
    line.textContent = text;
    out.append(line);
    out.scrollTop = out.scrollHeight;
  }

  const COMMANDS = {
    help: ['', 'list commands'],
    ls: ['[category]', 'list projects, optionally one category'],
    open: ['<project>', 'open a project (id, number or name)'],
    cat: ['<project>', 'print a project’s details'],
    filter: ['<category|all>', 'filter the project index'],
    cd: ['<work|about|~>', 'scroll to a section'],
    whoami: ['', 'who made this'],
    contact: ['', 'how to get in touch'],
    history: ['', 'commands you have typed'],
    clear: ['', 'clear the screen'],
    exit: ['', 'close the console'],
  };

  function run(line) {
    const trimmed = line.trim();
    print(`$ ${trimmed}`, 'echo');

    if (!trimmed) return;
    history.push(trimmed);
    historyIndex = history.length;
    const [cmd, ...args] = trimmed.split(/\s+/);
    const arg = args.join(' ');
    const projects = api.projects();
    const cats = api.categories();
    const catLabel = (id) => cats.find((c) => c.id === id)?.short?.toLowerCase() || id;

    switch (cmd.toLowerCase()) {
      case 'help':
        for (const [name, [usage, what]] of Object.entries(COMMANDS)) print(`  ${`${name} ${usage}`.padEnd(30)}${what}`);
        break;
      case 'ls': {
        const cat = arg ? findCategory(arg) : null;

        if (arg && !cat) return print(`ls: no category '${arg}'. Try: ${cats.map((c) => c.id).join(', ')}`, 'err');
        const list = projects.filter((p) => !cat || p.tags.includes(cat.id));

        for (const p of list) print(`  ${p.num}  ${String(p.year ?? '----')}  ${p.title.padEnd(24)} ${p.tags.map(catLabel).join(', ')}`);
        print(`${list.length} project${list.length === 1 ? '' : 's'}`, 'dim');
        break;
      }

      case 'open': {
        const p = findProject(arg);

        if (!p) return print(`open: no project matching '${arg}'`, 'err');
        closeConsole();
        api.open(p.id);
        break;
      }

      case 'cat': {
        const p = findProject(arg);

        if (!p) return print(`cat: ${arg || 'which project?'}: no such project`, 'err');
        print(`${p.title}  (#${p.num}${p.year ? ` · ${p.year}` : ''})`, 'strong');

        for (const [k, v] of [['role', p.role], ['studio', p.studio], ['platforms', p.platforms.join(', ')], ['tech', p.tech.join(', ')], ['tags', p.tags.map(catLabel).join(', ')]]) {
          print(`  ${k.padEnd(10)} ${v || '—'}`);
        }

        print(p.summary || '(no summary yet)', p.summary ? '' : 'dim');

        for (const l of p.links) print(`  ${l.label}: ${l.url}`);
        break;
      }

      case 'filter': {
        if (!arg || arg === 'all') {
          api.filter('all');

          return print(`showing all ${projects.length} projects`);
        }

        const cat = findCategory(arg);

        if (!cat) return print(`filter: no category '${arg}'`, 'err');
        api.filter(cat.id);
        print(`showing ${projects.filter((p) => p.tags.includes(cat.id)).length} ${cat.label.toLowerCase()} projects`);
        break;
      }

      case 'cd': {
        const target = SECTIONS[arg.replace(/^\/|\/$/g, '') || '~'];

        if (!target) return print(`cd: no such section: ${arg}`, 'err');
        closeConsole();
        api.goto(target);
        break;
      }

      case 'whoami': {
        const site = api.site();
        print('Daniel Stanciu', 'strong');

        if (site.tagline) print(site.tagline);

        if (site.about) print(site.about.split(/\n\s*\n/)[0]);
        break;
      }

      case 'contact': {
        const site = api.site();

        if (site.email) print(`  email     ${site.email}`);

        for (const l of site.links ?? []) print(`  ${l.label.toLowerCase().padEnd(9)} ${l.url}`);

        if (!site.email && !site.links?.length) print('No contact details yet.', 'dim');
        break;
      }

      case 'history':
        history.forEach((h, i) => print(`  ${String(i + 1).padStart(3)}  ${h}`));
        break;
      case 'clear':
        $('.console-out', con).replaceChildren();
        break;
      case 'exit':
      case 'quit':
        closeConsole();
        break;
      case 'sudo':
        print('Nice try. This incident will be reported.', 'err');
        break;
      case 'date':
        print(new Date().toString());
        break;
      case 'echo':
        print(arg);
        break;
      default:
        print(`${cmd}: command not found. Type 'help'.`, 'err');
    }
  }

  function findCategory(q) {
    const s = q.toLowerCase();

    return api.categories().find((c) => c.id === s || c.label.toLowerCase() === s || (c.short ?? '').toLowerCase() === s)
      ?? api.categories().find((c) => c.id.startsWith(s) || c.label.toLowerCase().startsWith(s));
  }

  function findProject(q) {
    if (!q) return null;
    const s = q.toLowerCase().trim();
    const projects = api.projects();

    return projects.find((p) => p.id === s || p.num === s.padStart(2, '0') || p.title.toLowerCase() === s)
      ?? projects
        .map((p) => ({ p, s: Math.max(score(p.title, s), score(p.id, s)) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)[0]?.p
      ?? null;
  }

  function complete(input) {
    const value = input.value;
    const parts = value.split(/\s+/);
    let options;

    if (parts.length <= 1) {
      options = Object.keys(COMMANDS);
    } else {
      const cmd = parts[0];
      options = {
        open: api.projects().map((p) => p.id),
        cat: api.projects().map((p) => p.id),
        ls: api.categories().map((c) => c.id),
        filter: ['all', ...api.categories().map((c) => c.id)],
        cd: ['work', 'about', '~'],
      }[cmd] ?? [];
    }

    const word = parts[parts.length - 1].toLowerCase();
    const matches = options.filter((o) => o.startsWith(word));

    if (!matches.length) return;
    let common = matches[0];

    for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
    parts[parts.length - 1] = matches.length === 1 ? `${matches[0]} ` : common;
    input.value = parts.join(' ');

    if (matches.length > 1) print(matches.join('  '), 'dim');
  }

  // ---- Year scrubber -------------------------------------------------------

  let scrubber;
  let scrubberVisible = false; // the project index is on screen

  function mountScrubber() {
    scrubber = document.createElement('nav');
    scrubber.className = 'scrubber mono';
    scrubber.setAttribute('aria-label', 'Jump to year');
    scrubber.innerHTML = '<ol></ol>';
    document.body.append(scrubber);

    scrubber.addEventListener('click', (e) => {
      const b = e.target.closest('[data-year]');

      if (!b) return;
      const year = b.dataset.year;
      const target = document.querySelector(`#projects .card[data-year="${year}"]`);

      if (!target) return;
      // On the way the highlight runs through the years in between (never
      // outside them), and lands on the clicked year once the scroll has
      // ended, or straight away if there's nowhere to scroll.
      const page = document.scrollingElement;
      const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      const to = Math.max(0, Math.min(page.scrollHeight - innerHeight, scrollY + target.getBoundingClientRect().top - margin));
      clearTimeout(clickedTimer);

      if (Math.abs(to - scrollY) < 1) {
        clickedYear = null;
        setYear(year);

        return;
      }

      clickedFrom = scrubber.querySelector('[aria-current]')?.dataset.year ?? null;
      clickedYear = year;
      // In case the scroll's end isn't reported
      clickedTimer = setTimeout(() => settleYear(), 2000);
      target.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    });
    window.addEventListener('scrollend', () => settleYear());

    // Scrolling by hand takes over from a click
    for (const type of ['wheel', 'touchstart', 'keydown']) {
      window.addEventListener(type, () => {
        if (clickedYear) settleYear(false);
      }, { passive: true });
    }

    // Only show it while the project index is on screen, and the filters are.
    new MutationObserver(showScrubber).observe($('#toolbar'), { attributes: true, attributeFilter: ['class'] });
    new IntersectionObserver(([entry]) => {
      scrubberVisible = entry.isIntersecting;
      showScrubber();
      markYear();
    }, { rootMargin: '0px 0px -30% 0px' }).observe($('#work'));

    // Keep it beside the content as the window or the card grid changes.
    let placing = 0;

    const replace = () => {
      cancelAnimationFrame(placing);
      placing = requestAnimationFrame(placeScrubber);
    };

    window.addEventListener('resize', replace);
    new ResizeObserver(replace).observe($('#work .section-head'));
    // The side column settles once the web fonts are in
    document.fonts?.ready.then(replace);
    placeScrubber();

    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking || !scrubberVisible) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        markYear();
      });
    }, { passive: true });
  }

  // Rebuild the years after the project index re-renders.
  function refresh() {
    if (!api || !scrubber) return;
    const years = [];

    for (const el of document.querySelectorAll('#projects .card:not([data-dup])[data-year]')) {
      const y = el.dataset.year;

      if (y && !years.includes(y)) years.push(y);
    }

    scrubber.style.setProperty('--years', years.length);
    $('ol', scrubber).innerHTML = years.length > 1
      ? years.map((y) => `<li><button type="button" data-year="${y}">${y}</button></li>`).join('')
      : '';
    showScrubber();
    markYear();
  }

  // It needs five free squares right of the content (the end of the Work
  // heading's line, which stops at the rightmost card), and sits with its
  // year labels three squares from the content. The first year is on the
  // row of the side column's Work link and the rest run down from there
  // (centred in the window if that link isn't shown).
  function placeScrubber() {
    const right = $('#work .section-head').getBoundingClientRect().right;
    const G = gridStep();
    const room = document.documentElement.clientWidth - right >= G * 5;
    scrubber.hidden = !room;

    if (!room) return;
    scrubber.style.left = `${right + G * 2}px`;
    const work = $('.side-nav a[data-section="work"]');
    const top = work?.offsetParent ? work.getBoundingClientRect().top : null;
    scrubber.style.top = top == null ? '' : `${top}px`;
    scrubber.style.transform = top == null ? '' : 'none';
  }

  // Shown while the project index is on screen, and not once the filters
  // have been hidden (About in place, see app.js)
  function showScrubber() {
    const filtersGone = $('#toolbar').classList.contains('is-gone');
    scrubber.classList.toggle('is-visible', scrubberVisible && !filtersGone && scrubber.querySelector('li') !== null);
  }

  // Highlight the year being read. Every year gets its own stretch of
  // scrolling, so none is skipped: each row of cards is current from when
  // it reaches the filters until the next row does, and that stretch is
  // shared between its cards in reading order. Near the end of the page,
  // where the last rows can't reach the filters, the remaining stretches
  // are squeezed into the scrolling that's left.
  function markYear() {
    let year = yearAt(scrollY);

    if (clickedYear && year) {
      // Mid-scroll after a click: only the years from the one lit when it was
      // clicked to the clicked one
      const years = [...scrubber.querySelectorAll('button')].map((b) => b.dataset.year);
      const a = years.indexOf(clickedFrom ?? clickedYear);
      const b = years.indexOf(clickedYear);
      const i = Math.min(Math.max(years.indexOf(year), Math.min(a, b)), Math.max(a, b));
      year = years[i];
    }

    setYear(year);
  }

  function yearAt(y) {
    const cards = [...document.querySelectorAll('#projects .card[data-year]')].filter((c) => c.dataset.year);

    if (!cards.length) return null;
    // Each row counts from where scrolling to it stops (an opened card stops
    // a square lower than the others, see .card.is-expanded's scroll margin)
    const rows = [];

    for (const card of cards) {
      const r = card.getBoundingClientRect();
      const row = rows.at(-1);

      if (row && Math.abs(row.top - (r.top + scrollY)) < 1) row.cards.push(card);
      else rows.push({ top: r.top + scrollY, bottom: r.bottom + scrollY, cards: [card], margin: parseFloat(getComputedStyle(card).scrollMarginTop) || 0 });
    }

    const marks = [];
    rows.forEach((row, i) => {
      const next = rows[i + 1];
      const from = row.top - row.margin;
      const to = next ? next.top - next.margin : row.bottom - row.margin;
      row.cards.forEach((card, j) => marks.push({ year: card.dataset.year, at: from + ((to - from) * j) / row.cards.length }));
    });
    const max = document.scrollingElement.scrollHeight - innerHeight;
    const last = marks.at(-1).at;
    const squeeze = Math.max(0, max - innerHeight / 2);

    if (last > max && last > squeeze) {
      for (const m of marks) if (m.at > squeeze) m.at = squeeze + ((m.at - squeeze) * (max - squeeze)) / (last - squeeze);
    }

    let year = marks[0].year;

    for (const m of marks) if (m.at <= y + 0.5) year = m.year;

    return year;
  }

  // A year clicked in the scrubber, waiting for its scroll to end
  let clickedYear = null;
  let clickedFrom = null;
  let clickedTimer = 0;

  function settleYear(keep = true) {
    if (!clickedYear) return;
    const year = clickedYear;
    clickedYear = null;
    clearTimeout(clickedTimer);

    if (keep === false) markYear();
    else setYear(year);
  }

  function setYear(year) {
    if (year == null) return;

    for (const b of scrubber.querySelectorAll('button')) b.toggleAttribute('aria-current', b.dataset.year === year);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  return { init, refresh, markYear: () => scrubber && markYear() };
})();
