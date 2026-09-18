/* Security test: document processing must not perform any network I/O.
 *
 * Two complementary checks:
 *  1. Runtime: monkeypatch every network primitive to throw, then run the full
 *     detect → replace pipeline. If anything tries to reach the network, the
 *     test fails.
 *  2. Static: scan the processing sources (detectors.js, worker.js) for network
 *     APIs so a future edit can't silently introduce exfiltration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { process as run } from '../docs/detectors.js';

test('processing performs no network calls at runtime', async () => {
  const calls = [];
  const trap = (name) => (...args) => { calls.push(name); throw new Error(`network blocked: ${name}`); };

  const g = globalThis;
  const saved = {
    fetch: g.fetch,
    XMLHttpRequest: g.XMLHttpRequest,
    WebSocket: g.WebSocket,
    sendBeacon: g.navigator && g.navigator.sendBeacon,
    EventSource: g.EventSource,
  };
  g.fetch = trap('fetch');
  g.XMLHttpRequest = function () { trap('XMLHttpRequest')(); };
  g.WebSocket = function () { trap('WebSocket')(); };
  g.EventSource = function () { trap('EventSource')(); };
  if (g.navigator) { try { g.navigator.sendBeacon = trap('sendBeacon'); } catch { /* readonly */ } }

  try {
    const sample = [
      'Ahmad Abdullah, ahmad@example.de, +49 30 1234567',
      'IBAN DE89370400440532013000, BIC COBADEFFXXX',
      'Kundennummer: KD-99887, 10115 Berlin, geboren 12.03.1985',
    ].join('\n');

    const anon = run(sample, { mode: 'anonymize' });
    const pseudo = run(sample, { mode: 'pseudonymize' });

    assert.ok(anon.output.includes('[EMAIL]'));
    assert.ok(pseudo.output.includes('Person-001'));
    assert.equal(calls.length, 0, `network primitives were called: ${calls.join(', ')}`);
  } finally {
    g.fetch = saved.fetch;
    g.XMLHttpRequest = saved.XMLHttpRequest;
    g.WebSocket = saved.WebSocket;
    g.EventSource = saved.EventSource;
    if (g.navigator && saved.sendBeacon) { try { g.navigator.sendBeacon = saved.sendBeacon; } catch { /* */ } }
  }
});

test('processing sources contain no network APIs', async () => {
  const files = ['../docs/detectors.js', '../docs/worker.js', '../docs/zip.js',
    '../docs/ooxml.js', '../docs/docx.js', '../docs/xlsx.js', '../docs/zipbundle.js'];
  const forbidden = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\bWebSocket\b/,
    /sendBeacon/,
    /EventSource/,
    /\bimportScripts\s*\(\s*['"]https?:/,
    /import\s*\(\s*['"]https?:/,
  ];
  for (const rel of files) {
    const src = await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    for (const re of forbidden) {
      assert.ok(!re.test(src), `${rel} must not contain ${re}`);
    }
  }
});

test('worker only imports the local detectors module', async () => {
  const src = await readFile(fileURLToPath(new URL('../docs/worker.js', import.meta.url)), 'utf8');
  const imports = [...src.matchAll(/import[^'"]*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(spec.startsWith('./') || spec.startsWith('../'), `non-local import: ${spec}`);
  }
});
