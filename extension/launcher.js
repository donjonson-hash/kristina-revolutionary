"use strict";
(() => {
  const api = typeof browser !== 'undefined' ? browser : chrome;
  let opening = false;
  async function open() {
    if (opening) return;
    opening = true;
    try {
      await api.tabs.create({url: api.runtime.getURL('index.html')});
      window.close();
    } catch (error) {
      document.getElementById('status').textContent = 'Нажмите «Открыть сверку», чтобы повторить.';
      opening = false;
    }
  }
  document.getElementById('open').addEventListener('click', open);
  open();
})();
