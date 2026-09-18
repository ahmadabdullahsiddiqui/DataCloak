/* DataCloak — main-thread orchestration.
 *
 * Reads the file locally (File API), drives the Web Worker, renders the review
 * table, and generates the output + mapping files locally. No network calls with
 * document data — the only fetch in the whole app is the service worker fetching
 * our own static assets.
 */
(() => {
  'use strict';

  const MAX_BYTES = 25 * 1024 * 1024; // 25 MB input cap (DoS hardening)

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
  let fileName = '';
  let rows = []; // [{type,label,value,replacement,count,active}]
  let outputText = '';
  let outputUrl = null; // Object URL to revoke

  // --- helpers ------------------------------------------------------
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 3500);
  }

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
    if (file.size > MAX_BYTES) {
      showToast(`Datei zu groß (max. ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`);
      return;
    }
    const isTxt = /\.txt$/i.test(file.name) || file.type === 'text/plain' || file.type === '';
    if (!isTxt) {
      showToast('Aktuell wird nur .txt unterstützt.');
      return;
    }

    let text;
    try {
      text = await file.text(); // local read, no upload
    } catch {
      showToast('Datei konnte nicht gelesen werden.');
      return;
    }

    fileName = file.name;
    fileMeta.hidden = false;
    fileMeta.textContent = `Geladen: ${file.name} · ${formatBytes(file.size)} · lokal eingelesen`;

    // Keep the text only until analyze hands it to the worker.
    stepReview.hidden = true;
    stepResult.hidden = true;
    stepOptions.hidden = false;
    analyzeBtn.dataset.ready = '1';
    analyzeBtn.onclick = () => analyze(text);
    stepOptions.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // --- analyze ------------------------------------------------------
  function analyze(text) {
    const mode = currentMode();
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analysiere…';

    const w = getWorker();
    w.onmessage = (e) => {
      const d = e.data || {};
      if (!d.ok) { showToast('Analyse fehlgeschlagen.'); resetAnalyzeBtn(); return; }
      if (d.type === 'analyzed') {
        rows = d.rows || [];
        renderReview();
        resetAnalyzeBtn();
        stepReview.hidden = false;
        stepReview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };
    w.onerror = () => { showToast('Analyse fehlgeschlagen.'); resetAnalyzeBtn(); };
    w.postMessage({ cmd: 'analyze', text, options: { mode } });
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
    applyBtn.disabled = true;
    applyBtn.textContent = 'Erzeuge…';
    const w = getWorker();
    w.onmessage = (e) => {
      const d = e.data || {};
      if (!d.ok) { showToast('Ersetzung fehlgeschlagen.'); resetApplyBtn(); return; }
      if (d.type === 'applied') {
        outputText = d.output || '';
        preview.textContent = outputText; // untrusted-safe
        resetApplyBtn();
        mappingWarn.hidden = true;
        stepResult.hidden = false;
        stepResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };
    w.postMessage({ cmd: 'apply', rows });
  });

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
    download(outName(suffix, 'txt'), outputText, 'text/plain;charset=utf-8');
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
    rows = [];
    outputText = '';
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

  // --- service worker (offline PWA) ---------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline is optional */ });
    });
  }
})();
