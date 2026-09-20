/* DataCloak — DOCX parsing & rewriting.
 *
 * A DOCX is a ZIP of XML parts. Visible text lives in <w:t> runs inside
 * word/document.xml and the header/footer/notes parts. Text is extracted with
 * the shared OOXML engine and only the <w:t> run text is rewritten — all
 * formatting, tables, headers and footers stay intact.
 */

import { unzipEntries } from './zip.js';
import { extractSegments, rebuild, scrubMetadata } from './ooxml.js';

// Body, headers, footers, notes AND comments — all carry visible <w:t> text.
const TEXT_PART = /^word\/(document\.xml|header\d*\.xml|footer\d*\.xml|footnotes\.xml|endnotes\.xml|comments\.xml|commentsExtended\.xml)$/;
const META_PART = /^docProps\/(core|app)\.xml$/;
const UNLIMITED = { maxEntries: Infinity, maxEntryBytes: Infinity, maxTotalBytes: Infinity };

export async function parseDocx(input) {
  const { files, raw } = await unzipEntries(input, UNLIMITED, {
    shouldDecode: (name) => TEXT_PART.test(name) || META_PART.test(name), // images/media pass through
  });
  const dec = new TextDecoder();
  const partModels = [];
  for (const [name, data] of files) {
    if (data != null && TEXT_PART.test(name)) partModels.push({ name, xml: dec.decode(data) });
  }
  // Runs are joined within a paragraph; a newline is inserted at each </w:p> so
  // detection never bridges paragraphs.
  const { segments, text } = extractSegments(partModels, 'w:t', { blockCloseTags: ['</w:p>'] });
  const metaModified = scrubMetadata(files); // strip author/last-modified-by/etc.
  return { files, raw, partModels, segments, text, metaModified };
}

export async function buildDocx(model, findings, rowsByKey) {
  return rebuild(model.files, model.raw, model.partModels, model.segments, findings, rowsByKey, model.metaModified);
}
