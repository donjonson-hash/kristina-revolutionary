import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {renderXlsx} from '../../extension/xlsx-report.mjs';
import {compare} from '../../extension/engine.mjs';
import {buildCommercialSummary} from '../../extension/commercial-summary.mjs';

const headers = ['sku', 'quantity', 'unit', 'price_rub', 'note'];
const csv = rows => [headers, ...rows].map(row => row.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\n');
async function fixture(a, b) {
  const left = csv(a || [['001', '10', 'piece', '189', 'unchecked A'], ['DS-200', '5', 'piece', '20', ''], ['LP-300', '2', 'piece', '10', ''], ['OLD-400', '1', 'piece', '40', '']]);
  const right = csv(b || [['NEW-500', '1', 'piece', '40', ''], ['DS-200', '4', 'piece', '22', ''], ['001', '10.00', 'piece', '189.00', 'unchecked B'], ['LP-300', '2', 'box', '10', '']]);
  const source = (data, name) => ({data: Buffer.from(data).toString('base64'), name});
  const report = await compare({left: source(left, 'order.csv'), right: source(right, 'confirmation.csv'), key: ['sku', 'sku'], fields: [['quantity', 'quantity', 'number'], ['unit', 'unit', 'text'], ['price_rub', 'price_rub', 'number']]});
  assert.equal(report.status, 'complete');
  report.commercial = buildCommercialSummary(report);
  return report;
}
// Independent ZIP/XML inspection: no production XLSX reader is used for assertions.
function inspect(bytes) {
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-c', `import io,json,re,sys,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
w=E.fromstring(z.read('xl/workbook.xml')); sheets=[]
for i,s in enumerate(w.find('s:sheets',ns)):
 root=E.fromstring(z.read('xl/worksheets/sheet%d.xml'%(i+1))); cells={}
 for c in root.findall('.//s:c',ns):
  v=c.find('s:v',ns); inline=c.find('s:is',ns)
  value=''.join(inline.itertext()) if inline is not None else (v.text or '' if v is not None else '')
  value=re.sub(r'_x([0-9a-fA-F]{4})_',lambda m:chr(int(m[1],16)),value,flags=re.I)
  cells[c.attrib['r']]={'value':value,'type':c.attrib.get('t'),'formula':c.find('s:f',ns) is not None}
 sheets.append({'name':s.attrib['name'],'cells':cells,'filter':root.find('s:autoFilter',ns) is not None,'cols':root.find('s:cols',ns) is not None,'hyperlinks':root.find('s:hyperlinks',ns) is not None})
print(json.dumps({'sheets':sheets,'entries':z.namelist()}))`], {input: bytes, maxBuffer: 20 * 1024 * 1024}));
}
const values = sheet => Object.values(sheet.cells).map(c => c.value);

test('demo exports complete evidence, partial totals, exclusions and source order', async () => {
  const report = await fixture(), bytes = renderXlsx(report), doc = inspect(bytes);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(doc.sheets.map(s => s.name), ['Сводка', 'Различия', 'Данные A', 'Данные B', 'Правила']);
  const [summary, differences, a, b, rules] = doc.sheets;
  assert.ok(values(summary).includes('2030')); assert.ok(values(summary).includes('2018')); assert.ok(values(summary).includes('-12'));
  assert.ok(values(summary).includes('Частичный расчёт — не итог всего документа'));
  assert.ok(values(summary).includes('Единицы A и B различаются; пересчёт не выполняется.'));
  assert.equal(a.cells.D2.value, '001'); assert.equal(b.cells.D2.value, 'NEW-500');
  assert.equal(a.cells.H2.value, 'unchecked A'); assert.equal(b.cells.H4.value, 'unchecked B');
  assert.equal(a.cells.E2.value, '10'); assert.equal(b.cells.E4.value, '10.00');
  assert.ok(values(differences).includes('Нет позиции')); assert.ok(values(differences).includes('OLD-400'));
  assert.ok(values(rules).includes(report.sources.left.sha256)); assert.ok(values(rules).includes('Не проверялось A'));
  assert.ok(doc.sheets.every(s => s.cols)); assert.ok(a.filter && b.filter && differences.filter);
  assert.ok(doc.sheets.every(s => !s.hyperlinks && Object.values(s.cells).every(c => !c.formula && ['str', 's', 'inlineStr'].includes(c.type))));
});

test('120-digit money, leading zero IDs, formula-like content and XML syntax remain strings', async () => {
  const huge = '9'.repeat(120), payload = '=HYPERLINK("https://example.org", "open")';
  const report = await fixture([['00001', '1', 'piece', huge, payload]], [['00001', '1', 'piece', huge, '+cmd|evil<&>"\'🙂\r\ntext']]);
  const doc = inspect(renderXlsx(report)), a = doc.sheets[2], b = doc.sheets[3];
  assert.equal(a.cells.D2.value, '00001'); assert.equal(a.cells.G2.value, huge); assert.equal(a.cells.H2.value, payload);
  assert.equal(b.cells.H2.value, '+cmd|evil<&>"\'🙂\r\ntext');
  assert.ok(values(doc.sheets[0]).includes(huge));
  assert.ok(doc.sheets.every(s => !s.hyperlinks && Object.values(s.cells).every(c => !c.formula)));
  assert.ok(!doc.entries.some(name => /externalLinks|vbaProject|calcChain/.test(name)));
});

test('source worksheet and exact cell coordinates survive in difference and data sheets', async () => {
  const report = await fixture();
  for (const side of ['left', 'right']) {
    report.sources[side].sheet = side === 'left' ? 'Заказ' : 'Ответ';
    for (const category of ['matched', 'changed']) for (const item of report[category]) {
      item[side].sheet = report.sources[side].sheet;
      item[side].cells = Object.fromEntries(headers.map((h, i) => [h, String.fromCharCode(66 + i) + (item[side].record + 6)]));
    }
  }
  const doc = inspect(renderXlsx(report));
  assert.equal(doc.sheets[1].cells.H2.value, 'Заказ'); assert.equal(doc.sheets[1].cells.I2.value, 'C9');
  assert.equal(doc.sheets[2].cells.C2.value, 'B8, C8, D8, E8, F8');
  assert.ok(values(doc.sheets[4]).includes('Другие листы не проверялись'));
});

test('unavailable and absent commercial calculation never present a invented zero total', async () => {
  const report = await fixture([['A', '1', '', '10', '']], [['A', '2', '', '10', '']]);
  let doc = inspect(renderXlsx(report));
  assert.ok(values(doc.sheets[0]).includes('Сумма не рассчитана'));
  assert.ok(!values(doc.sheets[0]).includes('Итог по рассчитанным позициям'));
  delete report.commercial; doc = inspect(renderXlsx(report));
  assert.ok(values(doc.sheets[0]).includes('Не выполнялся'));
});

test('incomplete and text reports cannot create a misleading spreadsheet', async () => {
  const report = await fixture();
  assert.throws(() => renderXlsx({...report, status: 'needs_clarification'}), /после завершения/);
  assert.throws(() => renderXlsx({...report, kind: 'text'}), /только для сверки таблиц/);
});

test('32767-character limit and invalid XML code points fail without silent replacement', async () => {
  const report = await fixture(), row = report.matched[0].left;
  row.values.note = 'x'.repeat(32767); assert.equal(inspect(renderXlsx(report)).sheets[2].cells.H2.value.length, 32767);
  row.values.note += 'x'; assert.throws(() => renderXlsx(report), /32 767/);
  for (const bad of ['\u0001', '\ufffe', '\ud800']) { row.values.note = bad; assert.throws(() => renderXlsx(report), /недопустимый в XML/); }
});

test('preflight limits reject oversized cell counts and repeated values before workbook allocation', async () => {
  const report = await fixture();
  report.matched = Array(50001).fill(report.matched[0]);
  assert.throws(() => renderXlsx(report), /слишком большой/);
  const repeated = await fixture();
  repeated.matched[0].left.values.note = 'x'.repeat(32767);
  repeated.matched = Array(600).fill(repeated.matched[0]);
  assert.throws(() => renderXlsx(repeated), /слишком большой/);
});


test('literal SpreadsheetML escape sequences and XML entities do not change source text', async () => {
  const content = '_x0041_ _x000D_ _x005F_ _X0020_ &amp; &#13; a\rb\nc\t🙂';
  const report = await fixture([['001', '1', 'piece', '1', content]], [['001', '1', 'piece', '1', content]]);
  const doc = inspect(renderXlsx(report));
  assert.equal(doc.sheets[2].cells.H2.value, content);
  assert.equal(doc.sheets[3].cells.H2.value, content);
});
