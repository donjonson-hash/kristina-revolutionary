import test from 'node:test';
import assert from 'node:assert/strict';
import {compare} from '../../extension/engine.mjs';
import {buildCommercialSummary} from '../../extension/commercial-summary.mjs';

const fields = [['quantity', 'quantity', 'number'], ['price', 'price', 'number']];
const headers = ['sku', 'quantity', 'price', 'unit', 'currency'];
const row = (sku, quantity, price, unit = 'pcs', currency = 'RUB') => [sku, quantity, price, unit, currency];
const csv = rows => rows.map(values => values.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
async function report(a, b, options = {}) {
  const source = (rows, side) => ({name: `${side}.csv`, data: Buffer.from(csv([options.headers || headers, ...rows])).toString('base64')});
  const result = await compare({left: source(a, 'A'), right: source(b, 'B'), key: ['sku', 'sku'], fields: options.fields || fields, strip: options.strip || false});
  assert.equal(result.status, 'complete');
  return result;
}
const summary = async (...args) => buildCommercialSummary(await report(...args));

test('known arithmetic covers simultaneous changes, reorder, missing and added positions', async () => {
  const result = await summary([row('A', '10', '12.30'), row('B', '2', '8'), row('C', '3', '1.20')], [row('D', '5', '2'), row('B', '2.0', '8.00'), row('A', '12', '13')]);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.counts, {paired: 2, quantity_changed: 1, price_changed: 1, only_left: 1, only_right: 1});
  assert.deepEqual(result.coverage, {total: 4, included: 4, excluded: 0});
  assert.deepEqual(result.totals, [{currency: 'RUB', before: '142.6', after: '182', delta: '39.4'}]);
  const a = result.items.find(item => item.key === 'A');
  assert.equal(a.delta, '33'); assert.equal(a.left.record, 2); assert.equal(a.right.record, 4);
  assert.equal(a.left.quantity, '10'); assert.equal(a.right.price, '13');
  assert.equal(result.items.find(item => item.key === 'C').delta, '-3.6');
  assert.equal(result.items.find(item => item.key === 'D').before, '0');
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('exact decimal products, zero, leading zeros, large integers and tiny fractions', async () => {
  const result = await summary([row('A', '+000.10', '0.20'), row('B', '9007199254740993', '0.01'), row('C', '-0.000', '999'), row('D', '0.00000000000000000001', '0.00000000000000000001')], [row('A', '0.3', '0.2'), row('B', '9007199254740993', '0.02'), row('C', '0', '0'), row('D', '0.00000000000000000001', '0.00000000000000000002')]);
  assert.equal(result.items.find(item => item.key === 'A').delta, '0.04');
  assert.equal(result.items.find(item => item.key === 'B').delta, '90071992547409.93');
  assert.equal(result.items.find(item => item.key === 'C').before, '0');
  assert.equal(result.items.find(item => item.key === 'D').delta, '0.' + '0'.repeat(39) + '1');
  assert.equal(result.totals[0].delta, '90071992547409.9700000000000000000000000000000000000001');
});

test('currencies are grouped independently; mismatched pair is excluded', async () => {
  const result = await summary([row('A', 1, 10), row('B', 1, 20, 'pcs', 'USD'), row('C', 1, 50, 'pcs', 'EUR')], [row('A', 1, 11), row('B', 1, 18, 'шт.', 'usd'), row('C', 1, 50, 'pcs', 'USD')]);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.totals, [{currency: 'RUB', before: '10', after: '11', delta: '1'}, {currency: 'USD', before: '20', after: '18', delta: '-2'}]);
  assert.match(result.excluded[0].reasons.join(' '), /Валюты/);
  assert.match(result.messages.join(' '), /не складываются/);
});

test('unknown units/currencies and changed units never become silent defaults', async () => {
  const result = await summary([row('A', 1, 10, ''), row('B', 1, 10, 'pcs', ''), row('C', 1, 10, 'box')], [row('A', 2, 10, ''), row('B', 2, 10, 'pcs', ''), row('C', 2, 10, 'pcs')]);
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.totals, []);
  assert.equal(result.coverage.excluded, 3);
  assert.equal(result.counts.quantity_changed, 3);
  assert.match(result.excluded[0].reasons.join(' '), /единицу/);
  assert.match(result.excluded[1].reasons.join(' '), /валюта/);
  assert.match(result.excluded[2].reasons.join(' '), /Единицы/);
});

test('rubles header is explicit evidence but conflicting or empty explicit currency blocks', async () => {
  const opts = {headers: ['sku', 'quantity', 'price_rub', 'unit'], fields: [['quantity', 'quantity', 'number'], ['price_rub', 'price_rub', 'number']]};
  assert.equal((await summary([['A', 1, 10, 'шт']], [['A', 2, 10, 'pcs']], opts)).totals[0].currency, 'RUB');
  opts.headers.push('currency');
  for (const c of ['USD', '']) {
    const result = await summary([row('A', 1, 10, 'pcs', c)], [row('A', 2, 10, 'pcs', c)], opts);
    assert.equal(result.status, 'unavailable');
    assert.match(result.excluded[0].reasons.join(' '), /валюта|валют|Валют/);
  }
});

test('only explicitly selected unambiguous numeric semantic fields are counted/calculated', async () => {
  for (const chosen of [[], [['quantity', 'quantity', 'text'], ['price', 'price', 'text']], [['price', 'price', 'number']], [['quantity', 'price', 'number']]]) {
    const result = await summary([row('A', 1, 10)], [row('A', 2, 11)], {fields: chosen});
    assert.equal(result.status, 'unavailable');
    assert.equal(result.counts.quantity_changed, null);
    if (!chosen.some(field => field[0] === 'price' && field[1] === 'price' && field[2] === 'number')) assert.equal(result.counts.price_changed, null);
  }
  const duplicateRows = [[['A', 1, 10, 'pcs', 'RUB', 12]], [['A', 2, 11, 'pcs', 'RUB', 14]]];
  const duplicate = await summary(...duplicateRows, {headers: [...headers, 'unit_price'], fields: [...fields, ['unit_price', 'unit_price', 'number']]});
  assert.equal(duplicate.status, 'unavailable'); assert.equal(duplicate.counts.price_changed, null);
  const explicitChoice = await summary(...duplicateRows, {headers: [...headers, 'unit_price']});
  assert.equal(explicitChoice.status, 'complete'); assert.equal(explicitChoice.totals[0].delta, '12');
});

test('tax and price-basis differences exclude rows even when not selected comparison fields', async () => {
  for (const name of ['vat', 'tax_included']) {
    const result = await summary([[...row('A', 1, 10), '20'], [...row('B', 1, 10), '20']], [[...row('A', 2, 10), '10'], [...row('B', 2, 10), '20']], {headers: [...headers, name]});
    assert.equal(result.status, 'partial'); assert.equal(result.excluded[0].key, 'A');
    assert.equal(result.totals[0].delta, '10');
  }
});

test('price basis must explicitly be per one unit when provided', async () => {
  for (const basis of ['100', 'per 100', 'за упаковку']) {
    const result = await summary([[...row('A', 1, 10), basis]], [[...row('A', 2, 10), basis]], {headers: [...headers, 'price_basis']});
    assert.equal(result.status, 'unavailable'); assert.match(result.excluded[0].reasons.join(' '), /одну единицу/);
  }
  assert.equal((await summary([[...row('A', 1, 10), '1']], [[...row('A', 2, 10), '1']], {headers: [...headers, 'price_basis']})).status, 'complete');
});

test('unit case and legacy currency codes do not silently cause conversions', async () => {
  for (const [a, b] of [['мВт', 'МВт'], ['mW', 'MW']]) {
    const result = await summary([row('A', 1, 10, a)], [row('A', 2, 10, b)]);
    assert.equal(result.status, 'unavailable'); assert.match(result.excluded[0].reasons.join(' '), /Единицы/);
  }
  const result = await summary([row('A', 1, 10, 'pcs', 'RUR')], [row('A', 2, 10, 'pcs', 'RUB')]);
  assert.equal(result.status, 'unavailable');
});

test('empty one side supports all additions/removals, no shared keys requires clarification', async () => {
  assert.deepEqual((await summary([], [row('A', 2, 10)])).totals, [{currency: 'RUB', before: '0', after: '20', delta: '20'}]);
  assert.deepEqual((await summary([row('A', 2, 10)], [])).totals, [{currency: 'RUB', before: '20', after: '0', delta: '-20'}]);
  const disjoint = await summary([row('A', 1, 10)], [row('B', 1, 20)]);
  assert.equal(disjoint.status, 'unavailable'); assert.match(disjoint.messages.join(' '), /общих ключей/);
  assert.equal(disjoint.counts.price_changed, null); assert.equal(disjoint.counts.quantity_changed, null);
  assert.match(disjoint.messages.join(' '), /не нулевое количество/);
  assert.equal((await summary([], [])).status, 'unavailable');
});

test('invalid, negative and oversized numbers fail closed with a specific cause', async () => {
  const base = await report([row('A', 1, 10)], [row('A', 2, 20)]);
  for (const [value, pattern] of [['', /отсутствует/], ['-1', /отрицательное/], ['1'.repeat(121), /120/], ['1e2', /десятичные/], ['2,5', /десятичные/], ['1\u2028', /десятичные/], ['1\n', /десятичные/]]) {
    const input = structuredClone(base); input.changed[0].left.values.quantity = value;
    const result = buildCommercialSummary(input);
    assert.equal(result.status, 'unavailable'); assert.equal(result.counts.quantity_changed, null);
    assert.match(result.excluded[0].reasons.join(' '), pattern);
  }
});

test('source evidence is bounded to relevant cells and inputs remain untouched', async () => {
  const input = await report([row('<img onerror=alert(1)>', 1, 10)], [row('<img onerror=alert(1)>', 2, 20)]);
  input.changed[0].left.sheet = 'Данные'; input.changed[0].left.cells = {quantity: 'C5', price: 'D5', note: 'Z5'};
  const before = JSON.stringify(input), result = buildCommercialSummary(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.items[0].key, '<img onerror=alert(1)>');
  assert.deepEqual(result.items[0].left.cells, {quantity: 'C5', price: 'D5'});
  assert.equal(result.items[0].left.sheet, 'Данные');
  input.changed[0].left.values.currency = '<script>USD</script>';
  assert.equal(buildCommercialSummary(input).status, 'unavailable');
});

test('text and incomplete reports never acquire commercial conclusions', () => {
  for (const input of [null, undefined, {status: 'needs_clarification'}, {kind: 'text', status: 'complete'}]) assert.equal(buildCommercialSummary(input), null);
});
