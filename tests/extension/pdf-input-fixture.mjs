import {PDFDocument, fontkit} from '../../extension/pdf-vendor.mjs';
import fontBase64 from '../../extension/pdf-font.mjs';

// Independently authored input documents: expected text comes from these source lines,
// never from the extractor under test. Embedded DejaVu exercises genuine Unicode PDFs.
export const PDF_LINES_A = [
  ['Договор № 17', 'Ёлка — офис & склад, 125 ₽.', 'Срок: 5 рабочих дней.', 'Количество: 10 штук.', 'Стоимость: 125000 рублей.'],
  ['Условия поставки', 'Поставщик направляет ежедневный отчёт.', 'Контакт: Анна.', 'Подпись заказчика.'],
];
export const PDF_LINES_B = [
  ['Договор № 17', 'Ёлка — офис & склад, 125 ₽.', 'Срок: 7 рабочих дней.', 'Количество: 12 штук.', 'Стоимость: 128500 рублей.'],
  ['Условия поставки', 'Контакт: Анна.', 'Уведомление об отгрузке по почте.', 'Подпись заказчика.'],
];
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

/** imagePages are one-based; even a raster-only page must not be silently omitted. */
export async function pdfSource(name, pages, {imagePages = [], inlineImagePages = [], form = false, standardFont = false} = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const font = await pdf.embedFont(standardFont ? 'Helvetica' : Buffer.from(fontBase64, 'base64'), {subset: true});
  for (const [index, lines] of pages.entries()) {
    const page = pdf.addPage([595, 842]);
    for (const [line, value] of lines.entries()) {
      let x = 48;
      for (const text of Array.isArray(value) ? value : [value]) {
        page.drawText(text, {font, size: 12, x, y: 785 - line * 24});
        x += font.widthOfTextAtSize(text, 12);
      }
    }
    if (imagePages.includes(index + 1)) page.drawImage(await pdf.embedPng(Buffer.from(tinyPng, 'base64')), {x: 48, y: 100, width: 400, height: 400});
    if (inlineImagePages.includes(index + 1)) {
      const stream = pdf.context.flateStream(Buffer.from('q\n10 0 0 10 48 100 cm\nBI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI\nQ\n', 'latin1'));
      page.node.addContentStream(pdf.context.register(stream));
    }
  }
  if (form) {
    const field = pdf.getForm().createTextField('Approval');
    field.setText('Hidden form value');
    field.addToPage(pdf.getPages()[0], {x: 48, y: 90, width: 250, height: 30});
  }
  return {name, data: Buffer.from(await pdf.save()).toString('base64')};
}

export async function pdfFixturePair() {
  return {left: await pdfSource('Заказ.pdf', PDF_LINES_A), right: await pdfSource('Подтверждение.pdf', PDF_LINES_B)};
}

// Actual password-protected PDF generated once with pypdf (password: secret).
// Stored bytes keep Node/browser CI independent of Python and encryption packages.
export const encryptedPdf = {name: 'encrypted.pdf', data: 'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDYxNTcxNmNjNTA+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA1OTUgODQyIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8MGU1MjI5MjVhM2U0ZTg3NGMzY2ZhY2JlZjUxMWE3M2FjNGVjMmJkODY1ZGNkM2Q0NjI3NjE0OTE3YWJmZDdlND4KL1UgPDcyNzcyYmI2NGE3M2E2NzI0YjY0M2JlOTE5OTI3YWQ2MjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM0MzEzNzMzMzAzMDY1MzM2MTMyMzM2MjY2NjYzMzM5NjI2NjY0MzQ2NDM3NjEzOTM0MzEzNDM4MzkzMTYzMzQ+IDwzNDMxMzczMzMwMzA2NTMzNjEzMjMzNjI2NjY2MzMzOTYyNjY2NDM0NjQzNzYxMzkzNDMxMzQzODM5MzE2MzM0PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK'};
