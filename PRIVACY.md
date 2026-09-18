# DataCloak — Privacy Documentation

This document describes, in technical terms, how DataCloak handles data.

## Plain-language statement (as shown in the app)

> Documents are processed locally in your browser and are **not** transmitted to
> our server or to external AI services for document processing.

We deliberately avoid unqualified claims such as "100 % GDPR-compliant". The
architecture is privacy-by-design, but overall GDPR compliance also depends on
your operations, hosting, logging, records of processing, your privacy notice,
and organisational measures.

## What data is processed

- The document you open and the text extracted from it.
- The personal data detected in that text (the findings).
- The replacement/mapping table (original value → replacement).
- The generated output document.

## Where processing happens

Entirely in your browser — on the main thread and in a local Web Worker. There
is no server-side processing and no external AI/LLM.

## What network connections the app makes

- **At load:** HTTPS GET requests to fetch the app's own static assets (HTML,
  CSS, JS, fonts, icons) from the origin that hosts it.
- **During document processing:** none. No file, text, PII or mapping data is
  sent anywhere.
- No third-party origins, analytics, trackers, or error-reporting endpoints are
  contacted.

## What data is stored

- **Document content:** not stored. It lives in memory during processing and is
  dropped on reset/after download.
- **Service worker cache:** stores only the app's own static assets so it works
  offline. It never stores document content, extracted text, PII or mappings.
- **No** cookies, `localStorage` or `IndexedDB` are used for document data.

## When data is discarded

- Object URLs created for downloads are revoked with `URL.revokeObjectURL()`.
- On reset (or loading another file), references to the previous document are
  released so the browser can reclaim the memory.
- Closing the tab discards everything (nothing is persisted).

## The mapping/report file (opt-in export)

If you export the replacement table (CSV/JSON), that file **contains personal
data** (the original values) and can re-identify pseudonymised output. The app
warns you before export. Store and share it accordingly.

## Third-party dependencies

- **MVP: none at runtime.** No third-party JavaScript is shipped for TXT
  processing. Fonts are self-hosted.
- Future document libraries (PDF/DOCX/XLSX) will be self-hosted (no CDN),
  version-pinned, and reviewed for network behaviour, license and maintenance.

## Your controls

- You choose which detected items are replaced (activate/deactivate) and can edit
  every replacement before generating the output.
- You choose whether to export the mapping/report at all.
