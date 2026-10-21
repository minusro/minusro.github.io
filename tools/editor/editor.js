(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const SLUG = /^[a-z0-9][a-z0-9-]*$/;

  const els = {
    status: $('#status'),
    tabs: $('.tabs'),
    sidebar: $('#sidebar'),
    form: $('#form'),
    count: $('#project-count'),
    previewToggle: $('#preview-toggle'),
    previewPane: $('#preview-pane'),
    preview: $('#preview'),
    publishOpen: $('#publish-open'),
    publishDialog: $('#publish-dialog'),
    publishInfo: $('#publish-info'),
    publishMessage: $('#publish-message'),
    publishLog: $('#publish-log'),
    publishGo: $('#publish-go'),
    fileCover: $('#file-cover'),
    fileVideo: $('#file-video'),
  };

  const catStyle = document.head.appendChild(document.createElement('style'));
  const autoId = new WeakSet(); // new projects whose URL id still follows the title

  let content = null;
  let tab = 'projects';
  let selected = null;
  let dirty = false;
  let saving = null;
  let saveTimer = 0;
  let domain = '';

  init();

  async function init() {
    try {
      content = await api('GET', '/api/content');
    } catch (err) {
      setStatus('error', `Couldn’t load content: ${err.message}. Is the editor server running (npm run edit)?`);
      return;
    }
    content.site = { tagline: '', about: '', email: '', links: [], ...content.site };
    content.categories ??= [];
    content.projects = (content.projects ?? []).map((p) => ({ ...blankProject(), ...p }));
    selected = sortedProjects()[0] ?? null;

    applyCategoryColours();
    renderSidebar();
    renderForm();
    setStatus('saved', 'All changes saved');
    bind();
    initPreview();
  }

  // ---- Events --------------------------------------------------------------

  function bind() {
    els.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      tab = b.dataset.tab;
      renderSidebar();
      renderForm();
      reloadPreview();
    });

    els.sidebar.addEventListener('click', (e) => {
      const item = e.target.closest('.pitem');
      if (item) {
        selected = content.projects[Number(item.dataset.index)];
        renderSidebar();
        renderForm();
        els.form.scrollTop = 0;
        reloadPreview();
        return;
      }
      const a = e.target.closest('[data-action]');
      if (a) action(a);
    });

    els.form.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]');
      if (a) action(a);
    });
    els.form.addEventListener('input', onInput);
    els.form.addEventListener('change', onChange);

    // Drag and drop onto the media boxes
    els.form.addEventListener('dragover', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.add('is-over');
    });
    els.form.addEventListener('dragleave', (e) => e.target.closest('[data-drop]')?.classList.remove('is-over'));
    els.form.addEventListener('drop', (e) => {
      const zone = e.target.closest('[data-drop]');
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove('is-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(zone.dataset.drop, file);
    });
    // A file dropped anywhere else shouldn't make the browser navigate away.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    for (const [input, kind] of [[els.fileCover, 'cover'], [els.fileVideo, 'video']]) {
      input.addEventListener('change', () => {
        const file = input.files[0];
        input.value = '';
        if (file) handleFile(kind, file);
      });
    }

    els.previewToggle.addEventListener('change', () => setPreview(els.previewToggle.checked));
    els.publishOpen.addEventListener('click', openPublish);
    els.publishGo.addEventListener('click', runPublish);
    els.publishDialog.addEventListener('click', (e) => {
      if (e.target === els.publishDialog || e.target.closest('[data-close-modal]')) els.publishDialog.close();
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    });
    window.addEventListener('beforeunload', (e) => {
      if (dirty || saving) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset.field) {
      updateProject(selected, t.dataset.field, t.value);
    } else if (t.dataset.site) {
      content.site[t.dataset.site] = t.value;
    } else if (t.dataset.link) {
      linkList(t.dataset.link)[Number(t.dataset.index)][t.dataset.prop] = t.value.trim();
    } else if (t.dataset.catIndex && t.dataset.prop !== 'id') {
      content.categories[Number(t.dataset.catIndex)][t.dataset.prop] = t.value;
      if (t.dataset.prop === 'color') applyCategoryColours();
    } else {
      return;
    }
    changed();
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.flag) {
      selected[t.dataset.flag] = t.checked;
      renderSidebar();
      changed();
    } else if (t.dataset.tag) {
      const id = t.dataset.tag;
      const rest = selected.tags.filter((x) => x !== id);
      selected.tags = t.checked ? [...rest, id] : rest;
      $('.checks', els.form).innerHTML = checksHTML(selected);
      $(`[data-tag="${id}"]`, els.form)?.focus();
      renderSidebar();
      changed();
    } else if (t.dataset.catIndex && t.dataset.prop === 'id') {
      renameCategory(Number(t.dataset.catIndex), t);
    }
  }

  async function action(a) {
    switch (a.dataset.action) {
      case 'new-project': {
        const p = { ...blankProject(), title: 'New project' };
        p.id = uniqueId('new-project', p);
        autoId.add(p);
        content.projects.push(p);
        selected = p;
        renderSidebar();
        renderForm();
        changed();
        const title = $('[data-field="title"]', els.form);
        title.focus();
        title.select();
        break;
      }
      case 'delete-project': {
        if (!confirm(`Delete “${selected.title || 'Untitled'}”? Its cover and video files are deleted too.`)) return;
        content.projects.splice(content.projects.indexOf(selected), 1);
        selected = sortedProjects()[0] ?? null;
        renderSidebar();
        renderForm();
        changed();
        break;
      }
      case 'add-link':
        linkList(a.dataset.list).push({ label: '', url: '' });
        rerenderLinks(a.dataset.list, true);
        changed();
        break;
      case 'remove-link':
        linkList(a.dataset.list).splice(Number(a.dataset.index), 1);
        rerenderLinks(a.dataset.list);
        changed();
        break;
      case 'choose-cover':
        els.fileCover.click();
        break;
      case 'choose-video':
        els.fileVideo.click();
        break;
      case 'remove-cover':
      case 'remove-video':
        selected[a.dataset.action.slice('remove-'.length)] = '';
        rerenderMedia();
        changed();
        break;
      case 'add-cat': {
        let id = 'new-category';
        for (let i = 2; content.categories.some((c) => c.id === id); i++) id = `new-category-${i}`;
        content.categories.push({ id, label: 'New category', short: 'New', color: '#9aa0a6' });
        applyCategoryColours();
        rerenderCategories();
        changed();
        break;
      }
      case 'remove-cat': {
        const i = Number(a.dataset.index);
        const c = content.categories[i];
        const used = content.projects.filter((p) => p.tags.includes(c.id)).length;
        if (used && !confirm(`${used} project${used === 1 ? ' uses' : 's use'} “${c.label}”. Remove the category and untag ${used === 1 ? 'it' : 'them'}?`)) return;
        content.categories.splice(i, 1);
        for (const p of content.projects) p.tags = p.tags.filter((t) => t !== c.id);
        applyCategoryColours();
        rerenderCategories();
        renderSidebar();
        changed();
        break;
      }
      case 'move-cat': {
        const i = Number(a.dataset.index);
        const j = i + Number(a.dataset.dir);
        const cats = content.categories;
        [cats[i], cats[j]] = [cats[j], cats[i]];
        rerenderCategories();
        changed();
        break;
      }
    }
  }

  // ---- Project edits -------------------------------------------------------

  function updateProject(p, field, value) {
    switch (field) {
      case 'title':
        p.title = value;
        $('#form-title').textContent = value || 'Untitled';
        if (autoId.has(p)) {
          p.id = uniqueId(slugify(value) || 'project', p);
          $('[data-field="id"]', els.form).value = p.id;
          showIdState(p);
        }
        break;
      case 'id':
        autoId.delete(p);
        p.id = value.trim();
        showIdState(p);
        break;
      case 'year': {
        const n = parseInt(value, 10);
        p.year = Number.isFinite(n) ? n : null;
        break;
      }
      case 'platforms':
      case 'tech':
        p[field] = value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'mediaAlign':
        p.mediaAlign = Math.round(Math.max(-1, Math.min(1, Number(value) || 0)) * 100) / 100;
        $('#align-value', els.form).textContent = formatAlign(p.mediaAlign);
        $('#media-pickers', els.form).style.setProperty('--media-y', mediaY(p.mediaAlign));
        break;
      case 'url':
        p.url = value.trim();
        break;
      default:
        p[field] = value;
    }
    if (field === 'title' || field === 'id' || field === 'year') renderSidebar();
  }

  function showIdState(p) {
    const problem = !SLUG.test(p.id)
      ? 'Use lowercase letters, numbers and dashes.'
      : content.projects.some((x) => x !== p && x.id === p.id)
        ? 'Another project already uses this id.'
        : '';
    $('[data-field="id"]', els.form).setAttribute('aria-invalid', String(Boolean(problem)));
    $('#id-error').textContent = problem;
    $('#id-preview').textContent = p.id;
  }

  function renameCategory(i, input) {
    const c = content.categories[i];
    const next = input.value.trim();
    if (next === c.id) return;
    if (!SLUG.test(next) || content.categories.some((x, j) => j !== i && x.id === next)) {
      alert('Category ids must be unique and use only lowercase letters, numbers and dashes.');
      input.value = c.id;
      return;
    }
    for (const p of content.projects) p.tags = p.tags.map((t) => (t === c.id ? next : t));
    c.id = next;
    applyCategoryColours();
    rerenderCategories();
    renderSidebar();
    changed();
  }

  // ---- Media ---------------------------------------------------------------

  async function handleFile(kind, file) {
    const p = selected;
    if (!p) return;
    try {
      let blob = file;
      let ext;
      if (kind === 'cover') {
        if (!file.type.startsWith('image/')) throw new Error('That file isn’t an image.');
        ({ blob, ext } = await prepareImage(file));
      } else {
        if (!/^(video\/(mp4|webm)|image\/gif)$/.test(file.type)) throw new Error('Use an MP4 or WebM video, or an animated GIF.');
        const mb = file.size / 1024 / 1024;
        if (mb > 95) throw new Error(`That video is ${mb.toFixed(0)} MB; GitHub only accepts files under 100 MB.`);
        if (mb > 25 && !confirm(`This video is ${mb.toFixed(0)} MB. Big videos make the site slow to load. Use it anyway?`)) return;
        ext = { 'video/webm': 'webm', 'image/gif': 'gif' }[file.type] ?? 'mp4';
      }

      setStatus('saving', `Uploading ${kind}…`);
      const base = SLUG.test(p.id) ? p.id : 'project';
      const res = await fetch(`/api/upload?name=${encodeURIComponent(`${base}-${kind}.${ext}`)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

      p[kind] = data.path;
      if (p === selected && tab === 'projects') rerenderMedia();
      changed();
      await save();
    } catch (err) {
      setStatus('error', err.message);
    }
  }

  // Shrink big images to 1600px wide WebP (JPEG where WebP encoding isn't available).
  // GIFs pass through untouched so animation survives.
  async function prepareImage(file) {
    if (file.type === 'image/gif') return { blob: file, ext: 'gif' };
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('This browser can’t read that image. Try a JPEG, PNG or WebP.');
    }
    const scale = Math.min(1, 1600 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    const webp = await encode('image/webp', 0.85);
    if (webp?.type === 'image/webp') return { blob: webp, ext: 'webp' };
    return { blob: await encode('image/jpeg', 0.88), ext: 'jpg' };
  }

  // ---- Saving --------------------------------------------------------------

  function changed() {
    dirty = true;
    setStatus('dirty', 'Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  }

  // Resolves true once everything is on disk, false if the save was rejected.
  async function save() {
    clearTimeout(saveTimer);
    while (saving) await saving;
    if (!dirty) return true;
    dirty = false;
    setStatus('saving', 'Saving…');
    saving = api('PUT', '/api/content', content)
      .then(() => {
        if (!dirty) setStatus('saved', 'All changes saved');
        reloadPreview();
        return true;
      })
      .catch((err) => {
        dirty = true;
        setStatus('error', err.message);
        return false;
      })
      .finally(() => {
        saving = null;
      });
    return saving;
  }

  // ---- Rendering -----------------------------------------------------------

  function renderSidebar() {
    els.count.textContent = content.projects.length;
    for (const b of els.tabs.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));

    if (tab === 'site') {
      els.sidebar.innerHTML = `
        <ul class="toc">
          <li><a href="#sec-intro">Intro</a></li>
          <li><a href="#sec-about">About</a></li>
          <li><a href="#sec-contact">Contact</a></li>
          <li><a href="#sec-categories">Categories</a></li>
        </ul>`;
      return;
    }

    els.sidebar.innerHTML = `
      <button type="button" class="btn btn-block" data-action="new-project">+ New project</button>
      <ul class="plist">
        ${sortedProjects().map((p) => `
          <li>
            <button type="button" class="pitem${p.hidden ? ' is-hidden' : ''}" data-index="${content.projects.indexOf(p)}"${p === selected ? ' aria-current="true"' : ''}>
              <span class="pitem-year">${p.year ?? '—'}</span>
              <span class="pitem-title">${esc(p.title || 'Untitled')}${p.hidden ? ' <span class="pitem-hidden">hidden</span>' : ''}</span>
              <span class="pitem-dots">${p.tags.map((t) => `<span class="dot" data-cat="${esc(t)}"></span>`).join('')}</span>
            </button>
          </li>`).join('')}
      </ul>`;
  }

  function renderForm() {
    if (tab === 'site') return renderSiteForm();
    const p = selected;
    if (!p) {
      els.form.innerHTML = '<p class="empty">No projects yet. Click “+ New project” to add one.</p>';
      return;
    }

    els.form.innerHTML = `
      <form class="form" autocomplete="off" onsubmit="return false">
        <div class="form-head">
          <h1 id="form-title">${esc(p.title || 'Untitled')}</h1>
          <button type="button" class="btn btn-small btn-danger" data-action="delete-project">Delete project</button>
        </div>

        <label class="field">
          <span class="label">Title</span>
          <input type="text" data-field="title" value="${esc(p.title)}">
        </label>

        <div class="row">
          <label class="field">
            <span class="label">URL id</span>
            <input type="text" data-field="id" value="${esc(p.id)}" spellcheck="false">
            <span class="hint">Project link: <code>/#/<span id="id-preview">${esc(p.id)}</span></code></span>
            <span class="error-text" id="id-error"></span>
          </label>
          <label class="field">
            <span class="label">Year</span>
            <input type="number" data-field="year" value="${p.year ?? ''}" min="1950" max="2100" placeholder="e.g. 2019">
            <span class="hint">Sets the order on the site. Leave empty if unsure.</span>
          </label>
        </div>

        <div class="field">
          <span class="label">Categories</span>
          <div class="checks">${checksHTML(p)}</div>
          <span class="hint">The first one ticked sets the project’s colour.</span>
        </div>

        <label class="check-row">
          <input type="checkbox" data-flag="hidden"${p.hidden ? ' checked' : ''}>
          Hide this project
          <span class="hint">It stays here in the editor but doesn’t appear anywhere on the site, and the project numbers skip it.</span>
        </label>

        <div class="row">
          <label class="field">
            <span class="label">Your role</span>
            <input type="text" data-field="role" value="${esc(p.role)}" placeholder="e.g. Lead programmer">
          </label>
          <label class="field">
            <span class="label">Studio / client</span>
            <input type="text" data-field="studio" value="${esc(p.studio)}">
          </label>
        </div>

        <label class="check-row">
          <input type="checkbox" data-flag="personal"${p.personal ? ' checked' : ''}>
          Personal project
          <span class="hint">The site says “Personal project” where the studio would go (the studio above is ignored).</span>
        </label>

        <label class="field">
          <span class="label">Project page</span>
          <input type="url" data-field="url" value="${esc(p.url)}" placeholder="https://…" spellcheck="false">
          <span class="hint">For a personal project: “Personal project” on the site links here (opens in a new tab). Leave empty for no link.</span>
        </label>

        <div class="row">
          <label class="field">
            <span class="label">Platforms</span>
            <input type="text" data-field="platforms" value="${esc(p.platforms.join(', '))}" placeholder="iOS, Android">
            <span class="hint">Separate with commas.</span>
          </label>
          <label class="field">
            <span class="label">Tech</span>
            <input type="text" data-field="tech" value="${esc(p.tech.join(', '))}" placeholder="Unity, C#">
            <span class="hint">Separate with commas.</span>
          </label>
        </div>

        <label class="field">
          <span class="label">Summary</span>
          <textarea data-field="summary" rows="7" placeholder="What it is, what you built, the interesting technical problem, and the outcome.">${esc(p.summary)}</textarea>
          <span class="hint">Leave a blank line between paragraphs.</span>
        </label>

        <h2>Media</h2>
        <div id="media-pickers" style="--media-y: ${mediaY(p.mediaAlign)}">${mediaPicker(p, 'cover')}${mediaPicker(p, 'video')}</div>

        <label class="field">
          <span class="label">Vertical alignment <output class="align-value" id="align-value">${formatAlign(p.mediaAlign)}</output></span>
          <input type="range" class="align-slider" data-field="mediaAlign" min="-1" max="1" step="0.05" value="${p.mediaAlign}">
          <span class="align-scale" aria-hidden="true"><span>Bottom</span><span>Centre</span><span>Top</span></span>
          <span class="hint">Which part of the cover and video stays in view when they’re cropped to fit the card: −1 keeps the bottom, 0 the middle, 1 the top. The previews above follow it.</span>
        </label>

        <h2>Links</h2>
        ${linkRows(p.links, 'links')}
      </form>`;
    showIdState(p);
  }

  function renderSiteForm() {
    const s = content.site;
    els.form.innerHTML = `
      <form class="form" autocomplete="off" onsubmit="return false">
        <div class="form-head"><h1>Site &amp; categories</h1></div>

        <h2 id="sec-intro">Intro</h2>
        <label class="field">
          <span class="label">Tagline</span>
          <input type="text" data-site="tagline" value="${esc(s.tagline)}">
          <span class="hint">Shown under your name at the top of the page.</span>
        </label>

        <h2 id="sec-about">About</h2>
        <label class="field">
          <span class="label">Bio</span>
          <textarea data-site="about" rows="9">${esc(s.about)}</textarea>
          <span class="hint">Leave a blank line between paragraphs. The first paragraph is shown brighter.</span>
        </label>

        <h2 id="sec-contact">Contact</h2>
        <label class="field">
          <span class="label">Email</span>
          <input type="email" data-site="email" value="${esc(s.email)}" placeholder="you@example.com">
          <span class="hint">Shown large in the Contact section. Leave empty to hide it.</span>
        </label>
        <div class="field">
          <span class="label">Links</span>
          ${linkRows(s.links, 'site-links')}
        </div>

        <h2 id="sec-categories">Categories</h2>
        <div class="rows" id="cat-rows">${categoryRows()}</div>
      </form>`;
  }

  function checksHTML(p) {
    return content.categories
      .map((c) => {
        const i = p.tags.indexOf(c.id);
        const order = i >= 0 && p.tags.length > 1 ? `<span class="check-order">${i + 1}</span>` : '';
        return `<label class="check" data-cat="${esc(c.id)}"><input type="checkbox" data-tag="${esc(c.id)}"${i >= 0 ? ' checked' : ''}>${esc(c.label)}${order}</label>`;
      })
      .join('');
  }

  function mediaPicker(p, kind) {
    const isVideo = kind === 'video';
    const value = p[kind];
    const src = /^https?:/.test(value) ? value : `/${value}`;
    const shown = value
      ? isVideo && !/\.gif$/i.test(value)
        ? `<video src="${esc(src)}" muted loop autoplay playsinline></video>`
        : `<img src="${esc(src)}" alt="">`
      : isVideo
        ? 'Drop a video here<br>MP4, WebM or GIF'
        : 'Drop an image here';
    return `
      <div class="field">
        <span class="label">${isVideo ? 'Hover video (optional)' : 'Cover image'}</span>
        <div class="media-pick">
          <div class="drop" data-drop="${kind}">${shown}</div>
          <div class="media-actions">
            <button type="button" class="btn btn-small" data-action="choose-${kind}">${value ? 'Replace…' : 'Choose file…'}</button>
            ${value ? `<button type="button" class="btn btn-small btn-danger" data-action="remove-${kind}">Remove</button><span class="media-path">${esc(value)}</span>` : ''}
            <span class="hint">${isVideo
              ? 'A short, silent loop (5–15 s), or an animated GIF. It plays when someone hovers the project. Aim for under 10 MB.'
              : 'Resized to 1600px wide and saved as WebP. GIFs are kept as they are.'}</span>
          </div>
        </div>
      </div>`;
  }

  // Vertical alignment: 1 shows the top of the media, 0 the middle, -1 the
  // bottom (the same mapping as the site's object-position)
  function mediaY(align) {
    return `${(1 - align) * 50}%`;
  }

  function formatAlign(align) {
    return (align > 0 ? '+' : '') + align.toFixed(2);
  }

  function linkRows(links, key) {
    return `
      <div class="rows" data-rows="${key}">
        ${links.map((l, i) => `
          <div class="link-row">
            <input type="text" data-link="${key}" data-index="${i}" data-prop="label" value="${esc(l.label)}" placeholder="Label, e.g. App Store">
            <input type="url" data-link="${key}" data-index="${i}" data-prop="url" value="${esc(l.url)}" placeholder="https://…">
            <button type="button" class="btn btn-icon" data-action="remove-link" data-list="${key}" data-index="${i}" aria-label="Remove link">✕</button>
          </div>`).join('')}
        <div><button type="button" class="btn btn-small" data-action="add-link" data-list="${key}">+ Add link</button></div>
      </div>`;
  }

  function categoryRows() {
    const last = content.categories.length - 1;
    return `
      <div class="cat-row cat-head"><span>Colour</span><span>Label</span><span>Short</span><span>Id</span><span></span><span></span><span></span></div>
      ${content.categories.map((c, i) => `
        <div class="cat-row">
          <input type="color" data-cat-index="${i}" data-prop="color" value="${esc(c.color)}" aria-label="${esc(c.label)} colour">
          <input type="text" data-cat-index="${i}" data-prop="label" value="${esc(c.label)}" aria-label="Label">
          <input type="text" data-cat-index="${i}" data-prop="short" value="${esc(c.short ?? '')}" aria-label="Short label">
          <input type="text" data-cat-index="${i}" data-prop="id" value="${esc(c.id)}" aria-label="Id" spellcheck="false">
          <button type="button" class="btn btn-icon" data-action="move-cat" data-index="${i}" data-dir="-1" aria-label="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="btn btn-icon" data-action="move-cat" data-index="${i}" data-dir="1" aria-label="Move down"${i === last ? ' disabled' : ''}>↓</button>
          <button type="button" class="btn btn-icon btn-danger" data-action="remove-cat" data-index="${i}" aria-label="Remove category">✕</button>
        </div>`).join('')}
      <div><button type="button" class="btn btn-small" data-action="add-cat">+ Add category</button></div>
      <span class="hint">“Short” is the text on the small tags. This order is the order of the filter buttons on the site. Renaming an id updates every project that uses it.</span>`;
  }

  function rerenderLinks(key, focusNew = false) {
    const box = $(`[data-rows="${key}"]`, els.form);
    box.outerHTML = linkRows(linkList(key), key);
    if (focusNew) [...els.form.querySelectorAll(`[data-link="${key}"][data-prop="label"]`)].pop()?.focus();
  }

  function rerenderMedia() {
    $('#media-pickers', els.form).innerHTML = mediaPicker(selected, 'cover') + mediaPicker(selected, 'video');
  }

  function rerenderCategories() {
    $('#cat-rows', els.form).innerHTML = categoryRows();
  }

  function applyCategoryColours() {
    catStyle.textContent = content.categories
      .filter((c) => SLUG.test(c.id) && /^#[0-9a-f]{6}$/i.test(c.color))
      .map((c) => `[data-cat="${c.id}"] { --c: ${c.color}; }`)
      .join('\n');
  }

  // ---- Preview -------------------------------------------------------------

  function initPreview() {
    let on = false;
    try {
      on = localStorage.getItem('portfolio-editor-preview') === '1';
    } catch {}
    els.previewToggle.checked = on;
    setPreview(on);
  }

  function setPreview(on) {
    els.previewPane.hidden = !on;
    try {
      localStorage.setItem('portfolio-editor-preview', on ? '1' : '0');
    } catch {}
    reloadPreview();
  }

  function reloadPreview() {
    if (els.previewPane.hidden) return;
    const hash =
      tab === 'site' ? '#about'
      : selected && SLUG.test(selected.id) ? `#/${selected.id}`
      : '';
    els.preview.src = `/?v=${Date.now()}${hash}`;
  }

  // ---- Publishing ----------------------------------------------------------

  async function openPublish() {
    els.publishLog.hidden = true;
    els.publishLog.textContent = '';
    els.publishGo.disabled = true;
    els.publishInfo.innerHTML = '<p>Saving and checking for changes…</p>';
    els.publishDialog.showModal();

    if (!(await save())) {
      els.publishInfo.innerHTML = `<p class="result-error">Your last edit couldn’t be saved: ${esc(els.status.textContent)}. Fix that first.</p>`;
      return;
    }

    try {
      const s = await api('GET', '/api/status');
      domain = s.domain;
      const notOnGitHub = s.unpushed === null;
      const nothing = s.changes.length === 0 && s.unpushed === 0;
      els.publishInfo.innerHTML = `
        ${s.branch !== s.liveBranch
          ? `<p class="warn">You’re on the <b>${esc(s.branch)}</b> branch. The live site only updates from <b>${esc(s.liveBranch)}</b>, so publishing backs your work up to GitHub without changing ${esc(domain || 'the live site')}.</p>`
          : ''}
        ${nothing
          ? '<p>Everything is already published.</p>'
          : s.changes.length
            ? `<p>${s.changes.length} changed file${s.changes.length === 1 ? '' : 's'}:</p><ul>${s.changes.map((c) => `<li>${esc(describeChange(c))}</li>`).join('')}</ul>`
            : `<p>${notOnGitHub ? 'This branch isn’t on GitHub yet.' : 'No new edits, but there are saved commits to send.'}</p>`}`;
      els.publishGo.disabled = nothing;
      els.publishMessage.focus();
      els.publishMessage.select();
    } catch (err) {
      els.publishInfo.innerHTML = `<p class="result-error">${esc(err.message)}</p>`;
    }
  }

  async function runPublish() {
    els.publishGo.disabled = true;
    els.publishGo.textContent = 'Publishing…';
    els.publishLog.hidden = false;
    els.publishLog.textContent = '';
    try {
      const r = await api('POST', '/api/publish', { message: els.publishMessage.value });
      els.publishLog.textContent = r.log.join('\n');
      els.publishInfo.innerHTML = !r.ok
        ? '<p class="result-error">Publishing failed; the details are below. Nothing on GitHub was changed.</p>'
        : r.live
          ? `<p class="result-ok">Published. ${esc(domain || 'The live site')} usually updates within a minute.</p>`
          : `<p class="result-ok">Pushed to the ${esc(r.branch)} branch on GitHub.</p>`;
    } catch (err) {
      els.publishInfo.innerHTML = `<p class="result-error">${esc(err.message)}</p>`;
    } finally {
      els.publishGo.textContent = 'Publish';
    }
  }

  function describeChange(line) {
    const code = line.slice(0, 2).replace(/\s/g, '')[0];
    const label = { '?': 'new', A: 'new', M: 'edited', D: 'deleted', R: 'renamed' }[code] ?? 'changed';
    return `${label.padEnd(8)} ${line.slice(3)}`;
  }

  // ---- Helpers -------------------------------------------------------------

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  function setStatus(state, text) {
    els.status.dataset.state = state;
    els.status.textContent = text;
  }

  function blankProject() {
    return { id: '', title: '', year: null, tags: [], hidden: false, personal: false, url: '', role: '', studio: '', platforms: [], tech: [], summary: '', links: [], cover: '', video: '', mediaAlign: 0 };
  }

  // Same order as the site: newest first, undated last, ties keep file order.
  function sortedProjects() {
    return content.projects
      .map((p, i) => [p, i])
      .sort(([a, i], [b, j]) => {
        if (a.year !== b.year) {
          if (a.year == null) return 1;
          if (b.year == null) return -1;
          return b.year - a.year;
        }
        return i - j;
      })
      .map(([p]) => p);
  }

  function linkList(key) {
    return key === 'site-links' ? content.site.links : selected.links;
  }

  function uniqueId(base, self) {
    let id = base;
    for (let i = 2; content.projects.some((p) => p !== self && p.id === id); i++) id = `${base}-${i}`;
    return id;
  }

  function slugify(s) {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();
