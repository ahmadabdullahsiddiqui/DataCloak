/* DataCloak — Web Worker.
 *
 * Runs document parsing, PII detection and replacement off the main thread so
 * the UI stays responsive. Document data is received ONLY via postMessage from
 * the same-origin page and is never sent over the network — this worker makes no
 * fetch/XHR calls at all.
 */

import { detect, aggregate, applyReplacements, keyOf } from './detectors.js';
import { parseDocx, buildDocx } from './docx.js';
import { parseXlsx, buildXlsx } from './xlsx.js';

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Kept in the worker so large documents aren't cloned back and forth on every
// edit. Cleared on reset.
let currentText = '';
let currentFindings = [];
let currentModel = null;   // DOCX/XLSX model (null for plain text)
let currentFormat = 'txt';

self.addEventListener('message', (e) => { handle(e.data || {}); });

async function handle(msg) {
  try {
    switch (msg.cmd) {
      case 'analyze': {
        currentFormat = (msg.format === 'docx' || msg.format === 'xlsx') ? msg.format : 'txt';
        if (currentFormat === 'docx') {
          currentModel = await parseDocx(msg.buffer);
          currentText = currentModel.text;
        } else if (currentFormat === 'xlsx') {
          currentModel = await parseXlsx(msg.buffer);
          currentText = currentModel.text;
        } else {
          currentModel = null;
          currentText = typeof msg.text === 'string' ? msg.text : '';
        }
        currentFindings = detect(currentText, msg.options || {});
        const rows = aggregate(currentFindings, msg.options || {});
        self.postMessage({ ok: true, type: 'analyzed', findings: currentFindings, rows });
        break;
      }
      case 'apply': {
        const rows = Array.isArray(msg.rows) ? msg.rows : [];
        const byKey = new Map(rows.map((r) => [keyOf(r.type, r.value), r]));
        const preview = applyReplacements(currentText, currentFindings, byKey);
        if ((currentFormat === 'docx' || currentFormat === 'xlsx') && currentModel) {
          const bytes = currentFormat === 'docx'
            ? await buildDocx(currentModel, currentFindings, byKey)
            : await buildXlsx(currentModel, currentFindings, byKey);
          self.postMessage(
            {
              ok: true, type: 'applied', binary: true, ext: currentFormat,
              mime: MIME[currentFormat], output: bytes, preview,
            },
            [bytes.buffer]
          );
        } else {
          self.postMessage({
            ok: true, type: 'applied', binary: false, ext: 'txt',
            mime: 'text/plain;charset=utf-8', output: preview, preview,
          });
        }
        break;
      }
      case 'reset': {
        currentText = '';
        currentFindings = [];
        currentModel = null;
        currentFormat = 'txt';
        self.postMessage({ ok: true, type: 'reset' });
        break;
      }
      default:
        self.postMessage({ ok: false, type: 'error', error: 'Unknown command' });
    }
  } catch (err) {
    // Never include document content in error messages.
    self.postMessage({ ok: false, type: 'error', error: 'Processing failed' });
  }
}
