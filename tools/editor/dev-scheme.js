// Auto / Light / Dark switch for previewing the site locally. The dev server
// (tools/server.mjs) adds this script to the page; it never reaches the live
// site. The choice is remembered in this browser.

(() => {
  'use strict';

  // Not inside the editor's preview pane
  if (window.self !== window.top) return;

  const KEY = 'portfolio-dev-scheme';
  const root = document.documentElement;
  let scheme = 'auto';
  try {
    scheme = localStorage.getItem(KEY) || 'auto';
  } catch {}

  const apply = () => {
    root.style.colorScheme = scheme === 'auto' ? '' : scheme;
  };
  apply();

  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .switch {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483000;
        display: flex; gap: 2px; padding: 3px;
        background: rgba(18, 18, 20, 0.88); border-radius: 9px;
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.3);
        font: 500 11px/1 system-ui, -apple-system, sans-serif;
      }
      button {
        all: unset; cursor: pointer; padding: 6px 9px; border-radius: 6px;
        color: rgba(255, 255, 255, 0.7);
      }
      button:hover { color: #fff; }
      button[aria-pressed="true"] { background: #fff; color: #111; }
      button:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 1px; }
    </style>
    <div class="switch" role="group" aria-label="Colour scheme (local preview only)">
      <button type="button" data-scheme="auto">Auto</button>
      <button type="button" data-scheme="light">Light</button>
      <button type="button" data-scheme="dark">Dark</button>
    </div>`;

  const render = () => {
    for (const b of shadow.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.scheme === scheme));
  };

  shadow.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    scheme = b.dataset.scheme;
    try {
      localStorage.setItem(KEY, scheme);
    } catch {}
    apply();
    render();
  });

  render();
  // Loaded in <head> so the scheme applies before first paint; the switch
  // itself goes in once the page body exists.
  if (document.body) document.body.append(host);
  else document.addEventListener('DOMContentLoaded', () => document.body.append(host));
})();
