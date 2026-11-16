// Minimal, dependency-free .xlsx reader (first sheet → array of rows).
// Uses the browser's built-in DecompressionStream to unzip the workbook.

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer, wanted) {
  const dv = new DataView(buffer);
  const len = buffer.byteLength;
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid .xlsx workbook.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const lName = dv.getUint16(localOff + 26, true);
    const lExtra = dv.getUint16(localOff + 28, true);
    const data = new Uint8Array(buffer, localOff + 30 + lName + lExtra, compSize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = await inflateRaw(data);
    else continue;
    out[name] = dec.decode(bytes);
  }
  return out;
}

function xml(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}
function all(node, local) {
  return Array.from(node.getElementsByTagNameNS('*', local));
}
function colIndex(ref) {
  const letters = (String(ref).match(/^[A-Z]+/i) || ['A'])[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(buffer) {
  const files = await unzip(buffer, n => /^xl\/(workbook\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(n));
  // Resolve the first sheet's file
  let sheetPath = null;
  if (files['xl/workbook.xml'] && files['xl/_rels/workbook.xml.rels']) {
    const wb = xml(files['xl/workbook.xml']);
    const first = all(wb, 'sheet')[0];
    const rid = first && (first.getAttribute('r:id') ||
      first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rels = xml(files['xl/_rels/workbook.xml.rels']);
    const rel = all(rels, 'Relationship').find(r => r.getAttribute('Id') === rid);
    if (rel) {
      let target = rel.getAttribute('Target').replace(/^\//, '');
      if (!target.startsWith('xl/')) target = 'xl/' + target;
      sheetPath = target;
    }
  }
  if (!sheetPath || !files[sheetPath]) {
    sheetPath = Object.keys(files).filter(n => n.startsWith('xl/worksheets/')).sort()[0];
  }
  if (!sheetPath) throw new Error('No worksheet found in this workbook.');

  const shared = files['xl/sharedStrings.xml']
    ? all(xml(files['xl/sharedStrings.xml']), 'si').map(si => all(si, 't').map(t => t.textContent).join(''))
    : [];

  const sheet = xml(files[sheetPath]);
  const rows = [];
  for (const row of all(sheet, 'row')) {
    const r = [];
    let auto = 0;
    for (const c of all(row, 'c')) {
      const ref = c.getAttribute('r');
      const ci = ref ? colIndex(ref) : auto;
      auto = ci + 1;
      const t = c.getAttribute('t');
      const v = all(c, 'v')[0];
      let val = '';
      if (t === 's') val = shared[Number(v && v.textContent)] ?? '';
      else if (t === 'inlineStr') val = all(c, 't').map(x => x.textContent).join('');
      else if (t === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
      else val = v ? v.textContent : '';
      // whole numbers stored as floats (e.g. 9876543210.0) → plain digits
      if (!t || t === 'n') {
        if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(val)) {
          const num = Number(val);
          if (Number.isFinite(num) && Number.isInteger(num) && Math.abs(num) < 1e16) val = num.toFixed(0);
        }
      }
      r[ci] = val;
    }
    for (let i = 0; i < r.length; i++) if (r[i] === undefined) r[i] = '';
    const ri = Number(row.getAttribute('r')) - 1;
    if (Number.isInteger(ri) && ri >= rows.length) { while (rows.length < ri) rows.push([]); }
    rows.push(r);
  }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}
