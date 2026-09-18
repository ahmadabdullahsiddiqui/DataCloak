# DataCloak

**Local, in-browser detection, anonymisation and pseudonymisation of personal
data (PII) in documents.**

DataCloak reads a document, finds personal data in it, lets you review and edit
every replacement, and produces an anonymised or pseudonymised copy — **entirely
inside your browser**. Documents, extracted text, detected PII and the
replacement map never leave your device.

> **Note on wording:** DataCloak is built with a *privacy-by-design*
> architecture (local processing, no upload, no external AI). It does **not**
> claim to make your overall use "100 % GDPR-compliant" — that depends on your
> operations, hosting, logging, records of processing and organisational
> measures. See [PRIVACY.md](PRIVACY.md).

## What makes it safe by design

The document content is **never transmitted to a server for processing**. There
is no backend, no cloud API, no external AI/LLM. After the static app has
loaded, no network connection is required to open, analyse, replace and export a
document.

| Guarantee                  | Status     |
| -------------------------- | ---------- |
| Server upload of documents | Disabled   |
| Server-side processing     | None       |
| External AI / LLM          | None       |
| Analytics on document data | None       |
| Persistent storage of docs | None       |

## Status

**`.txt` and `.docx` supported.** The full pipeline (read → detect →
review/map → replace → download → optional report) works end-to-end. DOCX keeps
the original formatting: only the text inside `<w:t>` runs (document body,
headers, footers, notes) is rewritten; PII split across adjacent runs is handled.
The ZIP container is parsed in-house and (de)compressed with the browser's
built-in Compression Streams — **no third-party library, no CDN**. There is no
file-size limit. `PDF` and `XLSX` are next. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Detected data types

E-mail, phone / mobile numbers, IBAN (with checksum), BIC, IPv4/IPv6, German
postal codes, dates of birth, German tax ID (`Steuer-IdNr`, with checksum),
vehicle plates (`Kfz-Kennzeichen`), URLs, customer/personnel/user IDs, and
person names (dictionary + capitalisation heuristics). New identifier types are
configurable via regular expressions in the UI.

## Run locally

```bash
npm run preview   # serves docs/ at http://127.0.0.1:8080
```

A static server is required because ES modules and Web Workers cannot be loaded
over `file://`. Any static host works; GitHub Pages serves the `docs/` folder
directly.

## Tests

```bash
npm test
```

Runs the detection unit tests and the "no network during processing" security
test (see [tests/](tests/)).

## Tech

Vanilla JavaScript, HTML and CSS — no framework, no build step, no
`node_modules` at runtime. Heavy analysis runs in a Web Worker. Ships as an
installable PWA that works fully offline. Strict Content-Security-Policy without
`unsafe-eval`; all assets self-hosted.

## Documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — architecture, data-flow, dependencies
- [THREAT-MODEL.md](THREAT-MODEL.md) — threat model
- [SECURITY.md](SECURITY.md) — security concept & hardening
- [PRIVACY.md](PRIVACY.md) — privacy documentation

## License

MIT © Ahmad Abdullah
