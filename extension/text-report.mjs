/** Offline export of extracted text differences, without semantic interpretation. */
import {MAX_REPORT_BYTES, renderJson} from './report.mjs';
const encoder = new TextEncoder();
const entities = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
const escape = value => String(value).replace(/[&<>"']/g, character => entities[character]);
const labels = {changed: 'Текст изменился', only_left: 'Только в A', only_right: 'Только в B', matched: 'Текст совпал'};
const style = `*{box-sizing:border-box}body{margin:0;padding:28px;background:#f3f4ee;color:#263b34;font:16px/1.65 system-ui,sans-serif}main{max-width:1280px;margin:auto}h1{font-size:30px;line-height:1.25}h2{font-size:21px}h3{font-size:15px;font-weight:500}.totals{display:flex;flex-wrap:wrap;gap:12px}.totals div{background:white;border:1px solid #d9dfd5;border-radius:8px;padding:14px;flex:1;min-width:140px}.totals strong{display:block;font-size:26px}.pair{margin:24px 0;break-inside:avoid}.papers{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}.paper{background:#fffefa;border:1px solid #d5dbd1;padding:22px;min-width:0}.paper header{font-size:13px;border-bottom:1px solid #dde1da;padding-bottom:10px;overflow-wrap:anywhere}.location,.note{font-size:12px;color:#59685f}.text{font:17px/1.8 Georgia,serif;white-space:pre-wrap;overflow-wrap:anywhere;margin-bottom:0}.left mark{background:#ffd5c5;color:#672a17}.right mark{background:#c5ebce;color:#164c2b}mark{border-radius:2px}.absent{background:repeating-linear-gradient(135deg,#f8f7f1,#f8f7f1 6px,#f0efe8 6px,#f0efe8 7px)}.metadata{margin-top:28px;padding:18px;border:1px solid #d5dbd1;border-radius:8px}.source{margin-top:18px;overflow-wrap:anywhere}.hash{font:12px/1.5 monospace;overflow-wrap:anywhere}summary{cursor:pointer}summary:focus-visible{outline:3px solid #6c93db;outline-offset:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{overflow-wrap:anywhere}@media(max-width:700px){body{padding:14px}.papers{grid-template-columns:1fr;gap:10px}.paper{padding:16px}h1{font-size:25px}}@media print{body{padding:0;background:white}.paper{box-shadow:none}.papers{gap:12px}}`;

export function renderTextHtml(report) {
  if (report.kind !== 'text' || report.status !== 'complete') throw new TypeError('Expected a complete text report');
  const parts = []; let size = 0;
  function append(text) {
    if (text.length > MAX_REPORT_BYTES - size) throw new RangeError('HTML report exceeds 16 MiB; split the input documents');
    const bytes = encoder.encode(text).length;
    if (bytes > MAX_REPORT_BYTES - size) throw new RangeError('HTML report exceeds 16 MiB; split the input documents');
    size += bytes; parts.push(text);
  }
  append(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Сверка текста — Кристина</title><style>${style}</style></head><body><main><h1>Различия в тексте документов</h1><p>Кристина сравнила извлечённый текст локально, без LLM. Подсветка показывает текстовые изменения. Это не оценка юридического смысла, достоверности фактов или орфографии.</p><p>Показано содержимое текстовых блоков, а не исходная вёрстка. Различия переводов строк нормализованы; пробелы и регистр учитываются. Места в исходных документах указаны в каждой панели.</p>`);
  if (Object.values(report.sources).some(source => source.format === 'pdf')) append('<p>PDF: проверен извлечённый текстовый слой. Пробелы и порядок строк восстановлены при извлечении; оформление и нетекстовые элементы не сравнивались.</p>');
  append('<div class="totals">');
  for (const [category, label] of Object.entries(labels)) append(`<div><strong>${escape(report.summary[category])}</strong><span>${label}</span></div>`);
  append('</div>');
  for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
    for (const note of report.sources[side].notes || []) append(`<p class="note">${label} · ${escape(note)}</p>`);
  }
  const rows = Object.keys(labels).flatMap(category => report[category].map(item => ({item, category})));
  rows.sort((a, b) => Number(a.item.key.slice(5)) - Number(b.item.key.slice(5)));
  if (!rows.length) append('<p>В извлечённом тексте обоих файлов нет блоков для сравнения.</p>');
  function panel(block, side, item, category) {
    const label = side === 'left' ? 'A' : 'B';
    append(`<section class="paper ${side}${block ? '' : ' absent'}"><header>${label} · ${escape(report.sources[side].name)}</header>`);
    if (!block) { append('<p class="note">Текстового блока с этой стороны нет.</p></section>'); return; }
    append(`<p class="location">${escape(block.location)} · блок ${escape(block.record)}</p><p class="text">`);
    if (category === 'changed') {
      const segments = item.segments?.[side];
      if (!Array.isArray(segments) || segments.some(segment => typeof segment.text !== 'string' || typeof segment.changed !== 'boolean') || segments.map(segment => segment.text).join('') !== block.text) throw new TypeError('Text highlight segments do not preserve the source block');
      for (const segment of segments) append(segment.changed ? `<mark>${escape(segment.text)}</mark>` : escape(segment.text));
    } else if (category === 'only_left' || category === 'only_right') append(`<mark>${escape(block.text)}</mark>`);
    else append(escape(block.text));
    append('</p>');
    if (!block.text) append('<p class="note">Пустой текстовый блок.</p>');
    append('</section>');
  }
  for (const {item, category} of rows) {
    append(`<article class="pair ${category}"><h3>${escape(item.key)} · ${labels[category]}</h3><div class="papers">`);
    const only = category === 'only_left' || category === 'only_right';
    for (const side of ['left', 'right']) panel(only ? (category === `only_${side}` ? item.row : null) : item[side], side, item, category);
    append('</div></article>');
  }
  append('<details class="metadata"><summary>Источники и правила</summary>');
  for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
    const source = report.sources[side];
    append(`<div class="source"><strong>${label} · ${escape(source.name)}</strong><p>Формат: ${escape(source.format)}. Текстовых блоков: ${escape(source.block_count)}.${source.page_count ? ' Страниц PDF: ' + escape(source.page_count) + '.' : ''}</p><p class="hash">SHA-256 исходных байтов: ${escape(source.sha256)}</p></div>`);
  }
  append('<h2>Правила сравнения</h2><pre>' + escape(renderJson(report.rules)) + '</pre><p>«Только в A/B» означает отсутствие сопоставленного блока в извлечённом тексте другой стороны. Причины изменения и его смысл не устанавливаются.</p></details></main></body></html>');
  return parts.join('');
}
