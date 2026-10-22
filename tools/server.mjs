#!/usr/bin/env node
// Local preview + content editor for the portfolio. No dependencies.
//
//   npm run edit    open the editor  (http://localhost:4000/editor/)
//   npm run dev     open the site    (http://localhost:4000/)
//
// The editor saves to content.json and media/, and "Publish" commits and
// pushes the repo to GitHub. The server only listens on this machine.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stampAssets } from './stamp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDITOR_DIR = path.join(ROOT, 'tools', 'editor');
const CONTENT_FILE = path.join(ROOT, 'content.json');
const MEDIA_DIR = path.join(ROOT, 'media');
const PORT = Number(process.env.PORT) || 4000;
const LIVE_BRANCH = 'main'; // GitHub Pages publishes from this branch
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const MEDIA_PATH = /^media\/[a-z0-9][a-z0-9._-]*$/;
const MEDIA_EXTS = new Set(['.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '.mp4', '.webm']);
const MAX_UPLOAD = 100 * 1024 * 1024; // GitHub rejects files over 100 MB

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const exec = promisify(execFile);

const server = http.createServer(async (req, res) => {
  try {
    // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
    if (!ALLOWED_HOSTS.has(req.headers.host)) return sendText(res, 403, 'Forbidden');
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      // Stop other websites open in your browser from calling the API.
      const origin = req.headers.origin;

      if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))) return sendText(res, 403, 'Forbidden');

      return await handleApi(req, res, url);
    }

    if (url.pathname === '/editor') return redirect(res, '/editor/');

    if (url.pathname.startsWith('/editor/')) return await serveFile(req, res, EDITOR_DIR, url.pathname.slice('/editor/'.length));

    return await serveFile(req, res, ROOT, url.pathname.slice(1));
  } catch (err) {
    console.error(err);

    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

// ---- API ---------------------------------------------------------------------

async function handleApi(req, res, url) {
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/content':
      return sendJson(res, 200, JSON.parse(await readFile(CONTENT_FILE, 'utf8')));

    case 'PUT /api/content': {
      let next;

      try {
        next = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'Content is not valid JSON' });
      }

      const problem = validate(next);

      if (problem) return sendJson(res, 400, { error: problem });

      const prev = await readFile(CONTENT_FILE, 'utf8').then(JSON.parse).catch(() => null);
      await writeAtomic(CONTENT_FILE, `${JSON.stringify(next, null, 2)}\n`);

      if (prev) await deleteDroppedMedia(prev, next);

      return sendJson(res, 200, { ok: true });
    }

    case 'POST /api/upload': {
      const requested = (url.searchParams.get('name') || '').toLowerCase();
      const ext = path.extname(requested);

      if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(requested) || !MEDIA_EXTS.has(ext)) {
        return sendJson(res, 400, { error: `Unsupported file. Use one of: ${[...MEDIA_EXTS].join(' ')}` });
      }

      const data = await readBody(req, MAX_UPLOAD);
      await mkdir(MEDIA_DIR, { recursive: true });
      const name = await freeName(requested);
      await writeFile(path.join(MEDIA_DIR, name), data);

      return sendJson(res, 200, { path: `media/${name}`, bytes: data.length });
    }

    case 'GET /api/status':
      return sendJson(res, 200, await gitStatus());

    case 'POST /api/publish': {
      let message = '';

      try {
        message = String(JSON.parse((await readBody(req, 10_000)).toString('utf8')).message ?? '');
      } catch {}

      return sendJson(res, 200, await publish(message.trim() || 'Update portfolio content'));
    }

    default:
      return sendJson(res, 404, { error: 'Unknown endpoint' });
  }
}

function validate(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'Content must be an object';

  if (!c.site || typeof c.site !== 'object') return 'Missing "site" section';

  if (!Array.isArray(c.categories)) return 'Missing "categories" list';

  if (!Array.isArray(c.projects)) return 'Missing "projects" list';

  const catIds = new Set();

  for (const k of c.categories) {
    if (!SLUG.test(k?.id ?? '')) return `Category id "${k?.id ?? ''}" must use lowercase letters, numbers and dashes`;

    if (catIds.has(k.id)) return `Two categories share the id "${k.id}"`;

    if (!/^#[0-9a-f]{6}$/i.test(k.color ?? '')) return `Category "${k.id}" needs a colour like #ff7a45`;

    if (!String(k.label ?? '').trim()) return `Category "${k.id}" needs a label`;
    catIds.add(k.id);
  }

  const ids = new Set();

  for (const p of c.projects) {
    const name = p?.title || p?.id || '(untitled)';

    if (!SLUG.test(p?.id ?? '')) return `"${name}": the URL id must use lowercase letters, numbers and dashes`;

    if (ids.has(p.id)) return `Two projects share the URL id "${p.id}"`;
    ids.add(p.id);

    if (!String(p.title ?? '').trim()) return `Project "${p.id}" needs a title`;

    if (p.year != null && !(Number.isInteger(p.year) && p.year > 1900 && p.year < 2200)) return `"${name}": year must be a number like 2019`;

    if (!Array.isArray(p.tags) || p.tags.some((t) => !catIds.has(t))) return `"${name}" has a tag that isn't a category`;

    if (p.personal != null && typeof p.personal !== 'boolean') return `"${name}": "personal" must be true or false`;

    if (p.url != null && typeof p.url !== 'string') return `"${name}": the project page must be a web address`;

    if (p.mediaAlign != null && !(typeof p.mediaAlign === 'number' && p.mediaAlign >= -1 && p.mediaAlign <= 1)) return `"${name}": vertical alignment must be between -1 and 1`;

    for (const key of ['cover', 'video']) {
      if (p[key] && !MEDIA_PATH.test(p[key]) && !/^https?:\/\/\S+$/.test(p[key])) return `"${name}": ${key} must be a file in media/ or a web address`;
    }
  }

  return null;
}

// When a cover or video is replaced or removed, delete the old file so media/
// doesn't fill up with orphans. Only files the old content pointed at are touched.
async function deleteDroppedMedia(prev, next) {
  const used = (c) =>
    new Set((c.projects ?? []).flatMap((p) => [p.cover, p.video]).filter((v) => MEDIA_PATH.test(v ?? '')));

  const keep = used(next);

  for (const file of used(prev)) {
    if (!keep.has(file)) await unlink(path.join(ROOT, file)).catch(() => {});
  }
}

async function freeName(name) {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);

  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${base}-${i}${ext}`;

    try {
      await stat(path.join(MEDIA_DIR, candidate));
    } catch {
      return candidate;
    }
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

// ---- Git -----------------------------------------------------------------------

async function git(...args) {
  const { stdout, stderr } = await exec('git', args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });

  return [stdout, stderr].map((s) => s.trim()).filter(Boolean).join('\n');
}

async function gitStatus() {
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const changes = (await exec('git', ['status', '--porcelain'], { cwd: ROOT })).stdout.split('\n').filter(Boolean);
  let unpushed = null; // null = branch has never been pushed

  try {
    unpushed = Number(await git('rev-list', '--count', '@{u}..HEAD'));
  } catch {}

  const domain = (await readFile(path.join(ROOT, 'CNAME'), 'utf8').catch(() => '')).trim();

  return { branch, liveBranch: LIVE_BRANCH, domain, changes, unpushed, lastCommit: await git('log', '-1', '--format=%h %s (%cr)') };
}

async function publish(message) {
  const log = [];

  const run = async (...args) => {
    log.push(`$ git ${args.join(' ')}`);

    try {
      const out = await git(...args);

      if (out) log.push(out);

      return out;
    } catch (err) {
      log.push((err.stderr || err.stdout || err.message).trim());
      throw err;
    }
  };

  try {
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');

    if (await stampAssets(ROOT)) log.push('Stamped the stylesheet and script links in index.html with their new versions.');
    await run('add', '-A');
    const staged = await git('diff', '--cached', '--name-only');

    if (staged) await run('commit', '-m', message);
    else log.push('Nothing new to commit.');

    try {
      await run('push', '-u', 'origin', branch);
    } catch {
      // Usually means GitHub has commits this copy doesn't (e.g. edited on github.com).
      log.push('Push was rejected, so fetching the changes on GitHub first…');

      try {
        await run('pull', '--rebase', 'origin', branch);
      } catch (err) {
        await git('rebase', '--abort').catch(() => {});
        throw err;
      }

      await run('push', '-u', 'origin', branch);
    }

    return { ok: true, branch, live: branch === LIVE_BRANCH, log };
  } catch {
    return { ok: false, log };
  }
}

// ---- Static files --------------------------------------------------------------

async function serveFile(req, res, base, rel) {
  rel = decodeURIComponent(rel);

  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const parts = rel.split('/');

  // Never serve dotfiles (.git), dependencies, or the tooling itself from the site root.
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return sendText(res, 404, 'Not found');

  if (base === ROOT && parts[0] === 'tools') return sendText(res, 404, 'Not found');

  const file = path.resolve(base, rel);

  if (!file.startsWith(base + path.sep)) return sendText(res, 404, 'Not found');

  let info;

  try {
    info = await stat(file);
  } catch {
    return sendText(res, 404, 'Not found');
  }

  if (info.isDirectory()) return redirect(res, `/${path.relative(ROOT, file)}/`);

  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };

  // Local previews of the site get a light/dark/auto switch. It's added here,
  // not in index.html, so it never reaches the live site.
  if (file === path.join(ROOT, 'index.html')) {
    const html = (await readFile(file, 'utf8')).replace('</head>', '  <script src="/editor/dev-scheme.js"></script>\n</head>');
    res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(html) });

    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  // Range requests, so videos can stream and seek (Safari insists on this).
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');

  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, info.size - 1);

    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });

      return res.end();
    }

    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });

    return createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': info.size });

  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// ---- Helpers -------------------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > limit) {
        reject(new Error(`Upload is larger than ${Math.round(limit / 1024 / 1024)} MB`));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];

  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// ---- Start ---------------------------------------------------------------------

const openArg = process.argv.find((a) => a.startsWith('--open='))?.split('=')[1] ?? 'none';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is the editor already running? Or try: PORT=4001 npm run edit`);
  } else {
    console.error(err);
  }

  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n  Portfolio running locally\n\n  Editor  ${base}/editor/\n  Site    ${base}/\n\n  Press Ctrl+C to stop.\n`);

  if (openArg === 'editor') openBrowser(`${base}/editor/`);

  if (openArg === 'site') openBrowser(`${base}/`);
});
