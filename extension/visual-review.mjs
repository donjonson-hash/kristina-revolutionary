/* Documents first: original pages, local corrections, and two editable versions. */
const sides = ['left', 'right'];
const letter = side => side === 'left' ? 'A' : 'B';
const other = side => side === 'left' ? 'right' : 'left';
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (label, action, className = 'button secondary') => { const node = el('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node; };
const categories = ['matched', 'changed', 'only_left', 'only_right', 'moved', 'reflow'];
const styleKeys = ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'textDecoration', 'color', 'backgroundColor', 'textAlign', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingLeft', 'paddingRight', 'textIndent', 'lineHeight', 'width', 'verticalAlign', 'paddingTop', 'paddingBottom', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft'];
const style = (node, values = {}) => { for (const key of styleKeys) if (values[key] !== undefined) node.style[key] = values[key]; };
function download(data, filename, mime) {
  const url = URL.createObjectURL(new Blob([data], {type: mime})), anchor = el('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function mountVisualReview(root, {report, sources, signal, onRevision = () => {}, restoredState, onStateChange = () => {}}) {
  const originalGroups = categories.flatMap(category => (report[category] || []).map(item => ({...item, category})));
  originalGroups.sort((a, b) => Number(a.key.slice(5)) - Number(b.key.slice(5)));
  let groups = [...originalGroups];
  const byKey = new Map(groups.map(group => [group.key, group]));
  const drafts = Object.fromEntries(sides.map(side => [side, window.KristinaTextEditor.create(report, side)]));
  let projectWord, normalizeWordRows;
  const viewers = {}, models = {}, pages = {left: 1, right: 1}, generations = {left: 0, right: 0}, ui = {};
  const row = (group, side) => group?.[side] || (group?.category === `only_${side}` ? group.row : null);
  const sourceBlocks = side => originalGroups.flatMap(group => { const block = row(group, side); return block ? block.source_blocks || [block] : []; }).sort((a, b) => a.record - b.record);
  let disposed = false, selected = null, selectionGeneration = 0;
  const typingTimers = {}; let diffKeys = new Set();
  const alive = () => !disposed && !signal?.aborted;
  const scrollPositions = {left: {top: 0, left: 0}, right: {top: 0, left: 0}};
  let restoring = true;
  function stateChanged() { if (alive() && !restoring) onStateChange(); }
  function readScroll(side) { return {top: ui[side].scroll.scrollTop, left: ui[side].scroll.scrollLeft}; }
  function snapshot() { return {version: 1, drafts: Object.fromEntries(sides.map(side => [side, drafts[side].snapshot()])), selected, pages: {...pages}, zoom: zoom.value, scroll: Object.fromEntries(sides.map(side => [side, readScroll(side)]))}; }
  function validateState(state) {
    const invalid = () => { throw new Error('Не удалось восстановить сохранённую работу: данные повреждены.'); };
    if (!state || state.version !== 1 || !['0', '794', '1191'].includes(state.zoom) || state.selected !== null && typeof state.selected !== 'string') invalid();
    for (const side of sides) {
      const position = state.scroll?.[side], page = state.pages?.[side];
      if (!position || !Number.isFinite(position.top) || position.top < 0 || position.top > 100000000 || !Number.isFinite(position.left) || position.left < 0 || position.left > 100000000 || !Number.isInteger(page) || page < 1 || page > 100) invalid();
      if (report.sources[side].format !== 'pdf' && page !== 1) invalid();
      drafts[side].restore(state.drafts?.[side]);
    }
    syncGroups();
    if (state.selected !== null && !byKey.has(state.selected)) invalid();
  }
  const loadMessages = [];
  await Promise.all(sides.map(async side => {
    const format = report.sources[side].format;
    try {
      if (format === 'pdf') { const {openPdfVisual} = await import('./pdf-visual.mjs'); const viewer = await openPdfVisual(sources[side], {signal}); if (!alive()) { await viewer.dispose(); return; } viewers[side] = viewer; }
      if (format === 'docx') { const {readDocxVisual, projectDocxVisual} = await import('./docx-visual.mjs'); projectWord = projectDocxVisual; models[side] = await readDocxVisual(sources[side]);
        if (models[side].hasTables) {
          const {createDocxRowEditor} = await import('./docx-row-editor.mjs');
          ({normalizeDocxRowPlan: normalizeWordRows} = await import('./docx-structure.mjs'));
          drafts[side] = createDocxRowEditor(report, side, models[side]);
        }
      }
    } catch (error) { if (format === 'docx') delete models[side]; loadMessages.push(`Вариант ${letter(side)} показан как текст. ${error.message}`); }
  }));
  try {
    if (restoredState !== undefined) {
      validateState(restoredState);
      for (const side of sides) if (viewers[side] && restoredState.pages[side] > viewers[side].pageCount) throw new Error('Не удалось восстановить сохранённую работу: страница не найдена.');
    }
    if (!alive()) throw new DOMException('Просмотр отменён.', 'AbortError');
  } catch (error) { for (const viewer of Object.values(viewers)) await viewer.dispose().catch(() => {}); throw error; }
  root.replaceChildren(); root.classList.add('visual-review');
  const toolbar = el('div', undefined, 'visual-toolbar'), progress = el('strong', '', 'visual-progress'); progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
  const navigation = el('div', undefined, 'visual-navigation');
  const back = button('↑', () => jump(-1)), next = button('Следующее отличие ↓', () => jump(1)); back.setAttribute('aria-label', 'Предыдущее отличие');
  navigation.append(back, next);
  const all = button('Сделать B как A', () => act('right', draft => draft.replaceAll(drafts.left.entries(), {rowPlan: drafts.left.rowPlan?.(), content: models.left?.content}))); all.dataset.action = 'copy-all-right';
  const tools = el('details', undefined, 'visual-more'); tools.append(el('summary', 'Ещё'));
  tools.append(button('Сделать A как B', () => act('left', draft => draft.replaceAll(drafts.right.entries(), {rowPlan: drafts.right.rowPlan?.(), content: models.right?.content}))));
  tools.append(button('Вернуть исходные документы', () => { if (!alive()) return; const before = sides.map(side => drafts[side].revision); for (const side of sides) drafts[side].reset(); refresh(); if (sides.some((side, i) => drafts[side].revision !== before[i])) stateChanged(); }));
  const saveNote = el('p', 'Нажмите на текст, чтобы исправить. Подсветка показывает отличия текста.', 'visual-instruction');
  const zoom = el('select'); zoom.setAttribute('aria-label', 'Масштаб документов');
  for (const [value, label] of [['0', 'По ширине'], ['794', '100%'], ['1191', '150%']]) { const option = el('option', label); option.value = value; zoom.append(option); }
  zoom.addEventListener('change', () => { if (!alive()) return; root.style.setProperty('--sheet-min-width', zoom.value + 'px'); stateChanged(); });
  toolbar.append(progress, navigation, all, zoom, tools); root.append(toolbar, saveNote);
  const status = el('p', '', 'visual-notice'); status.hidden = true; status.setAttribute('role', 'status'); root.append(status);
  if (loadMessages.length) message(loadMessages.join('\n'));
  const grid = el('div', undefined, 'visual-columns'); root.append(grid);
  const inspector = el('section', undefined, 'visual-inspector'); inspector.hidden = true; inspector.setAttribute('aria-label', 'Исправить выделенный текст');
  const inspectorHead = el('div', undefined, 'visual-inspector-head');
  const inspectorTitle = el('strong', 'Выделенный текст');
  inspectorHead.append(inspectorTitle, button('Готово ✓', () => { if (!alive()) return; for (const timer of Object.values(typingTimers)) clearTimeout(timer); selectionGeneration++; for (const side of sides) drafts[side].endEdit(); inspector.hidden = true; root.classList.remove('is-editing'); selected = null; refresh(); stateChanged(); }));
  inspector.append(inspectorHead);
  const fields = el('div', undefined, 'visual-edit-fields'); inspector.append(fields); root.append(inspector);
  const input = {};
  for (const side of sides) {
    const panel = el('section', undefined, 'visual-column'), heading = el('div', undefined, 'visual-column-heading');
    const name = el('span', sources[side].name, 'visual-file-name'); name.title = sources[side].name;
    const undo = button('↶', () => act(side, draft => draft.undo())); undo.setAttribute('aria-label', `Отменить правку ${letter(side)}`);
    const save = button(`Скачать ${letter(side)}`, () => saveSide(side), 'button primary'); save.dataset.saveSide = side;
    const menu = el('details', undefined, 'visual-more'); menu.append(el('summary', '⋯'));
    menu.append(button(`Скачать ${letter(side)} как TXT`, () => download(drafts[side].exportText(), filename(side, 'txt'), 'text/plain;charset=utf-8')));
    heading.append(el('span', letter(side), 'letter'), name, undo, save, menu); panel.append(heading);
    const pageNav = el('div', undefined, 'visual-page-nav'), pageLabel = el('span'); pageNav.hidden = report.sources[side].format !== 'pdf';
    const navigate = offset => { if (!alive() || !viewers[side]) return; const page = Math.max(1, Math.min(viewers[side].pageCount, pages[side] + offset)); if (page === pages[side]) return; pages[side] = page; void renderSide(side); stateChanged(); };
    const previous = button('←', () => navigate(-1)), following = button('→', () => navigate(1));
    previous.disabled = following.disabled = true;
    previous.setAttribute('aria-label', `Предыдущая страница ${letter(side)}`); following.setAttribute('aria-label', `Следующая страница ${letter(side)}`);
    pageNav.append(previous, pageLabel, following); panel.append(pageNav);
    const scroll = el('div', undefined, 'visual-scroll'); scroll.setAttribute('aria-label', `Документ ${letter(side)}`); panel.append(scroll); grid.append(panel);
    ui[side] = {panel, scroll, pageLabel, previous, following, undo, save};
    scroll.addEventListener('scroll', () => { if (!alive()) return; const position = readScroll(side), before = scrollPositions[side]; if (position.top !== before.top || position.left !== before.left) { scrollPositions[side] = position; stateChanged(); } });
    const fieldLabel = el('label', `Вариант ${letter(side)}`, 'visual-edit-label'), field = el('textarea'); field.rows = 3; field.maxLength = 500000;
    field.setAttribute('aria-label', `Править вариант ${letter(side)}`); field.dataset.editSide = side; fieldLabel.append(field);
    const copy = button(`Взять из ${letter(other(side))} ${side === 'right' ? '→' : '←'}`, () => copyTo(side)); copy.dataset.copyTo = side;
    fieldLabel.append(copy);
    const rowTools = el('div', undefined, 'visual-row-tools'), rowHint = el('small'); rowTools.hidden = true;
    const above = button('Строка выше', () => editRow(side, 'before'));
    const below = button('Строка ниже', () => editRow(side, 'after'));
    const remove = button('Удалить строку', () => editRow(side, 'delete'));
    above.dataset.insertRow = 'before'; below.dataset.insertRow = 'after'; remove.dataset.deleteRow = '';
    for (const control of [above, below, remove]) control.dataset.rowSide = side;
    rowTools.append(above, below, remove, rowHint); fieldLabel.append(rowTools);
    Object.assign(ui[side], {copy, rowTools, rowHint, above, below, remove});
    fields.append(fieldLabel); input[side] = field;
    field.addEventListener('input', () => {
      if (!alive() || !selected) return;
      try { const before = drafts[side].revision; drafts[side].edit(selected, field.value); changed(); if (drafts[side].revision !== before) stateChanged(); } catch (error) { field.value = value(side, selected) ?? ''; message(error.message); }
      clearTimeout(typingTimers[side]); typingTimers[side] = setTimeout(() => { if (alive()) renderSide(side); }, 350);
    });
    field.addEventListener('blur', () => drafts[side].endEdit());
  }
  function filename(side, ext) { return sources[side].name.replace(/\.[^.]*$/, '') + `-редакция-${letter(side)}.${ext}`; }
  function message(text = '') { if (!alive()) return; status.textContent = text; status.hidden = !text; }
  function value(side, key) {
    if (key?.startsWith('row-') && !drafts[side].entries().some(entry => entry.key === key)) return null;
    return drafts[side].get(key);
  }
  function syncGroups() {
    groups = [...originalGroups]; byKey.clear();
    for (const group of groups) byKey.set(group.key, group);
    for (const side of sides) for (const entry of drafts[side].entries()) {
      if (byKey.has(entry.key) && !byKey.get(entry.key).dynamic) continue;
      let group = byKey.get(entry.key);
      if (!group) { group = {key: entry.key, category: 'changed', dynamic: true}; groups.push(group); byKey.set(entry.key, group); }
      group[side] = entry;
    }
    if (selected && !byKey.has(selected)) { selected = null; inspector.hidden = true; root.classList.remove('is-editing'); }
  }
  function rowPosition(side) {
    if (!selected || !models[side]?.hasTables || !drafts[side].rowPlan) return null;
    const entry = drafts[side].entries().find(entry => entry.key === selected);
    if (!entry) return null;
    const layout = normalizeWordRows(models[side].content, drafts[side].rowPlan()).content;
    for (const table of layout.filter(item => item.type === 'table')) for (let i = 0; i < table.rows.length; i++) {
      const row = table.rows[i];
      if (row.cells.some(cell => cell.content.some(p => p.record === entry.record))) return {table: table.index, index: i + 1, row, count: table.rows.length};
    }
    return null;
  }
  function updateRowTools() {
    for (const side of sides) {
      const position = rowPosition(side), controls = ui[side]; controls.rowTools.hidden = !position;
      if (position) {
        const locked = position.row.mutable === false;
        controls.above.disabled = controls.below.disabled = locked;
        controls.remove.disabled = locked || position.count === 1;
        controls.rowHint.textContent = locked ? 'Строка с вертикальным объединением: здесь доступна правка текста.' : position.count === 1 ? 'Последнюю строку таблицы можно очистить, но нельзя удалить.' : `Строка ${position.index}. Удаление можно отменить кнопкой ↶.`;
      }
      const absent = !!selected && value(side, selected) === null;
      const unavailable = absent && (models[side]?.hasTables || byKey.get(selected)?.dynamic);
      input[side].disabled = unavailable;
      controls.copy.disabled = unavailable || !!selected && value(other(side), selected) === null && models[side]?.hasTables;
      input[side].placeholder = unavailable ? 'Этой строки здесь нет. Перенесите документ целиком или отмените удаление.' : '';
    }
  }
  function editRow(side, action) {
    if (!alive()) return;
    const position = rowPosition(side); if (!position) return;
    try {
      for (const timer of Object.values(typingTimers)) clearTimeout(timer);
      drafts[side].endEdit();
      if (action === 'delete') {
        drafts[side].deleteRow(position.table, position.index); selected = null;
        inspector.hidden = true; root.classList.remove('is-editing');
      } else {
        const inserted = drafts[side].insertRow(position.table, position.index, action);
        selected = typeof inserted === 'string' ? inserted : inserted?.key || null;
      }
      refresh(); stateChanged();
      message(action === 'delete' ? 'Строка удалена. Чтобы вернуть её, нажмите ↶.' : 'Пустая строка добавлена. Нажмите на ячейку и введите текст.');
      if (selected) void select(selected, side);
    } catch (error) { message(error.message); }
  }
  function updateDifferences() {
    const values = {}, orders = {};
    for (const side of sides) {
      values[side] = new Map(); orders[side] = [];
      for (const entry of drafts[side].entries()) {
        if (!values[side].has(entry.key)) { values[side].set(entry.key, []); orders[side].push(entry.key); }
        values[side].get(entry.key).push(entry.text);
      }
    }
    const shared = new Set(orders.left.filter(key => values.right.has(key)));
    const indexes = Object.fromEntries(sides.map(side => [side, new Map(orders[side].filter(key => shared.has(key)).map((key, i) => [key, i]))]));
    diffKeys = new Set(groups.filter(group => {
      const a = values.left.has(group.key) ? values.left.get(group.key).join('\n') : null;
      const b = values.right.has(group.key) ? values.right.get(group.key).join('\n') : null;
      return a !== b || group.category === 'moved' && indexes.left.get(group.key) !== indexes.right.get(group.key);
    }).map(group => group.key));
  }
  function different(group) { return !!group && diffKeys.has(group.key); }
  function differences() { return groups.filter(different); }
  function changed() {
    if (!alive()) return;
    syncGroups(); updateDifferences();
    const shape = side => models[side]?.hasTables ? normalizeWordRows(models[side].content, drafts[side].rowPlan?.()).content.filter(item => item.type === 'table').map(table => table.rows.map(row => row.cells.map(cell => [cell.column, cell.colSpan, cell.rowSpan, cell.content.length]))) : null;
    const structureDiffers = (drafts.left.structureChanged || drafts.right.structureChanged) && JSON.stringify(shape('left')) !== JSON.stringify(shape('right'));
    const count = differences().length, equal = drafts.left.text() === drafts.right.text() && !structureDiffers;
    if (equal) diffKeys.clear();
    progress.textContent = equal ? 'Тексты совпадают ✓' : count ? `Отличий: ${count}` : structureDiffers ? 'Отличается структура таблиц' : 'Отличается порядок текста';
    next.disabled = back.disabled = equal;
    all.disabled = equal;
    for (const side of sides) ui[side].undo.disabled = !drafts[side].canUndo;
    if (selected) inspectorTitle.textContent = different(byKey.get(selected)) ? 'Исправьте здесь или возьмите текст соседнего варианта' : 'Этот фрагмент совпадает ✓';
    updateRowTools();
    onRevision(drafts.left.changed || drafts.right.changed);
    for (const node of root.querySelectorAll('[data-group]')) {
      node.classList.toggle('has-difference', different(byKey.get(node.dataset.group)));
      node.classList.toggle('is-selected', node.dataset.group === selected);
    }
  }
  function act(side, callback) {
    if (!alive()) return;
    try { const before = drafts[side].revision; callback(drafts[side]); message(); refresh(); if (drafts[side].revision !== before) stateChanged(); } catch (error) { message(error.message); }
  }
  function copyTo(side) {
    if (!selected) return;
    const text = value(other(side), selected), group = byKey.get(selected);
    act(side, draft => draft.set(selected, text, {relocate: group.category === 'moved'}));
  }
  function refresh() {
    if (!alive()) return;
    changed();
    if (selected) for (const side of sides) input[side].value = value(side, selected) ?? '';
    for (const side of sides) void renderSide(side);
  }
  async function select(key, focusSide) {
    if (!alive()) return;
    if (!byKey.has(key)) throw new Error('Фрагмент не найден.');
    for (const timer of Object.values(typingTimers)) clearTimeout(timer); const selection = ++selectionGeneration; selected = key; inspector.hidden = false; root.classList.add('is-editing');
    const group = byKey.get(key);
    inspectorTitle.textContent = different(group) ? 'Исправьте здесь или возьмите текст соседнего варианта' : 'Можно править оба варианта';
    for (const side of sides) {
      if (!alive() || selection !== selectionGeneration) return;
      input[side].value = value(side, key) ?? '';
      const location = row(group, side), page = location?.page || location?.source_blocks?.[0]?.page;
      if (page && pages[side] !== page) { pages[side] = page; await renderSide(side); }
      if (!alive() || selection !== selectionGeneration) return;
      const target = [...ui[side].scroll.querySelectorAll('[data-group]')].find(node => node.dataset.group === key);
      if (target) alignTarget(ui[side].scroll, target);
    }
    changed(); if (focusSide) input[focusSide].focus({preventScroll: true});
    for (const side of sides) scrollPositions[side] = readScroll(side);
    stateChanged();
  }
  function alignTarget(scroll, target) {
    scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - Math.min(140, scroll.clientHeight / 3);
  }
  function jump(direction) {
    const diff = differences(); if (!diff.length) return;
    const index = diff.findIndex(group => group.key === selected);
    const nextIndex = index < 0 ? (direction > 0 ? 0 : diff.length - 1) : (index + direction + diff.length) % diff.length;
    void select(diff[nextIndex].key);
  }
  function pdfEdits(side) {
    const records = drafts[side].entries().map(entry => entry.record);
    if (records.some((record, i) => i && record < records[i - 1])) throw new Error('Порядок фрагментов изменён. Скачайте эту редакцию как TXT в меню ⋯.');
    const edits = [];
    for (const group of groups) {
      const block = row(group, side), current = value(side, group.key);
      if (!block) { if (current !== null) throw new Error('Новый фрагмент добавлен. Для него выберите «Скачать как TXT» в меню ⋯ рядом со скачиванием.'); continue; }
      const parts = block.source_blocks || [block], original = parts.map(part => part.text).join('\n');
      if (current === original) continue;
      const texts = current === null ? parts.map(() => '') : current.split('\n');
      if (texts.length !== parts.length) throw new Error('Переносы строк изменены. Эту редакцию можно скачать как TXT в меню ⋯.');
      parts.forEach((part, i) => edits.push({block: part, text: texts[i]}));
    }
    return edits;
  }
  async function renderSide(side) {
    if (!alive()) return;
    const generation = ++generations[side], {scroll} = ui[side], scrollTop = scroll.scrollTop; scroll.setAttribute('aria-busy', 'true');
    try {
      if (viewers[side]) {
        const viewer = viewers[side], pageNumber = pages[side];
        ui[side].previous.disabled = pageNumber <= 1; ui[side].following.disabled = pageNumber >= viewer.pageCount;
        ui[side].pageLabel.textContent = `${pageNumber} / ${viewer.pageCount}`;
        const paper = el('div', undefined, 'visual-pdf-page'), canvas = el('canvas');
        canvas.setAttribute('aria-label', `Страница ${pageNumber} документа ${letter(side)}`);
        let edits = [], editError;
        try { edits = pdfEdits(side); } catch (error) { editError = error; }
        try { await viewer.renderPage(pageNumber, canvas, {scale: 1.5, edits}); }
        catch (error) { if (!edits.length) throw error; editError = error; await viewer.renderPage(pageNumber, canvas, {scale: 1.5}); }
        if (!alive() || generation !== generations[side]) { canvas.width = canvas.height = 0; return; }
        paper.append(canvas);
        const layer = el('div', undefined, 'visual-hotspots');
        for (const group of groups) {
          const source = row(group, side); if (!source) continue;
          for (const rect of viewer.rects(source).filter(rect => rect.page === pageNumber)) {
            const target = button('', () => select(group.key, side), 'visual-hotspot');
            target.dataset.group = group.key; target.setAttribute('aria-label', `${different(group) ? 'Отличие. ' : ''}Править ${letter(side)}: ${source.text.slice(0, 120)}`);
            target.title = 'Нажмите, чтобы исправить';
            Object.assign(target.style, {left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${Math.max(.3, rect.width * 100)}%`, height: `${Math.max(.7, rect.height * 100)}%`}); layer.append(target);
          }
        }
        paper.append(layer); scroll.replaceChildren(paper);
        if (editError) { const note = el('p', `На странице показан исходник. ${editError.message} Правка сохранена в редакторе.`, 'visual-inline-notice'); scroll.prepend(note); }
      } else {
        const paper = el('div', undefined, 'visual-paper');
        const model = models[side]; if (model) paper.classList.add('visual-word');
        if (model) {
          paper.style.paddingLeft = `${model.page.marginLeft / model.page.width * 100}%`;
          paper.style.paddingRight = `${model.page.marginRight / model.page.width * 100}%`;
        }
        const projected = model ? projectWord(model, docxSequence(side), {rowPlan: drafts[side].rowPlan?.()}) : null;
        const entries = projected ? projected.blocks : drafts[side].entries();
        function paragraph(entry) {
          const p = el(entry.heading ? `h${entry.heading}` : 'p', undefined, 'visual-paragraph');
          style(p, entry.style);
          let content = p;
          if (entry.list) {
            const list = entry.list, marker = el('span', list.label, 'visual-list-marker');
            content = el('span', undefined, 'visual-list-content');
            p.classList.add('visual-list-item'); p.dataset.listLevel = String(list.level);
            marker.setAttribute('aria-hidden', 'true');
            const hanging = Math.max(0, list.indent?.hanging ?? 18), left = Math.max(0, list.indent?.left ?? (list.level + 1) * 36);
            const aligned = list.align === 'right' ? hanging : list.align === 'center' ? hanging / 2 : 0;
            p.style.paddingLeft = `${Math.max(0, left - hanging - aligned)}pt`;
            p.style.textIndent = '0';
            p.style.setProperty('--list-marker-width', list.suffix === 'tab' ? `max(0px, calc(${hanging}pt - .3em))` : '0px');
            p.style.setProperty('--list-gap', list.suffix === 'space' ? '.3em' : list.suffix === 'tab' ? `calc(${aligned}pt + .3em)` : '0px');
            marker.style.textAlign = list.align;
            if (list.fontFamily) marker.style.fontFamily = list.fontFamily;
            style(marker, list.markerStyle);
            p.append(marker, content);
          }
          if (entry.runs) for (const run of entry.runs) {
            if (run.image) { const img = el('img'); img.src = run.image.src; img.alt = run.image.alt || ''; img.width = run.image.width; img.height = run.image.height; content.append(img); }
            else { const span = el('span', run.text); style(span, run.style); content.append(span); }
          }
          else content.append(document.createTextNode(entry.text));
          if (!content.hasChildNodes()) content.append(el('br'));
          if (entry.key) {
            p.dataset.group = entry.key; p.tabIndex = 0; p.setAttribute('role', 'button'); p.setAttribute('aria-label', `Править ${letter(side)}: ${entry.list ? entry.list.label + ' ' : ''}${entry.text.slice(0, 100) || 'Пустой абзац'}`);
            p.addEventListener('click', () => select(entry.key, side));
            p.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(entry.key, side); } });
          }
          return p;
        }
        if (model?.hasTables) {
          const byRecord = new Map(entries.map(entry => [entry.record, entry]));
          for (const item of projected.content) {
            if (item.type === 'paragraph') { paper.append(paragraph(byRecord.get(item.record))); continue; }
            const table = el('table', undefined, 'visual-table');
            table.setAttribute('aria-label', `Таблица ${item.index}, вариант ${letter(side)}`); style(table, item.style);
            const colgroup = el('colgroup'), total = item.widths.reduce((n, w) => n + w, 0);
            for (const width of item.widths) { const col = el('col'); if (total) col.style.width = `${width / total * 100}%`; colgroup.append(col); }
            table.append(colgroup); const tbody = el('tbody'); table.append(tbody);
            for (const row of item.rows) {
              const tr = el('tr'); tbody.append(tr);
              for (const cell of row.cells) {
                const td = el('td'); td.colSpan = cell.colSpan; td.rowSpan = cell.rowSpan; style(td, cell.style);
                for (const p of cell.content) td.append(paragraph(byRecord.get(p.record)));
                tr.append(td);
              }
            }
            paper.append(table);
          }
        } else for (const entry of entries) paper.append(paragraph(entry));
        scroll.replaceChildren(paper);
      }
      const absent = groups.filter(group => !group.dynamic && !models[side]?.hasTables && value(side, group.key) === null && value(other(side), group.key) !== null);
      if (absent.length) {
        const missing = el('div', undefined, 'visual-missing'); missing.append(el('strong', `Нет в ${letter(side)}`));
        for (const group of absent) { const add = button(`＋ ${value(other(side), group.key).slice(0, 100) || 'Пустой абзац'}`, () => { if (!alive()) return; void select(group.key); copyTo(side); }); add.title = `Добавить из ${letter(other(side))}`; add.dataset.missingKey = group.key; missing.append(add); }
        scroll.append(missing);
      }
      scroll.scrollTop = scrollTop;
      if (selected) { const target = [...scroll.querySelectorAll('[data-group]')].find(node => node.dataset.group === selected); if (target) alignTarget(scroll, target); }
      scrollPositions[side] = readScroll(side);
      changed();
    } catch (error) { if (alive() && generation === generations[side]) { scroll.replaceChildren(el('p', `Не удалось показать страницу. ${error.message}`, 'visual-inline-notice')); message('Текст доступен в редакторе. Выберите «Следующее отличие».'); } }
    finally { if (alive() && generation === generations[side]) scroll.setAttribute('aria-busy', 'false'); }
  }
  function docxSequence(side) {
    if (drafts[side].rowPlan) return drafts[side].entries();
    const sequence = [];
    for (const entry of drafts[side].entries()) {
      const source = row(byKey.get(entry.key), side);
      const original = source?.source_blocks?.[0] || source;
      const previous = sequence.at(-1);
      if (previous?.key === entry.key) previous.text += '\n' + entry.text;
      else sequence.push({key: entry.key, ...(original ? {record: original.record} : {}), text: entry.text});
    }
    return sequence;
  }
  async function saveSide(side) {
    if (!alive() || ui[side].save.disabled) return;
    ui[side].save.disabled = true; message('Готовлю документ…');
    try {
      const format = report.sources[side].format;
      if (format === 'pdf') {
        const records = drafts[side].entries().map(entry => entry.record);
        if (records.some((record, i) => i && record < records[i - 1])) throw new Error('Порядок фрагментов изменён. Скачайте эту редакцию как TXT в меню ⋯.');
        if (!drafts[side].changed) download(Uint8Array.from(atob(sources[side].data), c => c.charCodeAt(0)), filename(side, 'pdf'), 'application/pdf');
        else {
          const {renderPdfRevision} = await import('./pdf-visual.mjs');
          const data = await renderPdfRevision(sources[side], pdfEdits(side), {signal, blocks: sourceBlocks(side)});
          if (!alive()) return;
          download(data, filename(side, 'pdf'), 'application/pdf');
        }
      } else if (format === 'docx') {
        const {writeDocxVisual} = await import('./docx-visual.mjs');
        const data = await writeDocxVisual(sources[side], [], {sequence: docxSequence(side), rowPlan: drafts[side].rowPlan?.()});
        if (!alive()) return;
        download(data, filename(side, 'docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } else download(drafts[side].exportText(), filename(side, 'txt'), 'text/plain;charset=utf-8');
      message(`Вариант ${letter(side)} готов к скачиванию.`);
    } catch (error) { message(error.message); }
    finally { if (alive()) ui[side].save.disabled = false; }
  }
  const dispose = () => { if (disposed) return; disposed = true; selectionGeneration++; for (const timer of Object.values(typingTimers)) clearTimeout(timer); for (const viewer of Object.values(viewers)) void viewer.dispose().catch(() => {}); root.replaceChildren(); };
  signal?.addEventListener('abort', dispose, {once: true});
  if (alive()) {
    if (Object.values(models).some(model => model.hasTables)) saveNote.textContent += ' Нажмите на ячейку: можно исправить текст, добавить или удалить строку. Любое действие можно отменить.';
    if (Object.values(models).some(model => model.blocks.some(block => block.list))) saveNote.textContent += ' Нумерация показана для ориентира; сравнивается и редактируется текст пунктов.';
    if (restoredState !== undefined) {
      for (const side of sides) {
        if (viewers[side] && restoredState.pages[side] > viewers[side].pageCount) { dispose(); throw new Error('Не удалось восстановить сохранённую работу: страница не найдена.'); }
        pages[side] = restoredState.pages[side];
      }
      selected = restoredState.selected; zoom.value = restoredState.zoom;
      root.style.setProperty('--sheet-min-width', zoom.value + 'px');
      inspector.hidden = !selected; root.classList.toggle('is-editing', !!selected);
      if (selected) for (const side of sides) input[side].value = value(side, selected) ?? '';
    }
    changed();
    await Promise.all(sides.map(side => renderSide(side)));
    if (alive() && restoredState !== undefined) for (const side of sides) {
      ui[side].scroll.scrollTop = restoredState.scroll[side].top;
      ui[side].scroll.scrollLeft = restoredState.scroll[side].left;
      scrollPositions[side] = readScroll(side);
    }
  }
  restoring = false;
  return {dispose, drafts, select, snapshot, get changed() { return drafts.left.changed || drafts.right.changed; }};
}
