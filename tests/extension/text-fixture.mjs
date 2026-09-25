import {deflateRawSync} from 'node:zlib';
const enc = new TextEncoder();
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; };
const concat = arrays => { const result = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0)); let offset = 0; for (const a of arrays) { result.set(a, offset); offset += a.length; } return result; };
export function zipEntries(entries, {deflate = false} = {}) {
  const files = [], directory = []; let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const bytes = typeof data === 'string' ? enc.encode(data) : data, path = enc.encode(name), compressed = deflate ? deflateRawSync(bytes) : bytes, crc = crc32(bytes);
    const local = new Uint8Array(30 + path.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(8, deflate ? 8 : 0, true);
    l.setUint32(14, crc, true); l.setUint32(18, compressed.length, true); l.setUint32(22, bytes.length, true); l.setUint16(26, path.length, true); local.set(path, 30);
    const central = new Uint8Array(46 + path.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, deflate ? 8 : 0, true);
    c.setUint32(16, crc, true); c.setUint32(20, compressed.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, path.length, true); c.setUint32(42, offset, true); central.set(path, 46);
    files.push(local, compressed); directory.push(central); offset += local.length + compressed.length;
  }
  const central = concat(directory), end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, directory.length, true); view.setUint16(10, directory.length, true); view.setUint32(12, central.length, true); view.setUint32(16, offset, true);
  return concat([...files, central, end]);
}
export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const escapeXml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function docx(paragraphs, options = {}) {
  const xml = options.xml ?? `<w:document xmlns:w="${W}"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  return zipEntries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': xml,
    ...options.extraEntries,
  }, {deflate: options.deflate || false});
}
