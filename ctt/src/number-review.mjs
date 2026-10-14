import {findNumberChanges, numberExcerpt} from './number-changes.mjs';

const PAGE_SIZE = 5;
const displayValue = raw => raw.length > 80 ? raw.slice(0, 60) + '…' + raw.slice(-15) : raw;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (text, action) => {
  const node = el('button', text, 'button secondary'); node.type = 'button';
  node.addEventListener('click', action); return node;
};

export function mountNumberReview(root, {queue, open = false, getBlocks, choose, onChange}) {
  let items = [], revision = null, page = 0, disposed = false;
  const panel = el('details', undefined, 'number-review'); panel.open = open;
  const summary = el('summary'), title = el('strong', 'Amounts & percentages'), count = el('span');
  summary.append(title, count);
  const hint = el('p', 'Finds changes to amounts ($, €, £, ₽, USD, EUR, GBP, RUB) and percentages. Open a passage to edit it. Other text changes still need review.', 'number-review-hint');
  const progress = el('p', '', 'number-review-progress'); progress.setAttribute('role', 'status');
  const list = el('ol', undefined, 'number-review-list');
  const empty = el('p', 'No changes to supported amounts or percentages found. Other text differences may remain.', 'number-review-hint');
  const pagination = el('div', undefined, 'number-review-pages');
  const previous = button('Previous passages', () => { page--; render(); });
  const next = button('Next passages', () => { page++; render(); });
  const pageLabel = el('span'); pagination.append(previous, pageLabel, next);
  panel.append(summary, hint, progress, empty, list, pagination); root.append(panel);
  panel.addEventListener('toggle', () => { if (!disposed) onChange(); });

  function render() {
    if (disposed) return;
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset.numberKey, focusAction = focused?.dataset.numberAction;
    const checked = items.filter(item => queue.reviewed(item.key)).length;
    count.textContent = items.length ? `${items.length - checked} to check · ${items.length} ${items.length === 1 ? 'passage' : 'passages'}` : 'No changes found';
    progress.textContent = items.length ? `Values checked in ${checked} of ${items.length} ${items.length === 1 ? 'passage' : 'passages'}` : '';
    empty.hidden = items.length > 0; progress.hidden = !items.length;
    page = Math.max(0, Math.min(page, Math.ceil(items.length / PAGE_SIZE) - 1));
    list.replaceChildren(); list.start = page * PAGE_SIZE + 1;
    for (const item of items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const card = el('li', undefined, 'number-review-item'); card.dataset.numberPassage = item.key;
      const checked = queue.reviewed(item.key); card.classList.toggle('is-checked', checked);
      const heading = el('strong', item.mode === 'added' ? 'Values in added text' : item.mode === 'removed' ? 'Values in removed text' : item.mode === 'context' ? 'Review values in context' : 'Values changed');
      card.append(heading);
      if (item.mode === 'paired') {
        const values = el('ul', undefined, 'number-review-values');
        for (const pair of item.pairs.slice(0, 6)) values.append(el('li', `${pair.before.kind === 'percentage' ? 'Percentage' : 'Amount'}: ${displayValue(pair.before.raw)} → ${displayValue(pair.after.raw)}`));
        if (item.pairs.length > 6) values.append(el('li', `+ ${item.pairs.length - 6} more in this passage`));
        card.append(values);
      }
      const before = item.focusBefore, after = item.focusAfter;
      for (const [label, text, token] of [['A', item.left, before], ['B', item.right, after]]) {
        const excerpt = el('p', undefined, 'number-review-excerpt');
        excerpt.append(el('strong', `${label}: `), document.createTextNode(numberExcerpt(text, token)));
        card.append(excerpt);
      }
      if (item.mode === 'context') card.append(el('p', 'The surrounding text or value order also changed. Check both versions.', 'number-review-hint'));
      const actions = el('div', undefined, 'number-review-actions');
      const show = button('Show in document', () => {
        if (disposed) return;
        Promise.resolve(choose(item)).catch(() => { if (!disposed) progress.textContent = 'Could not open this passage. Choose it in the documents below.'; });
      });
      const mark = button(checked ? 'Values checked ✓' : 'Mark values checked', () => {
        if (disposed) return;
        if (queue.reviewed(item.key)) queue.reopen(item.key); else queue.accept(item.key);
        render(); onChange();
      });
      mark.setAttribute('aria-pressed', String(checked));
      for (const [node, action] of [[show, 'show'], [mark, 'check']]) { node.dataset.numberKey = item.key; node.dataset.numberAction = action; }
      actions.append(show, mark); card.append(actions); list.append(card);
    }
    pagination.hidden = items.length <= PAGE_SIZE;
    previous.disabled = page === 0; next.disabled = (page + 1) * PAGE_SIZE >= items.length;
    pageLabel.textContent = items.length ? `${page + 1} / ${Math.ceil(items.length / PAGE_SIZE)}` : '';
    if (focusKey) [...list.querySelectorAll('button')].find(node => node.dataset.numberKey === focusKey && node.dataset.numberAction === focusAction)?.focus({preventScroll: true});
  }
  return {
    refresh(currentRevision) {
      if (disposed || currentRevision === revision) return;
      revision = currentRevision;
      items = findNumberChanges(getBlocks());
      queue.sync(items.map(item => ({key: item.key, signature: item.signature, differs: true})));
      render();
    },
    snapshot: () => queue.snapshot(panel.open),
    reset() { queue.reset(); render(); },
    dispose() { disposed = true; panel.remove(); },
  };
}
