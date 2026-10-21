// Stamps index.html's links to the stylesheet and scripts with a short hash of
// each file (styles.css?v=1a2b3c4d). Browsers may keep an old copy of a file
// for a while (GitHub Pages allows ten minutes, phones often longer); a new
// stamp makes them fetch the new one as soon as the page itself is new, so an
// update never mixes old and new files. The editor's Publish runs this; by
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
  let html = before;
  for (const name of ASSETS) {
    const hash = createHash('sha1').update(await readFile(path.join(root, name))).digest('hex').slice(0, 8);
    const link = new RegExp(`(["'])${name.replace('.', '\\.')}(?:\\?v=[0-9a-f]*)?\\1`, 'g');
    html = html.replace(link, `$1${name}?v=${hash}$1`);
  }
  if (html !== before) await writeFile(file, html);
  return html !== before;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log((await stampAssets(root)) ? 'index.html: links restamped' : 'index.html: links already up to date');
}
