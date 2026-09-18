# DataCloak — Architecture

## 1. Overview

DataCloak is a **client-only** web application. All document processing happens
in the user's browser. There is no application backend; the only server role is
to deliver static files (HTML, CSS, JS, fonts, icons), which any static host
(e.g. GitHub Pages) can do.

```
Browser (single origin, no network needed after load)
   │
   ├── Main thread (app.js)
   │      ├── File API: read file locally (no upload)
   │      ├── UI: workflow, review table, mapping editor
   │      └── File generation + download (Blob + Object URL)
   │
   └── Web Worker (worker.js)  ← document text only via postMessage
          ├── Format parsing (MVP: TXT; later: PDF/DOCX/XLSX)
          ├── PII detection (detectors.js — regex, dictionaries, checksums)
          └── Replacement (anonymise / pseudonymise)

   ✕ Backend processing   ✕ Cloud AI/LLM
   ✕ Document upload       ✕ Third-party API
```

## 2. Components

| Component            | File                | Responsibility                                    |
| -------------------- | ------------------- | ------------------------------------------------- |
| App shell            | `docs/index.html`   | Markup, CSP, PWA meta, status indicators          |
| Styles               | `docs/styles.css`   | B2B UI, light/dark                                |
| Orchestration/UI     | `docs/app.js`       | File API, drag & drop, review table, download     |
| Worker               | `docs/worker.js`    | Off-thread parse → detect → replace               |
| Detection engine     | `docs/detectors.js` | Pure functions: detect + replace (also unit-tested) |
| Service worker       | `docs/sw.js`        | Offline precache; document data never touched     |
| Manifest             | `docs/manifest.json`| PWA install metadata                              |
| Preview server       | `preview.mjs`       | Local static server for `docs/` (dev only)        |

`detectors.js` contains **no DOM and no I/O** — it is a set of pure functions so
it can run in the worker *and* be imported directly by the Node test suite.

## 3. Data-flow diagram

```
[User selects file]
   │  File API (FileReader / file.text()) — local read, no HTTP
   ▼
[ArrayBuffer / string in memory (main thread)]
   │  structured clone via postMessage  →  Web Worker
   ▼
[Worker: parse to plain text]
   │
   ▼
[Worker: detect PII]  →  findings[] {type, value, start, end}
   │  postMessage  →  main thread
   ▼
[UI: review table]  user toggles active / edits replacement
   │
   ▼
[Worker: apply replacements]  (anonymise or pseudonymise)
   │  postMessage  →  main thread
   ▼
[Blob → Object URL → <a download>]  user saves file locally
   │  URL.revokeObjectURL() after download
   ▼
[Reset: drop references so GC can reclaim document memory]
```

No arrow in this diagram crosses the network boundary. The only network traffic
in the whole lifecycle is the initial GET of the static assets.

## 4. Detection strategy

Local, deterministic techniques only — **no external AI**:

- **Regular expressions** for structured identifiers (e-mail, IBAN, BIC, IP,
  postcode, dates, tax ID, vehicle plate, URL, generic ID patterns).
- **Checksum validation** where a standard exists (IBAN mod-97, German
  `Steuer-IdNr` check digit) to cut false positives.
- **Dictionaries + heuristics** for person names (known first-name list plus
  capitalised-token adjacency). Names are inherently fuzzy; the review step is
  where the human confirms.
- **User-configurable rules**: additional regex identifiers added at runtime in
  the UI.

Optional browser-local NLP can be layered in later (e.g. a small self-hosted
WASM/ONNX model) **without** changing the network guarantees — it would ship as
a self-hosted asset and run in the worker. Not part of the MVP.

## 5. Replacement modes

- **Anonymise** — replace with a type token: `[PERSON]`, `[EMAIL]`, `[IBAN]`.
- **Pseudonymise** — replace with a stable per-value alias: `Person-001`,
  `email-001@example.invalid`. Identical values map to the same alias within a
  document (a `Map<originalValue, alias>` held only in memory).

Replacement is applied on original offsets, processed right-to-left so earlier
offsets stay valid as the string length changes.

## 6. Format handling (roadmap)

| Format | MVP | Approach                                                              |
| ------ | --- | -------------------------------------------------------------------- |
| TXT    | ✅  | Read as text; detect; replace; re-encode UTF-8.                      |
| DOCX   | ✅  | In-house ZIP parse (`zip.js`) + Compression Streams; rewrite `<w:t>` runs across body/headers/footers/notes, cross-run aware; re-zip. No library. |
| XLSX   | ✅  | Shared OOXML engine (`ooxml.js`): rewrite `<t>` text in `sharedStrings.xml` + worksheet inline strings; numeric `<v>` cells and `<f>` formulas untouched. |
| PDF    | ✅  | **Secure rasterised redaction** (`pdfredact.js` + vendored pdf.js, `imagepdf.js`): render each page locally, paint over PII runs, export an image-only PDF — the original text is gone, not merely covered. Runs on the main thread (pdf.js has its own worker). |

## 7. Dependencies

**Runtime:** none for TXT/DOCX/XLSX (the ZIP/OOXML engine is our own code).
**PDF** uses **pdf.js** (Apache-2.0), version-pinned and vendored under
`docs/vendor/` — self-hosted, never from a CDN.

**Dev only:** Node.js built-ins (`node:http`, `node:test`) for the preview
server and tests. No packages are installed.

Every future document library will be evaluated for: fully client-side
operation, no network calls, license, and maintenance status — and then
**vendored** (self-hosted), never loaded from a CDN.

## 8. Resource limits (DoS hardening)

By product decision there is **no file-size limit** and the ZIP reader's
decompression caps are disabled (`Infinity`). Processing still runs in a Web
Worker, so a runaway parse can be terminated (`worker.terminate()`) without
freezing the UI, and everything stays local. The zip reader retains
configurable `maxEntries` / `maxEntryBytes` / `maxTotalBytes` guards in code —
currently set to unlimited — so a cap can be reintroduced without a rewrite if a
future deployment needs it.

See [SECURITY.md](SECURITY.md) and [THREAT-MODEL.md](THREAT-MODEL.md).
