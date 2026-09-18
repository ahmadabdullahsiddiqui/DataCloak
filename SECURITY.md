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
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
media-src 'self';
connect-src 'self';
worker-src 'self';
manifest-src 'self';
object-src 'none';
form-action 'none';
frame-ancestors 'none'
```

Notes:
- **No `unsafe-eval`.** Libraries requiring `eval` are rejected.
- `connect-src 'self'` limits any network call to the app's own origin (static
  assets); no third-party origin is permitted.
- `style-src` allows `'unsafe-inline'` for pragmatic styling only; scripts do not.
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

- Maximum input file size (default 25 MB, configurable).
- Decompression ratio and absolute output-size caps for zip-based formats.
- Entry-count and per-entry size caps when unzipping DOCX/XLSX.
- Bounded regex use to avoid catastrophic backtracking.

## PDF redaction rule

Anonymisation, pseudonymisation and **secure PDF redaction** are distinct. A
black rectangle over text is *not* redaction: DataCloak removes/replaces the
underlying text in the exported PDF so it cannot be copied or extracted.

## Reporting

Please report security issues to abdullah@powerfolder.com.
