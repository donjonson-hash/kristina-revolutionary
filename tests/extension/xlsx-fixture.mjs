// Minimal OOXML byte fixtures, independent of the production parser.
// XML overrides deliberately produce malformed/unsupported documents for tests.
import {execFileSync} from 'node:child_process';
export const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export function worksheet(rows) {
  return `<worksheet xmlns="${ns}"><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((input, c) => {
    const cell = input !== null && typeof input === 'object' ? input : {v: input};
    let col = '', n = c + 1;
    while (n) { col = String.fromCharCode(65 + (n - 1) % 26) + col; n = Math.floor((n - 1) / 26); }
    const type = cell.t || (typeof cell.v === 'number' ? 'n' : typeof cell.v === 'boolean' ? 'b' : 'inlineStr');
    return `<c r="${col}${r + 1}" t="${type}" s="${cell.style || 0}">${cell.f === undefined ? '' : '<f>' + xmlEscape(cell.f) + '</f>'}${cell.v === undefined || cell.v === null ? '' : type === 'inlineStr' ? '<is><t xml:space="preserve">' + xmlEscape(cell.v) + '</t></is>' : '<v>' + xmlEscape(typeof cell.v === 'boolean' ? Number(cell.v) : cell.v) + '</v>'}</c>`;
  }).join('')}</row>`).join('')}</sheetData></worksheet>`;
}
export function xlsx(sheets = [{name: 'Данные', rows: [['Артикул', 'Количество'], ['00123', 10]]}], options = {}) {
  const entries = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="${rel}"><workbookPr date1904="${options.date1904 ? 1 : 0}"/><sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.hidden ? ' state="hidden"' : ''}/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rStyle" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<styleSheet xmlns="${ns}"><numFmts count="3"><numFmt numFmtId="164" formatCode="00000"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="000-00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/><xf numFmtId="166" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  };
  sheets.forEach((sheet, i) => { entries[`xl/worksheets/sheet${i + 1}.xml`] = sheet.xml ?? worksheet(sheet.rows || []); });
  Object.assign(entries, options.entries);
  return execFileSync(process.env.PYTHON || 'python3', ['-c', `import io,json,sys,zipfile
p=json.load(sys.stdin); b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED if p['compressed'] else zipfile.ZIP_STORED) as z:
 for name,data in p['entries'].items(): z.writestr(name,data)
sys.stdout.buffer.write(b.getvalue())`], {input: JSON.stringify({entries, compressed: options.compressed !== false}), maxBuffer: 20 * 1024 * 1024});
}
export const source = (raw, name = 'book.xlsx', sheet) => ({name, data: Buffer.from(raw).toString('base64'), ...(sheet === undefined ? {} : {sheet})});
