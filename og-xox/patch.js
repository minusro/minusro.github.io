// Byte patching for the installer. Pure functions so they run the same in the
// browser and in node.
//
// A patch set is data:
//   {
//     id, description,
//     base:   { version, file, sha256 },   the stock file it applies to
//     result: { sha256 },                  what applying it must produce
//     patches: [ op, … ],                  applied in order
//   }
//
// Ops:
//   { name, offset, expect | expectSha256, replace }      overwrite bytes in place
//   { name, op: 'append', label, align, data }             add bytes at the end of the file
//   { name, op: 'scatter-add', load: label, exec, size }   make the boot loader copy an
//                                                          appended block into RAM
//
// expectSha256 lets a patch check bytes it replaces without the patch set
// carrying Roland's bytes.

export const FLASH_BASE = 0x60080000;

export const hexToBytes = (hex) => {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error(`bad hex: ${hex.slice(0, 40)}`);
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
};

export const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('Web Crypto is not available (the page must be served over https or localhost)');
  return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
}

/** Checks a file against a patch set's base. Returns { ok, hash, reason }. */
export async function checkBase(bytes, patchSet, subtle) {
  const hash = await sha256(bytes, subtle);
  const want = patchSet.base.sha256;
  if (!want) return { ok: true, hash, reason: 'No reference hash recorded yet; record this one from a known-good 5.52 file.' };
  if (hash !== want.toLowerCase()) return { ok: false, hash, reason: `This is not the ${patchSet.base.version} file OG-XOX expects.` };
  return { ok: true, hash, reason: `Matches ${patchSet.base.version}.` };
}

/** Checks a patched file against the patch set's recorded result hash, if any. */
export async function checkResult(bytes, patchSet, subtle) {
  const hash = await sha256(bytes, subtle);
  const want = patchSet.result?.sha256;
  if (!want) return { ok: true, hash, reason: 'No result hash recorded yet.' };
  if (hash !== want.toLowerCase()) return { ok: false, hash, reason: 'The patched file is not what this patch set should produce.' };
  return { ok: true, hash, reason: 'Patched file verified.' };
}

// --- Arm scatter-load table ------------------------------------------------

const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put32 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
};

/**
 * Finds Arm's __scatterload stub (`adr r0, ptrs; ldm r0, {r10, r11};
 * add r10, r0; add r11, r0`) and returns where its two table offsets live and
 * the table's rows ({ load, exec, size, handler }).
 */
export function scatterTable(bytes) {
  const sig = [0xa0, 0x90, 0xe8, 0x00, 0x0c, 0x82, 0x44, 0x83, 0x44];
  for (let i = 0; i < Math.min(bytes.length, 0x400) - sig.length; i += 2) {
    if (!sig.every((v, k) => bytes[i + 1 + k] === v)) continue;
    const ptrs = ((i + 4) & ~3) + bytes[i] * 4;
    const start = (ptrs + u32(bytes, ptrs)) >>> 0;
    const end = (ptrs + u32(bytes, ptrs + 4)) >>> 0;
    if (end <= start || end > bytes.length || (end - start) % 16) break;
    const rows = [];
    for (let o = start; o < end; o += 16) {
      rows.push({ load: u32(bytes, o), exec: u32(bytes, o + 4), size: u32(bytes, o + 8), handler: u32(bytes, o + 12) });
    }
    return { ptrs, start, end, rows };
  }
  throw new Error('scatter-load table not found');
}

// --- Applying --------------------------------------------------------------

const alignUp = (n, a) => Math.ceil(n / a) * a;

function grow(buf, size) {
  if (size <= buf.length) return buf;
  const out = new Uint8Array(size).fill(0xff); // erased flash
  out.set(buf);
  return out;
}

/** Applies every op to a copy of bytes. Throws on the first problem. */
export async function applyPatches(bytes, patchSet, subtle) {
  let out = new Uint8Array(bytes);
  const stockLength = bytes.length;
  const labels = {};
  const seen = [];

  for (const p of patchSet.patches) {
    const op = p.op ?? 'replace';

    if (op === 'replace') {
      const replace = hexToBytes(p.replace);
      const end = p.offset + replace.length;
      if (p.offset < 0 || end > stockLength) throw new Error(`${p.name}: offset out of range`);
      for (const [s, e, name] of seen) if (p.offset < e && s < end) throw new Error(`${p.name}: overlaps ${name}`);
      const current = bytes.subarray(p.offset, end);
      if (p.expect !== undefined) {
        const expect = hexToBytes(p.expect);
        if (expect.length !== replace.length) throw new Error(`${p.name}: expect and replace differ in length`);
        if (!expect.every((b, i) => current[i] === b)) throw new Error(`${p.name}: unexpected bytes at 0x${p.offset.toString(16)}`);
      } else if (p.expectSha256 !== undefined) {
        if ((await sha256(current, subtle)) !== p.expectSha256) throw new Error(`${p.name}: unexpected bytes at 0x${p.offset.toString(16)}`);
      } else {
        throw new Error(`${p.name}: no expect or expectSha256`);
      }
      out.set(replace, p.offset);
      seen.push([p.offset, end, p.name]);
    } else if (op === 'append') {
      const data = hexToBytes(p.data);
      const at = alignUp(out.length, p.align ?? 4);
      out = grow(out, at + data.length);
      out.set(data, at);
      if (p.label) labels[p.label] = at;
    } else if (op === 'scatter-add') {
      const loadOff = labels[p.load];
      if (loadOff === undefined) throw new Error(`${p.name}: unknown label ${p.load}`);
      if (p.size % 4) throw new Error(`${p.name}: size must be a multiple of 4`);
      const table = scatterTable(out);
      const vectors = table.rows.find((r) => r.exec === 0);
      if (!vectors) throw new Error(`${p.name}: no copy handler found`);
      for (const r of table.rows) {
        if (p.exec < r.exec + r.size && r.exec < p.exec + p.size) throw new Error(`${p.name}: RAM overlaps an existing region`);
      }
      const rows = [...table.rows, { load: FLASH_BASE + loadOff, exec: p.exec, size: p.size, handler: vectors.handler }];
      const at = alignUp(out.length, 16);
      out = grow(out, at + rows.length * 16);
      rows.forEach((r, i) => {
        put32(out, at + i * 16, r.load);
        put32(out, at + i * 16 + 4, r.exec);
        put32(out, at + i * 16 + 8, r.size);
        put32(out, at + i * 16 + 12, r.handler);
      });
      // The stub reads the table bounds relative to where they're stored.
      // These 8 bytes are rewritten in place, so treat them as a replace.
      for (const [s, e, name] of seen) if (table.ptrs < e && s < table.ptrs + 8) throw new Error(`${p.name}: overlaps ${name}`);
      put32(out, table.ptrs, at - table.ptrs);
      put32(out, table.ptrs + 4, at + rows.length * 16 - table.ptrs);
      seen.push([table.ptrs, table.ptrs + 8, p.name]);
    } else {
      throw new Error(`${p.name}: unknown op ${op}`);
    }
  }

  // The updater writes whole 256-byte pages.
  return grow(out, alignUp(out.length, 0x100));
}
