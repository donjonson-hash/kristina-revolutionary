import {prepare, inspect, compare} from './engine.mjs';
import {renderHtml, renderJson} from './report.mjs';
import {prepareText, compareText} from './text-engine.mjs';
import {renderTextHtml} from './text-report.mjs';
import {buildCommercialSummary} from './commercial-summary.mjs';

export async function handleRequest(path, payload) {
  if (path === '/api/export') {
    const format = payload?.format, report = payload?.report;
    if (!['xlsx', 'pdf'].includes(format)) throw new Error('Выберите экспорт XLSX или PDF.');
    if (!report || report.status !== 'complete') throw new Error('Сначала завершите сверку документов.');
    renderJson(report); // Bound the evidence before loading either binary writer.
    const data = format === 'xlsx'
      ? (await import('./xlsx-report.mjs')).renderXlsx(report)
      : await (await import('./pdf-report.mjs')).renderPdf(report);
    if (!(data instanceof Uint8Array) || data.byteLength > 16 * 1024 * 1024) throw new Error('Отчёт превышает 16 MiB. Разделите исходные файлы и повторите сверку.');
    return {data, filename: `kristina-reconciliation.${format}`, mime: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  }
  for (const side of ['left', 'right']) {
    const unsupported = /\.(doc|docm|odt|rtf)$/i.exec(payload?.[side]?.name || '');
    if (unsupported) throw new Error(`Формат ${unsupported[1].toUpperCase()} пока не поддерживается. Для текста выберите TXT, DOCX или PDF с текстовым слоем.`);
  }
  const isText = side => /\.(txt|docx|pdf)$/i.test(payload?.[side]?.name || '');
  if (isText('left') || isText('right')) {
    if (!isText('left') || !isText('right')) throw new Error('Для текста загрузите два файла TXT, DOCX или PDF. Таблицы CSV/XLSX сравниваются отдельно.');
    if (path === '/api/prepare' || path === '/api/inspect') {
      const result = await prepareText(payload);
      renderJson(result);
      return result;
    }
    if (path === '/api/compare') {
      const report = await compareText(payload);
      renderJson(report);
      return {report, html: renderTextHtml(report)};
    }
    throw new Error('Неизвестная операция.');
  }
  if (path === '/api/prepare') {
    const result = await prepare(payload);
    renderJson(result); // Bound amplified metadata before transferring it.
    return result;
  }
  if (path === '/api/inspect') {
    const result = await inspect(payload);
    renderJson(result);
    return result;
  }
  if (path === '/api/compare') {
    const report = await compare(payload);
    report.commercial = buildCommercialSummary(report);
    renderJson(report);
    return {report, html: renderHtml(report)};
  }
  throw new Error('Неизвестная операция.');
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async ({data}) => {
    try {
      const result = await handleRequest(data.path, data.payload);
      self.postMessage({ok: true, result}, result?.data instanceof Uint8Array ? [result.data.buffer] : []);
    }
    catch (error) { self.postMessage({ok: false, error: error.message || 'Не удалось обработать файлы.'}); }
  };
}
