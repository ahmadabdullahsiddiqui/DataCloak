/* DataCloak — main-thread orchestration.
 *
 * Reads the file locally (File API), drives the Web Worker, renders the review
 * table, and generates the output + mapping files locally. No network calls with
 * document data — the only fetch in the whole app is the service worker fetching
 * our own static assets.
 */
(() => {
  'use strict';

  const APP_VERSION = '0.5.0';

  // File size is intentionally unlimited (processing is fully local).
  const MAX_BYTES = Infinity;

  // --- element refs -------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const dropzone = $('dropzone');
  const fileInput = $('fileInput');
  const fileMeta = $('fileMeta');
  const stepOptions = $('step-options');
  const stepReview = $('step-review');
  const stepResult = $('step-result');
  const analyzeBtn = $('analyzeBtn');
  const applyBtn = $('applyBtn');
  const reviewBody = $('reviewBody');
  const reviewEmpty = $('reviewEmpty');
  const reviewCount = $('reviewCount');
  const preview = $('preview');
  const downloadBtn = $('downloadBtn');
  const mappingCsvBtn = $('mappingCsvBtn');
  const mappingJsonBtn = $('mappingJsonBtn');
  const mappingWarn = $('mappingWarn');
  const resetBtn = $('resetBtn');
  const toast = $('toast');

  // --- in-memory state (never persisted) ----------------------------
  let worker = null;
  let pdfMod = null;    // lazily imported PDF engine
  let usePdf = false;   // current file is a PDF (handled by pdfMod, not the worker)
  let pdfPageCount = 0;
  let fileName = '';
  let rows = []; // [{type,label,value,replacement,count,active}]
  let outputText = '';
  let outputBytes = null;   // Uint8Array for binary formats (DOCX)
  let outputMime = 'text/plain;charset=utf-8';
  let outputExt = 'txt';
  let outputUrl = null;     // Object URL to revoke

  // --- helpers ------------------------------------------------------
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  // --- progress bar -------------------------------------------------
  const progress = $('progress');
  const progressFill = $('progressFill');
  const progressLabel = $('progressLabel');

  function showProgress(label) {
    progress.hidden = false;
    setProgress(null, label); // start indeterminate until we know a fraction
  }
  // fraction: 0..1 for a determinate bar, or null for indeterminate.
  function setProgress(fraction, label) {
    if (fraction == null) {
      progress.classList.add('indeterminate');
      progressFill.style.width = '';
      progress.removeAttribute('aria-valuenow');
    } else {
      progress.classList.remove('indeterminate');
      const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      progressFill.style.width = pct + '%';
      progress.setAttribute('aria-valuenow', String(pct));
    }
    if (label != null) progressLabel.textContent = label;
  }
  function hideProgress() { progress.hidden = true; }

  function getWorker() {
    if (!worker) worker = new Worker('worker.js', { type: 'module' });
    return worker;
  }

  function currentMode() {
    const el = document.querySelector('input[name="mode"]:checked');
    return el ? el.value : 'anonymize';
  }

  function revokeOutputUrl() {
    if (outputUrl) {
      URL.revokeObjectURL(outputUrl);
      outputUrl = null;
    }
  }

  // --- file selection ----------------------------------------------
  function pickFile() { fileInput.click(); }

  dropzone.addEventListener('click', pickFile);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
  });

  async function handleFile(file) {
    const isTxt = /\.txt$/i.test(file.name) || file.type === 'text/plain';
    const isDocx = /\.docx$/i.test(file.name) ||
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isXlsx = /\.xlsx$/i.test(file.name) ||
      file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    const isZip = /\.zip$/i.test(file.name) ||
      file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
    if (!isTxt && !isDocx && !isXlsx && !isPdf && !isZip) {
      showToast('Unterstützt werden .txt, .docx, .xlsx, .pdf und .zip.');
      return;
    }

    let payload;
    try {
      if (isDocx) {
        payload = { format: 'docx', buffer: await file.arrayBuffer() }; // local read, no upload
      } else if (isXlsx) {
        payload = { format: 'xlsx', buffer: await file.arrayBuffer() };
      } else if (isPdf) {
        payload = { format: 'pdf', buffer: await file.arrayBuffer() };
      } else if (isZip) {
        payload = { format: 'zip', buffer: await file.arrayBuffer() };
      } else {
        payload = { format: 'txt', text: await file.text() };
      }
    } catch {
      showToast('Datei konnte nicht gelesen werden.');
      return;
    }

    fileName = file.name;
    fileMeta.hidden = false;
    fileMeta.textContent = `Geladen: ${file.name} · ${formatBytes(file.size)} · lokal eingelesen`;

    stepReview.hidden = true;
    stepResult.hidden = true;
    stepOptions.hidden = false;
    analyzeBtn.onclick = () => analyze(payload);
    stepOptions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // --- analyze ------------------------------------------------------
  function analyze(payload) {
    if (payload.format === 'pdf') { analyzePdf(payload); return; }
    usePdf = false;
    const mode = currentMode();
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analysiere…';
    showProgress('Analysiere…');

    const w = getWorker();
    w.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'progress') { setProgress(d.value, d.label); return; }
      if (!d.ok) { showToast('Analyse fehlgeschlagen.'); resetAnalyzeBtn(); hideProgress(); return; }
      if (d.type === 'analyzed') {
        rows = d.rows || [];
        renderReview();
        resetAnalyzeBtn();
        hideProgress();
        stepReview.hidden = false;
        stepReview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };
    w.onerror = () => { showToast('Analyse fehlgeschlagen.'); resetAnalyzeBtn(); hideProgress(); };

    const msg = { cmd: 'analyze', format: payload.format, options: { mode } };
    if (payload.buffer) msg.buffer = payload.buffer; // structured-clone copy: keeps
    else msg.text = payload.text;                    // the original usable for re-analyze
    w.postMessage(msg);
  }

  async function analyzePdf(payload) {
    usePdf = true;
    const mode = currentMode();
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analysiere…';
    showProgress('PDF wird gelesen…');
    try {
      if (!pdfMod) pdfMod = await import('./pdfredact.js');
      // Pass a copy so the stored buffer stays usable for re-analysis.
      const res = await pdfMod.analyze(payload.buffer.slice(0), {
        mode,
        onProgress: (done, total) => setProgress(done / total, `Seite ${done}/${total} analysieren…`),
      });
      rows = res.rows || [];
      pdfPageCount = res.pageCount || 0;
      renderReview();
      resetAnalyzeBtn();
      hideProgress();
      stepReview.hidden = false;
      stepReview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {
      showToast('PDF konnte nicht verarbeitet werden.');
      resetAnalyzeBtn();
      hideProgress();
    }
  }

  function resetAnalyzeBtn() {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analysieren';
  }

  // --- review table -------------------------------------------------
  function renderReview() {
    reviewBody.textContent = '';
    reviewCount.textContent = rows.length ? `${rows.length}` : '';
    reviewEmpty.hidden = rows.length > 0;
    applyBtn.hidden = rows.length === 0;

    rows.forEach((row, i) => {
      const tr = document.createElement('tr');

      const tdType = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'type-badge';
      badge.textContent = row.label; // textContent → untrusted-safe
      tdType.appendChild(badge);

      const tdOrig = document.createElement('td');
      tdOrig.className = 'mono';
      tdOrig.textContent = row.value;

      const tdRepl = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'repl';
      input.value = row.replacement;
      input.setAttribute('aria-label', `Ersetzung für ${row.value}`);
      input.addEventListener('input', () => { rows[i].replacement = input.value; });
      tdRepl.appendChild(input);

      const tdCount = document.createElement('td');
      tdCount.className = 'num';
      tdCount.textContent = String(row.count);

      const tdActive = document.createElement('td');
      tdActive.className = 'num';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = row.active !== false;
      cb.setAttribute('aria-label', `Ersetzung aktiv für ${row.value}`);
      cb.addEventListener('change', () => {
        rows[i].active = cb.checked;
        tr.classList.toggle('inactive', !cb.checked);
      });
      tdActive.appendChild(cb);

      tr.append(tdType, tdOrig, tdRepl, tdCount, tdActive);
      reviewBody.appendChild(tr);
    });
  }

  // --- apply --------------------------------------------------------
  applyBtn.addEventListener('click', () => {
    if (usePdf) { applyPdf(); return; }
    applyBtn.disabled = true;
    applyBtn.textContent = 'Erzeuge…';
    showProgress('Ergebnis wird erzeugt…');
    const w = getWorker();
    w.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'progress') { setProgress(d.value, d.label); return; }
      if (!d.ok) { showToast('Ersetzung fehlgeschlagen.'); resetApplyBtn(); hideProgress(); return; }
      if (d.type === 'applied') {
        if (d.binary) {
          outputBytes = d.output;               // Uint8Array (e.g. DOCX/XLSX)
          outputText = '';
        } else {
          outputBytes = null;
          outputText = d.output || '';          // full text for the .txt download
        }
        outputMime = d.mime || 'text/plain;charset=utf-8';
        outputExt = d.ext || 'txt';
        preview.textContent = d.preview || '';   // capped, untrusted-safe preview
        resetApplyBtn();
        hideProgress();
        mappingWarn.hidden = true;
        stepResult.hidden = false;
        stepResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };
    w.postMessage({ cmd: 'apply', rows });
  });

  async function applyPdf() {
    applyBtn.disabled = true;
    applyBtn.textContent = 'Erzeuge…';
    showProgress('PDF wird geschwärzt…');
    try {
      outputBytes = await pdfMod.build(rows, {
        onProgress: (done, total) => setProgress(done / total, `Seite ${done}/${total} schwärzen…`),
      });
      outputMime = 'application/pdf';
      outputExt = 'pdf';
      outputText = `PDF sicher geschwärzt · ${pdfPageCount} Seite(n) · als Bild-PDF exportiert. ` +
        `Der ursprüngliche Text ist im Ergebnis nicht mehr enthalten (nicht markier-/kopierbar).`;
      preview.textContent = outputText;
      resetApplyBtn();
      hideProgress();
      mappingWarn.hidden = true;
      stepResult.hidden = false;
      stepResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {
      showToast('PDF-Erzeugung fehlgeschlagen.');
      resetApplyBtn();
      hideProgress();
    }
  }

  function resetApplyBtn() {
    applyBtn.disabled = false;
    applyBtn.textContent = 'Ersetzen & Ergebnis erzeugen';
  }

  // --- downloads ----------------------------------------------------
  function download(filename, content, mime) {
    revokeOutputUrl();
    const blob = new Blob([content], { type: mime });
    outputUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = outputUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Release shortly after the click has been handled.
    setTimeout(revokeOutputUrl, 1000);
  }

  function outName(suffix, ext) {
    const base = fileName.replace(/\.[^.]+$/, '') || 'dokument';
    return `${base}.${suffix}.${ext}`;
  }

  downloadBtn.addEventListener('click', () => {
    const mode = currentMode();
    const suffix = mode === 'pseudonymize' ? 'pseudonymisiert' : 'anonymisiert';
    const content = outputBytes ? outputBytes : outputText;
    download(outName(suffix, outputExt), content, outputMime);
  });

  function activeRows() { return rows.filter((r) => r.active !== false); }

  mappingCsvBtn.addEventListener('click', () => {
    mappingWarn.hidden = false;
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const head = ['Typ', 'Original', 'Ersetzung', 'Anzahl'].map(esc).join(',');
    const body = activeRows()
      .map((r) => [r.label, r.value, r.replacement, r.count].map(esc).join(','))
      .join('\r\n');
    download(outName('mapping', 'csv'), '﻿' + head + '\r\n' + body, 'text/csv;charset=utf-8');
  });

  mappingJsonBtn.addEventListener('click', () => {
    mappingWarn.hidden = false;
    const data = activeRows().map((r) => ({
      type: r.type, label: r.label, original: r.value,
      replacement: r.replacement, count: r.count,
    }));
    download(outName('mapping', 'json'), JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
  });

  // --- reset --------------------------------------------------------
  resetBtn.addEventListener('click', reset);

  function reset() {
    // Terminate the worker so any document text it holds is discarded.
    if (worker) { worker.terminate(); worker = null; }
    if (pdfMod) { try { pdfMod.reset(); } catch { /* */ } }
    usePdf = false;
    pdfPageCount = 0;
    rows = [];
    outputText = '';
    outputBytes = null;
    fileName = '';
    revokeOutputUrl();
    fileInput.value = '';
    reviewBody.textContent = '';
    preview.textContent = '';
    fileMeta.hidden = true;
    stepOptions.hidden = true;
    stepReview.hidden = true;
    stepResult.hidden = true;
    mappingWarn.hidden = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('Zurückgesetzt – alle Daten wurden verworfen.');
  }

  // --- version in footer --------------------------------------------
  const verEl = document.getElementById('app-version');
  if (verEl) verEl.textContent = APP_VERSION;

  // --- service worker (offline PWA) ---------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline is optional */ });
    });
  }
})();
