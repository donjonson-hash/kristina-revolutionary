import test from 'node:test';
import assert from 'node:assert/strict';
import {compareText} from '../../extension/text-engine.mjs';
import {readTextSource} from '../../extension/text-source.mjs';
import {pdfSource} from './pdf-input-fixture.mjs';
import {docx} from './text-fixture.mjs';

const txt = lines => ({name: 'source.txt', data: Buffer.from(lines.join('\n') + '\n').toString('base64')});
const pdf = lines => pdfSource('source.pdf', [lines], {standardFont: true});
const word = lines => ({name: 'source.docx', data: Buffer.from(docx(lines)).toString('base64')});
const categories = ['matched', 'changed', 'only_left', 'only_right', 'moved', 'reflow'];
async function evidence(report, payload) {
  const items = categories.flatMap(category => (report[category] || []).map(item => ({...item, category})));
  const keys = items.map(item => Number(item.key.slice(5))).sort((a, b) => a - b);
  assert.deepEqual(keys, Array.from({length: items.length}, (_, i) => i + 1));
  for (const side of ['left', 'right']) {
    const original = await readTextSource(payload[side]);
    const recovered = items.flatMap(item => {
      const value = item[side] || (item.category === `only_${side}` ? item.row : null);
      return value ? value.source_blocks || [value] : [];
    }).sort((a, b) => a.record - b.record);
    assert.deepEqual(recovered, original.blocks, `${side}: every source block occurs exactly once with original coordinates`);
  }
  for (const item of report.reflow || []) {
    assert.equal(item.left.source_blocks.map(block => block.text).join(' '), item.right.source_blocks.map(block => block.text).join(' '));
    assert.ok(item.left.source_blocks.length > 1 || item.right.source_blocks.length > 1);
    for (const side of ['left', 'right']) {
      assert.equal(item[side].text, item[side].source_blocks.map(block => block.text).join('\n'));
      for (const block of item[side].source_blocks) assert.ok(item[side].location.includes(block.location));
    }
  }
}

test('unique moved block is found before a neighboring changed pair consumes it', async () => {
  const payload = {left: txt(['start', 'Moved exact clause', 'stable one', 'stable two', 'old value', 'end']), right: txt(['start', 'new value', 'stable one', 'stable two', 'Moved exact clause', 'end'])};
  const report = await compareText(payload);
  assert.equal(report.summary.moved, 1);
  assert.equal(report.moved[0].left.text, 'Moved exact clause');
  assert.equal(report.moved[0].left.record, 2);
  assert.equal(report.moved[0].right.record, 5);
  assert.equal(report.changed.length, 0);
  assert.equal(report.only_left[0].row.text, 'old value');
  assert.equal(report.only_right[0].row.text, 'new value');
  await evidence(report, payload);
});

for (const [name, a, b] of [
  ['one to two', ['Payment is due in 10 days.'], ['Payment is due', 'in 10 days.']],
  ['two to one', ['Payment is due', 'in 10 days.'], ['Payment is due in 10 days.']],
  ['two to two', ['Payment is due', 'in 10 days.'], ['Payment is', 'due in 10 days.']],
]) test(`PDF line boundaries: ${name} retains exact original evidence`, async () => {
  const payload = {left: await pdf(['start', ...a, 'end']), right: await pdf(['start', ...b, 'end'])};
  const report = await compareText(payload);
  assert.equal(report.summary.reflow, 1);
  assert.equal(report.summary.matched, 2);
  assert.equal(report.summary.changed + report.summary.only_left + report.summary.only_right, 0);
  assert.equal(report.moved, undefined);
  await evidence(report, payload);
});

test('independent neighboring reflows remain separate minimal exact pairs', async () => {
  const payload = {left: await pdf(['alpha beta', 'gamma delta']), right: txt(['alpha', 'beta', 'gamma', 'delta'])};
  const report = await compareText(payload);
  assert.equal(report.summary.reflow, 2);
  await evidence(report, payload);
});

test('DOCX paragraphs remain indivisible; a PDF can reflow within one Word paragraph', async () => {
  const payload = {left: word(['Payment is due in 10 days.']), right: await pdf(['Payment is due', 'in 10 days.'])};
  const report = await compareText(payload);
  assert.equal(report.summary.reflow, 1);
  await evidence(report, payload);
  const separate = {left: word(['alpha', 'beta']), right: await pdf(['alpha beta'])};
  const unchangedSemantics = await compareText(separate);
  assert.equal(unchangedSemantics.reflow, undefined);
  await evidence(unchangedSemantics, separate);
  const nonPdf = await compareText({left: txt(['alpha beta']), right: txt(['alpha', 'beta'])});
  assert.equal(nonPdf.reflow, undefined);
});

test('changed numbers, negation, case, internal whitespace and hyphens cannot become reflow', async () => {
  const cases = [
    [['Pay 10 days'], ['Pay 11', 'days']],
    [['Pay not today'], ['Pay', 'today']],
    [['Pay today'], ['pay', 'today']],
    [['Pay  today now'], ['Pay', 'today now']],
    [['hyphenated word'], ['hyphen-', 'ated word']],
  ];
  for (const [a, b] of cases) {
    // TXT preserves authored repeated spaces exactly; PDF extraction itself may
    // interpret visual spacing before the comparison engine receives its blocks.
    const payload = {left: txt(a), right: await pdf(b)};
    const report = await compareText(payload);
    assert.equal(report.reflow, undefined, `${a} versus ${b}`);
    assert.ok(report.changed.length + report.only_left.length + report.only_right.length > 0);
    await evidence(report, payload);
  }
});

test('repeated blocks and repeated joined phrases remain conservative', async () => {
  const moves = {left: txt(['repeated', 'repeated', 'anchor one', 'anchor two', 'anchor three']), right: txt(['anchor one', 'anchor two', 'anchor three', 'repeated', 'repeated'])};
  const moveReport = await compareText(moves);
  assert.equal(moveReport.moved, undefined);
  await evidence(moveReport, moves);
  const payload = {left: await pdf(['alpha beta', 'anchor', 'alpha beta']), right: txt(['alpha', 'beta', 'anchor', 'alpha', 'beta'])};
  const report = await compareText(payload);
  assert.equal(report.reflow, undefined);
  await evidence(report, payload);
});

test('reflow across page boundaries keeps every original page and line reference', async () => {
  const payload = {left: await pdfSource('pages.pdf', [['Payment is due'], ['in 10 days.']], {standardFont: true}), right: txt(['Payment is due in 10 days.'])};
  const report = await compareText(payload);
  assert.deepEqual(report.reflow[0].left.source_blocks.map(block => block.page), [1, 2]);
  assert.ok(report.reflow[0].left.location.includes('Страница 1'));
  assert.ok(report.reflow[0].left.location.includes('Страница 2'));
  await evidence(report, payload);
});

test('blank blocks and spans beyond the documented bound remain explicit differences', async () => {
  for (const lines of [['alpha', '', 'beta'], Array.from({length: 9}, (_, i) => `word${i}`)]) {
    const text = lines.filter(Boolean).join(' ');
    const payload = {left: await pdf([text]), right: txt(lines)};
    const report = await compareText(payload);
    assert.equal(report.reflow, undefined);
    assert.ok(report.sources.left.notes.some(note => note.includes('до 8 соседних')));
    await evidence(report, payload);
  }
});

test('ordinary unchanged inputs preserve the original summary shape', async () => {
  const report = await compareText({left: txt(['alpha', 'beta']), right: txt(['alpha', 'beta'])});
  assert.deepEqual(report.summary, {left_blocks: 2, right_blocks: 2, matched: 2, changed: 0, only_left: 0, only_right: 0});
  assert.equal(report.moved, undefined);
  assert.equal(report.reflow, undefined);
});

test('large block sequences retain one-to-one evidence after an exact move', async () => {
  const lines = Array.from({length: 1500}, (_, i) => `Unique clause ${i}`);
  const payload = {left: txt(lines), right: txt([lines.at(-1), ...lines.slice(0, -1)])};
  const report = await compareText(payload);
  assert.equal(report.summary.moved, 1);
  assert.equal(report.summary.matched, 1499);
  await evidence(report, payload);
});

test('reflow work budget falls back explicitly without consuming source blocks', async () => {
  const lines = Array.from({length: 1500}, (_, i) => `Clause ${i}: ${'unique text '.repeat(15)}`);
  const payload = {left: await pdf(['Small PDF input']), right: txt(lines)};
  const report = await compareText(payload);
  assert.equal(report.reflow, undefined);
  assert.ok(report.sources.left.notes.some(note => note.includes('Превышен бюджет проверки переносов')));
  await evidence(report, payload);
});
