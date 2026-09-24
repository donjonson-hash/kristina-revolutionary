import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepare, inspect, compare, MAX_SOURCE_BYTES} from '../../extension/engine.mjs';

const source = (raw, name = 'input.csv') => ({name, data: Buffer.from(raw).toString('base64')});
const payload = (left, right = left, extra = {}) => ({left: source(left, 'order.csv'), right: source(right, 'confirmation.csv'), ...extra});
const csv = (headers, rows, delimiter = ',') => [headers, ...rows].map(row => row.map(v => /["\r\n,;\t]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v).join(delimiter)).join('\r\n') + '\r\n';
const fixture = (name, operation, input) => ({name, operation, payload: input});
const rules = {key: ['sku', 'sku'], fields: [['quantity', 'quantity', 'number']]};
const cases = [
  fixture('demo', 'compare', payload('sku,quantity,unit\nA,10,piece\nB,5,piece\nC,2,piece\nD,1,piece\n', 'sku,quantity,unit\nA,10.00,piece\nB,4,piece\nC,2,box\nE,1,piece\n', {...rules, fields: [...rules.fields, ['unit', 'unit', 'text']]})),
  fixture('arbitrary precision', 'compare', payload('sku,quantity\n001,+000123456789123456789123456789.000\n002,-0.000\n003,0.00000000000000000000000001\n', 'sku,quantity\n001,123456789123456789123456789\n002,+0\n003,0.00000000000000000000000002\n', rules)),
  fixture('aliases and rubles', 'prepare', payload(csv(['Артикул', 'Количество', 'Цена_руб'], [['001', '10', '189']]), csv(['sku', 'qty', 'price_rub'], [['001', '10.00', '189.00']]))),
  fixture('unmatched currency', 'prepare', payload('sku,Цена_руб\nA,10\n', 'sku,price\nA,10\n')),
  fixture('different identifier namespaces', 'prepare', payload('sku,quantity\n001,10\n', 'id,quantity\n001,10\n')),
  fixture('ambiguous identifiers', 'prepare', payload('sku,id,quantity\nA,1,10\n')),
  fixture('multiple aliases', 'prepare', payload('sku,quantity,qty\nA,1,1\n', 'sku,Количество\nA,1\n')),
  fixture('unknown columns', 'prepare', payload('sku,notes\nA,one\n', 'sku,remarks\nA,one\n')),
  fixture('no overlap', 'prepare', payload('sku,quantity\nA,1\n', 'sku,quantity\nB,1\n')),
  fixture('empty list', 'prepare', payload('sku,quantity\nA,1\n', 'sku,quantity\n')),
  fixture('single column', 'prepare', payload('id\n001\n002\n')),
  fixture('invalid number after preview', 'prepare', payload('sku,quantity\n' + Array.from({length: 8}, (_, i) => `${i},${i === 7 ? '1e3' : '1'}\n`).join(''))),
  fixture('duplicate after preview', 'prepare', payload('sku,quantity\n' + Array.from({length: 8}, (_, i) => `${i === 7 ? 0 : i},1\n`).join(''))),
  fixture('empty key', 'compare', payload('sku,quantity\n,2\nA,1\n', undefined, rules)),
  fixture('duplicate key with repr quotes', 'compare', payload(csv(['sku', 'quantity'], [["a'b", '1'], ["a'b", '2']]), undefined, rules)),
  fixture('Python whitespace trim', 'compare', payload(csv(['sku', 'quantity'], [['\u001cA\u0085', '\u00a0+01.000\u3000']]), 'sku,quantity\nA,1\n', {...rules, strip: true})),
  fixture('BOM inside data is not Python whitespace', 'compare', payload(csv(['sku', 'quantity'], [['\ufeffA', '1']]), 'sku,quantity\nA,1\n', {...rules, strip: true})),
  fixture('source UTF8 BOM', 'inspect', payload('\ufeffsku,name\r\n001,тест\r\n')),
  fixture('prototype-looking headers', 'compare', payload('__proto__,constructor,toString\nx,a,b\n', '__proto__,constructor,toString\nx,c,b\n', {key: ['__proto__', '__proto__'], fields: [['constructor', 'constructor', 'text'], ['toString', 'toString', 'text']]})),
  fixture('numeric-looking header order', 'inspect', payload('sku,20,1,10\nx,a,b,c\n')),
  fixture('missing rules', 'compare', payload('sku,quantity\nA,1\n')),
  fixture('missing column', 'compare', payload('sku,quantity\nA,1\n', undefined, {key: ['absent', 'sku'], fields: []})),
  fixture('membership only', 'compare', payload('sku,quantity\nA,1\n', 'sku,quantity\nA,2\n', {...rules, fields: []})),
  fixture('issue truncation', 'compare', payload('sku,quantity\n' + 'A,bad\n'.repeat(110), undefined, rules)),
  fixture('empty quoted cell and multiline', 'inspect', payload('sku,name\r\n001,""\r\n002,"a\r\nb\nc\rd"\r\n')),
  fixture('casefold Cyrillic variants', 'prepare', payload('кᲂᲁ,name\nA,one\n', 'код,name\nA,one\n')),
  fixture('casefold long s', 'prepare', payload('ſku,name\nA,one\n', 'sku,name\nA,one\n')),
];
for (const delimiter of [',', ';', '\t']) cases.push(fixture(`quoted ${JSON.stringify(delimiter)} separator`, 'prepare', payload(csv(['sku', 'name'], [['001', 'one, two; three\tfour\nfive "six"']], delimiter))));
for (const invalid of ['1,5', '1e3', 'NaN', 'Infinity', ' 1', '1\n', '1\r', '1\u2028', '1\u2029', '.5', '1.', '１２', '']) cases.push(fixture(`numeric reject ${JSON.stringify(invalid)}`, 'compare', payload(csv(['sku', 'quantity'], [['A', invalid]]), undefined, rules)));
for (const [name, raw] of [
  ['quote in unquoted', 'sku,name\nA,ab"cd\n'], ['unterminated quote', 'sku,name\nA,"abc\n'],
  ['after quote', 'sku,name\nA,"abc"x\n'], ['ragged row', 'sku,name\nA,b,c\n'],
  ['duplicate headers', 'sku,sku\nA,B\n'], ['blank header', 'sku, \nA,B\n'],
  ['blank record', 'sku\n\n'], ['empty source', ''], ['NUL', 'sku\nA\0\n'],
  ['too many columns', Array.from({length: 201}, (_, i) => `h${i}`).join(',') + '\n'],
  ['too many rows', 'sku\n' + 'x\n'.repeat(5001)],
  ['field limit', 'sku,name\nA,' + 'x'.repeat(131073) + '\n'],
]) cases.push(fixture(name, 'inspect', payload(raw)));
for (const raw of ['sku,name;unit\nA,book;piece\n', 'sku,quantity\nA,1,2\n']) cases.push(fixture('ambiguous delimiter', 'prepare', payload(raw)));
cases.push(fixture('mixed delimiters', 'prepare', payload('sku,quantity\nA,1\n', 'sku;quantity\nA;1\n')));
cases.push(fixture('invalid UTF8', 'inspect', payload(Buffer.from([0xff]))));

const oracle = spawnSync(process.env.PYTHON || 'python3', [fileURLToPath(new URL('./python_oracle.py', import.meta.url))], {input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024});
assert.equal(oracle.status, 0, oracle.stderr);
const expected = JSON.parse(oracle.stdout);
for (let i = 0; i < cases.length; i++) {
  const item = cases[i];
  test(`Python parity: ${item.name}`, async () => {
    const operation = {prepare, inspect, compare}[item.operation];
    if (expected[i].error) await assert.rejects(() => operation(item.payload));
    else assert.deepEqual(await operation(item.payload), expected[i].result);
  });
}

test('prepare to compare works without network access', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network access forbidden'); };
  try {
    const input = payload('sku;quantity\n001;10\n002;5\n', 'sku;quantity\n001;10.00\n002;4\n');
    const setup = await prepare(input);
    assert.equal(setup.ready, true);
    const report = await compare({...input, ...setup.rules, delimiter: setup.delimiter});
    assert.equal(report.summary.matched, 1);
    assert.equal(report.summary.changed, 1);
  } finally { globalThis.fetch = previous; }
});

test('input bytes, invalid base64 and serialized result amplification are bounded', async () => {
  await assert.rejects(() => inspect(payload(Buffer.alloc(MAX_SOURCE_BYTES + 1, 65))), /2 MiB/);
  for (const encoded of ['YQ==\n', '@@@=', '=YQ=', 'YQ=']) {
    const input = payload('sku\nA\n'); input.left.data = encoded;
    await assert.rejects(() => inspect(input), /base64/);
  }
  const header = 'x'.repeat(10000), raw = csv(['sku', header], Array.from({length: 1000}, (_, i) => [String(i), 'a']));
  await assert.rejects(() => compare(payload(raw, raw, {key: ['sku', 'sku'], fields: [[header, header, 'text']]})), /16 MiB/);
});

test('astral Unicode field limit counts characters, not UTF16 code units', async () => {
  const raw = csv(['sku', 'name'], [['A', '😀'.repeat(70000)]]);
  const result = await inspect(payload(raw));
  assert.equal([...result.left.preview[0].values.name].length, 70000);
});
