// The OG-XOX installer page: takes Roland's 5.52 download (the .zip or the
// SP404MKII_APP1.bin in it), checks it, patches it in the browser and hands
// back the patched SP404MKII_APP1.bin. Nothing is uploaded.

import { checkBase, checkResult, applyPatches } from './patch.js?v=df7492aa6e';
import { PATCH_SET as set } from './patchset.js?v=96f064ac52';
import { isZip, listZip, extractZip, findEntry } from './unzip.js?v=f9f1c7631b';

const $ = (id) => document.getElementById(id);

// GoatCounter events (see index.html). count.js loads after the page and
// doesn't count on localhost; an event from before it has loaded waits for it
// (up to 15 s), and if it's blocked nothing is counted. Only what happened is
// sent, never the file.
function track(name, title = name, wait = 15000) {
  if (typeof window.goatcounter?.count !== 'function') {
    if (wait > 0) setTimeout(() => track(name, title, wait - 250), 250);
    return;
  }
  try {
    window.goatcounter.count({ path: `og-xox/${name}`, title: String(title).slice(0, 200), event: true });
  } catch { /* counting is best-effort */ }
}

// The Help tab is the same page, so count it when it's opened.
const trackHelp = () => location.hash === '#help' && track('help', 'Opened Help');
addEventListener('hashchange', trackHelp);
trackHelp();
const FILE = set.base.file; // the updater looks for this exact name
let input = null;

const version = set.id.replace(/^ogxox-/, '');
$('version').textContent = `OG-XOX ${version}`;
for (const p of set.patches) $('changes').append(Object.assign(document.createElement('li'), { textContent: p.name }));

function status(kind, text, hash) {
  const el = $('status');
  el.dataset.kind = kind;
  el.textContent = text;
  if (hash) el.append(Object.assign(document.createElement('span'), { className: 'hash', textContent: `SHA-256 ${hash}` }));
}

async function readChoice(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZip(bytes)) return bytes;
  const entry = findEntry(listZip(bytes), FILE);
  if (!entry) throw new Error(`There's no ${FILE} in this zip. Choose Roland's 5.52 download.`);
  return extractZip(bytes, entry);
}

async function choose(file) {
  input = null;
  $('patch').disabled = true;
  if (!file) return;
  $('drop-text').textContent = file.name;
  status('', 'Checking…');
  const kind = /\.zip$/i.test(file.name) ? 'zip' : 'bin';
  try {
    if (!window.isSecureContext || !crypto.subtle) throw new Error('This page has to be opened over https to check files.');
    const bytes = await readChoice(file);
    const r = await checkBase(bytes, set);
    if (!r.ok) {
      status('error', `This isn't Roland's 5.52 ${FILE}, so OG-XOX can't patch it. See Help if you're not sure which file to choose.`, r.hash);
      track(`file-refused-${kind}`, `Not 5.52 ${FILE} (${kind})`);
      return;
    }
    input = bytes;
    status('ok', `Roland's 5.52 ${FILE}. Ready to patch.`);
    $('patch').disabled = false;
    track(`file-ok-${kind}`, `5.52 ${FILE} chosen (${kind})`);
  } catch (err) {
    status('error', err.message);
    track(`file-error-${kind}`, err.message);
  }
}

$('file').addEventListener('change', () => choose($('file').files[0]));

const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  choose(e.dataTransfer.files[0]);
});

$('patch').addEventListener('click', async () => {
  if (!input) return;
  $('patch').disabled = true;
  try {
    const out = await applyPatches(input, set);
    const r = await checkResult(out, set);
    if (!r.ok) throw new Error(r.reason);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
    a.download = FILE;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status('ok', `Patched and checked. Your browser is saving ${FILE}: copy it to the SD card as below.`, r.hash);
    track(`patched-${version}`, `Patched and downloaded OG-XOX ${version}`);
  } catch (err) {
    status('error', `Patching stopped, nothing was saved: ${err.message}`);
    track(`patch-fail-${version}`, err.message);
  } finally {
    $('patch').disabled = !input;
  }
});
