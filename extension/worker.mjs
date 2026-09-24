import {prepare, inspect, compare} from './engine.mjs';
import {renderHtml, renderJson} from './report.mjs';

export async function handleRequest(path, payload) {
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
