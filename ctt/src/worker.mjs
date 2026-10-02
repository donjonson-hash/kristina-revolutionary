import {prepare, inspect, compare} from './engine.mjs';
import {renderHtml, renderJson} from './report.mjs';
import {prepareText, compareText} from './text-engine.mjs';
import {renderTextHtml} from './text-report.mjs';
import {buildCommercialSummary} from './commercial-summary.mjs';

export async function handleRequest(path, payload) {
  if (path === '/api/export') {
    const format = payload?.format, report = payload?.report;
    if (!['xlsx', 'pdf'].includes(format)) throw new Error("Select XLSX or PDF export.");
    if (!report || report.status !== 'complete') throw new Error("Complete the document comparison first.");
    renderJson(report); // Bound the evidence before loading either binary writer.
    const data = format === 'xlsx'
      ? (await import('./xlsx-report.mjs')).renderXlsx(report)
      : await (await import('./pdf-report.mjs')).renderPdf(report);
    if (!(data instanceof Uint8Array) || data.byteLength > 16 * 1024 * 1024) throw new Error("The report exceeds 16 MiB. Split the source files and compare again.");
    return {data, filename: `ctt-comparison.${format}`, mime: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  }
  for (const side of ['left', 'right']) {
    const unsupported = /\.(doc|docm|odt|rtf)$/i.exec(payload?.[side]?.name || '');
    if (unsupported) throw new Error(`Format ${unsupported[1].toUpperCase()} is not yet supported. For text, select TXT, DOCX, or PDF files with a text layer.`);
  }
  const isText = side => /\.(txt|docx|pdf)$/i.test(payload?.[side]?.name || '');
  if (isText('left') || isText('right')) {
    if (!isText('left') || !isText('right')) throw new Error("For text, upload two TXT, DOCX, or PDF files. CSV/XLSX tables are compared separately.");
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
    throw new Error("Unknown operation.");
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
  throw new Error("Unknown operation.");
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async ({data}) => {
    try {
      const result = await handleRequest(data.path, data.payload);
      self.postMessage({ok: true, result}, result?.data instanceof Uint8Array ? [result.data.buffer] : []);
    }
    catch (error) { self.postMessage({ok: false, error: error.message || "Could not process the files."}); }
  };
}
