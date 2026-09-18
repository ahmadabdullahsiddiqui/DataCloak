import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip } from '../docs/zip.js';
import { parseDocx, buildDocx } from '../docs/docx.js';
import { detect, aggregate } from '../docs/detectors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const u8 = (s) => encoder.encode(s);

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Ahmad Abdullah</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Mail: </w:t></w:r><w:r><w:t>ahmad@example</w:t></w:r><w:r><w:t>.de</w:t></w:r></w:p>
<w:p><w:r><w:t>Firma Tom &amp; Jerry, Kundennummer: KD-77</w:t></w:r></w:p>
</w:body></w:document>`;

const HEADER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Kontakt Max Mustermann</w:t></w:r></w:p></w:hdr>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;

async function makeDocx() {
  return zip([
    { name: '[Content_Types].xml', data: u8(CONTENT_TYPES) },
    { name: 'word/document.xml', data: u8(DOCUMENT_XML) },
    { name: 'word/header1.xml', data: u8(HEADER_XML) },
  ]);
}

async function partText(bytes, name) {
  const files = await unzip(bytes);
  return decoder.decode(files.get(name));
}

test('zip round-trips content and CRC', async () => {
  const bytes = await zip([{ name: 'a.txt', data: u8('Grüße & Umlauts äöü') }]);
  const files = await unzip(bytes);
  assert.equal(decoder.decode(files.get('a.txt')), 'Grüße & Umlauts äöü');
});

test('parseDocx joins runs and paragraphs into detectable text', async () => {
  const model = await parseDocx(await makeDocx());
  assert.ok(model.text.includes('Ahmad Abdullah'));
  // email split across two runs must be readable as one value
  assert.ok(model.text.includes('ahmad@example.de'));
  // entity decoded
  assert.ok(model.text.includes('Tom & Jerry'));
  // header part contributed its text
  assert.ok(model.text.includes('Max Mustermann'));

  const found = detect(model.text).map((f) => f.value);
  assert.ok(found.includes('Ahmad Abdullah'));
  assert.ok(found.includes('ahmad@example.de'));
  assert.ok(found.includes('Max Mustermann'));
  assert.ok(found.includes('KD-77'));
});

test('buildDocx replaces PII while preserving markup (anonymize)', async () => {
  const model = await parseDocx(await makeDocx());
  const findings = detect(model.text);
  const rows = aggregate(findings, { mode: 'anonymize' });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));

  const out = await buildDocx(model, findings, byKey);
  const doc = await partText(out, 'word/document.xml');
  const hdr = await partText(out, 'word/header1.xml');

  // originals gone
  assert.ok(!doc.includes('ahmad@example'));
  assert.ok(!doc.includes('Ahmad Abdullah'));
  assert.ok(!doc.includes('KD-77'));
  assert.ok(!hdr.includes('Max Mustermann'));

  // tokens present
  assert.ok(doc.includes('[PERSON]'));
  assert.ok(doc.includes('[EMAIL]'));
  assert.ok(doc.includes('[KUNDENNR]'));
  assert.ok(hdr.includes('[PERSON]'));

  // formatting + structure preserved
  assert.ok(doc.includes('<w:b/>'));
  assert.ok(doc.includes('xml:space="preserve"'));
  assert.ok(doc.includes('Tom &amp; Jerry')); // entity re-encoded, text intact
  assert.ok(doc.includes('<w:t>Mail: </w:t>') || doc.includes('Mail: '));
});

test('buildDocx pseudonymize is stable and re-openable', async () => {
  const model = await parseDocx(await makeDocx());
  const findings = detect(model.text);
  const rows = aggregate(findings, { mode: 'pseudonymize' });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));

  const out = await buildDocx(model, findings, byKey);
  const files = await unzip(out); // must still be a valid ZIP
  assert.ok(files.has('word/document.xml'));
  assert.ok(files.has('[Content_Types].xml'));

  const doc = decoder.decode(files.get('word/document.xml'));
  assert.ok(/Person-00\d/.test(doc));
  assert.ok(doc.includes('email-001@example.invalid'));
});

test('deactivated rows leave the DOCX text unchanged', async () => {
  const model = await parseDocx(await makeDocx());
  const findings = detect(model.text);
  const rows = aggregate(findings, { mode: 'anonymize' });
  rows.forEach((r) => { r.active = false; });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));

  const out = await buildDocx(model, findings, byKey);
  const doc = await partText(out, 'word/document.xml');
  assert.ok(doc.includes('Ahmad Abdullah'));
  assert.ok(doc.includes('KD-77'));
});
