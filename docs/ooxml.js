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
 * rebuild(files, partModels, segments, findings, rowsByKey) → Uint8Array
 * Applies the active replacements into the run text and re-zips the archive.
 */
export async function rebuild(files, partModels, segments, findings, rowsByKey) {
  const get = (k) => (typeof rowsByKey.get === 'function' ? rowsByKey.get(k) : rowsByKey[k]);

  // Distribute each finding across the run segments it overlaps.
  const editsBySeg = new Map();
  const ordered = [...findings].sort((a, b) => a.start - b.start);
  for (const f of ordered) {
    const row = get(keyOf(f.type, f.value));
    if (!row || row.active === false) continue;
    const overlap = segments.filter((s) => s.gStart < f.end && s.gEnd > f.start);
    overlap.forEach((s, idx) => {
      const localStart = Math.max(f.start, s.gStart) - s.gStart;
      const localEnd = Math.min(f.end, s.gEnd) - s.gStart;
      const txt = idx === 0 ? row.replacement : ''; // full replacement in first run
      if (!editsBySeg.has(s)) editsBySeg.set(s, []);
      editsBySeg.get(s).push({ localStart, localEnd, txt });
    });
  }

  // Rewrite each segment's decoded text, then re-escape.
  for (const s of segments) {
    const edits = editsBySeg.get(s);
    let d = s.decoded;
    if (edits) {
      edits.sort((a, b) => b.localStart - a.localStart); // right-to-left
      for (const e of edits) d = d.slice(0, e.localStart) + e.txt + d.slice(e.localEnd);
    }
    s.newInner = xmlEncode(d);
  }

  // Splice new inner text back into each part's XML (right-to-left).
  const enc = new TextEncoder();
  for (let pi = 0; pi < partModels.length; pi++) {
    const segs = segments.filter((s) => s.partIndex === pi).sort((a, b) => b.innerStart - a.innerStart);
    let xml = partModels[pi].xml;
    for (const s of segs) xml = xml.slice(0, s.innerStart) + s.newInner + xml.slice(s.innerEnd);
    files.set(partModels[pi].name, enc.encode(xml));
  }

  return zip(files);
}
