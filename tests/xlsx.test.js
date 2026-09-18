import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zip, unzip } from '../docs/zip.js';
import { parseXlsx, buildXlsx } from '../docs/xlsx.js';
import { detect, aggregate } from '../docs/detectors.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const u8 = (s) => enc.encode(s);

// Shared strings hold most text; a name is split across two rich-text runs in
// one cell to exercise cross-run joining. A worksheet inline string carries an
// email. A numeric cell and a formula must stay untouched.
const SHARED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
<si><t>Ahmad Abdullah</t></si>
<si><r><t>Kundennummer: </t></r><r><t>KD-88</t></r></si>
<si><t xml:space="preserve">Firma Tom &amp; Jerry</t></si>
</sst>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>ahmad@example.de</t></is></c><c r="B2"><v>42</v></c><c r="C2"><f>A2&amp;B2</f><v>x</v></c></row>
</sheetData></worksheet>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;

async function makeXlsx() {
  return zip([
    { name: '[Content_Types].xml', data: u8(CONTENT_TYPES) },
    { name: 'xl/sharedStrings.xml', data: u8(SHARED) },
    { name: 'xl/worksheets/sheet1.xml', data: u8(SHEET) },
  ]);
}

async function partText(bytes, name) {
  const files = await unzip(bytes);
  return dec.decode(files.get(name));
}

test('parseXlsx pulls text from shared strings and inline strings', async () => {
  const model = await parseXlsx(await makeXlsx());
  assert.ok(model.text.includes('Ahmad Abdullah'));
  assert.ok(model.text.includes('KD-88'));          // joined across two runs
  assert.ok(model.text.includes('ahmad@example.de')); // worksheet inline string
  assert.ok(model.text.includes('Tom & Jerry'));      // entity decoded

  const found = detect(model.text).map((f) => f.value);
  assert.ok(found.includes('Ahmad Abdullah'));
  assert.ok(found.includes('ahmad@example.de'));
  assert.ok(found.includes('KD-88'));
});

test('buildXlsx replaces PII and preserves numbers/formulas (anonymize)', async () => {
  const model = await parseXlsx(await makeXlsx());
  const findings = detect(model.text);
  const rows = aggregate(findings, { mode: 'anonymize' });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));

  const out = await buildXlsx(model, findings, byKey);
  const shared = await partText(out, 'xl/sharedStrings.xml');
  const sheet = await partText(out, 'xl/worksheets/sheet1.xml');

  // originals gone
  assert.ok(!shared.includes('Ahmad Abdullah'));
  assert.ok(!shared.includes('KD-88'));
  assert.ok(!sheet.includes('ahmad@example.de'));

  // tokens present
  assert.ok(shared.includes('[PERSON]'));
  assert.ok(shared.includes('[KUNDENNR]'));
  assert.ok(sheet.includes('[EMAIL]'));

  // numbers, formulas and entities preserved
  assert.ok(sheet.includes('<v>42</v>'));
  assert.ok(sheet.includes('<f>A2&amp;B2</f>'));
  assert.ok(shared.includes('Tom &amp; Jerry'));
});

test('buildXlsx stays a valid, re-openable ZIP (pseudonymize)', async () => {
  const model = await parseXlsx(await makeXlsx());
  const findings = detect(model.text);
  const rows = aggregate(findings, { mode: 'pseudonymize' });
  const byKey = new Map(rows.map((r) => [`${r.type} ${r.value}`, r]));

  const out = await buildXlsx(model, findings, byKey);
  const files = await unzip(out);
  assert.ok(files.has('xl/sharedStrings.xml'));
  assert.ok(files.has('[Content_Types].xml'));
  assert.ok(dec.decode(files.get('xl/sharedStrings.xml')).includes('Person-001'));
});
