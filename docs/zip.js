/* DataCloak — minimal ZIP reader/writer.
 *
 * No third-party code: the ZIP container is parsed by hand and the actual
 * DEFLATE (de)compression uses the browser/Node built-in Compression Streams
 * (`deflate-raw`). Available in Web Workers and Node 18+. Makes no network
 * calls of any kind.
 *
 * Scope: the subset needed for Office Open XML (DOCX/XLSX) — store (0) and
 * deflate (8), no ZIP64, no encryption.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// CRC-32 (IEEE) table + function.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(u8) {
  if (typeof CompressionStream === 'undefined') return null; // caller falls back to store
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEOCD(buf) {
  // Scan backwards for the End Of Central Directory signature (PK\5\6).
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  throw new Error('Not a ZIP archive');
}

/*
 * unzip(buffer, limits) → Map<name, Uint8Array>  (decompressed contents)
 * limits guards against decompression/zip bombs:
 *   maxEntries, maxEntryBytes, maxTotalBytes
 */
export async function unzip(input, limits = {}) {
  const maxEntries = limits.maxEntries ?? 5000;
  const maxEntryBytes = limits.maxEntryBytes ?? 100 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 300 * 1024 * 1024;

  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const eocd = findEOCD(buf);
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count > maxEntries) throw new Error('ZIP has too many entries');

  const files = new Map();
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (uncompSize > maxEntryBytes) throw new Error('ZIP entry too large');

    if (!name.endsWith('/')) {
      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('Corrupt local header');
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);

      let data;
      if (method === 0) data = comp.slice();
      else if (method === 8) data = await inflateRaw(comp);
      else throw new Error('Unsupported compression method ' + method);

      if (data.length > maxEntryBytes) throw new Error('ZIP entry too large');
      total += data.length;
      if (total > maxTotalBytes) throw new Error('ZIP total size exceeds limit');
      files.set(name, data);
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/*
 * unzipEntries(buffer, limits) → { files, raw }
 *   files: Map<name, Uint8Array>  (decompressed, like unzip)
 *   raw:   Map<name, { method, comp, crc, uncompSize }>  (original compressed
 *          bytes) so unchanged entries can be re-written WITHOUT recompressing —
 *          a large speed-up for big Office files full of images.
 */
export async function unzipEntries(input, limits = {}) {
  const maxEntries = limits.maxEntries ?? 5000;
  const maxEntryBytes = limits.maxEntryBytes ?? 100 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 300 * 1024 * 1024;

  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const eocd = findEOCD(buf);
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count > maxEntries) throw new Error('ZIP has too many entries');

  const files = new Map();
  const raw = new Map();
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));

    if (uncompSize > maxEntryBytes) throw new Error('ZIP entry too large');

    if (!name.endsWith('/')) {
      if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('Corrupt local header');
      const lNameLen = dv.getUint16(localOff + 26, true);
      const lExtraLen = dv.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize).slice();

      let data;
      if (method === 0) data = comp.slice();
      else if (method === 8) data = await inflateRaw(comp);
      else throw new Error('Unsupported compression method ' + method);

      if (data.length > maxEntryBytes) throw new Error('ZIP entry too large');
      total += data.length;
      if (total > maxTotalBytes) throw new Error('ZIP total size exceeds limit');
      files.set(name, data);
      raw.set(name, { method, comp, crc, uncompSize });
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  return { files, raw };
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/*
 * zip(entries) → Uint8Array
 * entries: iterable of { name, data:Uint8Array }. Insertion order is preserved.
 * Deflates each entry (stores it instead if deflate wouldn't be smaller or
 * CompressionStream is unavailable). No ZIP64.
 */
export async function zip(entries) {
  const list = Array.isArray(entries) ? entries : [...entries].map(([name, data]) => ({ name, data }));
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of list) {
    const { name } = entry;
    const nameBytes = enc.encode(name);

    let method, comp, crc, uncompSize;
    if (entry.precompressed) {
      // Pass an unchanged entry straight through — no recompression.
      ({ method, comp, crc, uncompSize } = entry.precompressed);
    } else {
      const data = entry.data;
      crc = crc32(data);
      uncompSize = data.length;
      method = 8;
      comp = await deflateRaw(data);
      if (!comp || comp.length >= uncompSize) { method = 0; comp = data; }
    }

    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);       // version needed
    ldv.setUint16(6, 0x0800, true);   // flag: UTF-8 names
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, 0, true);       // mod time (fixed → deterministic output)
    ldv.setUint16(12, 0x21, true);    // mod date (1980-01-01, a valid DOS date)
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, comp.length, true);
    ldv.setUint32(22, uncompSize, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    parts.push(lh, comp);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);        // version made by
    cdv.setUint16(6, 20, true);        // version needed
    cdv.setUint16(8, 0x0800, true);    // flag: UTF-8
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, 0, true);        // time
    cdv.setUint16(14, 0x21, true);     // date
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, comp.length, true);
    cdv.setUint32(24, uncompSize, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);   // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += lh.length + comp.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  parts.push(...central);

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, list.length, true);
  edv.setUint16(10, list.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);
  parts.push(eocd);

  return concat(parts);
}
