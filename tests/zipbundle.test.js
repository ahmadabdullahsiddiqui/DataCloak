import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip } from '../docs/zip.js';
import { parseZip, buildZip } from '../docs/zipbundle.js';
import { detect, aggregate } from '../docs/detectors.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const u8 = (s) => enc.encode(s);

const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Ahmad Abdullah, ahmad@example.de</w:t></w:r></w:p>
</w:body></w:document>`;

const IMAGE = Uint8Array.from({ length: 1024 }, (_, i) => (i * 13 + 5) & 0xff);

async function makeInnerDocx() {
  return zip([
    { name: '[Content_Types].xml', data: u8('<?xml version="1.0"?><Types/>') },
    { name: 'word/document.xml', data: u8(DOCX_DOCUMENT) },
  ]);
}

async function makeBundle() {
  return zip([
    { name: 'notes.txt', data: u8('Kontakt Ahmad Abdullah, Mail ahmad@example.de') },
    { name: 'letter.docx', data: await makeInnerDocx() },
    { name: 'logo.png', data: IMAGE },
  ]);
}

test('parseZip collects text from all supported inner files', async () => {
  const model = await parseZip(await makeBundle());
  assert.ok(model.text.includes('Ahmad Abdullah'));
  assert.ok(model.text.includes('ahmad@example.de'));
  assert.equal(model.subs.length, 2); // txt + docx (png is not a sub)
  assert.equal(model.entryCount, 3);
});

test('buildZip anonymises every inner file and passes others through', async () => {
  const model = await parseZip(await makeBundle());
  const findings = detect(model.text);
  const rows = aggregate(findings, { mode: 'anonymize' });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));

  const out = await buildZip(model, findings, byKey);
  const files = await unzip(out);

  // txt processed
  const txt = dec.decode(files.get('notes.txt'));
  assert.ok(txt.includes('[PERSON]'));
  assert.ok(txt.includes('[EMAIL]'));
  assert.ok(!txt.includes('ahmad@example.de'));

  // docx processed (unwrap inner docx and check its document.xml)
  const innerDocx = await unzip(files.get('letter.docx'));
  const doc = dec.decode(innerDocx.get('word/document.xml'));
  assert.ok(doc.includes('[PERSON]'));
  assert.ok(doc.includes('[EMAIL]'));
  assert.ok(!doc.includes('Ahmad Abdullah'));

  // png passed through byte-identical
  assert.deepEqual(files.get('logo.png'), IMAGE);
});

test('pseudonyms are consistent across files in the bundle', async () => {
  const model = await parseZip(await makeBundle());
  const findings = detect(model.text);
  const rows = aggregate(findings, { mode: 'pseudonymize' });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));

  const out = await buildZip(model, findings, byKey);
  const files = await unzip(out);
  const txt = dec.decode(files.get('notes.txt'));
  const innerDocx = await unzip(files.get('letter.docx'));
  const doc = dec.decode(innerDocx.get('word/document.xml'));

  // "Ahmad Abdullah" -> the SAME pseudonym in both the txt and the docx
  assert.ok(txt.includes('Person-001'));
  assert.ok(doc.includes('Person-001'));
  assert.ok(txt.includes('email-001@example.invalid'));
  assert.ok(doc.includes('email-001@example.invalid'));
});
