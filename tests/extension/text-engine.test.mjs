import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compareText, prepareText} from '../../extension/text-engine.mjs';
import {readTextSource} from '../../extension/text-source.mjs';
import {docx, zipEntries, W} from './text-fixture.mjs';
const input = (raw, name = 'file.txt') => ({name, data: Buffer.from(raw).toString('base64')});
const payload = (a, b) => ({left: a, right: b});
const pairs = report => ['matched', 'changed', 'only_left', 'only_right'].flatMap(category => report[category].map(item => ({...item, category}))).sort((a, b) => Number(a.key.slice(5)) - Number(b.key.slice(5)));
function completeEvidence(report, left, right) {
  const all = pairs(report);
  assert.deepEqual(all.filter(x => x.left || x.category === 'only_left').map(x => (x.left || x.row).text), left);
  assert.deepEqual(all.filter(x => x.right || x.category === 'only_right').map(x => (x.right || x.row).text), right);
  assert.deepEqual(all.map(x => x.key), all.map((_, i) => `text-${i + 1}`));
  for (const item of report.changed) for (const side of ['left', 'right']) assert.equal(item.segments[side].map(s => s.text).join(''), item[side].text);
}

test('insertion, deletion and changed words retain every paragraph and global ordering', async () => {
  const left = ['Начало', 'Оплата через 10 дней.', 'Раздел два', 'Удалённый пункт', 'Конец'];
  const right = ['Начало', 'Оплата через 30 дней.', 'Раздел два', 'Конец', 'Новый пункт'];
  const report = await compareText(payload(input(left.join('\n')), input(right.join('\n'))));
  assert.deepEqual(report.summary, {left_blocks: 5, right_blocks: 5, matched: 3, changed: 1, only_left: 1, only_right: 1});
  completeEvidence(report, left, right);
  assert.deepEqual(report.changed[0].segments.left, [{text: 'Оплата через ', changed: false}, {text: '10', changed: true}, {text: ' дней.', changed: false}]);
  assert.deepEqual(report.changed[0].segments.right.filter(s => s.changed).map(s => s.text), ['30']);
});

test('repeated and blank lines, leading/trailing spaces and Unicode are not discarded', async () => {
  const left = [' ', 'Повтор', '', 'Повтор', 'A\u0301 😀 漢字', 'end  '];
  const right = ['', 'Повтор', '', 'Повтор', 'Á 😀 漢字', 'end '];
  const report = await compareText(payload(input(left.join('\r\n') + '\r\n'), input(right.join('\r') + '\r')));
  completeEvidence(report, left, right);
  assert.ok(report.changed.length > 0);
  assert.ok(report.sources.left.notes.some(n => n.includes('Unicode')));
});

test('TXT EOF newline is a line boundary, additional blank lines remain blocks', async () => {
  for (const [raw, expected] of [['', []], ['\n', ['']], ['a\n', ['a']], ['a\n\n', ['a', '']], ['\r\na\r\n', ['', 'a']]]) {
    const result = await readTextSource(input(raw)); assert.deepEqual(result.blocks.map(b => b.text), expected);
  }
  const result = await readTextSource(input('\ufefffirst\nsecond'));
  assert.deepEqual(result.blocks.map(b => b.text), ['first', 'second']);
  assert.equal(result.meta.sha256, createHash('sha256').update('\ufefffirst\nsecond').digest('hex'));
});

test('DOCX↔TXT compares XML-escaped text and blank paragraphs identically', async () => {
  const paragraphs = ['Пункт <A> & "B" — 😀', '', '  пробелы  '];
  const source = input(docx(paragraphs, {deflate: true}), 'original.docx');
  const report = await compareText(payload(source, input(paragraphs.join('\n') + '\n')));
  assert.equal(report.summary.matched, 3); assert.equal(report.summary.changed, 0);
  assert.equal(report.sources.left.format, 'docx'); assert.equal(report.sources.left.block_count, 3);
  assert.equal(report.matched[0].left.location, 'Абзац 1'); assert.equal(report.matched[0].right.location, 'Строка 1');
  completeEvidence(report, paragraphs, paragraphs);
  const prepared = await prepareText(payload(source, input('test')));
  assert.equal(prepared.kind, 'text'); assert.equal(prepared.ready, true); assert.equal(prepared.rules, undefined);
});

test('namespace prefixes are resolved by URI; run splitting, tab and breaks preserve text', async () => {
  const xml = `<d:document xmlns:d="${W}"><d:body><d:p><d:r><d:t>A &amp; </d:t></d:r><d:r><d:t>Б</d:t><d:tab/><d:t> C</d:t><d:br/><d:t>next</d:t></d:r></d:p><d:p/></d:body></d:document>`;
  const parsed = await readTextSource(input(docx([], {xml}), 'runs.docx'));
  assert.deepEqual(parsed.blocks.map(b => b.text), ['A & Б\t C\nnext', '']);
  await assert.rejects(() => readTextSource(input(docx([], {xml: xml.replaceAll(W, 'urn:fake')}), 'fake.docx')), /WordprocessingML/);
});

test('strict OOXML namespace is supported without changing text semantics', async () => {
  const xml = '<document xmlns="http://purl.oclc.org/ooxml/wordprocessingml/main"><body><p><r><t>text</t></r></p></body></document>';
  const parsed = await readTextSource(input(docx([], {xml}), 'strict.docx'));
  assert.equal(parsed.blocks[0].text, 'text');
});

for (const element of ['ins', 'del', 'fldSimple', 'fldChar', 'instrText', 'numPr', 'tbl', 'drawing', 'txbxContent', 'footnoteReference', 'commentReference', 'sdt', 'pPrChange']) {
  test(`unsupported substantive DOCX content rejects ${element}`, async () => {
    const xml = `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>ordinary</w:t><w:${element}/></w:r></w:p></w:body></w:document>`;
    await assert.rejects(() => readTextSource(input(docx([], {xml}), 'unsupported.docx')), /не поддерживается/);
  });
}
for (const extra of ['word/header1.xml', 'word/footer1.xml', 'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml', 'word/custom.xml']) {
  test(`additional DOCX story is never silently dropped: ${extra}`, async () => {
    await assert.rejects(() => readTextSource(input(docx(['main'], {extraEntries: {[extra]: '<extra>hidden</extra>'}}), 'extra.docx')), /не поддержива|колонтитулы/);
  });
}

test('only applied/default style chains with numbering are rejected; unused list templates are harmless', async () => {
  const numbered = '<w:style w:type="paragraph" w:styleId="Numbered"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>';
  const styles = `<w:styles xmlns:w="${W}">${numbered}<w:style w:type="paragraph" w:styleId="Derived"><w:basedOn w:val="Numbered"/></w:style></w:styles>`;
  const unused = await readTextSource(input(docx(['item'], {extraEntries: {'word/styles.xml': styles}}), 'plain.docx'));
  assert.equal(unused.blocks[0].text, 'item');
  const xml = `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:t>item</w:t></w:r></w:p></w:body></w:document>`;
  await assert.rejects(() => readTextSource(input(docx([], {xml, extraEntries: {'word/styles.xml': styles}}), 'numbered.docx')), /нумерацию/);
  const defaults = styles.replace('w:styleId="Numbered"', 'w:styleId="Numbered" w:default="1"');
  await assert.rejects(() => readTextSource(input(docx(['item'], {extraEntries: {'word/styles.xml': defaults}}), 'default-numbered.docx')), /нумерацию/);
  const cycle = styles.replace('<w:basedOn w:val="Numbered"/>', '<w:basedOn w:val="Derived"/>');
  await assert.rejects(() => readTextSource(input(docx([], {xml, extraEntries: {'word/styles.xml': cycle}}), 'cycle.docx')), /наследование/);
});

test('empty bibliography metadata is allowed; actual bibliography, bindings and arbitrary custom XML are not', async () => {
  const bibliography = '<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" StyleName="APA"/>';
  const permitted = await readTextSource(input(docx(['body'], {extraEntries: {'customXml/item1.xml': bibliography}}), 'plain.docx'));
  assert.ok(permitted.meta.notes.some(n => n.includes('Пустой служебный шаблон библиографии')));
  for (const raw of [bibliography.replace('/>', '><b:Source>user source</b:Source></b:Sources>'), '<data>customer information</data>']) {
    await assert.rejects(() => readTextSource(input(docx(['body'], {extraEntries: {'customXml/item1.xml': raw}}), 'data.docx')), /XML-данные|библиографию/);
  }
  const binding = `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:dataBinding w:xpath="/data"/></w:pPr></w:p></w:body></w:document>`;
  await assert.rejects(() => readTextSource(input(docx([], {xml: binding, extraEntries: {'customXml/item1.xml': bibliography}}), 'bound.docx')), /не поддерживается/);
});

test('metadata thumbnail and properties are explicitly outside scope', async () => {
  const parsed = await readTextSource(input(docx(['main'], {extraEntries: {'docProps/thumbnail.jpeg': new Uint8Array([1, 2, 3]), 'docProps/core.xml': '<core>metadata</core>'}}), 'metadata.docx'));
  assert.equal(parsed.blocks[0].text, 'main'); assert.ok(parsed.meta.notes.some(n => n.includes('эскиз')));
});

test('broken XML, unknown entities and DTD cannot be accepted as partial text', async () => {
  for (const xml of [`<w:document xmlns:w="${W}"><w:body><w:p>`, `<!DOCTYPE x [<!ENTITY boom "text">]><w:document xmlns:w="${W}"><w:body/></w:document>`, `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&unknown;</w:t></w:r></w:p></w:body></w:document>`, '<w:document><w:body/></w:document>']) {
    await assert.rejects(() => readTextSource(input(docx([], {xml}), 'bad.docx')), /XML|DTD/);
  }
});

test('ZIP corruption, forged size, traversal, missing parts and expansion are bounded', async () => {
  const raw = docx(['okay']); raw[40] ^= 1;
  await assert.rejects(() => readTextSource(input(raw, 'bad.docx')), /ZIP/);
  await assert.rejects(() => readTextSource(input(zipEntries({'../escape': 'bad'}), 'bad.docx')), /ZIP/);
  await assert.rejects(() => readTextSource(input(zipEntries({'only.xml': '<x/>'}), 'bad.docx')), /обязательные/);
  const bomb = docx(['okay'], {deflate: true, extraEntries: {'word/styles.xml': '<x>' + 'a'.repeat(17 * 1024 * 1024) + '</x>'}});
  await assert.rejects(() => readTextSource(input(bomb, 'bomb.docx')), /16 МиБ/);
  const forged = docx(['okay'], {deflate: true}); const v = new DataView(forged.buffer); const central = v.getUint32(forged.length - 6, true);
  const realSize = v.getUint32(central + 24, true); v.setUint32(central + 24, realSize - 1, true); v.setUint32(22, realSize - 1, true);
  await assert.rejects(() => readTextSource(input(forged, 'forged.docx')), /ZIP/);
});

test('source bytes, extracted Unicode chars, block count and XML depth have explicit limits', async () => {
  await assert.rejects(() => readTextSource(input('a'.repeat(2 * 1024 * 1024 + 1))), /2 МиБ/);
  await assert.rejects(() => readTextSource(input('a'.repeat(500001))), /500 000/);
  await assert.rejects(() => readTextSource(input('x\n'.repeat(2001))), /2000/);
  const xml = `<w:document xmlns:w="${W}"><w:body>${'<w:r>'.repeat(70)}${'</w:r>'.repeat(70)}</w:body></w:document>`;
  await assert.rejects(() => readTextSource(input(docx([], {xml}), 'depth.docx')), /64 уровня/);
  await assert.rejects(() => readTextSource(input(Buffer.from([0xff]))), /UTF-8/);
  await assert.rejects(() => readTextSource(input('a\0b')), /NUL/);
  await assert.rejects(() => readTextSource({name: 'a.txt', data: 'YQ==\n'}), /base64/);
});

test('word-diff work budget falls back to entire paragraph with explicit note, never lost text', async () => {
  const a = 'left '.repeat(2000), b = 'right '.repeat(2000);
  const report = await compareText(payload(input(a), input(b)));
  assert.deepEqual(report.changed[0].segments.left, [{text: a, changed: true}]);
  assert.ok(report.sources.left.notes.some(note => note.includes('абзац целиком')));
  completeEvidence(report, [a], [b]);
});

test('empty documents and one-sided text have complete evidence and correct summaries', async () => {
  const empty = await compareText(payload(input(''), input(docx([]), 'empty.docx')));
  assert.deepEqual(empty.summary, {left_blocks: 0, right_blocks: 0, matched: 0, changed: 0, only_left: 0, only_right: 0});
  const added = await compareText(payload(input(''), input('new\n\n')));
  assert.equal(added.only_right.length, 2); completeEvidence(added, [], ['new', '']);
});

test('ordinary DOCX hyperlinks preserve visible text and never access their URLs', async () => {
  const xml = `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="rId2"><w:r><w:t>click text</w:t></w:r></w:hyperlink></w:p></w:body></w:document>`;
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private" TargetMode="External"/></Relationships>';
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('network forbidden'); };
  try {
    const result = await readTextSource(input(docx([], {xml, extraEntries: {'word/_rels/document.xml.rels': rels}}), 'link.docx'));
    assert.equal(result.blocks[0].text, 'click text'); assert.ok(result.meta.notes.some(n => n.includes('адреса не открываются')));
  } finally { globalThis.fetch = previous; }
});
