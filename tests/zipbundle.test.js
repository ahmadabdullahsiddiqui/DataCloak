import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip, unzipEntries } from '../docs/zip.js';
import { parseZip, analyzeZip, buildZip } from '../docs/zipbundle.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const u8 = (s) => enc.encode(s);
const key = (r) => `${r.type} ${r.value}`;

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

function analyzeAndKey(model, mode) {
  const rows = analyzeZip(model, { mode });
  return new Map(rows.map((r) => [key(r), r]));
}

test('parseZip collects the supported inner files (no giant combined string)', async () => {
  const model = await parseZip(await makeBundle());
  assert.equal(model.subs.length, 2); // txt + docx (png passes through)
  assert.ok(model.subs.find((s) => s.name === 'notes.txt').text.includes('Ahmad Abdullah'));
  assert.ok(model.subs.find((s) => s.name === 'letter.docx').text.includes('ahmad@example.de'));
  assert.equal(model.text, undefined); // deliberately no combined string
});

test('buildZip anonymises every inner file and passes others through', async () => {
  const model = await parseZip(await makeBundle());
  const byKey = analyzeAndKey(model, 'anonymize');

  const out = await buildZip(model, byKey);
  const files = await unzip(out);

  const txt = dec.decode(files.get('notes.txt'));
  assert.ok(txt.includes('[PERSON]'));
  assert.ok(txt.includes('[EMAIL]'));
  assert.ok(!txt.includes('ahmad@example.de'));

  const innerDocx = await unzip(files.get('letter.docx'));
  const doc = dec.decode(innerDocx.get('word/document.xml'));
  assert.ok(doc.includes('[PERSON]'));
  assert.ok(doc.includes('[EMAIL]'));
  assert.ok(!doc.includes('Ahmad Abdullah'));

  assert.deepEqual(files.get('logo.png'), IMAGE); // byte-identical passthrough
});

// Flip the compression method of a named entry (local + central headers) to an
// unsupported value, to simulate an archive made by another tool.
function corruptMethod(zipBytes, targetName, method) {
  const buf = zipBytes.slice();
  const dv = new DataView(buf.buffer);
  const nameBytes = new TextEncoder().encode(targetName);
  const matchesAt = (off) => nameBytes.every((b, i) => buf[off + i] === b);
  for (let i = 0; i + 4 < buf.length; i++) {
    const sig = dv.getUint32(i, true);
    if (sig === 0x04034b50) {
      const nameLen = dv.getUint16(i + 26, true);
      if (nameLen === nameBytes.length && matchesAt(i + 30)) dv.setUint16(i + 8, method, true);
    } else if (sig === 0x02014b50) {
      const nameLen = dv.getUint16(i + 28, true);
      if (nameLen === nameBytes.length && matchesAt(i + 46)) dv.setUint16(i + 10, method, true);
    }
  }
  return buf;
}

test('an entry with an unsupported method does not break the whole archive', async () => {
  const bundle = await zip([
    { name: 'ok.txt', data: u8('Ahmad Abdullah hier') },
    { name: 'weird.dat', data: Uint8Array.from({ length: 300 }, (_, i) => i & 0xff) },
  ]);
  const broken = corruptMethod(bundle, 'weird.dat', 99);

  const model = await parseZip(broken);
  assert.ok(model.subs.some((s) => s.name === 'ok.txt'));
  const byKey = analyzeAndKey(model, 'anonymize');
  const out = await buildZip(model, byKey);
  const { files } = await unzipEntries(out); // tolerant reader
  assert.ok(dec.decode(files.get('ok.txt')).includes('[PERSON]'));
  assert.ok(files.has('weird.dat'));
});

test('pseudonyms are consistent across files in the bundle', async () => {
  const model = await parseZip(await makeBundle());
  const byKey = analyzeAndKey(model, 'pseudonymize');

  const out = await buildZip(model, byKey);
  const files = await unzip(out);
  const txt = dec.decode(files.get('notes.txt'));
  const innerDocx = await unzip(files.get('letter.docx'));
  const doc = dec.decode(innerDocx.get('word/document.xml'));

  assert.ok(txt.includes('Person-001'));
  assert.ok(doc.includes('Person-001'));
  assert.ok(txt.includes('email-001@example.invalid'));
  assert.ok(doc.includes('email-001@example.invalid'));
});
