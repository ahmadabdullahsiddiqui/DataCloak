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
        self.postMessage({ type: 'progress', value: 0.1, label: 'Einlesen…' });
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
        self.postMessage({ type: 'progress', value: 0.55, label: 'Personenbezogene Daten erkennen…' });
        currentFindings = detect(currentText, msg.options || {});
        const rows = aggregate(currentFindings, msg.options || {});
        self.postMessage({ type: 'progress', value: 1, label: 'Fertig' });
        self.postMessage({ ok: true, type: 'analyzed', findings: currentFindings, rows });
        break;
      }
      case 'apply': {
        const rows = Array.isArray(msg.rows) ? msg.rows : [];
        const byKey = new Map(rows.map((r) => [keyOf(r.type, r.value), r]));
        self.postMessage({ type: 'progress', value: 0.3, label: 'Ersetzungen anwenden…' });
        const full = applyReplacements(currentText, currentFindings, byKey);
        // Cap the on-screen preview so a huge document can't freeze the UI when
        // rendered into the DOM. The downloaded file always uses the full output.
        const PREVIEW_MAX = 20000;
        const preview = full.length > PREVIEW_MAX
          ? full.slice(0, PREVIEW_MAX) + '\n… (Vorschau gekürzt – der Download enthält das vollständige Ergebnis)'
          : full;
        if ((currentFormat === 'docx' || currentFormat === 'xlsx') && currentModel) {
          self.postMessage({ type: 'progress', value: 0.6, label: 'Datei erzeugen…' });
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
            mime: 'text/plain;charset=utf-8', output: full, preview,
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
