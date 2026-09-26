const {test} = require('node:test');
const assert = require('node:assert/strict');
const office = require('../../static/reconciliation/office.js');
const block = (record, text) => ({record, text, location: `Абзац ${record}`});
function fixture() {
  return {schema_version: 1, kind: 'text', status: 'complete',
    sources: {left: {name: 'A.docx', block_count: 3, notes: ['Примечания не извлекались.']}, right: {name: 'B.txt', block_count: 3, notes: []}},
    rules: {mode: 'text', normalization: 'line_endings'},
    summary: {left_blocks: 3, right_blocks: 3, changed: 1, matched: 1, only_left: 1, only_right: 1},
    matched: [{key: 'text-1', left: block(1, 'Совпало.'), right: block(1, 'Совпало.')}],
    changed: [{key: 'text-3', left: block(2, 'Доставка через 15 дней.\nБез изменений упаковки.'), right: block(3, 'Доставка через 20 дней.\nБез изменений упаковки.')}],
    only_left: [{key: 'text-4', row: block(3, 'Старое условие.')}],
    only_right: [{key: 'text-2', row: block(2, 'Новое условие.')}],
  };
}

test('text summary and quick questions stay about extracted text', () => {
  const report = fixture(), summary = office.describe(report);
  assert.match(summary.text, /Изменённых блоков: 1/);
  assert.match(summary.text, /Примечания не извлекались/);
  assert.doesNotMatch(summary.text, /ключ|проверенные поля|Цена/);
  assert.match(office.answer(report, 'Что изменилось?').text, /Сравнила текст/);
  assert.deepEqual(office.answer(report, 'Что добавлено?').actions.map(a => a.key), ['text-2']);
  assert.deepEqual(office.answer(report, 'Что удалено?').actions.map(a => a.key), ['text-4']);
});

test('position and phrase queries return source locations and exact navigation keys', () => {
  const report = fixture();
  for (const query of ['text-3', 'Покажи text-3', 'Покажи абзац 2 в A', 'Найди «через 20 дней»']) {
    const result = office.answer(report, query);
    assert.deepEqual(result.actions.map(a => a.key), ['text-3']);
    assert.match(result.text, /Абзац 2/); assert.match(result.text, /Абзац 3/);
    assert.match(result.text, /15 дней/); assert.match(result.text, /20 дней/);
  }
  assert.deepEqual(office.answer(report, 'Покажи абзац 2').actions.map(a => a.key), ['text-2', 'text-3']);
  assert.deepEqual(office.answer(report, 'Найди «несуществующее»').actions, []);
});

test('legal, factual and proofreading questions receive no invented judgments', () => {
  for (const question of ['Правильный ли договор?', 'Есть ли юридические риски?', 'Проверь орфографию', 'Факты достоверны?']) {
    const result = office.answer(fixture(), question);
    assert.match(result.text, /Юридический смысл, достоверность фактов и орфография не оценивались/);
    assert.equal(result.draft, undefined);
  }
});

test('full editable draft includes every exact difference and notes, and never sends it', () => {
  const report = fixture();
  const sharedNote = 'Проверялся только извлечённый текст.';
  report.sources.left.notes.push(sharedNote);
  report.sources.right.notes.push(sharedNote, 'Кодировка UTF-8.');
  const result = office.draftLetter(report);
  for (const value of [report.changed[0].left.text, report.changed[0].right.text, report.only_left[0].row.text, report.only_right[0].row.text]) assert.ok(result.draft.includes(JSON.stringify(value)));
  assert.ok(result.draft.includes('A: "Примечания не извлекались."'));
  assert.ok(result.draft.includes('B: "Кодировка UTF-8."'));
  assert.ok(result.draft.includes(`Оба файла (A и B): ${JSON.stringify(sharedNote)}`));
  assert.equal(result.draft.split(sharedNote).length - 1, 1);
  assert.ok(result.draft.indexOf('text-2') < result.draft.indexOf('text-3'));
  assert.match(result.text, /Письмо не отправлено/);
  assert.equal(office.answer(report, 'Подготовь письмо').draft, result.draft);
  assert.equal(office.answer(report, 'Не готовь письмо').draft, undefined);
});

test('large replies disclose truncation; oversized full draft is refused', () => {
  const report = fixture();
  report.changed = Array.from({length: 35}, (_, i) => ({key: `text-${i + 10}`, left: block(i + 1, 'А'.repeat(20000)), right: block(i + 1, 'Б'.repeat(20000))}));
  const answer = office.answer(report, 'Найди «ААА»');
  assert.ok(answer.text.length <= 12000); assert.equal(answer.actions.length, 12);
  assert.match(answer.text, /сокращён|сокращено/);
  const draft = office.draftLetter(report);
  assert.equal(draft.draft, undefined); assert.match(draft.text, /превышает лимит 1 МиБ/);
});

function structuralFixture() {
  const report = fixture();
  report.changed = []; report.only_left = []; report.only_right = []; report.matched = [];
  report.moved = [{key: 'text-1', left: block(1, 'Неизменный текст.'), right: block(4, 'Неизменный текст.')}];
  const first = {...block(2, 'Поставка через'), page: 1, location: 'Страница 1 · строка 2'};
  const second = {...block(3, '15 дней.'), page: 2, location: 'Страница 2 · строка 1'};
  report.reflow = [{key: 'text-2', left: {...first, text: 'Поставка через\n15 дней.', location: 'Страницы 1–2', source_blocks: [first, second]}, right: {...block(2, 'Поставка через 15 дней.'), page: 1}}];
  return report;
}

test('structural-only summary and draft never claim unchanged documents or new/removed content', () => {
  const report = structuralFixture(), summary = office.describe(report), draft = office.draftLetter(report).draft;
  assert.match(summary.text, /Изменённых блоков: 0; только в A: 0; только в B: 0/);
  assert.match(summary.text, /Перемещено без изменения текста: 1/);
  assert.match(summary.text, /Изменены переносы строк: 1/);
  assert.match(summary.text, /эвристикой объединения строк/);
  assert.doesNotMatch(summary.text + draft, /Извлечённый текст совпал по правилам|Текстовых различий по указанным правилам не обнаружено/);
  assert.deepEqual(summary.actions.map(action => action.category), ['moved', 'reflow']);
  assert.deepEqual(office.answer(report, 'Что добавлено?').actions, []);
  assert.deepEqual(office.answer(report, 'Что удалено?').actions, []);
  assert.deepEqual(office.answer(report, 'Что перемещено?').actions.map(action => action.key), ['text-1']);
  assert.deepEqual(office.answer(report, 'Покажи переносы строк').actions.map(action => action.key), ['text-2']);
  for (const source of report.reflow[0].left.source_blocks) {
    assert.ok(draft.includes(JSON.stringify(source.text)));
    assert.ok(draft.includes(JSON.stringify(source.location)));
  }
  assert.match(draft, /без оценки смысловой эквивалентности/);
});

test('aggregated reflow locates every original block and PDF page with correct side', () => {
  const report = structuralFixture();
  for (const query of ['Покажи блок 3 в A', 'Покажи страницу 2 в A', 'Найди «15 дней.»']) {
    const result = office.answer(report, query);
    assert.deepEqual(result.actions.map(action => action.key), ['text-2']);
    assert.match(result.text, /Страница 2 · строка 1/);
    assert.match(result.text, /блок 3/);
  }
  assert.deepEqual(office.answer(report, 'Покажи блок 3 в B').actions, []);
  assert.deepEqual(office.answer(report, 'Покажи страницу 2 в B').actions, []);
  assert.deepEqual(office.answer(report, 'Покажи блок 4 в B').actions.map(action => action.key), ['text-1']);
});
