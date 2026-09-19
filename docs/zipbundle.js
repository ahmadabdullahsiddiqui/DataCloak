/* DataCloak — ZIP bundle processing.
 *
 * Processes every supported document INSIDE a .zip (.txt, .docx, .xlsx) and
 * repackages the archive. All inner files share ONE replacement table, so the
 * same value gets the same pseudonym across the whole bundle. Unsupported entries
 * (images, .pdf, …) are passed through byte-for-byte unchanged.
 *
 * Each inner file is detected and rewritten INDEPENDENTLY — we never build one
 * giant combined string, so huge archives don't hit the JS max-string-length
 * limit ("Invalid string length"). Consistent pseudonyms come from aggregating
 * all files' findings into a single replacement table.
 */

import { unzipEntries, zip } from './zip.js';
import { parseDocx, buildDocx } from './docx.js';
import { parseXlsx, buildXlsx } from './xlsx.js';
import { detect, aggregate, applyReplacements } from './detectors.js';

const UNLIMITED = { maxEntries: Infinity, maxEntryBytes: Infinity, maxTotalBytes: Infinity };
const SUPPORTED = /\.(txt|docx|xlsx)$/i;

// Run async fn over items with bounded concurrency, preserving input order.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      try { results[idx] = await fn(items[idx], idx); }
      catch { results[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function parseZip(input, onProgress) {
  // Only decompress the documents we can process; images/other entries keep their
  // raw compressed bytes and pass through untouched (faster + robust).
  const { files, raw } = await unzipEntries(input, UNLIMITED, {
    shouldDecode: (name) => SUPPORTED.test(name),
  });
  const dec = new TextDecoder();

  // Candidates in archive order (deterministic pseudonym numbering later).
  const candidates = [];
  for (const [name, data] of files) {
    if (data != null && SUPPORTED.test(name)) candidates.push({ name, data });
  }

  // Decompress/parse inner files concurrently to overlap the async inflate work.
  let done = 0;
  const total = candidates.length;
  const parsed = await mapPool(candidates, 8, async ({ name, data }) => {
    try {
      const lower = name.toLowerCase();
      if (lower.endsWith('.txt')) return { kind: 'txt', name, text: dec.decode(data) };
      if (lower.endsWith('.docx')) { const m = await parseDocx(data); return { kind: 'docx', name, model: m, text: m.text }; }
      if (lower.endsWith('.xlsx')) { const m = await parseXlsx(data); return { kind: 'xlsx', name, model: m, text: m.text }; }
      return null;
    } finally {
      if (typeof onProgress === 'function') onProgress(++done, total);
    }
  });

  const subs = parsed.filter(Boolean);
  return { files, raw, subs };
}

/*
 * analyzeZip(model, options, onProgress) → rows
 * Detects each inner file separately (findings stored file-local on the sub) and
 * aggregates them into one shared replacement table.
 */
export function analyzeZip(model, options = {}, onProgress) {
  const all = [];
  let i = 0;
  for (const sub of model.subs) {
    sub.findings = detect(sub.text, options);
    for (const f of sub.findings) all.push(f);
    if (typeof onProgress === 'function') onProgress(++i, model.subs.length);
  }
  return aggregate(all, options);
}

/*
 * buildZip(model, rowsByKey, onProgress) → Uint8Array
 * Applies the shared replacement table to each inner file, repackages the rest.
 */
export async function buildZip(model, rowsByKey, onProgress) {
  const enc = new TextEncoder();
  const { files, raw, subs } = model;
  const processed = new Set();

  let i = 0;
  for (const sub of subs) {
    const local = sub.findings || [];
    let bytes;
    if (sub.kind === 'txt') bytes = enc.encode(applyReplacements(sub.text, local, rowsByKey));
    else if (sub.kind === 'docx') bytes = await buildDocx(sub.model, local, rowsByKey);
    else bytes = await buildXlsx(sub.model, local, rowsByKey);
    files.set(sub.name, bytes);
    processed.add(sub.name);
    if (typeof onProgress === 'function') onProgress(++i, subs.length);
  }

  const entries = [];
  for (const [name, data] of files) {
    if (!processed.has(name) && raw.has(name)) entries.push({ name, precompressed: raw.get(name) });
    else entries.push({ name, data });
  }
  return zip(entries);
}
