// A small .zip reader, so the installer can take Roland's download as it comes
// (sp404mk2_sys_v552.zip) as well as the unzipped SP404MKII_APP1.bin. Lists a
// zip's files from its central directory and extracts one (stored or
// deflated), checking its CRC-32. No ZIP64, encryption or multi-part archives.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

export class ZipError extends Error {}

export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

// [{ name, method, compressedSize, size, crc, offset }]
export function listZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("The file isn't a zip file.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL_SIG) throw new ZipError('The zip file is damaged.');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entries.push({
      name: names.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRawStream(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The entry's contents. inflateRaw(Uint8Array) can be passed in where
// DecompressionStream lacks 'deflate-raw'.
export async function extractZip(bytes, entry, inflateRaw = inflateRawStream) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.offset;
  if (view.getUint32(p, true) !== LOCAL_SIG) throw new ZipError('The zip file is damaged.');
  const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  let out;
  if (entry.method === 0) out = data.slice();
  else if (entry.method === 8) out = await inflateRaw(data);
  else throw new ZipError(`${entry.name} is packed in a way this page can't unpack.`);
  if (out.length !== entry.size || crc32(out) !== entry.crc) throw new ZipError(`${entry.name} didn't unpack intact.`);
  return out;
}

// The entry for `file` (any folder, ignoring macOS's __MACOSX copies), or null.
export function findEntry(entries, file) {
  return entries.find((e) => {
    const parts = e.name.split('/');
    return !parts.includes('__MACOSX') && parts[parts.length - 1] === file;
  }) ?? null;
}
