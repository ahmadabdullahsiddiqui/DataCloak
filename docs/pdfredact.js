/* DataCloak — PDF secure redaction (rasterise & flatten).
 *
 * PDF is the one format where "cover with a black box" is NOT enough: the text
 * usually stays extractable underneath. So we take the only approach that truly
 * removes it, entirely locally:
 *
 *   1. render each page to a canvas with pdf.js (self-hosted, no CDN),
 *   2. locate every text run's box via getTextContent(),
 *   3. paint an opaque box (and the replacement label) over each PII run,
 *   4. export each page as a JPEG and assemble an image-only PDF.
 *
 * The output contains no text objects at all — only pixels — so the original
 * text cannot be copied or extracted, and the PII pixels are painted over.
 *
 * pdf.js may fetch its OWN same-origin assets (worker, standard fonts); it never
 * sends document data anywhere, and CSP `connect-src 'self'` enforces that no
 * cross-origin request is possible.
 */

import * as pdfjsLib from './vendor/pdf.min.mjs';
import { detect, aggregate, keyOf } from './detectors.js';
import { assembleImagePdf } from './imagepdf.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
const STANDARD_FONTS = new URL('./vendor/standard_fonts/', import.meta.url).href;

const RENDER_SCALE = 2; // rasterisation resolution
let model = null;       // { pages:[{ base:Canvas, w, h, items:[{gStart,gEnd,box}] }], text }

// --- analysis -----------------------------------------------------------
export async function analyze(buffer, options = {}) {
  reset();
  // Copy the bytes: pdf.js transfers the array to its worker (detaching it), so
  // we must not hand it the caller's buffer — that would break re-analysis.
  const src = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const data = new Uint8Array(src.length);
  data.set(src);
  const pdf = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,             // keep working under strict CSP (no unsafe-eval)
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;

  const pages = [];
  let text = '';

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const str = it.str || '';
      if (str.length) {
        const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
        const h = Math.hypot(tx[2], tx[3]) || (Math.abs(tx[3]) || 10);
        const w = (it.width || (str.length * h * 0.5)) * RENDER_SCALE;
        const box = { x: tx[4], y: tx[5] - h, w, h };
        const gStart = text.length;
        text += str;
        items.push({ gStart, gEnd: text.length, box });
      }
      text += it.hasEOL ? '\n' : ' ';
    }
    text += '\n';
    pages.push({ base: canvas, w: canvas.width, h: canvas.height, items });
    if (typeof options.onProgress === 'function') options.onProgress(p, pdf.numPages);
  }

  const findings = detect(text, options);
  const rows = aggregate(findings, options);
  model = { pages, text, findings };
  return { rows, findings, pageCount: pdf.numPages };
}

// --- build the redacted PDF --------------------------------------------
export async function build(rows, opts = {}) {
  if (!model) throw new Error('No PDF analysed');
  const byKey = new Map(rows.map((r) => [keyOf(r.type, r.value), r]));
  const active = model.findings.filter((f) => {
    const r = byKey.get(keyOf(f.type, f.value));
    return r && r.active !== false;
  });

  const outPages = [];
  for (const pg of model.pages) {
    // Work on a fresh canvas so re-applying with different choices is clean.
    const canvas = document.createElement('canvas');
    canvas.width = pg.w;
    canvas.height = pg.h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(pg.base, 0, 0);

    for (const f of active) {
      const r = byKey.get(keyOf(f.type, f.value));
      for (const item of pg.items) {
        if (item.gStart < f.end && item.gEnd > f.start) {
          drawRedaction(ctx, item.box, r ? r.replacement : '');
        }
      }
    }

    const jpeg = await canvasToJpeg(canvas, 0.9);
    outPages.push({ jpeg, width: canvas.width, height: canvas.height });
    if (typeof opts.onProgress === 'function') opts.onProgress(outPages.length, model.pages.length);
  }
  return assembleImagePdf(outPages); // pure writer, imported from imagepdf.js
}

export function reset() {
  model = null;
}

// --- drawing ------------------------------------------------------------
function drawRedaction(ctx, box, label) {
  const pad = Math.max(1, box.h * 0.12);
  const x = box.x - pad;
  const y = box.y - pad;
  const w = box.w + pad * 2;
  const h = box.h + pad * 2;

  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);

  if (label) {
    const size = Math.max(6, Math.min(h * 0.72, 40));
    ctx.font = `${size}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    // Clip so a long label can't spill outside the box.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillText(label, x + pad, y + h / 2);
    ctx.restore();
  }
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { reject(new Error('encode failed')); return; }
        blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
      },
      'image/jpeg',
      quality
    );
  });
}
