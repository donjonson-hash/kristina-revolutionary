/** Word body order and table coordinates, shared by extraction, preview and export. */
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const elements = node => Array.from(node?.childNodes || []).filter(n => n.nodeType === 1);
const is = (node, name) => W.has(node?.namespaceURI) && node.localName === name;
const child = (node, name) => elements(node).find(n => is(n, name));
const attr = (node, name = 'val') => { for (const ns of W) { const value = node?.getAttributeNS(ns, name); if (value !== null && value !== undefined) return value; } return null; };
const fail = message => { throw new Error(`DOCX: ${message}`); };
const enabled = node => node && !['0', 'false', 'off'].includes(attr(node));
function number(value, min, max, fallback) {
  if (value === null && fallback !== undefined) return fallback;
  if (!/^\d+$/.test(value || '') || Number(value) < min || Number(value) > max) fail('некорректные размеры таблицы.');
  return Number(value);
}
function contents(node, allowed) {
  for (const n of Array.from(node.childNodes)) {
    if (n.nodeType === 8 || n.nodeType === 3 && !n.data.trim()) continue;
    if (n.nodeType !== 1 || !W.has(n.namespaceURI) || !allowed.includes(n.localName)) fail(`содержимое ${node.localName} не поддерживается. Вложенные таблицы и дополнительные объекты пока недоступны.`);
  }
}
function emptyProperties(node) {
  if (node?.textContent.trim()) fail('текст в свойствах таблицы не поддерживается.');
}
function borders(node) {
  const result = {};
  for (const n of elements(node)) {
    const value = attr(n), size = attr(n, 'sz'), color = attr(n, 'color');
    const kind = {single: 'solid', thick: 'solid', double: 'double', dotted: 'dotted', dashed: 'dashed', dashSmallGap: 'dashed', nil: 'none', none: 'none'}[value];
    if (kind) result[n.localName] = `${size && /^\d+$/.test(size) ? Math.min(12, Number(size) / 8) : .5}pt ${kind} ${/^[a-f\d]{6}$/i.test(color || '') ? '#' + color : '#333333'}`;
  }
  return result;
}
function cellStyle(pr) {
  const result = {}, fill = attr(child(pr, 'shd'), 'fill'), alignment = attr(child(pr, 'vAlign'));
  if (/^[a-f\d]{6}$/i.test(fill || '')) result.backgroundColor = '#' + fill;
  if (['top', 'center', 'bottom'].includes(alignment)) result.verticalAlign = alignment === 'center' ? 'middle' : alignment;
  for (const [edge, value] of Object.entries(borders(child(pr, 'tcBorders')))) if (['top', 'bottom', 'left', 'right'].includes(edge)) result['border' + edge[0].toUpperCase() + edge.slice(1)] = value;
  for (const n of elements(child(pr, 'tcMar'))) if (['top', 'bottom', 'left', 'right'].includes(n.localName) && attr(n, 'type') === 'dxa' && /^\d+$/.test(attr(n, 'w') || '')) result['padding' + n.localName[0].toUpperCase() + n.localName.slice(1)] = `${Math.min(1440, Number(attr(n, 'w'))) / 20}pt`;
  return result;
}
function tableStyles(docs) {
  const styles = new Map(elements(docs.get('word/styles.xml')?.documentElement).filter(n => is(n, 'style') && attr(n, 'type') === 'table').map(n => [attr(n, 'styleId'), n]));
  function chain(id, seen = new Set()) {
    if (!id || !styles.has(id)) return [];
    if (seen.has(id) || seen.size > 32) fail('циклический стиль таблицы.');
    seen.add(id); const node = styles.get(id);
    return [...chain(attr(child(node, 'basedOn')), seen), node];
  }
  return pr => chain(attr(child(pr, 'tblStyle')));
}

export function readDocxStructure(doc, docs = new Map()) {
  if (!is(doc.documentElement, 'document')) fail('основной XML не является WordprocessingML-документом.');
  const body = child(doc.documentElement, 'body'), paragraphs = [], locations = [], content = [], styles = tableStyles(docs);
  if (!body) fail('отсутствует основное содержимое.');
  contents(body, ['p', 'tbl', 'sectPr']);
  let tableIndex = 0;
  function paragraph(node, table) {
    paragraphs.push(node);
    if (paragraphs.length > 2000) fail('документ содержит более 2000 текстовых блоков. Разделите его.');
    locations.push(table || null);
    return {type: 'paragraph', record: paragraphs.length};
  }
  for (const node of elements(body)) {
    if (is(node, 'p')) { content.push(paragraph(node)); continue; }
    if (is(node, 'sectPr')) { emptyProperties(node); continue; }
    contents(node, ['tblPr', 'tblGrid', 'tr']);
    const pr = child(node, 'tblPr'), grid = child(node, 'tblGrid'), rows = elements(node).filter(n => is(n, 'tr'));
    emptyProperties(pr); emptyProperties(grid);
    if (child(pr, 'tblpPr') || enabled(child(pr, 'bidiVisual'))) fail('плавающие таблицы и обратный порядок столбцов пока не поддерживаются.');
    const columns = elements(grid);
    if (!columns.length || columns.length > 64 || columns.some(n => !is(n, 'gridCol')) || !rows.length || rows.length > 1000) fail('поддерживаются таблицы с сеткой до 64 столбцов и 1000 строк.');
    const widths = columns.map(n => number(attr(n, 'w'), 0, 31680, 0));
    const inherited = styles(pr), tablePr = [...inherited.map(n => child(n, 'tblPr')), pr];
    const tableBorders = Object.assign({}, ...tablePr.map(n => borders(child(n, 'tblBorders'))));
    const table = {type: 'table', index: ++tableIndex, widths, rows: [], style: {}};
    const widthNode = tablePr.map(n => child(n, 'tblW')).filter(Boolean).at(-1);
    const width = attr(widthNode, 'w'), widthType = attr(widthNode, 'type');
    if (/^\d+$/.test(width || '') && Number(width) > 0) {
      if (widthType === 'pct') table.style.width = `${Math.min(100, Number(width) / 50)}%`;
      else if (widthType === 'dxa') table.style.width = `${Math.min(31680, Number(width)) / 20}pt`;
    }
    const align = attr(child(pr, 'jc'));
    if (align === 'center') table.style.marginLeft = table.style.marginRight = 'auto';
    if (align === 'right' || align === 'end') table.style.marginLeft = 'auto';
    const look = child(pr, 'tblLook'), mask = /^[a-f\d]{1,4}$/i.test(attr(look) || '') ? parseInt(attr(look), 16) : 0;
    const flag = (name, bit) => attr(look, name) !== null ? ['1', 'true', 'on'].includes(attr(look, name)) : !!(mask & bit);
    let previous = new Map();
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]; contents(row, ['trPr', 'tc']); emptyProperties(child(row, 'trPr'));
      if (child(child(row, 'trPr'), 'gridBefore') || child(child(row, 'trPr'), 'gridAfter') || child(child(row, 'trPr'), 'tblPrEx')) fail('таблицы с пропущенными ячейками пока не поддерживаются.');
      const cells = elements(row).filter(n => is(n, 'tc')), rowModel = {cells: []}, next = new Map(); let column = 0;
      for (const cell of cells) {
        contents(cell, ['tcPr', 'p']); const cp = child(cell, 'tcPr'); emptyProperties(cp);
        if (child(cp, 'hMerge') || child(cp, 'textDirection') && attr(child(cp, 'textDirection')) !== 'lrTb') fail('эта разновидность объединения или поворота ячеек пока не поддерживается.');
        const span = number(attr(child(cp, 'gridSpan')), 1, 64, 1), merge = child(cp, 'vMerge'), mergeValue = attr(merge) || 'continue';
        if (column + span > widths.length || merge && !['restart', 'continue'].includes(mergeValue)) fail('некорректное объединение ячеек.');
        const ps = elements(cell).filter(n => is(n, 'p'));
        if (!ps.length) fail('ячейка не содержит абзаца.');
        if (merge && mergeValue === 'continue') {
          const origin = previous.get(column);
          if (!origin || origin.colSpan !== span) fail('нарушено вертикальное объединение ячеек.');
          // Word does not display these continuation paragraphs. Do not hide real
          // content or number a phantom list item if a producer wrote any there.
          for (const p of ps) {
            const stack = [p]; while (stack.length) { const n = stack.pop(); if (is(n, 't') && n.textContent || ['drawing', 'tab', 'br', 'cr', 'numPr', 'pStyle', 'sym', 'noBreakHyphen', 'softHyphen'].some(name => is(n, name))) fail('скрытое содержимое продолжения объединённой ячейки не поддерживается.'); stack.push(...elements(n)); }
          }
          origin.rowSpan++; next.set(column, origin);
        } else {
          const conditions = ['wholeTable'];
          const bandRow = r - (flag('firstRow', 0x20) ? 1 : 0), bandColumn = column - (flag('firstColumn', 0x80) ? 1 : 0);
          if (!flag('noHBand', 0x200) && bandRow >= 0) conditions.push(bandRow % 2 ? 'band2Horz' : 'band1Horz');
          if (!flag('noVBand', 0x400) && bandColumn >= 0) conditions.push(bandColumn % 2 ? 'band2Vert' : 'band1Vert');
          if (column === 0 && flag('firstColumn', 0x80)) conditions.push('firstCol');
          if (column + span === widths.length && flag('lastColumn', 0x100)) conditions.push('lastCol');
          if (r === 0 && flag('firstRow', 0x20)) conditions.push('firstRow');
          if (r === rows.length - 1 && flag('lastRow', 0x40)) conditions.push('lastRow');
          const style = {};
          for (const [edge, border] of Object.entries({top: tableBorders[r === 0 ? 'top' : 'insideH'], bottom: tableBorders[r === rows.length - 1 ? 'bottom' : 'insideH'], left: tableBorders[column === 0 ? 'left' : 'insideV'], right: tableBorders[column + span === widths.length ? 'right' : 'insideV']})) if (border) style['border' + edge[0].toUpperCase() + edge.slice(1)] = border;
          for (const s of inherited) {
            Object.assign(style, cellStyle(child(s, 'tcPr')));
            for (const condition of conditions) for (const spec of elements(s).filter(n => is(n, 'tblStylePr') && attr(n, 'type') === condition)) Object.assign(style, cellStyle(child(spec, 'tcPr')));
          }
          Object.assign(style, cellStyle(cp));
          const c = {column: column + 1, colSpan: span, rowSpan: 1, style, content: ps.map((p, i) => paragraph(p, {table: tableIndex, row: r + 1, column: column + 1, paragraph: i + 1}))};
          rowModel.cells.push(c); if (merge) next.set(column, c);
        }
        column += span;
      }
      if (column !== widths.length) fail('число ячеек не соответствует сетке таблицы.');
      table.rows.push(rowModel); previous = next;
    }
    content.push(table);
  }
  return {paragraphs, locations, content, hasTables: tableIndex > 0};
}

export const TABLE_EDIT_NOTICE = 'В документе с таблицами пока можно менять текст в существующих абзацах и ячейках. Добавление, удаление и перенос абзацев, строк и столбцов пока недоступны.';
export function validateTableSequence(records, sequence) {
  if (sequence.length !== records.length || sequence.some((item, i) => item.record !== records[i])) throw new Error(TABLE_EDIT_NOTICE);
}
