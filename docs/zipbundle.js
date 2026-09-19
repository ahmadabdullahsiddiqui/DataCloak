/* DataCloak — ZIP bundle processing.
 *
 * Processes every supported document INSIDE a .zip (.txt, .docx, .xlsx) and
 * repackages the archive. All inner files share ONE replacement table, so the
 * same value gets the same pseudonym across the whole bundle. Unsupported entries
 * (images, .pdf, …) are passed through byte-for-byte unchanged — PDF needs the
 * canvas-based engine and is not processed inside a zip.
 *
 * Reuses the per-format engines: each inner .docx/.xlsx is itself a zip, parsed
 * by parseDocx/parseXlsx and rebuilt by buildDocx/buildXlsx.
 */

import { unzipEntries, zip } from './zip.js';
import { parseDocx, buildDocx } from './docx.js';
import { parseXlsx, buildXlsx } from './xlsx.js';
import { applyReplacements } from './detectors.js';

const UNLIMITED = { maxEntries: Infinity, maxEntryBytes: Infinity, maxTotalBytes: Infinity };

const SUPPORTED = /\.(txt|docx|xlsx)$/i;

export async function parseZip(input) {
  // Only decompress the documents we can process; images/other entries keep their
  // raw compressed bytes and pass through untouched (faster + robust to exotic
  // compression methods elsewhere in the archive).
  const { files, raw } = await unzipEntries(input, UNLIMITED, {
    shouldDecode: (name) => SUPPORTED.test(name),
  });
  const dec = new TextDecoder();

  const subs = [];
  let text = '';
  for (const [name, data] of files) {
    const lower = name.toLowerCase();
    let sub = null;
    try {
      if (data == null) sub = null;          // not decoded → pass through
      else if (lower.endsWith('.txt')) {
        sub = { kind: 'txt', name, text: dec.decode(data) };
      } else if (lower.endsWith('.docx')) {
        const m = await parseDocx(data);
        sub = { kind: 'docx', name, model: m, text: m.text };
      } else if (lower.endsWith('.xlsx')) {
        const m = await parseXlsx(data);
        sub = { kind: 'xlsx', name, model: m, text: m.text };
      }
    } catch {
      sub = null; // corrupt/unsupported inner file → leave it untouched
    }
    if (sub) {
      if (text.length) text += '\n'; // separate files so detection never bridges them
      sub.gStart = text.length;
      text += sub.text;
      sub.gEnd = text.length;
      subs.push(sub);
    }
  }
  return { files, raw, subs, text, entryCount: files.size };
}

export async function buildZip(model, findings, rowsByKey) {
  const enc = new TextEncoder();
  const { files, raw, subs } = model;
  const ordered = [...findings].sort((a, b) => a.start - b.start);
  const processed = new Set();

  for (const sub of subs) {
    // Findings inside this file's range, shifted to file-local offsets.
    const local = [];
    for (const f of ordered) {
      if (f.start >= sub.gStart && f.end <= sub.gEnd) {
        local.push({ type: f.type, value: f.value, start: f.start - sub.gStart, end: f.end - sub.gStart });
      }
    }
    let bytes;
    if (sub.kind === 'txt') bytes = enc.encode(applyReplacements(sub.text, local, rowsByKey));
    else if (sub.kind === 'docx') bytes = await buildDocx(sub.model, local, rowsByKey);
    else bytes = await buildXlsx(sub.model, local, rowsByKey);
    files.set(sub.name, bytes);
    processed.add(sub.name);
  }

  // Processed files are recompressed; everything else passes through unchanged.
  const entries = [];
  for (const [name, data] of files) {
    if (!processed.has(name) && raw.has(name)) entries.push({ name, precompressed: raw.get(name) });
    else entries.push({ name, data });
  }
  return zip(entries);
}
