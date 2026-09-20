/* DataCloak — shared Office Open XML (DOCX/XLSX) text engine.
 *
 * Both DOCX and XLSX are ZIPs of XML where visible text sits inside a specific
 * element (`<w:t>` for Word, `<t>` for Excel). This module extracts those runs
 * into one detectable string (remembering each run's exact byte range) and
 * rewrites only the run text for replacements, leaving all surrounding markup —
 * formatting, tables, formulas, headers/footers — byte-for-byte intact.
 *
 * PII split across adjacent runs in the same block is handled: the full
 * replacement goes into the first run, the remaining matched characters are
 * removed from the following runs.
 */

import { zip } from './zip.js';
import { keyOf } from './detectors.js';

export function xmlDecode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return e[1] === 'x' || e[1] === 'X'
          ? String.fromCodePoint(parseInt(e.slice(2), 16))
          : String.fromCodePoint(parseInt(e.slice(1), 10));
    }
  });
}

export function xmlEncode(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Document metadata often holds personal data (author, "last modified by", …).
// Empty these fields in docProps/core.xml and app.xml. Returns the names of the
// parts that changed (so the caller marks them for recompression).
const META_FIELDS = /<(dc:creator|cp:lastModifiedBy|dc:title|dc:subject|dc:description|cp:keywords|cp:category|Company|Manager|HyperlinkBase)((?:\s[^>]*)?)>[\s\S]*?<\/\1>/g;

export function scrubMetadata(files) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const modified = [];
  for (const name of ['docProps/core.xml', 'docProps/app.xml']) {
    const data = files.get(name);
    if (data == null) continue;
    const xml = dec.decode(data);
    const scrubbed = xml.replace(META_FIELDS, (m, tag, attrs) => `<${tag}${attrs}></${tag}>`);
    if (scrubbed !== xml) { files.set(name, enc.encode(scrubbed)); modified.push(name); }
  }
  return modified;
}

/*
 * extractSegments(partModels, tagName, opts) → { segments, text }
 *   partModels: [{ name, xml }]
 *   tagName:    e.g. 'w:t' (Word) or 't' (Excel)
 *   opts.blockCloseTags: closing tags that mark a block boundary (a newline is
 *     inserted so detection never bridges paragraphs/cells), e.g. ['</w:p>'].
 * A segment: { partIndex, innerStart, innerEnd, gStart, gEnd, decoded }
 */
export function extractSegments(partModels, tagName, opts = {}) {
  const blockCloseTags = opts.blockCloseTags || [];
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'g');
  const closeLen = `</${tagName}>`.length;

  const segments = [];
  let text = '';
  for (let pi = 0; pi < partModels.length; pi++) {
    const xml = partModels[pi].xml;
    let m;
    let searchFrom = 0;
    let firstInPart = true;
    while ((m = re.exec(xml)) !== null) {
      const innerLen = m[1].length;
      const innerStart = m.index + m[0].length - closeLen - innerLen;
      const innerEnd = innerStart + innerLen;

      let brk = firstInPart;
      if (!brk) {
        const between = xml.slice(searchFrom, innerStart);
        brk = blockCloseTags.some((t) => between.includes(t));
      }
      if (text.length && brk) text += '\n';

      const decoded = xmlDecode(m[1]);
      const gStart = text.length;
      text += decoded;
      segments.push({ partIndex: pi, innerStart, innerEnd, gStart, gEnd: text.length, decoded });

      searchFrom = innerEnd;
      firstInPart = false;
    }
  }
  return { segments, text };
}

/*
 * rebuild(files, raw, partModels, segments, findings, rowsByKey) → Uint8Array
 * Applies the active replacements into the run text and re-zips the archive.
 *
 * Performance for large files:
 *  - segments are in text order (gStart/gEnd ascending, non-overlapping), so each
 *    finding's overlapping runs are found by binary search — O(F log S), not O(F·S);
 *  - only the modified text parts are recompressed; every other entry is passed
 *    through with its original compressed bytes (`raw`).
 */
export async function rebuild(files, raw, partModels, segments, findings, rowsByKey, extraModified) {
  const get = (k) => (typeof rowsByKey.get === 'function' ? rowsByKey.get(k) : rowsByKey[k]);

  // First segment whose gEnd > start (segments' gEnd is ascending).
  const firstOverlap = (start) => {
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].gEnd > start) hi = mid; else lo = mid + 1;
    }
    return lo;
  };

  const editsBySeg = new Map();
  const ordered = [...findings].sort((a, b) => a.start - b.start);
  for (const f of ordered) {
    const row = get(keyOf(f.type, f.value));
    if (!row || row.active === false) continue;
    let idx = 0;
    for (let i = firstOverlap(f.start); i < segments.length && segments[i].gStart < f.end; i++) {
      const s = segments[i];
      const localStart = Math.max(f.start, s.gStart) - s.gStart;
      const localEnd = Math.min(f.end, s.gEnd) - s.gStart;
      const txt = idx === 0 ? row.replacement : ''; // full replacement in first run
      if (!editsBySeg.has(s)) editsBySeg.set(s, []);
      editsBySeg.get(s).push({ localStart, localEnd, txt });
      idx++;
    }
  }

  // Rewrite ONLY the segments that actually changed. `wrap` lets a segment
  // rebuild surrounding markup (e.g. an XLSX numeric cell becomes an inline
  // string when its value is replaced); default just uses the escaped text.
  const enc = new TextEncoder();
  const byPart = partModels.map(() => []);
  for (const s of segments) {
    const edits = editsBySeg.get(s);
    if (!edits) continue; // untouched → leave original XML (and pass through)
    edits.sort((a, b) => b.localStart - a.localStart); // right-to-left
    let d = s.decoded;
    for (const e of edits) d = d.slice(0, e.localStart) + e.txt + d.slice(e.localEnd);
    s.newXml = s.wrap ? s.wrap(xmlEncode(d), s) : xmlEncode(d);
    byPart[s.partIndex].push(s);
  }

  const modified = new Set(extraModified || []);
  for (let pi = 0; pi < partModels.length; pi++) {
    if (byPart[pi].length === 0) continue; // no changes in this part
    const segs = byPart[pi].sort((a, b) => b.innerStart - a.innerStart);
    let xml = partModels[pi].xml;
    for (const s of segs) xml = xml.slice(0, s.innerStart) + s.newXml + xml.slice(s.innerEnd);
    files.set(partModels[pi].name, enc.encode(xml));
    modified.add(partModels[pi].name);
  }

  // Only modified parts are recompressed; everything else passes through.
  const entries = [];
  for (const [name, data] of files) {
    if (!modified.has(name) && raw && raw.has(name)) entries.push({ name, precompressed: raw.get(name) });
    else entries.push({ name, data });
  }
  return zip(entries);
}
