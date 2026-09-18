/* DataCloak — DOCX parsing & rewriting.
 *
 * A DOCX is a ZIP of XML parts. Visible text lives in <w:t> runs inside
 * word/document.xml and the header/footer/notes parts. Text is extracted with
 * the shared OOXML engine and only the <w:t> run text is rewritten — all
 * formatting, tables, headers and footers stay intact.
 */

import { unzip } from './zip.js';
import { extractSegments, rebuild } from './ooxml.js';

const TEXT_PART = /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml|footnotes\.xml|endnotes\.xml)$/;
const UNLIMITED = { maxEntries: Infinity, maxEntryBytes: Infinity, maxTotalBytes: Infinity };

export async function parseDocx(input) {
  const files = await unzip(input, UNLIMITED);
  const dec = new TextDecoder();
  const partModels = [];
  for (const [name, data] of files) {
    if (TEXT_PART.test(name)) partModels.push({ name, xml: dec.decode(data) });
  }
  // Runs are joined within a paragraph; a newline is inserted at each </w:p> so
  // detection never bridges paragraphs.
  const { segments, text } = extractSegments(partModels, 'w:t', { blockCloseTags: ['</w:p>'] });
  return { files, partModels, segments, text };
}

export async function buildDocx(model, findings, rowsByKey) {
  return rebuild(model.files, model.partModels, model.segments, findings, rowsByKey);
}
