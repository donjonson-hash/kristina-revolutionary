/** Bounded XLSX input. No formulas are evaluated and no links are followed. */
import {read, utils, SSF} from './xlsx-vendor.mjs';

const LIMIT = 16 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const decoder = new TextDecoder('utf-8', {fatal: true});
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crcUpdate = (crc, bytes) => {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
};

// Validate the actual expanded ZIP bytes before handing the archive to SheetJS.
// Central-directory declarations alone do not protect against forged ZIP sizes.
export async function validateZip(raw) {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u16 = i => v.getUint16(i, true), u32 = i => v.getUint32(i, true);
  const bad = () => fail('Некорректный XLSX/ZIP. Сохраните книгу заново в Excel.');
  if (raw.length < 22) bad();
  let end = raw.length - 22;
  while (end >= Math.max(0, raw.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < Math.max(0, raw.length - 65557) || end + 22 + u16(end + 20) !== raw.length) bad();
  const count = u16(end + 10), start = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || count !== u16(end + 8) || !count || count > 1024 || start + u32(end + 12) !== end) bad();
  let cursor = start, total = 0;
  const names = new Set(), ranges = [];
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) bad();
    const flags = u16(cursor + 8), method = u16(cursor + 10), compressed = u32(cursor + 20), size = u32(cursor + 24);
    const nameLength = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32), local = u32(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > end || flags & ~0x080e || ![0, 8].includes(method) || u16(cursor + 34)) bad();
    const name = decoder.decode(raw.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || names.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/') || name.includes('\0')) bad();
    names.add(name);
    if (/vbaProject|externalLinks\//i.test(name)) fail('Книги с макросами или внешними связями не поддерживаются. Сохраните отдельную XLSX-копию со значениями.');
    if (size > LIMIT || total + size > LIMIT) fail('XLSX после распаковки превышает 16 MiB. Разделите книгу.');
    if (local + 30 > start || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) bad();
    const dataStart = local + 30 + nameLength + u16(local + 28), dataEnd = dataStart + compressed;
    if (dataEnd > start || decoder.decode(raw.subarray(local + 30, local + 30 + nameLength)) !== name) bad();
    if (!(flags & 8) && (u32(local + 18) !== compressed || u32(local + 22) !== size)) bad();
    ranges.push([local, dataEnd]);
    let actual = 0, crc = 0xffffffff;
    if (method === 0) { actual = compressed; crc = crcUpdate(crc, raw.subarray(dataStart, dataEnd)); }
    else {
      const stream = new Blob([raw.subarray(dataStart, dataEnd)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = stream.getReader();
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          actual += value.length;
          if (actual > size || total + actual > LIMIT) { await reader.cancel(); bad(); }
          crc = crcUpdate(crc, value);
        }
      } finally { reader.releaseLock(); }
    }
    if (actual !== size || ((crc ^ 0xffffffff) >>> 0) !== u32(cursor + 16)) bad();
    total += actual;
    cursor += 46 + nameLength + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || ranges.some((range, i) => i && range[0] < ranges[i - 1][1]) || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) bad();
}

function decimal(value) {
  if (!Number.isFinite(value)) fail('Некорректное число в Excel.');
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponent] = text.toLowerCase().split('e'), negative = mantissa.startsWith('-');
  const [whole, fraction = ''] = mantissa.replace('-', '').split('.'), digits = whole + fraction, point = whole.length + Number(exponent);
  return (negative ? '-' : '') + (point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point));
}

function valueOf(cell, location, date1904, identifier = false) {
  if (!cell) return '';
  if (cell.f !== undefined || cell.F !== undefined) fail(`${location}: найдена формула. Сохраните копию листа только со значениями и загрузите её. Формулы не пересчитываются.`);
  if (cell.t === 'e') fail(`${location}: ошибка Excel. Исправьте её перед сверкой.`);
  if (cell.v === undefined || cell.v === null) return '';
  let value;
  if (cell.t === 'n') {
    if (SSF.is_date(cell.z || 'General')) {
      const d = SSF.parse_date_code(cell.v, {date1904});
      if (!d || d.d < 1 || /\[[hms]+\]/i.test(cell.z) || (!date1904 && Math.floor(cell.v) === 60) || d.u > 0.000001) fail(`${location}: дата/время не поддерживается. Преобразуйте в текст.`);
      const pad = n => String(n).padStart(2, '0');
      value = `${String(d.y).padStart(4, '0')}-${pad(d.m)}-${pad(d.d)}`;
      if (d.H || d.M || d.S) value += `T${pad(d.H)}:${pad(d.M)}:${pad(d.S)}`;
    } else {
      if (/00/.test((cell.z || '').split('.')[0]) && !/^0+$/.test(cell.z)) fail(`${location}: нестандартный формат с ведущими нулями. Сохраните значение как текст.`);
      if (identifier && !['General', '@'].includes(cell.z || 'General') && !/^0+$/.test(cell.z)) fail(`${location}: нестандартный числовой формат идентификатора. Сохраните артикул как текст.`);
      if (identifier && (!Number.isSafeInteger(cell.v) || Math.abs(cell.v) >= 1e15)) fail(`${location}: длинный или дробный числовой идентификатор. Сохраните артикул как текст; проверьте исходные цифры.`);
      value = decimal(cell.v);
      if (/^0+$/.test(cell.z || '') && Number.isInteger(cell.v)) value = (cell.v < 0 ? '-' : '') + String(Math.abs(cell.v)).padStart(cell.z.length, '0');
    }
  } else if (cell.t === 'b') value = cell.v ? 'TRUE' : 'FALSE';
  else if (['s', 'str', 'inlineStr'].includes(cell.t)) value = String(cell.v);
  else fail(`${location}: неподдерживаемый тип ячейки. Сохраните значение как текст.`);
  if (value.includes('\0') || [...value].length > 131072) fail(`${location}: недопустимое или слишком длинное значение.`);
  return value;
}

export async function readWorkbook(raw, {name, sha256, sheet}) {
  await validateZip(raw);
  let workbook;
  try { workbook = read(raw, {type: 'array', cellFormula: true, sheetStubs: true, cellNF: true, cellText: false, cellDates: false, dense: false}); }
  catch { fail(`${name}: не удалось прочитать XLSX. Сохраните книгу заново.`); }
  if (workbook.SheetNames.length > 100) fail(`${name}: более 100 листов. Разделите книгу.`);
  let count = 0;
  const populated = workbook.SheetNames.map((name, i) => {
    const ws = workbook.Sheets[name];
    const addresses = Object.keys(ws).filter(key => /^[A-Z]+[1-9][0-9]*$/.test(key) && (ws[key].v !== undefined && ws[key].v !== '' || ws[key].f !== undefined || ws[key].F !== undefined));
    count += addresses.length;
    if (count > 100000) fail('Книга содержит более 100 000 заполненных ячеек. Разделите книгу.');
    return {name, hidden: !!workbook.Workbook?.Sheets?.[i]?.Hidden, addresses, ws};
  }).filter(s => s.addresses.length);
  if (!populated.length) fail(`${name}: в книге нет заполненных листов.`);
  const sheets = populated.map(({name, hidden}) => ({name, hidden}));
  if (sheet !== undefined && (typeof sheet !== 'string' || !populated.some(s => s.name === sheet))) fail(`${name}: выбранный лист не найден или пуст.`);
  if (sheet === undefined && populated.length > 1) return {sheets, selected: null, parsed: null};
  const selected = populated.find(s => s.name === sheet) || populated[0];
  const {ws, addresses} = selected;
  const prefix = address => `${name} · «${selected.name}»!${address}`;
  if (ws['!merges']?.length) fail(`${name} · «${selected.name}»: объединённые ячейки не поддерживаются. Подготовьте лист с одной строкой заголовков.`);
  const coords = addresses.map(utils.decode_cell);
  let minRow = Infinity, maxRow = 0, minCol = Infinity, maxCol = 0;
  for (const {r, c} of coords) { minRow = Math.min(minRow, r); maxRow = Math.max(maxRow, r); minCol = Math.min(minCol, c); maxCol = Math.max(maxCol, c); }
  if (maxRow >= 1048576 || maxCol >= 16384 || maxCol - minCol >= 200) fail(`${name}: недопустимый диапазон или более 200 столбцов.`);
  const rowNumbers = [...new Set(coords.map(c => c.r))].sort((a, b) => a - b);
  if (rowNumbers.length > 5001) fail(`${name}: более 5000 строк данных.`);
  const date1904 = !!workbook.Workbook?.WBProps?.date1904;
  const headerCells = {}, headers = [];
  for (let c = minCol; c <= maxCol; c++) {
    const addr = utils.encode_cell({r: minRow, c}), value = valueOf(ws[addr], prefix(addr), date1904);
    if (!value.trim() || headers.includes(value)) fail(`${prefix(addr)}: заголовки должны быть непустыми и уникальными.`);
    headers.push(value); Object.defineProperty(headerCells, value, {value: addr, enumerable: true});
  }
  const rows = rowNumbers.slice(1).map(r => {
    const values = {}, cells = {};
    headers.forEach((header, i) => {
      const addr = utils.encode_cell({r, c: minCol + i});
      const identifier = /^(sku|артикул|id|идентификатор|product_id|код|код товара|код_товара)$/i.test(header.trim());
      Object.defineProperty(values, header, {value: valueOf(ws[addr], prefix(addr), date1904, identifier), enumerable: true});
      Object.defineProperty(cells, header, {value: addr, enumerable: true});
    });
    return {record: r + 1, values, cells, sheet: selected.name};
  });
  return {sheets, selected: selected.name, parsed: {meta: {name, sha256, format: 'xlsx', sheet: selected.name, sheets, headers, header_cells: headerCells, row_count: rows.length,
    notes: ['Сверяется только выбранный лист, включая скрытые строки и столбцы. Пустые строки пропущены. Первая заполненная строка — заголовки.', 'Числа сверяются по значениям; простой формат 000… сохраняет ведущие нули. Даты приведены к ISO. Оформление, комментарии, изображения и формулы не сравниваются.']}, rows}};
}
