import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleImagePdf } from '../docs/imagepdf.js';

const dec = new TextDecoder('latin1');

// A tiny fake "JPEG" byte blob — the writer only embeds bytes, it doesn't decode.
const fakeJpeg = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);

test('image PDF has a valid structure for one page', () => {
  const jpeg = fakeJpeg(120);
  const pdf = assembleImagePdf([{ jpeg, width: 300, height: 400 }]);
  const s = dec.decode(pdf);

  assert.ok(s.startsWith('%PDF-1.7'));
  assert.ok(s.includes('/Type /Catalog'));
  assert.ok(s.includes('/Type /Pages'));
  assert.ok(s.includes('/Count 1'));
  assert.ok(s.includes('/MediaBox [0 0 300 400]'));
  assert.ok(s.includes('/Filter /DCTDecode'));
  assert.ok(s.includes(`/Length ${jpeg.length}`));
  assert.ok(s.includes('startxref'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
});

test('page count and object numbering scale with pages', () => {
  const pages = [
    { jpeg: fakeJpeg(50), width: 100, height: 100 },
    { jpeg: fakeJpeg(60), width: 200, height: 150 },
    { jpeg: fakeJpeg(70), width: 210, height: 297 },
  ];
  const s = dec.decode(assembleImagePdf(pages));
  assert.ok(s.includes('/Count 3'));
  // xref announces object 0..(2 + 3*3)=11 -> "0 12"
  assert.ok(s.includes('xref\n0 12\n'));
  // each media box present
  assert.ok(s.includes('/MediaBox [0 0 100 100]'));
  assert.ok(s.includes('/MediaBox [0 0 200 150]'));
  assert.ok(s.includes('/MediaBox [0 0 210 297]'));
});

test('xref offsets point at the real object starts', () => {
  const pdf = assembleImagePdf([{ jpeg: fakeJpeg(40), width: 10, height: 10 }]);
  const s = dec.decode(pdf);
  // Parse the xref offset for object 1 and confirm "1 0 obj" lives there.
  const xrefIdx = s.indexOf('xref\n0 ');
  const lines = s.slice(xrefIdx).split('\n');
  // lines[0]='xref', lines[1]='0 5', lines[2]=free entry, lines[3]=obj1 entry
  const off1 = parseInt(lines[3].slice(0, 10), 10);
  assert.equal(s.slice(off1, off1 + 7), '1 0 obj');
});
