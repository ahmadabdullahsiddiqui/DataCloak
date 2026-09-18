/* DataCloak — Web Worker.
 *
 * Runs document parsing, PII detection and replacement off the main thread so
 * the UI stays responsive. Document text is received ONLY via postMessage from
 * the same-origin page and is never sent over the network — this worker makes no
 * fetch/XHR calls at all.
 */

import { detect, aggregate, applyReplacements } from './detectors.js';

// Kept in the worker so large documents aren't cloned back and forth on every
// edit. Cleared on reset.
let currentText = '';
let currentFindings = [];

self.addEventListener('message', (e) => {
  const msg = e.data || {};
  try {
    switch (msg.cmd) {
      case 'analyze': {
        currentText = typeof msg.text === 'string' ? msg.text : '';
        currentFindings = detect(currentText, msg.options || {});
        const rows = aggregate(currentFindings, msg.options || {});
        self.postMessage({
          ok: true,
          type: 'analyzed',
          findings: currentFindings,
          rows,
        });
        break;
      }
      case 'apply': {
        const rows = Array.isArray(msg.rows) ? msg.rows : [];
        const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));
        const findings = Array.isArray(msg.findings) ? msg.findings : currentFindings;
        const output = applyReplacements(currentText, findings, byKey);
        self.postMessage({ ok: true, type: 'applied', output });
        break;
      }
      case 'reset': {
        currentText = '';
        currentFindings = [];
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
});
