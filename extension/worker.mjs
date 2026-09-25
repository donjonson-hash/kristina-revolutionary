import {prepare, inspect, compare} from './engine.mjs';
import {renderHtml, renderJson} from './report.mjs';
import {prepareText, compareText} from './text-engine.mjs';
import {renderTextHtml} from './text-report.mjs';
import {buildCommercialSummary} from './commercial-summary.mjs';

export async function handleRequest(path, payload) {
  for (const side of ['left', 'right']) {
    const unsupported = /\.(doc|docm|odt|rtf|pdf)$/i.exec(payload?.[side]?.name || '');
    if (unsupported) throw new Error(`Формат ${unsupported[1].toUpperCase()} пока не поддерживается. Для текста выберите TXT или DOCX.`);
  }
  const isText = side => /\.(txt|docx)$/i.test(payload?.[side]?.name || '');
  if (isText('left') || isText('right')) {
    if (!isText('left') || !isText('right')) throw new Error('Для текста загрузите два файла TXT или DOCX. Таблицы CSV/XLSX сравниваются отдельно.');
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
    try { self.postMessage({ok: true, result: await handleRequest(data.path, data.payload)}); }
    catch (error) { self.postMessage({ok: false, error: error.message || 'Не удалось обработать файлы.'}); }
  };
}
