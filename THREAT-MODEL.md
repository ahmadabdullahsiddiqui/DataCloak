# DataCloak — Threat Model

## Assets

1. **Document content** (the uploaded file and its extracted text) — most sensitive.
2. **Detected PII** (findings list).
3. **Replacement / mapping table** (original → alias). This *re-identifies*
   pseudonymised data, so it is as sensitive as the source.
4. **The output document** (anonymised/pseudonymised copy).

## Trust boundaries

```
┌──────────────────────────────────────────────┐
│ User's browser (trusted for processing)        │
│   ┌───────────────┐   postMessage  ┌─────────┐ │
│   │ Main thread    │ ─────────────► │ Worker  │ │
│   └───────────────┘ ◄───────────── └─────────┘ │
│           ▲                                      │
└───────────┼──────────────────────────────────────┘
            │ HTTPS GET (static assets only, at load)
            ▼
   ┌────────────────────────┐
   │ Static host (untrusted  │  ← must never receive document data
   │ w.r.t. document content)│
   └────────────────────────┘
```

The **document must never cross the browser→host boundary**. It is the core
security property.

## Threats & mitigations

| # | Threat | Mitigation |
|---|--------|------------|
| T1 | Document uploaded to a server | No form submit, no `fetch`/`XHR`/`sendBeacon`/WebSocket with document data. `connect-src 'self'` (only same-origin, only static assets). Automated test asserts no such request occurs during processing. |
| T2 | Content leaked to external AI/analytics/CDN | No third-party origins in CSP; no analytics; no error-tracking of content; all assets self-hosted. |
| T3 | Content persisted where it can be recovered later | No `localStorage`/`IndexedDB`/cookies for document data; processing in memory; references dropped on reset. |
| T4 | Content leaked via logs / errors | No `console.log` of document content or PII; error messages avoid content; no error-reporting SDK. |
| T5 | Malicious document → code execution (XSS) | Content treated as untrusted; inserted via `textContent`, never `innerHTML`; no `eval`/`new Function`; CSP without `unsafe-eval`; no dynamic import of document-derived code. |
| T6 | Malicious document → DoS (zip bomb, huge XML, decompression bomb) | File-size cap; decompression ratio + absolute size caps; entry-count caps; work in a terminable worker. |
| T7 | Unsafe PDF "redaction" (black box over recoverable text) | Redaction removes/replaces the underlying text in the output; visual masking alone is rejected. (Enforced when PDF ships.) |
| T8 | Mapping table leaked | Kept in memory; export is opt-in and warns that it contains PII and must be protected; naming makes sensitivity obvious. |
| T9 | Stale/compromised cached app via service worker | SW caches only same-origin, non-opaque, 200 responses; shell is network-first so a fixed build lands on next online load; SW never stores document data. |
| T10 | Supply-chain compromise of a dependency | MVP has zero runtime deps; future libs are vendored, pinned and reviewed — not pulled live from a CDN. |

## Out of scope

- A compromised browser, OS, or malicious browser extension (can read any page).
- The user deliberately choosing to export and then mishandle the mapping file.
- Physical access / shoulder-surfing.
- Cryptographic guarantees about the *output* document beyond "the redacted text
  is not present in it".

## Residual risk

Name detection is heuristic; some PII may be missed or over-matched. The
mandatory human review step is the control for this, and the UI states that
automated detection is assistive, not exhaustive.
