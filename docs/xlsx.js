/* DataCloak — XLSX parsing & rewriting.
 *
 * An XLSX is a ZIP of XML parts. Cell text lives in <t> elements: shared strings
 * in xl/sharedStrings.xml (the main text store) and inline strings inside every
 * worksheet (xl/worksheets/sheet*.xml). Numbers stored in <v> and formulas in
 * <f> are intentionally left untouched, so numeric/formula cells are preserved.
 *
 * Text is extracted with the shared OOXML engine; a newline is inserted at each
 * </si> (shared-string item) and </c> (cell) so detection never bridges cells.
 */

import { unzipEntries } from './zip.js';
import { extractSegments, rebuild } from './ooxml.js';

const TEXT_PART = /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/;
const UNLIMITED = { maxEntries: Infinity, maxEntryBytes: Infinity, maxTotalBytes: Infinity };

export async function parseXlsx(input) {
  const { files, raw } = await unzipEntries(input, UNLIMITED);
  const dec = new TextDecoder();
  const partModels = [];
  // sharedStrings first (most text), then worksheets — order is not significant.
  for (const [name, data] of files) {
    if (TEXT_PART.test(name)) partModels.push({ name, xml: dec.decode(data) });
  }
  const { segments, text } = extractSegments(partModels, 't', { blockCloseTags: ['</si>', '</c>'] });
  return { files, raw, partModels, segments, text };
}

export async function buildXlsx(model, findings, rowsByKey) {
  return rebuild(model.files, model.raw, model.partModels, model.segments, findings, rowsByKey);
}
