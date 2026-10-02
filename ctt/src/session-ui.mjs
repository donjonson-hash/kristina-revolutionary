import {openSessionStore} from './session-store.mjs';

// One saved comparison. Writes are serialized; only committed transactions say “saved”.
export async function mountSessionUI(root, {onResume, onFinish, onOperating = () => {}, openStore = openSessionStore, single = false}) {
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const button = (text, action, className = 'button secondary') => {
    const item = node('button', text, className); item.type = 'button'; item.addEventListener('click', action); return item;
  };
  root.className = 'session-panel'; root.hidden = true;
  const info = node('div', '', 'session-info'), title = node('strong'), names = node('p', '', 'session-names');
  const status = node('p', '', 'session-status'); status.setAttribute('role', 'status');
  const actions = node('div', '', 'session-actions');
  const resume = button(single ? "Continue editing" : "Continue →", resumeSaved, 'button primary'); resume.id = (single ? 'single-' : '') + 'session-resume';
  const remove = button(single ? "Delete saved work" : "Finish and delete", finish); remove.id = (single ? 'single-' : '') + 'session-delete';
  const retry = button("Retry saving", retrySave); retry.hidden = true; retry.id = (single ? 'single-' : '') + 'session-retry';
  status.id = (single ? 'single-' : '') + 'session-status'; info.append(title, names, status); actions.append(resume, retry, remove); root.append(info, actions);
  let store, row = {token: null, payload: null}, getPayload = null, pending = null, lastPayload = null;
  let running = null, busy = false, operating = false, failed = null, corrupt = false, disposed = false, loaded = false;
  const active = () => !!getPayload;
  function paint() {
    root.hidden = !active() && !row.payload && !failed && !corrupt;
    title.textContent = single ? (active() ? "Your document" : "Continue editing your document") : active() ? "Your work will be saved here" : "Continue working on documents";
    const sources = active() ? lastPayload?.sources : row.payload?.sources;
    names.textContent = single ? (active() ? lastPayload?.source?.name : row.payload?.source?.name) || '' : sources ? `A · ${sources.left.name}   ↔   B · ${sources.right.name}` : '';
    names.hidden = single ? !names.textContent : !sources || active();
    resume.hidden = active() || !row.payload || corrupt;
    resume.disabled = remove.disabled = busy || operating;
    remove.hidden = !store || (!active() && !row.payload && !corrupt);
    retry.hidden = !active() || !failed || ['conflict', 'corrupt', 'incompatible'].includes(failed.code);
    retry.disabled = busy || operating;
    root.classList.toggle('session-error', !!failed);
  }
  function showError(error) {
    failed = error;
    if (error.code === 'conflict') status.textContent = "Your work changed in another tab. These edits were not saved automatically—download them before closing.";
    else if (error.code === 'corrupt' || error.code === 'incompatible') status.textContent = "Couldn't restore saved work. You can delete it and add your documents again.";
    else status.textContent = "Couldn't save your work in this browser. Try saving again or download your documents before closing.";
    paint();
  }
  function savedStatus() {
    status.textContent = active() ? "Saved in this browser ✓" : "Your documents and edits are still saved in this browser.";
  }
  function drain() {
    if (running || failed || !pending || disposed) return running;
    running = (async () => {
      while (pending && !failed && !disposed) {
        const payload = pending; pending = null;
        try { row = await store.write(payload, row.token); }
        catch (error) { pending = pending || payload; showError(error); break; }
      }
      if (!failed && !disposed) { savedStatus(); paint(); }
    })().finally(() => {
      running = null;
      // An edit may arrive after the loop exits but before this promise settles.
      // Keep the original flush/finish waiter chained to that final queued write.
      return drain();
    });
    return running;
  }
  function changed() {
    if (!getPayload || operating || disposed) return;
    try { lastPayload = getPayload(); pending = lastPayload; }
    catch (error) { showError(error); return; }
    if (!failed) { status.textContent = "Saving…"; paint(); void drain(); }
  }
  async function retrySave() {
    if (!active() || operating || failed?.code === 'conflict') return;
    if (!loaded) {
      try { if (!store) store = await openStore(); row = await store.read(); loaded = true; }
      catch (error) { showError(error); return; }
    }
    failed = null; changed();
  }
  async function resumeSaved() {
    if (busy || operating || disposed) return;
    operating = true; onOperating(true); paint();
    try {
      await running;
      row = await store.read(); loaded = true;
      if (!row.payload) { failed = null; corrupt = false; savedStatus(); return; }
      await onResume(row.payload);
      failed = null; corrupt = false; savedStatus();
    } catch (error) {
      // A failed restoration must leave the stored documents intact.
      if (error.token !== undefined) row.token = error.token;
      corrupt = true; showError({code: error.code === 'incompatible' ? 'incompatible' : 'corrupt'});
    } finally { operating = false; onOperating(false); paint(); if (active() && !failed) changed(); }
  }
  async function finish() {
    if (busy || operating || !store || disposed) return;
    operating = true; onOperating(true); paint();
    try {
      await running;
      row = await store.clear(row.token); loaded = true;
      pending = lastPayload = null; getPayload = null; failed = null; corrupt = false;
      await onFinish(); status.textContent = '';
    } catch (error) { showError(error); }
    finally { operating = false; onOperating(false); paint(); }
  }
  try { store = await openStore(); row = await store.read(); loaded = true; savedStatus(); }
  catch (error) {
    corrupt = ['corrupt', 'incompatible'].includes(error.code);
    if (error.token !== undefined) row.token = error.token;
    showError(error);
  }
  paint();
  return {
    activate(readPayload) { getPayload = readPayload; changed(); paint(); },
    changed,
    get saved() { return active() && loaded && !pending && !running && !failed; },
    get hasSavedWork() { return !!row.payload || corrupt; },
    deactivate() { getPayload = null; paint(); },
    setBusy(value) { busy = value; paint(); },
    // Tests and page lifecycle callers may wait for an already queued transaction.
    flush() { return running || drain(); },
    dispose() { disposed = true; getPayload = null; store?.close(); },
  };
}
