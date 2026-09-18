/* DataCloak — DOCX parsing & rewriting.
 *
 * A DOCX is a ZIP of XML parts. Visible text lives in <w:t> runs inside
 * word/document.xml and the header/footer/notes parts. We:
 *   1. unzip and pull the text parts,
 *   2. concatenate every <w:t> run into one plain-text string (with paragraph
 *      breaks) for detection, remembering each run's exact range in the XML,
 *   3. rewrite only the <w:t> inner text for replacements — the surrounding
 *      markup (formatting, tables, headers/footers) is left byte-for-byte intact.
 *
 * PII split across adjacent runs in the same paragraph is handled: the full
 * replacement goes into the first run and the remaining matched characters are
 * removed from the following runs.
 */

import { unzip, zip } from './zip.js';
import { keyOf } from './detectors.js';

const TEXT_PART = /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml|footnotes\.xml|endnotes\.xml)$/;

const UNLIMITED = { maxEntries: Infinity, maxEntryBytes: Infinity, maxTotalBytes: Infinity };

function xmlDecode(s) {
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

function xmlEncode(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/*
 * parseDocx(buffer) → model
 *   model.files     — Map<name, Uint8Array> (all entries, for rebuild)
 *   model.parts     — [{ name, xml }] text parts in order
 *   model.segments  — [{ partIndex, innerStart, innerEnd, gStart, gEnd, decoded }]
 *   model.text      — combined plain text for detection
 */
export async function parseDocx(input) {
  const files = await unzip(input, UNLIMITED);
  const dec = new TextDecoder();

  const parts = [];
  for (const [name, data] of files) {
    if (TEXT_PART.test(name)) parts.push({ name, xml: dec.decode(data) });
  }

  const segments = [];
  let text = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

  for (let pi = 0; pi < parts.length; pi++) {
    const xml = parts[pi].xml;
    let m;
    let searchFrom = 0;
    let firstInPart = true;
    while ((m = re.exec(xml)) !== null) {
      const innerLen = m[1].length;
      const innerStart = m.index + m[0].length - '</w:t>'.length - innerLen;
      const innerEnd = innerStart + innerLen;

      // Insert a newline separator when a paragraph ended before this run, or at
      // the start of a new part, so detection never bridges paragraphs.
      const paraBreak = xml.slice(searchFrom, innerStart).includes('</w:p>');
      if (text.length && (paraBreak || firstInPart)) text += '\n';

      const decoded = xmlDecode(m[1]);
      const gStart = text.length;
      text += decoded;
      segments.push({ partIndex: pi, innerStart, innerEnd, gStart, gEnd: text.length, decoded });

      searchFrom = innerEnd;
      firstInPart = false;
    }
  }

  return { files, parts, segments, text };
}

/*
 * buildDocx(model, findings, rowsByKey) → Uint8Array
 * Applies the active replacements into the run text and re-zips the document.
 */
export async function buildDocx(model, findings, rowsByKey) {
  const get = (k) => (rowsByKey instanceof Map ? rowsByKey.get(k) : rowsByKey[k]);
  const { files, parts, segments } = model;

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
  for (let pi = 0; pi < parts.length; pi++) {
    const segs = segments.filter((s) => s.partIndex === pi).sort((a, b) => b.innerStart - a.innerStart);
    let xml = parts[pi].xml;
    for (const s of segs) xml = xml.slice(0, s.innerStart) + s.newInner + xml.slice(s.innerEnd);
    files.set(parts[pi].name, enc.encode(xml));
  }

  return zip(files);
}
