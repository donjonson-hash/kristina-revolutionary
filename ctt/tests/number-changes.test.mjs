import test from 'node:test';
import assert from 'node:assert/strict';
import {extractNumberTokens, findNumberChanges, numberExcerpt} from '../dist/number-changes.mjs';
const compare = (left, right) => findNumberChanges([{key: 'text-1', left, right}]);

test('currency and percentage evidence retains literal Unicode text and exact selection offsets', () => {
  const text = '😀 Price: $1,000.50; залог: 12\u202f500,25 ₽; fee: −3,5%; GBP 25; 20 EUR; refund: -$10.';
  const tokens = extractNumberTokens(text);
  assert.deepEqual(tokens.map(t => t.raw), ['$1,000.50', '12\u202f500,25 ₽', '−3,5%', 'GBP 25', '20 EUR', '-$10']);
  for (const token of tokens) assert.equal(text.slice(token.start, token.end), token.raw);
  assert.deepEqual(extractNumberTokens('Date 10/14/2026; 20 days; ref X50%; CAD$10; USD10x; 1e3%; abc30%'), []);
});

test('pairs only aligned values in otherwise identical wording and does not calculate ambiguous numbers', () => {
  const [item] = compare('Price $1,000. Deposit 30%. Tax 10%.', 'Price $1,150. Deposit 50%. Tax 10%.');
  assert.equal(item.mode, 'paired');
  assert.deepEqual(item.pairs.map(p => [p.before.raw, p.after.raw]), [['$1,000', '$1,150'], ['30%', '50%']]);
  assert.equal(compare('Сумма: 1.000 €.', 'Сумма: 1,000 €.')[0].pairs[0].after.raw, '1,000 €');
  assert.deepEqual(compare('Pay $10.', 'Please pay $10.'), []);
  assert.deepEqual(compare('Sum 1 000 ₽', 'Sum 1000 ₽'), []);
});

test('rewritten wording, reordered clauses, different currencies and removed values never invent a pairing', () => {
  for (const [a, b] of [
    ['Price $10.', 'New price $15.'],
    ['Deposit 30%; balance 70%.', 'Balance 60%; deposit 40%.'],
    ['Price $10.', 'Price €15.'],
    ['Deposit 30%; balance 70%.', 'Deposit 40%.'],
  ]) {
    const [item] = compare(a, b); assert.equal(item.mode, 'context'); assert.deepEqual(item.pairs, []);
  }
  const [removed] = compare('Fee $10.', null); assert.equal(removed.mode, 'removed'); assert.equal(removed.right, null);
  const [added] = compare(null, 'Deposit 50%.'); assert.equal(added.mode, 'added'); assert.equal(added.left, null);
  const [rewritten] = compare('Deposit 30%. Fee $10.', 'Deposit 30%. New fee $15.');
  assert.equal(rewritten.focusBefore.raw, '$10'); assert.equal(rewritten.focusAfter.raw, '$15');
});

test('repeated values keep their positions and changes to either side invalidate the evidence signature', () => {
  const [first] = compare('First $10; second $10.', 'First $10; second $20.');
  assert.equal(first.pairs.length, 1); assert.equal(first.pairs[0].before.start, 18);
  assert.notEqual(first.signature, compare('First $10; second $11.', first.right)[0].signature);
  assert.notEqual(first.signature, compare(first.left, 'First $10; second $30.')[0].signature);
});

test('large unmarked numeric passages are scanned without searching every numeric suffix', {timeout: 2000}, () => {
  assert.deepEqual(extractNumberTokens('123 '.repeat(100000) + 'plain text'), []);
  const text = 'a'.repeat(1000) + ' Price $20.' + ' z'.repeat(1000);
  const token = extractNumberTokens(text)[0], excerpt = numberExcerpt(text, token);
  assert.ok(excerpt.includes('$20')); assert.ok(excerpt.length < 200); assert.ok(excerpt.startsWith('…'));
  const large = '$' + '1'.repeat(100000); assert.ok(numberExcerpt(large, extractNumberTokens(large)[0]).length < 200);
});
