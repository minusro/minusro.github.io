// Stamps index.html's links to the stylesheet and scripts with a short hash of
// each file (styles.css?v=1a2b3c4d). Browsers may keep an old copy of a file
// for a while (GitHub Pages allows ten minutes, phones often longer); a new
// stamp makes them fetch the new one as soon as the page itself is new, so an
// update never mixes old and new files. It also points the preload of the
// first project's cover at the right file. The editor's Publish runs this; by
// hand: npm run stamp

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ASSETS = ['styles.css', 'fx.js', 'nav.js', 'app.js'];

// Returns true if index.html changed.
export async function stampAssets(root) {
  const file = path.join(root, 'index.html');
  const before = await readFile(file, 'utf8');
  const content = JSON.parse(await readFile(path.join(root, 'content.json'), 'utf8'));
  let html = before;
  for (const name of ASSETS) {
    const hash = createHash('sha1').update(await readFile(path.join(root, name))).digest('hex').slice(0, 8);
    const link = new RegExp(`(["'])${name.replace('.', '\\.')}(?:\\?v=[0-9a-f]*)?\\1`, 'g');
    html = html.replace(link, `$1${name}?v=${hash}$1`);
  }
  html = html.replace(/<link rel="preload" href="[^"]*" as="image" fetchpriority="high" data-first-cover>/, () => {
    const cover = firstCover(content);
    return `<link rel="preload" href="${cover}" as="image" fetchpriority="high" data-first-cover>`;
  });
  if (html !== before) await writeFile(file, html);
  return html !== before;
}

// The cover of the project the site shows first: the newest visible one (ties
// go to the one later in content.json, undated ones last), as in app.js.
// Without a cover the preload points at nothing the page will ask for again,
// so it falls back to the favicon, which the page loads anyway.
function firstCover(content) {
  const SLUG = /^[a-z0-9][a-z0-9-]*$/;
  const MEDIA = /^media\/[\w.-]+$/i;
  const projects = (content.projects ?? [])
    .map((p, order) => ({ ...p, order }))
    .filter((p) => SLUG.test(p.id ?? '') && !p.hidden)
    .sort((a, b) => {
      const ay = a.year ?? null, by = b.year ?? null;
      if (ay !== by) {
        if (ay == null) return 1;
        if (by == null) return -1;
        return by - ay;
      }
      return b.order - a.order;
    });
  const cover = projects[0]?.cover;
  return MEDIA.test(cover ?? '') ? cover : 'favicon.svg';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log((await stampAssets(root)) ? 'index.html: links restamped' : 'index.html: links already up to date');
}
