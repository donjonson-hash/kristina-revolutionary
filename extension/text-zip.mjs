/** Bounded ZIP extraction for DOCX. ZIP64, encryption and multi-disk are refused. */
const LIMIT = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', {fatal: true});
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crcUpdate = (crc, bytes) => { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; };
export async function unzipDocument(raw) {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), u16 = i => v.getUint16(i, true), u32 = i => v.getUint32(i, true);
  const bad = () => { throw new Error('Некорректный DOCX/ZIP. Сохраните документ заново.'); };
  if (raw.length < 22) bad();
  let end = raw.length - 22;
  while (end >= Math.max(0, raw.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < Math.max(0, raw.length - 65557) || end + 22 + u16(end + 20) !== raw.length) bad();
  const count = u16(end + 10), start = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || count !== u16(end + 8) || !count || count > 256 || start + u32(end + 12) !== end) bad();
  let cursor = start, total = 0;
  const entries = new Map(), ranges = [];
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) bad();
    const flags = u16(cursor + 8), method = u16(cursor + 10), compressed = u32(cursor + 20), size = u32(cursor + 24), checksum = u32(cursor + 16);
    const nameLength = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32), local = u32(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > end || flags & ~0x080e || ![0, 8].includes(method) || u16(cursor + 34)) bad();
    let name;
    try { name = decoder.decode(raw.subarray(cursor + 46, cursor + 46 + nameLength)); } catch { bad(); }
    if (!name || entries.has(name) || name.split('/').some(part => part === '..' || part === '.') || /[\\\0]/.test(name) || name.startsWith('/')) bad();
    if (size > LIMIT || total + size > LIMIT) throw new Error('DOCX после распаковки превышает 16 МиБ. Разделите документ.');
    if (local + 30 > start || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) bad();
    const dataStart = local + 30 + nameLength + u16(local + 28), dataEnd = dataStart + compressed;
    if (dataEnd > start || decoder.decode(raw.subarray(local + 30, local + 30 + nameLength)) !== name) bad();
    if (!(flags & 8) && (u32(local + 14) !== checksum || u32(local + 18) !== compressed || u32(local + 22) !== size)) bad();
    let rangeEnd = dataEnd;
    if (flags & 8) {
      let descriptor = dataEnd;
      if (descriptor + 4 <= start && u32(descriptor) === 0x08074b50) descriptor += 4;
      if (descriptor + 12 > start || u32(descriptor) !== checksum || u32(descriptor + 4) !== compressed || u32(descriptor + 8) !== size) bad();
      rangeEnd = descriptor + 12;
    }
    ranges.push([local, rangeEnd]);
    const chunks = []; let actual = 0, crc = 0xffffffff;
    if (method === 0) { actual = compressed; const bytes = raw.subarray(dataStart, dataEnd); chunks.push(bytes); crc = crcUpdate(crc, bytes); }
    else {
      const stream = new Blob([raw.subarray(dataStart, dataEnd)]).stream().pipeThrough(new DecompressionStream('deflate-raw')), reader = stream.getReader();
      try {
        for (;;) {
          const {done, value} = await reader.read(); if (done) break;
          actual += value.length;
          if (actual > size || total + actual > LIMIT) { await reader.cancel(); bad(); }
          chunks.push(value); crc = crcUpdate(crc, value);
        }
      } catch { bad(); } finally { reader.releaseLock(); }
    }
    if (actual !== size || ((crc ^ 0xffffffff) >>> 0) !== checksum) bad();
    const bytes = new Uint8Array(actual); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    entries.set(name, bytes); total += actual; cursor += 46 + nameLength + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) bad();
  return entries;
}
