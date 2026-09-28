import {docx, W, escapeXml} from './text-fixture.mjs';
export const paragraph = (text, properties = '') => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
export const cell = (text, properties = '') => `<w:tc><w:tcPr>${properties}</w:tcPr>${Array.isArray(text) ? text.join('') : paragraph(text)}</w:tc>`;
export const table = rows => `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows.map(row => `<w:tr>${row.join('')}</w:tr>`).join('')}</w:tbl>`;
export function tableSource(price = '100', {body, extraEntries = {}} = {}) {
  const content = body ?? paragraph('Предложение') + table([
    [cell('Услуги', '<w:gridSpan w:val="3"/><w:shd w:fill="DDEEFF"/>')],
    [cell('Группа', '<w:vMerge w:val="restart"/>'), cell('Товар'), cell('Цена')],
    [cell(['<w:p/>'], '<w:vMerge/>'), cell([paragraph('Печать'), paragraph('Доставка')]), cell(price)],
    [cell('Итого', '<w:gridSpan w:val="2"/>'), cell(price)],
  ]) + paragraph('Конец');
  const borders = ['top','bottom','left','right','insideH','insideV'].map(n => `<w:${n} w:val="single" w:sz="8" w:color="336699"/>`).join('');
  const raw = docx([], {xml: `<w:document xmlns:w="${W}"><w:body>${content}<w:sectPr/></w:body></w:document>`, extraEntries: {
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="table" w:styleId="TableGrid"><w:tblPr><w:tblBorders>${borders}</w:tblBorders></w:tblPr></w:style></w:styles>`, ...extraEntries,
  }});
  return {name: 'table.docx', data: Buffer.from(raw).toString('base64')};
}
