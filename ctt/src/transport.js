"use strict";
// Each request gets an isolated worker. Cancellation also stops CPU work.
(() => {
  const workerURL = new URL('worker.mjs', document.currentScript.src);
  window.KristinaTransport = Object.freeze({
    request(path, payload, {signal} = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Canceled", 'AbortError')); return; }
        const worker = new Worker(workerURL, {type: 'module'});
        let settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          worker.terminate();
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(new DOMException("Canceled", 'AbortError'));
        const timer = setTimeout(() => finish(new Error("Processing took too long. Try a smaller file.")), 40000);
        signal?.addEventListener('abort', abort, {once: true});
        worker.onmessage = ({data}) => data.ok ? finish(null, data.result) : finish(new Error(data.error));
        worker.onerror = (event) => { event.preventDefault(); finish(new Error("Couldn't start processing in your browser. Reload this page.")); };
        worker.onmessageerror = () => finish(new Error("Couldn't retrieve the processing results."));
        try { worker.postMessage({path, payload}); } catch (error) { finish(error); }
      });
    }
  });
})();
