# DataCloak — Security Concept

## Core principle

The application is designed so that document content **does not need to reach a
server** to be processed. Security is enforced by architecture, not by promises.

## Hardening measures

### No exfiltration
- No file upload to any server; "upload" means a local read via the browser File API.
- No document processing on a server.
- No external AI/LLM APIs, no analytics on document data, no session replay, no
  tracking pixels.
- No transmission of file names, extracted text, or detected PII.

### No unwanted persistence
- No document content in `localStorage` or cookies.
- No `IndexedDB` unless strictly technically required (not used in the MVP).
- No automatic persistence; processing happens primarily in memory.
- On reset/after download, references to document data are dropped so memory can
  be reclaimed; Object URLs are released with `URL.revokeObjectURL()`.

### No leaks via side channels
- No sensitive information via `console.log`.
- No sensitive content in error messages.
- No document content sent to error-tracking systems (none are integrated).

### Untrusted-content handling
- Document content is treated as untrusted at all times.
- Rendered into the DOM via `textContent`, never `innerHTML`.
- No dynamic execution of document content (`eval`, `new Function`, dynamic
  `import` of derived code are not used).

## Content Security Policy

Delivered as a `<meta http-equiv="Content-Security-Policy">` and intended to be
reinforced by an HTTP header where the host allows it:

```
default-src 'self';
base-uri 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self';
img-src 'self' data: blob:;
font-src 'self';
media-src 'self';
connect-src 'self';
worker-src 'self' blob:;
manifest-src 'self';
object-src 'none';
form-action 'none'
```

`frame-ancestors` is intentionally NOT in the meta CSP — it is ignored there and
must be an HTTP response header, which this static host (GitHub Pages) can't set.
Clickjacking is instead mitigated by a JavaScript frame-buster in `app.js`. On a
host that can set headers, serve the CSP (with `frame-ancestors 'none'`) as an
HTTP header for full effect.

The PDF feature relaxes two directives (still **no `unsafe-eval`**):
`script-src` also allows `'wasm-unsafe-eval'` (pdf.js image decoders) and
`img-src`/`worker-src` also allow `blob:` (pdf.js worker/rendering). `connect-src`
stays `'self'`, so pdf.js can fetch only same-origin assets (its worker and
fonts) and no document data can be sent anywhere.

Notes:
- **No `unsafe-eval`.** Libraries requiring `eval` are rejected. pdf.js runs with
  `isEvalSupported: false`.
- `connect-src 'self'` limits any network call to the app's own origin (static
  assets); no third-party origin is permitted.
- `style-src 'self'` — no inline styles in markup; dynamic sizing uses CSSOM.
- `object-src 'none'` and `form-action 'none'` remove plugin and form-exfiltration vectors.

## Self-hosting / no CDN

All JavaScript, CSS, fonts and (future) WASM are self-hosted. The production app
must not depend on any public CDN.

## Offline / network protection

After the static app has loaded, no network communication is needed for document
processing. The app is a PWA and is designed to run fully offline; a dedicated
offline-hardened mode can be added.

## Web Workers

Heavy document analysis runs in a Web Worker so the UI stays responsive.
Document data is exchanged **only** between the browser main thread and local
workers via `postMessage` — never over the network. A stuck parse can be killed
with `worker.terminate()`.

## Resource / DoS limits

- **File size is unlimited by product decision**, and the ZIP reader's
  decompression caps are disabled. The trade-off: a very large or maliciously
  crafted archive can consume significant memory. This is bounded only by the
  browser tab and mitigated by running in a terminable Web Worker.
- The zip reader keeps `maxEntries` / `maxEntryBytes` / `maxTotalBytes`
  parameters (currently `Infinity`) so limits can be re-enabled centrally.
- Bounded regex use to avoid catastrophic backtracking.

## PDF redaction rule

Anonymisation, pseudonymisation and **secure PDF redaction** are distinct. A
black rectangle over text is *not* redaction. DataCloak redacts PDFs by
**rasterising**: each page is rendered locally with a vendored, self-hosted
pdf.js, PII runs are painted over, and pages are re-exported as an image-only
PDF. The output has **no text objects at all**, so the original text cannot be
copied or extracted. Trade-off: the result is not selectable text and files are
larger. Scanned/OCR-only PDFs are rendered and redacted the same way based on any
embedded text layer; if a PDF has no text layer, nothing is detected to redact.

## Sanitisation scope & residual risk (important)

Detection is **assistive, not exhaustive** — matching and replacing individual
values does NOT prove a document is fully anonymised. What is and isn't handled:

- **DOCX:** body, headers, footers, foot/endnotes **and comments** are processed;
  document metadata (author, last-modified-by, title, …) in `docProps` is scrubbed.
  **Not** inspected: text baked into embedded images, embedded objects/OLE, charts,
  and other binary parts.
- **XLSX:** shared strings, worksheet inline strings **and numeric cells** (a
  replaced numeric cell becomes an inline string) are processed; metadata scrubbed.
  Formulas are left intact — a formula that *derives* a personal value is not
  rewritten. Embedded images/objects are not inspected.
- **PDF:** redaction is based on the detected text layer and its positions. Pages
  with **no text layer (scans/images)** cannot be detected or redacted; the UI
  warns and reports how many such pages exist. Unusual fonts, rotated text and
  complex layouts should be visually verified.
- **ZIP:** only inner `.txt/.docx/.xlsx` are processed. Unsupported entries
  (images, `.pdf`, …) are passed through **unchanged**; the UI lists them and warns
  that they may still contain personal data.

The app surfaces these limits after processing and does not claim guaranteed
anonymisation. Before production use, validate outputs with a synthetic PII data
set, inspecting metadata and embedded parts of every generated file.

## Reporting

Please report security issues to github.
