import {PDFDocument, fontkit} from '../../extension/pdf-vendor.mjs';
import fontBase64 from '../../extension/pdf-font.mjs';

// Each run is drawn through its own Form XObject, as in PDFs exported by design
// tools. The authored order deliberately differs from a global visual sort.
export async function layoutPdf(name, pages) {
  const forms = await PDFDocument.create();
  forms.registerFontkit(fontkit);
  const font = await forms.embedFont(Buffer.from(fontBase64, 'base64'), {subset: true});
  const placements = [];
  for (const rows of pages) {
    const pageRuns = [];
    for (const {text, x = 48, y, size = 12, angle = 0} of rows) {
      let nextX = x, nextY = y;
      const radians = angle * Math.PI / 180;
      for (const run of Array.isArray(text) ? text : [text]) {
        const width = font.widthOfTextAtSize(run, size);
        const page = forms.addPage([Math.max(1, width + 2), size * 3]);
        page.drawText(run, {font, size, x: 0, y: size});
        pageRuns.push({index: forms.getPageCount() - 1, x: nextX + size * Math.sin(radians), y: nextY - size * Math.cos(radians), angle});
        nextX += width * Math.cos(radians);
        nextY += width * Math.sin(radians);
      }
    }
    placements.push(pageRuns);
  }
  const source = await PDFDocument.load(await forms.save());
  const output = await PDFDocument.create();
  for (const pageRuns of placements) {
    const page = output.addPage([595, 842]);
    for (const {index, x, y, angle} of pageRuns) {
      page.drawPage(await output.embedPage(source.getPages()[index]), {x, y, rotate: {type: 'degrees', angle}});
    }
  }
  return {name, data: Buffer.from(await output.save()).toString('base64')};
}

export function salesLayout({sales = '1,3–2,6', orders = '80–100', plan = '100%'} = {}) {
  return [[
    {text: 'ПРОФИЛЬ', x: 48, y: 790, size: 16},
    {text: 'Работаю на результат.', x: 48, y: 760},
    {text: 'РЕЗУЛЬТАТЫ', x: 48, y: 720, size: 16},
    {text: `Продажи в месяц: ${sales} млн ₽.`, x: 48, y: 690},
    {text: `Заказы в месяц: ${orders}.`, x: 48, y: 666},
    {text: `Выполнение плана: ${plan}.`, x: 48, y: 642},
    {text: 'КОНТАКТЫ', x: 340, y: 790, size: 16},
    {text: 'Город: Москва.', x: 340, y: 760},
  ]];
}
