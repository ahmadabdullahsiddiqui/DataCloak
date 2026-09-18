/* DataCloak — minimal image-only PDF writer.
 *
 * Assembles a PDF whose pages are each a single full-page JPEG (DCTDecode).
 * Pure: no DOM, no I/O — so it can be unit-tested in Node. Used by the PDF
 * redaction path, where rasterised pages guarantee the original text is gone.
 */

export function assembleImagePdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offsets = [];
  const wr = (s) => {
    const u = typeof s === 'string' ? enc.encode(s) : s;
    parts.push(u);
    len += u.length;
  };
  const setObj = (n) => { offsets[n] = len; };

  // %PDF-1.7 + a binary comment so tools treat the file as binary.
  wr(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const N = pages.length;
  const CATALOG = 1;
  const PAGES = 2;
  const pageNum = (k) => 3 + k * 3;
  const imgNum = (k) => 4 + k * 3;
  const contentNum = (k) => 5 + k * 3;
  const totalObjs = 2 + N * 3;

  setObj(CATALOG);
  wr(`${CATALOG} 0 obj\n<< /Type /Catalog /Pages ${PAGES} 0 R >>\nendobj\n`);

  setObj(PAGES);
  const kids = Array.from({ length: N }, (_, k) => `${pageNum(k)} 0 R`).join(' ');
  wr(`${PAGES} 0 obj\n<< /Type /Pages /Count ${N} /Kids [${kids}] >>\nendobj\n`);

  for (let k = 0; k < N; k++) {
    const { jpeg, width, height } = pages[k];

    setObj(pageNum(k));
    wr(`${pageNum(k)} 0 obj\n<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${width} ${height}] ` +
       `/Resources << /XObject << /Im0 ${imgNum(k)} 0 R >> >> /Contents ${contentNum(k)} 0 R >>\nendobj\n`);

    setObj(imgNum(k));
    wr(`${imgNum(k)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
       `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    wr(jpeg);
    wr('\nendstream\nendobj\n');

    const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
    const cbytes = enc.encode(content);
    setObj(contentNum(k));
    wr(`${contentNum(k)} 0 obj\n<< /Length ${cbytes.length} >>\nstream\n`);
    wr(cbytes);
    wr('\nendstream\nendobj\n');
  }

  const xrefStart = len;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  }
  wr(xref);
  wr(`trailer\n<< /Size ${totalObjs + 1} /Root ${CATALOG} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  let total = 0;
  for (const u of parts) total += u.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const u of parts) { out.set(u, o); o += u.length; }
  return out;
}
