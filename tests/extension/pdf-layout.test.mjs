import test from 'node:test';
import assert from 'node:assert/strict';
import {readTextSource} from '../../extension/text-source.mjs';
import {compareText} from '../../extension/text-engine.mjs';
import {layoutPdf, salesLayout} from './pdf-layout-fixture.mjs';

const authoredLines = pages => pages.flat().map(({text}) => Array.isArray(text) ? text.join('') : text);

test('independent PDF Forms separate headings and baselines without changing authored text or stream order', async () => {
  const pages = salesLayout();
  const parsed = await readTextSource(await layoutPdf('forms.pdf', pages));
  assert.deepEqual(parsed.blocks.map(block => block.text), authoredLines(pages));
  assert.deepEqual(parsed.blocks.map(block => block.record), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(parsed.blocks.map(block => block.location), pages[0].map((_, i) => `Страница 1 · строка ${i + 1}`));
});

test('two same-baseline columns in independent PDF Forms remain separate source blocks', async () => {
  const pages = [[
    {text: 'ЛЕВАЯ КОЛОНКА', x: 48, y: 770},
    {text: 'ПРАВАЯ КОЛОНКА', x: 340, y: 770},
    {text: 'Левый текст.', x: 48, y: 740},
    {text: 'Правый текст.', x: 340, y: 740},
  ]];
  const parsed = await readTextSource(await layoutPdf('columns.pdf', pages));
  assert.deepEqual(parsed.blocks.map(block => block.text), authoredLines(pages));
});

test('contiguous independent PDF Forms preserve words split between runs and internal spaces', async () => {
  const pages = [[
    {text: ['Сто', 'имость: 125000 рублей.'], y: 770},
    {text: ['Ёл', 'ка — офис & склад.'], y: 740},
  ]];
  const parsed = await readTextSource(await layoutPdf('runs.pdf', pages));
  assert.deepEqual(parsed.blocks.map(block => block.text), authoredLines(pages));
});

test('nearby superscript and baseline jitter stay on the same line across independent Forms', async () => {
  const pages = [[
    {text: 'H', x: 48, y: 770},
    {text: '2', x: 57, y: 773, size: 8},
    {text: 'O', x: 62, y: 770},
    {text: 'Сто', x: 48, y: 740},
    {text: 'имость', x: 71, y: 740.2},
  ]];
  const parsed = await readTextSource(await layoutPdf('superscript.pdf', pages));
  assert.deepEqual(parsed.blocks.map(block => block.text), ['H2O', 'Стоимость']);
});

test('rotated Forms use their own baseline axis for separate lines and contiguous runs', async () => {
  const pages = [[
    {text: ['По', 'ворот один.'], x: 100, y: 300, angle: 90},
    {text: ['По', 'ворот два.'], x: 130, y: 300, angle: 90},
    {text: 'Обычная строка.', x: 160, y: 300},
  ]];
  const parsed = await readTextSource(await layoutPdf('rotated.pdf', pages));
  assert.deepEqual(parsed.blocks.map(block => block.text), authoredLines(pages));
});

test('long sequences of independent Forms preserve boundaries beyond a text stream chunk', async () => {
  const pages = [Array.from({length: 140}, (_, i) => ({text: `Строка ${i + 1}.`, x: 48, y: 800 - i * 5, size: 3}))];
  const parsed = await readTextSource(await layoutPdf('many-forms.pdf', pages));
  assert.deepEqual(parsed.blocks.map(block => block.text), authoredLines(pages));
  assert.equal(parsed.blocks[139].location, 'Страница 1 · строка 140');
});

test('Form geometry state resets at a page boundary and keeps original page references', async () => {
  const pages = [
    [{text: 'Конец первой страницы.', y: 770}],
    [{text: 'Начало второй страницы.', y: 770}],
  ];
  const parsed = await readTextSource(await layoutPdf('pages.pdf', pages));
  assert.deepEqual(parsed.blocks.map(block => block.text), authoredLines(pages));
  assert.deepEqual(parsed.blocks.map(({record, page, line}) => ({record, page, line})), [
    {record: 1, page: 1, line: 1}, {record: 2, page: 2, line: 1},
  ]);
});

test('three numeric edits in a two-column Form PDF produce exactly three changes and preserve every source block', async () => {
  const before = salesLayout();
  const after = salesLayout({sales: '1,8–2,9', orders: '90–120', plan: '120%'});
  const report = await compareText({
    left: await layoutPdf('before.pdf', before),
    right: await layoutPdf('after.pdf', after),
  });
  assert.equal(report.status, 'complete');
  assert.deepEqual(report.summary, {left_blocks: 8, right_blocks: 8, matched: 5, changed: 3, only_left: 0, only_right: 0});
  assert.deepEqual(report.changed.map(item => item.left.text), authoredLines(before).slice(3, 6));
  assert.deepEqual(report.changed.map(item => item.right.text), authoredLines(after).slice(3, 6));
  for (const [side, pages] of [['left', before], ['right', after]]) {
    const blocks = [...report.matched, ...report.changed].map(item => item[side]).sort((a, b) => a.record - b.record);
    assert.deepEqual(blocks.map(block => block.text), authoredLines(pages));
    for (const item of report.changed) {
      assert.equal(item.segments[side].map(segment => segment.text).join(''), item[side].text);
      assert.equal(item[side].page, 1);
    }
  }
});
