/* DataCloak — XLSX parsing & rewriting.
 *
 * Cell text lives in <t> elements: shared strings in xl/sharedStrings.xml and
 * inline strings inside worksheets. Those are handled by the shared OOXML engine.
 *
 * In addition, PII can sit in NUMERIC cells (e.g. an 11-digit tax id or a phone
 * number stored as a number). We scan worksheet numeric cells, feed their values
 * into the same detection pass, and — when a value is replaced — convert that
 * cell to an inline string so the replacement text is valid. Formula cells and
 * untouched numbers are left exactly as they were.
 *
 * Document metadata (author, last-modified-by, …) is scrubbed too.
 */

import { unzipEntries } from './zip.js';
import { extractSegments, rebuild, scrubMetadata } from './ooxml.js';

const TEXT_PART = /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/;
const SHEET_PART = /worksheets\/sheet\d+\.xml$/;
const META_PART = /^docProps\/(core|app)\.xml$/;
const UNLIMITED = { maxEntries: Infinity, maxEntryBytes: Infinity, maxTotalBytes: Infinity };

// Collect numeric-cell values as extra segments, continuing the combined text.
function numericCellSegments(partModels, text) {
  const segments = [];
  const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  for (let pi = 0; pi < partModels.length; pi++) {
    if (!SHEET_PART.test(partModels[pi].name)) continue;
    const xml = partModels[pi].xml;
    let m;
    while ((m = cellRe.exec(xml)) !== null) {
      const attrs = m[1];
      const inner = m[2];
      if (/\bt="(?:s|str|inlineStr|b|e)"/.test(attrs)) continue; // strings/bool/error handled via <t>
      if (inner.includes('<f')) continue;                        // formula — leave untouched
      const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
      if (!vm || !vm[1]) continue;
      const value = vm[1];
      const cleanAttrs = attrs.replace(/\s+t="[^"]*"/, '');
      text += '\n';
      const gStart = text.length;
      text += value;
      segments.push({
        partIndex: pi,
        innerStart: m.index,
        innerEnd: m.index + m[0].length,
        gStart,
        gEnd: text.length,
        decoded: value,
        // When replaced, the cell must become an inline string to hold text.
        wrap: (encoded) => `<c${cleanAttrs} t="inlineStr"><is><t xml:space="preserve">${encoded}</t></is></c>`,
      });
    }
  }
  return { segments, text };
}

export async function parseXlsx(input) {
  const { files, raw } = await unzipEntries(input, UNLIMITED, {
    shouldDecode: (name) => TEXT_PART.test(name) || META_PART.test(name),
  });
  const dec = new TextDecoder();
  const partModels = [];
  for (const [name, data] of files) {
    if (data != null && TEXT_PART.test(name)) partModels.push({ name, xml: dec.decode(data) });
  }

  const base = extractSegments(partModels, 't', { blockCloseTags: ['</si>', '</c>'] });
  const num = numericCellSegments(partModels, base.text);
  // Segments stay ordered by gStart (numeric ones are appended after the <t> ones).
  const segments = base.segments.concat(num.segments);
  const text = num.text;

  const metaModified = scrubMetadata(files);
  return { files, raw, partModels, segments, text, metaModified };
}

export async function buildXlsx(model, findings, rowsByKey) {
  return rebuild(model.files, model.raw, model.partModels, model.segments, findings, rowsByKey, model.metaModified);
}
