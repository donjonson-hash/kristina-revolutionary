/** Local print view: only rendered pages from the final PDF enter the print job. */
const aborted = () => new DOMException('Printing canceled.', 'AbortError');

/** Call directly from a click handler, before awaiting PDF generation. */
export function preparePdfPrintWindow() {
  const target = window.open('', '_blank');
  if (!target) throw new Error('Allow the print window in your browser, then click Print again.');
  const doc = target.document;
  doc.title = 'Preparing document…';
  doc.documentElement.lang = 'en';
  doc.head.replaceChildren();
  const charset = doc.createElement('meta'); charset.charset = 'utf-8';
  const link = doc.createElement('link'); link.rel = 'stylesheet';
  link.href = new URL('./pdf-print.css', import.meta.url).href;
  const bar = doc.createElement('header'), status = doc.createElement('p'), retry = doc.createElement('button');
  bar.className = 'print-controls'; status.textContent = 'Preparing your document for printing…';
  retry.type = 'button'; retry.textContent = 'Print'; retry.disabled = true;
  bar.append(status, retry);
  const pages = doc.createElement('main'); pages.className = 'print-pages';
  doc.body.replaceChildren(bar, pages);
  const urls = new Set();
  let closed = false, started = false, styleLoaded = false, styleError = false;
  link.addEventListener('load', () => { styleLoaded = true; });
  link.addEventListener('error', () => { styleError = true; });
  doc.head.append(charset, link);
  const release = () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  const close = () => { closed = true; release(); if (!target.closed) target.close(); };
  target.addEventListener('unload', release, {once: true});
  const requestPrint = () => {
    if (target.closed || closed) return;
    status.textContent = 'Ready. If the print dialog did not open, click Print. Check paper size and turn off browser headers and footers in the print dialog.';
    try { target.focus(); target.print(); }
    catch { status.textContent = 'The browser could not open its print dialog. Click Print to try again.'; }
  };
  retry.addEventListener('click', requestPrint);
  return {
    close,
    async print(data, {signal, title = 'Document'} = {}) {
      if (started) throw new Error('This print window has already been prepared.');
      started = true;
      let viewer, timer;
      const check = () => { if (signal?.aborted || closed || target.closed) throw aborted(); };
      // Watch a manually closed popup even while a page is rendering.
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, {once: true});
      timer = setInterval(() => { if (closed || target.closed) cancel(); }, 250);
      const wait = async predicate => {
        const deadline = Date.now() + 15000;
        while (!predicate()) {
          check();
          if (Date.now() > deadline) throw new Error('The print preview did not finish loading. Try Print again.');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        check();
      };
      try {
        check();
        if (!(data instanceof Uint8Array) || !data.length || data.length > 64 * 1024 * 1024) throw new Error('The PDF is not available for printing.');
        const {openPdfVisual} = await import('./pdf-visual.mjs');
        check();
        viewer = await openPdfVisual({data}, {generated: true, signal: controller.signal});
        if (viewer.pageCount > 100) throw new Error('Print up to 100 pages at once. Download the PDF to print a longer document.');
        await wait(() => styleLoaded || styleError);
        if (styleError || !link.sheet) throw new Error('The print stylesheet could not be loaded. Try Print again.');
        let totalPixels = 0;
        for (let number = 1; number <= viewer.pageCount; number++) {
          check(); status.textContent = `Preparing page ${number} of ${viewer.pageCount}…`;
          const canvas = doc.createElement('canvas');
          try {
            const {width, height} = await viewer.renderPage(number, canvas, {scale: 2});
            check();
            totalPixels += canvas.width * canvas.height;
            if (totalPixels > 120_000_000) throw new Error('This document is too large for the browser print preview. Download the PDF and print it from your PDF viewer.');
            if (![width, height].every(value => Number.isFinite(value) && value > 0)) throw new Error('The PDF page size is invalid.');
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            check(); if (!blob) throw new Error('The PDF page could not be prepared for printing.');
            const url = URL.createObjectURL(blob); urls.add(url);
            const section = doc.createElement('section'), img = doc.createElement('img');
            section.className = `print-page print-page-${number}`;
            // CSSOM on the local external stylesheet works with style-src 'self'.
            const w = Number(width.toFixed(3)), h = Number(height.toFixed(3));
            link.sheet.insertRule(`@page pdf${number} { size: ${w}pt ${h}pt; margin: 0; }`, link.sheet.cssRules.length);
            link.sheet.insertRule(`.print-page-${number} { page: pdf${number}; width: ${w}pt; height: ${h}pt; }`, link.sheet.cssRules.length);
            img.alt = `Page ${number}`; img.width = canvas.width; img.height = canvas.height;
            let loaded = false, failed = false;
            img.onload = () => { loaded = true; }; img.onerror = () => { failed = true; }; img.src = url;
            section.append(img); pages.append(section);
            await wait(() => loaded || failed);
            if (failed) throw new Error('A print page could not be loaded. Try Print again.');
          } finally { canvas.width = canvas.height = 0; }
        }
        check(); doc.title = String(title).slice(0, 200); retry.disabled = false;
        requestPrint();
      } catch (error) { close(); throw error; }
      finally { clearInterval(timer); signal?.removeEventListener('abort', cancel); if (viewer) await viewer.dispose(); }
    }
  };
}
