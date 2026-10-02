'use strict';
(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  let opening = false;
  async function open() {
    if (opening) return;
    opening = true;
    try { await api.tabs.create({url: api.runtime.getURL('index.html')}); window.close(); }
    catch { document.getElementById('status').textContent = 'Select Open comparison to try again.'; opening = false; }
  }
  document.getElementById('open').addEventListener('click', open);
  open();
})();
