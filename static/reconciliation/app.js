"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_FILE_BYTES = 2 * 1024 * 1024, PAGE_SIZE = 25;
  const state = {sources: {left: null, right: null}, metadata: null, suggested: [], delimiter: ',',
    report: null, html: null, records: [], busy: false, revision: 0, filter: 'all', page: 0, active: -1};
  const loads = {left: 0, right: 0}, selectColumns = new WeakMap();
  let controller = null, exportController = null, changePage = 0;
  const officeHome = $('office-sidebar').parentElement;
  const officeNext = $('office-sidebar').nextElementSibling;
  function reviewMode(enabled, textMode = false) {
    document.body.classList.toggle('review-mode', enabled);
    document.body.classList.toggle('document-mode', enabled && textMode);
    if (enabled) $('review-sidebar').append($('office-sidebar'));
    else officeHome.insertBefore($('office-sidebar'), officeNext);
    $('zoom-control').hidden = !textMode;
  }
  const categories = [['all', 'Все позиции'], ['changed', 'Изменились'], ['only_left', 'Только в A'], ['only_right', 'Только в B'], ['matched', 'Совпали']];
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  // A bounded conversation is scoped to one report revision. Sources never become HTML.
  const OFFICE_MESSAGE_LIMIT = 12, OFFICE_TEXT_LIMIT = 12000;
  let officeDraftGeneration = 0;
  function officeAvailable() { return !!state.report && !state.busy && !!window.KristinaOffice; }
  function officeEnable() {
    const enabled = officeAvailable();
    $('office-question').disabled = !enabled; $('office-send').disabled = !enabled;
    $('office-form').hidden = !enabled; $('office-suggestions').hidden = !enabled;
    const textMode = state.report?.kind === 'text';
    $('office-impact-question').hidden = !enabled || textMode || !state.report?.commercial;
    $('office-impact-question').disabled = !enabled;
    $('office-question').placeholder = enabled ? (textMode ? 'Например: что изменилось в тексте?' : 'Например: почему эти строки совпали?') : 'Сначала добавьте два файла';
    const questions = textMode ? ['Что изменилось?', 'Что добавлено?', 'Что удалено?', 'Подготовь письмо'] : ['Объясни результат', 'Где изменилась цена?', 'Что отсутствует?', 'Подготовь письмо'];
    Array.from($('office-suggestions').children).forEach((button, index) => { button.disabled = !enabled; button.dataset.question = questions[index]; button.textContent = questions[index]; });
  }
  function officeReset(message = 'Добавьте два файла. Я помогу разобраться в различиях и подготовить письмо по результату.') {
    officeDraftGeneration++;
    $('office-summary').textContent = message;
    $('office-transcript').replaceChildren(); $('office-question').value = '';
    $('office-draft').value = ''; $('office-draft-section').hidden = true; $('office-draft-status').textContent = '';
    $('office-summary-actions')?.remove(); officeEnable();
  }
  function officeJump(action, revision) {
    if (revision !== state.revision || !officeAvailable() || state.report.status !== 'complete') return;
    if (typeof action.key === 'string') {
      const index = state.records.findIndex(item => item.key === action.key);
      if (index < 0) return;
      $('search').value = ''; state.filter = 'all'; state.active = index; state.page = Math.floor(index / PAGE_SIZE);
      renderRows(true);
      // Keys can contain any CSV text. Only a numeric row index selects the DOM node.
      const pair = Array.from($('result-rows').children).find(node => node.dataset.index === String(index));
      if (!pair) return;
      pair.focus({preventScroll: true}); pair.scrollIntoView({behavior: 'smooth', block: 'center'});
      if (typeof action.field === 'string') {
        const field = Array.from(pair.querySelectorAll('.document-field')).find(node => node.dataset.field === action.field);
        if (field) { field.classList.add('office-target'); setTimeout(() => field.classList.remove('office-target'), 2500); }
      }
    } else if (categories.some(([category]) => category === action.category)) {
      $('search').value = ''; state.filter = action.category; state.active = -1; state.page = 0; changePage = 0; renderRows();
      const target = $('result-rows').querySelector('.document-pair') || $('result-heading');
      target.focus({preventScroll: true}); target.scrollIntoView({behavior: 'smooth', block: 'center'});
    }
  }
  function officeActions(actions, revision) {
    const box = element('div', undefined, 'office-actions');
    for (const action of (Array.isArray(actions) ? actions.slice(0, 20) : [])) {
      if (!action || typeof action.label !== 'string') continue;
      const hasKey = typeof action.key === 'string';
      if (!hasKey && !categories.some(([category]) => category === action.category)) continue;
      const button = element('button', action.label.slice(0, 180), 'office-action'); button.type = 'button';
      if (hasKey) button.dataset.key = action.key;
      if (typeof action.category === 'string') button.dataset.category = action.category;
      button.addEventListener('click', () => officeJump(action, revision)); box.append(button);
    }
    return box;
  }
  function officeMessage(role, text, actions = []) {
    const log = $('office-transcript'), message = element('article', undefined, 'office-message ' + role);
    message.append(element('span', role === 'user' ? 'Вы' : 'Кристина', 'office-speaker'), element('p', String(text).slice(0, OFFICE_TEXT_LIMIT)));
    if (role !== 'user') { const buttons = officeActions(actions, state.revision); if (buttons.children.length) message.append(buttons); }
    log.append(message); while (log.children.length > OFFICE_MESSAGE_LIMIT) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  function officeShowDraft(text) {
    if (typeof text !== 'string') return;
    officeDraftGeneration++;
    $('office-draft').value = text.slice(0, 1048576); $('office-draft-section').hidden = false;
    $('office-draft-status').textContent = 'Черновик готов. Отправка остаётся за вами.';
  }
  function officeDescribe() {
    if (!window.KristinaOffice || !state.report) return;
    const answer = window.KristinaOffice.describe(state.report);
    $('office-summary').textContent = String(answer.text || '').slice(0, OFFICE_TEXT_LIMIT);
    $('office-summary-actions')?.remove();
    const actions = officeActions(answer.actions, state.revision);
    if (actions.children.length) { actions.id = 'office-summary-actions'; $('office-summary').after(actions); }
  }
  function officeAsk(question, draftIntent = false) {
    if (!officeAvailable()) return;
    question = String(question); if (!question.trim()) return;
    if (question.length > 1000) { $('office-question').setCustomValidity('Сократите вопрос до 1 000 символов.'); $('office-question').reportValidity(); return; }
    $('office-question').setCustomValidity(''); officeMessage('user', question); $('office-question').value = '';
    try {
      const answer = draftIntent ? window.KristinaOffice.draftLetter(state.report) : window.KristinaOffice.answer(state.report, question);
      officeMessage('assistant', answer.text || 'Уточните вопрос по текущей сверке.', answer.actions);
      if (typeof answer.draft === 'string') officeShowDraft(answer.draft);
    } catch (_error) { officeMessage('assistant', 'Не удалось подготовить ответ. Найденные различия доступны в документах.'); }
  }
  async function officeCopy() {
    if (!officeAvailable() || $('office-draft-section').hidden) return;
    const revision = state.revision, generation = officeDraftGeneration, text = $('office-draft').value;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (revision === state.revision && generation === officeDraftGeneration) $('office-draft-status').textContent = text === $('office-draft').value ? 'Текст скопирован.' : 'Скопирована версия на момент нажатия. Изменённый текст скопируйте ещё раз.';
    } catch (_error) {
      if (revision !== state.revision || generation !== officeDraftGeneration) return;
      $('office-draft').focus(); $('office-draft').select();
      $('office-draft-status').textContent = 'Автоматическое копирование недоступно. Текст выделен — нажмите Ctrl+C или ⌘C.';
    }
  }
  function officeDownload() {
    if (!officeAvailable() || $('office-draft-section').hidden) return;
    const url = URL.createObjectURL(new Blob([$('office-draft').value], {type: 'text/plain;charset=utf-8'}));
    const link = element('a'); link.href = url; link.download = 'kristina-letter-draft.txt'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('office-draft-status').textContent = 'Черновик передан браузеру для скачивания.';
  }
  function notice(message = '', error = false) {
    $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = !message;
  }
  function busy(value) {
    state.busy = value;
    if (value) officeReset('Читаю документы и проверяю данные. Отвечу по новой сверке, когда она будет готова.');
    officeEnable(); exportEnable();
    for (const id of ['demo', 'left-file', 'right-file', 'delimiter', 'left-key', 'right-key', 'answer']) $(id).disabled = value;
    for (const side of ['left', 'right']) if ($(side + '-sheet')) $(side + '-sheet').disabled = value;
    $('rules').disabled = value || !state.metadata || state.metadata.kind === 'text';
    $('compare').disabled = value;
    $('compare').textContent = value ? 'Обрабатываю…' : 'Применить настройки';
  }
  function clearResult() {
    state.revision += 1;
    if (controller) controller.abort();
    if (exportController) exportController.abort();
    exportController = null;
    state.report = null; state.html = null; state.records = [];
    exportStatus(); exportEnable();
    $('results').hidden = true; $('result-rows').replaceChildren();
    $('change-list').replaceChildren(); changePage = 0;
    reviewMode(false);
    officeReset('Текущая сверка сброшена. Добавьте файлы или примените настройки — разберём новый результат.');
  }
  function dirty() { clearResult(); notice('Настройки изменены. Нажмите «Применить настройки» или «Продолжить».'); }
  function textSourcesSelected() { return Object.values(state.sources).some(source => source && /\.(txt|docx)$/i.test(source.name)); }
  function delimiter() { return $('delimiter').value === 'tab' ? '\t' : $('delimiter').value; }
  function encode(bytes) {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text);
  }
  async function api(path, payload) {
    controller = new AbortController();
    if (window.KristinaTransport) return window.KristinaTransport.request(path, payload, {signal: controller.signal});
    const response = await fetch(path, {method: 'POST', signal: controller.signal,
      headers: {'Content-Type': 'application/json', 'X-Kristina-Reconcile': '1'}, body: JSON.stringify(payload)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось выполнить запрос.');
    return result;
  }
  function sourceLabel(side, file) {
    $(side + '-filename').textContent = file ? file.name : 'Выберите файл или перетащите сюда';
    $(side + '-meta').textContent = file ? 'Файл выбран · нажмите, чтобы заменить' : (window.KristinaTransport ? 'XLSX, CSV, TXT, DOCX · до 2 MiB' : 'CSV · UTF-8 · до 2 MiB');
  }
  function showSheets(side, sheets = [], selected = null) {
    const select = $(side + '-sheet');
    if (!select) return;
    select.parentElement.hidden = sheets.length < 2;
    options(select, sheets.map(s => s.name), 'Выберите лист');
    sheets.forEach((sheet, i) => { if (sheet.hidden) select.options[i + 1].textContent += ' (скрытый)'; });
    if (selected !== null) { chooseColumn(select, selected); state.sources[side].sheet = selected; }
  }
  function options(select, names, placeholder) {
    selectColumns.set(select, names); select.replaceChildren(new Option(placeholder, ''));
    names.forEach((name, index) => select.add(new Option(name.length > 80 ? name.slice(0, 80) + `… [${index + 1}]` : name, String(index))));
  }
  function selectedColumn(select) { return select.value === '' ? '' : selectColumns.get(select)[Number(select.value)]; }
  function chooseColumn(select, name) {
    const index = selectColumns.get(select).indexOf(name); select.value = index < 0 ? '' : String(index);
  }
  function mapping(preserve = true) {
    if (!state.metadata || state.metadata.kind === 'text') return;
    const body = $('field-mapping'), previous = new Map();
    if (preserve) for (const row of body.children) previous.set(row.dataset.left, [selectedColumn(row.querySelector('.field-target')), row.querySelector('.field-mode').value]);
    const suggestions = new Map(state.suggested.map(([left, right, mode]) => [left, [right, mode]]));
    body.replaceChildren();
    const leftKey = selectedColumn($('left-key')), rightKey = selectedColumn($('right-key'));
    for (const name of state.metadata.left.headers.filter(n => n !== leftKey)) {
      const row = element('div', undefined, 'field-rule'); row.dataset.left = name;
      row.append(element('span', name));
      const targetLabel = element('label', 'Соответствует в B'), target = element('select', undefined, 'field-target');
      target.setAttribute('aria-label', `Столбец B для ${name}`);
      options(target, state.metadata.right.headers.filter(n => n !== rightKey), 'Не проверять');
      const [right, rule] = previous.get(name) || suggestions.get(name) || [name, 'text'];
      chooseColumn(target, right); targetLabel.append(target);
      const modeLabel = element('label', 'Как проверять'), mode = element('select', undefined, 'field-mode');
      mode.setAttribute('aria-label', `Режим для ${name}`);
      mode.add(new Option('Текст', 'text')); mode.add(new Option('Число', 'number')); mode.value = rule;
      mode.disabled = target.value === ''; modeLabel.append(mode);
      target.addEventListener('change', () => { mode.disabled = target.value === ''; dirty(); updateUnmapped(); });
      mode.addEventListener('change', dirty); row.append(targetLabel, modeLabel); body.append(row);
    }
    updateUnmapped();
  }
  function updateUnmapped() {
    if (!state.metadata || state.metadata.kind === 'text') return;
    const used = new Set([selectedColumn($('right-key'))]), omitted = [];
    for (const row of $('field-mapping').children) {
      const target = selectedColumn(row.querySelector('.field-target'));
      if (target) used.add(target); else omitted.push('A: ' + row.dataset.left);
    }
    for (const name of state.metadata.right.headers) if (!used.has(name)) omitted.push('B: ' + name);
    $('unmapped-fields').textContent = omitted.length ? 'Не будут проверены: ' + omitted.join('; ') + '. Сопоставьте поля или явно примените эти настройки.' : 'Все поля сопоставлены. Идентификатор ищет пары; остальные поля проверяются внутри каждой пары.';
  }
  async function prepare() {
    clearResult(); state.metadata = null; state.suggested = [];
    $('advanced-key-home').append($('key-controls')); $('setup-question').hidden = true;
    $('rules').hidden = true; $('rules').disabled = true; $('rules-empty').hidden = false;
    $('rules-summary').textContent = 'Определим автоматически';
    $('settings').hidden = textSourcesSelected();
    if (!state.sources.left || !state.sources.right) { notice('Добавьте второй файл — сверка начнётся автоматически.'); officeReset('Первый файл готов. Добавьте второй — я сопоставлю позиции и объясню результат.'); return; }
    busy(true); notice('Читаю файлы и нахожу соответствия…');
    const revision = state.revision; let ready = false;
    try {
      const metadata = await api('/api/prepare', {...state.sources, delimiter: delimiter()});
      if (revision !== state.revision) return;
      if (metadata.needs_sheet) {
        for (const side of ['left', 'right']) showSheets(side, metadata.sheets[side], metadata.selected[side]);
        notice('Выберите лист в каждом Excel-файле с несколькими заполненными листами. Я сверю только выбранные листы.');
        officeReset('В книге несколько заполненных листов. Выберите нужный рядом с файлом — и я продолжу сверку.');
        return;
      }
      state.metadata = metadata;
      if (metadata.kind === 'text') {
        $('settings').hidden = true; $('rules-empty').hidden = true;
        for (const side of ['left', 'right']) {
          showSheets(side);
          $(side + '-meta').textContent = `${metadata[side].block_count} фрагментов · ${String(metadata[side].format).toUpperCase()} · заменить файл`;
        }
        ready = metadata.ready;
      } else {
        $('settings').hidden = false;
        state.suggested = metadata.rules.fields; state.delimiter = metadata.delimiter;
        for (const side of ['left', 'right']) {
          showSheets(side, metadata[side].sheets, metadata[side].sheet ?? null);
          $(side + '-meta').textContent = `${metadata[side].sheet ? 'Лист «' + metadata[side].sheet + '» · ' : ''}${metadata[side].row_count} строк · ${metadata[side].headers.length} столбцов · заменить файл`;
          options($(side + '-key'), metadata[side].headers, 'Выберите идентификатор');
        }
        if (metadata.rules.key) { chooseColumn($('left-key'), metadata.rules.key[0]); chooseColumn($('right-key'), metadata.rules.key[1]); }
        $('membership').checked = !!metadata.rules.key && metadata.left.headers.length === 1 && metadata.right.headers.length === 1;
        $('strip').checked = false; $('mapping-panel').hidden = $('membership').checked;
        mapping(false); $('rules').hidden = false; $('rules-empty').hidden = true;
        ready = metadata.ready;
        if (!ready) {
          $('question-text').textContent = metadata.question;
          $('setup-question').hidden = false;
          if (!metadata.rules.key) $('question-controls').append($('key-controls'));
          else $('settings').open = true;
          $('question-title').focus({preventScroll: true});
          $('setup-question').scrollIntoView({behavior: 'smooth', block: 'center'});
          if (metadata.unmatched.left.length || metadata.unmatched.right.length) $('settings').open = true;
          notice(); officeReset('Файлы прочитаны. Уточните, как сопоставить позиции, — затем смогу объяснить результат.');
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError' && revision === state.revision) { state.metadata = null; notice('Не удалось прочитать файлы. ' + error.message, true); $('settings').open = true; officeReset('Не удалось прочитать файлы. Проверьте сообщение рядом с загрузкой и попробуйте снова.'); }
    } finally { if (revision === state.revision) busy(false); }
    if (ready && revision === state.revision) await compare();
  }
  async function loadFile(side, file) {
    if (!file || state.busy) return;
    const version = ++loads[side]; clearResult(); state.sources[side] = null; state.metadata = null;
    showSheets(side); $('settings').hidden = textSourcesSelected();
    $('advanced-key-home').append($('key-controls')); $('setup-question').hidden = true;
    $('rules').hidden = true; $('rules').disabled = true; $('rules-empty').hidden = false; sourceLabel(side, null);
    if (file.size > MAX_FILE_BYTES) { notice('Файл превышает 2 MiB. Выберите меньший файл.', true); return; }
    if (/\.(txt|docx)$/i.test(file.name) && !window.KristinaTransport) { notice('TXT и DOCX доступны в расширении Кристины. Здесь загрузите CSV.', true); return; }
    if (/\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(file.name) && !window.KristinaTransport) { notice('Excel доступен в расширении Кристины. Здесь загрузите CSV.', true); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (version !== loads[side]) return;
      state.sources[side] = {name: file.name, data: encode(bytes)}; sourceLabel(side, file); await prepare();
    } catch (error) { if (version === loads[side]) { clearResult(); state.metadata = null; notice('Не удалось открыть файл. ' + error.message, true); } }
  }
  function selectedRules() {
    const key = [selectedColumn($('left-key')), selectedColumn($('right-key'))];
    if (key.some(value => !value)) throw new Error('Выберите идентификатор одной и той же позиции в обоих файлах.');
    const fields = [], used = new Set();
    if (!$('membership').checked) {
      for (const row of $('field-mapping').children) {
        const right = selectedColumn(row.querySelector('.field-target')); if (!right) continue;
        if (used.has(right)) throw new Error('Каждому столбцу нужна одна пара. Повторяется: ' + right);
        used.add(right); fields.push([row.dataset.left, right, row.querySelector('.field-mode').value]);
      }
      if (!fields.length) throw new Error('Выберите значения для проверки или включите «Проверить только наличие позиций».');
    }
    return {key, fields, strip: $('strip').checked};
  }
  async function compare() {
    if (state.busy || !state.metadata) return;
    let rules; try { rules = state.metadata.kind === 'text' ? {} : selectedRules(); } catch (error) { clearResult(); notice(error.message, true); return; }
    clearResult(); busy(true); const revision = state.revision; notice('Сравниваю документы…');
    try {
      const payload = state.metadata.kind === 'text' ? {...state.sources} : {...state.sources, delimiter: state.delimiter, ...rules};
      const result = await api('/api/compare', payload);
      if (revision !== state.revision) return;
      state.report = result.report; state.html = result.html;
      $('advanced-key-home').append($('key-controls')); $('setup-question').hidden = true;
      renderResult(); officeDescribe(); notice();
    } catch (error) { if (error.name !== 'AbortError' && revision === state.revision) { clearResult(); notice('Сверка не выполнена. ' + error.message, true); officeReset('Сверка не выполнена. Исправьте данные или настройки по сообщению об ошибке.'); busy(false); } }
    finally { if (revision === state.revision) busy(false); }
  }
  function renderCommercial() {
    const box = $('commercial-summary'), impact = state.report?.commercial;
    box.replaceChildren(); box.hidden = !impact || state.report.kind === 'text' || state.report.status !== 'complete';
    if (box.hidden) return;
    box.append(element('h3', 'Влияние на сумму'));
    const stats = element('p', undefined, 'commercial-counts');
    const count = value => value === null || value === undefined ? 'не определено' : String(value);
    stats.textContent = `Изменилась цена: ${count(impact.counts.price_changed)} · количество: ${count(impact.counts.quantity_changed)} · только в A: ${impact.counts.only_left} · только в B: ${impact.counts.only_right}`;
    box.append(stats);
    for (const line of window.KristinaOffice.commercialLines(state.report)) box.append(element('p', line));
    const revision = state.revision;
    function details(items, heading, describe) {
      if (!items.length) return;
      const section = element('details'), list = element('ul', undefined, 'commercial-items');
      section.append(element('summary', `${heading}: ${items.length}`));
      for (const item of items.slice(0, 12)) {
        const row = element('li'); row.append(element('p', describe(item)));
        row.append(officeActions([{label: `Открыть ${String(item.key).slice(0, 70)} в документах`, key: item.key, category: item.category}], revision));
        list.append(row);
      }
      section.append(list);
      if (items.length > 12) section.append(element('p', `Показано 12 из ${items.length}; все позиции включены в скачиваемый HTML-отчёт.`, 'hint'));
      box.append(section);
    }
    details(impact.items.filter(item => !/^0(?:\.0+)?$/.test(String(item.delta))), 'Изменения по позициям', item => `${item.key} · ${item.unit}: ${window.KristinaOffice.commercialTotalLine(item)}`);
    details(impact.excluded, 'Что уточнить для полного расчёта', item => `${item.key}: ${item.reasons.join(' ')}`);
  }
  function renderResult() {
    const report = state.report, complete = report.status === 'complete', textMode = report.kind === 'text';
    reviewMode(complete, textMode);
    changePage = 0;
    exportEnable();
    renderCommercial();
    $('results').hidden = false; $('complete-result').hidden = !complete; $('clarification').hidden = complete;
    $('result-heading').textContent = complete ? (report.summary.changed + report.summary.only_left + report.summary.only_right ? 'Различия в документах' : 'Проверенные значения совпадают') : 'Нужно уточнить данные';
    $('settings').hidden = textMode; $('text-scope').hidden = !textMode;
    $('results').classList.toggle('text-results', textMode);
    $('search').placeholder = textMode ? 'Найти в тексте…' : 'Найти артикул…';
    $('search-label-text').textContent = textMode ? 'Найти текст в документах' : 'Найти позицию';
    $('totals').setAttribute('aria-label', textMode ? 'Показать фрагменты' : 'Показать позиции');
    const notes = $('text-source-notes'); notes.replaceChildren();
    if (textMode) {
      $('result-context').textContent = `${report.summary.left_blocks} фрагментов в A · ${report.summary.right_blocks} в B. Показан извлечённый текст без исходной вёрстки.`;
      if (!report.summary.changed && !report.summary.only_left && !report.summary.only_right) $('result-heading').textContent = 'Текст документов совпадает';
      $('audit-explanation').textContent = 'Сравнивается извлечённый текст: строки TXT и абзацы DOCX. Сохранены исходные слова, пробелы и порядок; унифицированы переводы строк. Номера и подписи фрагментов относятся к каждому исходному файлу. Фрагменты без пары показаны только с одной стороны. Оформление и вёрстка не сравниваются.';
      for (const side of ['left', 'right']) for (const note of (report.sources[side].notes || [])) notes.append(element('li', `${side === 'left' ? 'A' : 'B'}: ${note}`));
    } else {
      $('result-context').textContent = 'Пары строк совмещены по «' + report.rules.key.join('» ↔ «') + '». Номера записей — в исходных файлах.';
      const numeric = report.rules.fields.filter(f => f[2] === 'number').map(f => f[0]);
      const brief = 'По «' + report.rules.key.join('» ↔ «') + '»' + (numeric.length ? ' · числа: ' + numeric.join(', ') : ' · точное сравнение текста');
      $('rules-summary').textContent = brief.length > 180 ? brief.slice(0, 180) + '…' : brief;
      $('audit-explanation').textContent = 'Показано содержимое выбранных таблиц. Пары выровнены по идентификатору, номера записей относятся к исходным файлам (заголовок — запись 1). Подсветка относится только к проверенным полям; остальные помечены отдельно. Единицы и валюты не пересчитываются.';
    }
    notes.hidden = !notes.children.length;
    $('source-notes-details').hidden = !notes.children.length;
    $('audit-details').textContent = JSON.stringify({sources: report.sources, rules: report.rules}, null, 2);
    $('search').value = ''; state.active = -1;
    if (!complete) {
      const box = $('clarification'); box.replaceChildren(element('h3', 'Сравнение не выполнено'));
      const list = element('ul'); for (const question of report.questions) list.append(element('li', question));
      box.append(list, element('p', 'Исправьте указанные данные или измените настройки сравнения. Частичных итогов нет.'));
      const details = element('details'); details.append(element('summary', 'Подробнее'), element('pre', JSON.stringify(report.issues, null, 2))); box.append(details);
      return;
    }
    state.records = [];
    for (const [category] of categories.slice(1)) for (const item of report[category]) state.records.push({...item, category});
    if (textMode) state.records.sort((a, b) => Number(a.key.slice(5)) - Number(b.key.slice(5)));
    else state.records.sort((a, b) => (a.left?.record ?? (a.category === 'only_left' ? a.row.record : Infinity)) - (b.left?.record ?? (b.category === 'only_left' ? b.row.record : Infinity)) || (a.right?.record ?? a.row?.record ?? 0) - (b.right?.record ?? b.row?.record ?? 0));
    state.filter = 'all'; state.page = 0; $('totals').replaceChildren();
    for (const [key, label] of categories) {
      const button = element('button', undefined, 'total'); button.type = 'button'; button.dataset.category = key;
      button.append(element('strong', key === 'all' ? state.records.length : report.summary[key]), element('span', textMode && key === 'all' ? 'Все фрагменты' : label));
      button.addEventListener('click', () => { state.filter = key; state.page = 0; state.active = -1; changePage = 0; renderRows(); }); $('totals').append(button);
    }
    $('document-left-name').textContent = report.sources.left.name; $('document-right-name').textContent = report.sources.right.name;
    $('no-overlap').hidden = textMode || !(report.summary.left_rows && report.summary.right_rows && report.summary.matched + report.summary.changed === 0);
    renderRows();
  }
  // A bounded, linear prefix/suffix highlight. Preserve every original character.
  function highlight(container, value, other, mode) {
    if (mode === 'number' || !value || !other) { container.append(element('mark', value)); return; }
    const a = Array.from(value), b = Array.from(other); let start = 0, end = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    container.append(document.createTextNode(a.slice(0, start).join('')), element('mark', a.slice(start, a.length - end).join('')), document.createTextNode(end ? a.slice(a.length - end).join('') : ''));
  }
  function textPanel(item, side) {
    const isLeft = side === 'left', row = item[side] || (item.category === (isLeft ? 'only_left' : 'only_right') ? item.row : null);
    const panel = element('section', undefined, 'document-record text-record ' + (isLeft ? 'before' : 'after'));
    panel.setAttribute('aria-label', `${isLeft ? 'A' : 'B'} · ${row?.location || 'Нет фрагмента'}`);
    if (!row) { panel.classList.add('absent'); panel.append(element('p', 'Нет этого фрагмента')); return panel; }
    const title = element('div', undefined, 'record-title');
    const labels = {changed: 'Текст изменён', matched: 'Текст совпадает', only_left: 'Только в A', only_right: 'Только в B'};
    title.append(element('strong', row.location), element('span', labels[item.category], 'record-status')); panel.append(title);
    const content = element('p', undefined, 'text-content');
    if (item.category === 'changed') {
      const segments = item.segments?.[side];
      // Never replace source text with an incomplete set of highlight tokens.
      if (Array.isArray(segments) && segments.map(part => part.text).join('') === row.text) {
        for (const part of segments) content.append(element(part.changed ? 'mark' : 'span', part.text));
      } else content.append(element('mark', row.text));
    } else if (item.category === 'only_left' || item.category === 'only_right') content.append(element('mark', row.text));
    else content.textContent = row.text;
    if (!row.text) { content.classList.add('is-empty'); content.setAttribute('aria-label', 'Пустая строка'); }
    panel.append(content); return panel;
  }
  function recordPanel(item, side) {
    const isLeft = side === 'left', index = isLeft ? 0 : 1;
    const row = item[side] || (item.category === (isLeft ? 'only_left' : 'only_right') ? item.row : null);
    const panel = element('section', undefined, 'document-record ' + (isLeft ? 'before' : 'after'));
    panel.setAttribute('aria-label', `${isLeft ? 'A' : 'B'} · ${item.key}`);
    if (!row) { panel.classList.add('absent'); panel.append(element('p', 'Нет этой позиции')); return panel; }
    const title = element('div', undefined, 'record-title'), keyName = state.report.rules.key[index];
    title.append(element('strong', `${keyName}: ${row.values[keyName]}`), element('span', row.sheet ? `«${row.sheet}» · строка ${row.record} · ${row.cells[keyName]}` : `Запись ${row.record}`, 'record-number'));
    const labels = {changed: 'Есть изменения', only_left: 'Только в A', only_right: 'Только в B', matched: 'Проверенные поля совпали'};
    title.append(element('span', labels[item.category], 'record-status')); panel.append(title);
    const values = element('dl', undefined, 'document-values');
    const changes = new Map((item.changes || []).map(c => [isLeft ? c.left_column : c.right_column, c]));
    const checked = new Map(state.report.rules.fields.map(f => [f[index], f]));
    for (const name of state.report.sources[side].headers) {
      const value = row.values[name];
      if (name === keyName) continue;
      const block = element('div', undefined, 'document-field'), label = element('dt', name), dd = element('dd');
      block.dataset.field = name;
      if (row.cells?.[name]) label.append(element('span', ' · ' + row.cells[name], 'cell-address'));
      if (value.length > 35 || /наименование|name|description/i.test(name)) block.classList.add('wide');
      if (!value) label.append(element('span', ' · пустое значение', 'uncompared'));
      const change = changes.get(name), single = item.category === 'only_left' || item.category === 'only_right';
      if (change) {
        block.classList.add('is-changed'); label.append(element('span', ' · изменено'));
        highlight(dd, value, isLeft ? change.after : change.before, change.mode);
      } else if (single) dd.append(element('mark', value));
      else {
        dd.textContent = value;
        const rule = checked.get(name);
        if (!rule) label.append(element('span', ' · не проверялось', 'uncompared'));
        else if (rule[2] === 'number' && item[isLeft ? 'right' : 'left'].values[rule[isLeft ? 1 : 0]] !== value) label.append(element('span', ' · равно как число', 'uncompared'));
      }
      block.append(label, dd); values.append(block);
    }
    if (!values.children.length) values.append(element('p', 'Проверено наличие идентификатора.', 'hint'));
    panel.append(values); return panel;
  }
  function filtered() {
    const query = $('search').value.toLocaleLowerCase();
    return state.records.filter(item => (state.filter === 'all' || item.category === state.filter) && (state.report?.kind === 'text' ? [item.left?.text, item.right?.text, item.row?.text, item.left?.location, item.right?.location, item.row?.location].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query)) : item.key.toLocaleLowerCase().includes(query)));
  }
  function changeEntries(records) {
    return records.flatMap((item, index) => item.category === 'matched' ? [] : [{item, index}]);
  }
  function renderChanges(records, followActive = false) {
    const changes = changeEntries(records), active = changes.findIndex(entry => entry.index === state.active);
    const pages = Math.max(1, Math.ceil(changes.length / PAGE_SIZE));
    if (followActive && active >= 0) changePage = Math.floor(active / PAGE_SIZE);
    changePage = Math.max(0, Math.min(changePage, pages - 1));
    $('change-count').textContent = String(changes.length);
    $('change-position').textContent = active < 0 ? `Отличий: ${changes.length}` : `Отличие ${active + 1} из ${changes.length}`;
    const list = $('change-list'); list.replaceChildren(); list.start = changePage * PAGE_SIZE + 1;
    const labels = {changed: 'Изменено', only_left: 'Только в A', only_right: 'Только в B'};
    const textMode = state.report.kind === 'text';
    for (const [offset, {item, index}] of changes.slice(changePage * PAGE_SIZE, (changePage + 1) * PAGE_SIZE).entries()) {
      const li = element('li'), button = element('button', undefined, 'change-item');
      button.type = 'button'; button.dataset.index = String(index);
      if (index === state.active) button.setAttribute('aria-current', 'true');
      button.append(element('span', `${changePage * PAGE_SIZE + offset + 1}. ${labels[item.category]}`, 'change-item-title'));
      const locations = [];
      for (const side of ['left', 'right']) {
        const left = side === 'left', row = item[side] || (item.category === (left ? 'only_left' : 'only_right') ? item.row : null);
        if (!row) continue;
        locations.push(`${left ? 'A' : 'B'}: ${textMode ? row.location : (row.sheet ? `«${row.sheet}» · строка ${row.record}` : `запись ${row.record}`)}`);
        let value;
        if (textMode) value = row.text;
        else value = item.key + (item.changes?.length ? ' · ' + item.changes.map(change => `${left ? change.left_column : change.right_column}: ${left ? change.before : change.after}`).join('; ') : '');
        // Only this navigation preview is shortened; the evidence keeps every character.
        const preview = Array.from(value);
        button.append(element('span', `${left ? 'A' : 'B'}: ${preview.slice(0, 160).join('')}${preview.length > 160 ? '…' : ''}` + (!value ? ' (пустой текст)' : ''), 'change-excerpt ' + (left ? 'before' : 'after')));
      }
      button.append(element('span', locations.join(' · '), 'change-location'));
      const revision = state.revision;
      button.addEventListener('click', () => { if (revision === state.revision) selectChange(index); });
      li.append(button); list.append(li);
    }
    $('change-empty').hidden = changes.length > 0;
    $('change-empty').textContent = state.filter !== 'all' || $('search').value ? 'В выбранных результатах отличий нет. Сбросьте фильтр или поиск, чтобы увидеть остальные.' : 'Отличий не найдено по правилам этой сверки.';
    $('changes-page').textContent = changes.length ? `${changePage * PAGE_SIZE + 1}–${Math.min((changePage + 1) * PAGE_SIZE, changes.length)} из ${changes.length}` : '0';
    $('changes-previous').disabled = changePage === 0; $('changes-next').disabled = changePage >= pages - 1;
  }
  function renderRows(followActive = false) {
    if (!state.report || state.report.status !== 'complete') return;
    for (const button of $('totals').children) button.setAttribute('aria-pressed', String(button.dataset.category === state.filter));
    const records = filtered(), pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE)); state.page = Math.min(state.page, pages - 1);
    const textMode = state.report.kind === 'text', unit = textMode ? 'фрагментов' : 'позиций';
    const start = state.page * PAGE_SIZE; $('record-range').textContent = records.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, records.length)} из ${records.length} ${unit}` : `0 ${unit}`;
    const root = $('result-rows'); root.replaceChildren();
    for (const [offset, item] of records.slice(start, start + PAGE_SIZE).entries()) {
      const pair = element('article', undefined, 'document-pair ' + item.category.replace('_', '-')); pair.tabIndex = -1; pair.dataset.index = String(start + offset); pair.dataset.category = item.category;
      pair.classList.toggle('active-change', start + offset === state.active && item.category !== 'matched');
      const panel = textMode ? textPanel : recordPanel;
      pair.append(panel(item, 'left'), panel(item, 'right')); root.append(pair);
    }
    if (!records.length) root.append(element('p', textMode ? 'Нет фрагментов для выбранного фильтра.' : 'Нет позиций для выбранного фильтра.', 'zero-state'));
    $('page-info').textContent = `Страница ${state.page + 1} из ${pages}`;
    $('previous').disabled = state.page === 0; $('next').disabled = state.page >= pages - 1;
    const hasChanges = records.some(item => item.category !== 'matched'); $('next-change').disabled = !hasChanges; $('previous-change').disabled = !hasChanges;
    $('document-scroll').scrollTop = 0;
    renderChanges(records, followActive);
  }
  function selectChange(index) {
    const records = filtered();
    if (!records[index] || records[index].category === 'matched') return;
    state.active = index; state.page = Math.floor(index / PAGE_SIZE); renderRows(true);
    const pair = $('result-rows').querySelector(`[data-index="${index}"]`);
    pair.focus({preventScroll: true}); pair.scrollIntoView({behavior: 'smooth', block: 'center', inline: 'nearest'});
  }
  function jumpChange(direction) {
    const records = filtered(), indexes = records.flatMap((item, i) => item.category !== 'matched' ? [i] : []);
    if (!indexes.length) return;
    selectChange(direction > 0 ? (indexes.find(i => i > state.active) ?? indexes[0]) : (indexes.findLast(i => i < state.active) ?? indexes[indexes.length - 1]));
  }
  function download(format) {
    if (!state.report) return;
    const html = format === 'html', content = html ? state.html : JSON.stringify(state.report, null, 2) + '\n';
    const url = URL.createObjectURL(new Blob([content], {type: html ? 'text/html;charset=utf-8' : 'application/json;charset=utf-8'}));
    const link = element('a'); link.href = url; link.download = 'kristina-reconciliation.' + format; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportEnable() {
    const available = !!window.KristinaTransport && state.report?.status === 'complete';
    for (const format of ['xlsx', 'pdf']) {
      const button = $('download-' + format);
      button.hidden = !available || (format === 'xlsx' && state.report.kind === 'text');
      button.disabled = button.hidden || state.busy || !!exportController;
    }
  }
  function exportStatus(message = '', error = false) {
    const status = $('export-status');
    status.textContent = message; status.hidden = !message; status.classList.toggle('export-error', error);
  }
  async function downloadExport(format) {
    if (!['xlsx', 'pdf'].includes(format) || !window.KristinaTransport || state.busy || exportController || state.report?.status !== 'complete') return;
    if (format === 'xlsx' && state.report.kind === 'text') return;
    const report = state.report, revision = state.revision, requestController = new AbortController();
    exportController = requestController; exportEnable();
    exportStatus('Готовлю ' + format.toUpperCase() + '-отчёт…');
    const current = () => !requestController.signal.aborted && revision === state.revision && report === state.report && exportController === requestController;
    try {
      // Export has its own cancellation scope so a new comparison stays independent.
      const result = await window.KristinaTransport.request('/api/export', {report, format}, {signal: requestController.signal});
      if (!current()) return;
      if (!(result?.data instanceof Uint8Array) || !result.data.length) throw new Error('Не удалось получить готовый файл. Повторите скачивание.');
      const url = URL.createObjectURL(new Blob([result.data], {type: result.mime}));
      const link = element('a'); link.href = url; link.download = result.filename;
      try { document.body.append(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      exportStatus(format.toUpperCase() + '-отчёт передан браузеру для скачивания.');
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return;
      const detail = typeof error?.message === 'string' && /^(?:[А-Яа-яЁё]|(?:XLSX|PDF)[: -])/.test(error.message) ? ' ' + error.message.slice(0, 240) : ' Повторите скачивание или сохраните HTML-отчёт.';
      exportStatus('Не удалось подготовить ' + format.toUpperCase() + '.' + detail, true);
    } finally {
      if (exportController === requestController) { exportController = null; exportEnable(); }
    }
  }
  $('office-form').addEventListener('submit', event => { event.preventDefault(); officeAsk($('office-question').value); });
  $('office-question').addEventListener('input', () => $('office-question').setCustomValidity(''));
  $('office-question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); officeAsk($('office-question').value); } });
  $('office-impact-question').addEventListener('click', () => officeAsk('Как изменилась сумма?'));
  for (const button of $('office-suggestions').children) button.addEventListener('click', () => officeAsk(button.dataset.question, button.dataset.question === 'Подготовь письмо'));
  $('office-open').addEventListener('click', () => {
    $('office-panel').open = true; $('office-panel').scrollIntoView({behavior: 'smooth', block: 'center'});
    if (officeAvailable()) $('office-question').focus({preventScroll: true});
  });
  $('office-copy').addEventListener('click', officeCopy); $('office-download').addEventListener('click', officeDownload);
  $('office-draft').addEventListener('input', () => { $('office-draft-status').textContent = 'Черновик изменён. Проверьте текст перед отправкой.'; });
  if (window.matchMedia?.('(max-width:1379px)').matches) $('office-panel').open = false;
  officeEnable(); exportEnable();
  if (window.KristinaTransport) {
    $('supported-formats').textContent = 'Таблицы CSV и Excel или текстовые документы TXT и DOCX. Формат определю по файлам.';
    $('source-privacy').textContent = 'Сравнение начнётся автоматически. Файлы обрабатываются локально, без отправки в LLM. До 2 MiB на файл.';
  }
  for (const side of ['left', 'right']) {
    if (window.KristinaTransport) {
      $(side + '-file').accept += ',.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.txt,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      sourceLabel(side, null);
      const label = element('label', 'Лист для сверки', 'sheet-choice'), select = element('select');
      select.id = side + '-sheet'; select.setAttribute('aria-label', 'Лист для сверки ' + (side === 'left' ? 'A' : 'B'));
      label.hidden = true; label.append(select); $(side + '-drop').after(label);
      select.addEventListener('change', () => {
        if (!state.sources[side] || state.busy) return;
        if (select.value === '') delete state.sources[side].sheet;
        else state.sources[side].sheet = selectedColumn(select);
        prepare();
      });
    }
    $(side + '-file').addEventListener('change', event => loadFile(side, event.target.files[0]));
    const zone = $(side + '-drop'); zone.addEventListener('dragover', event => { event.preventDefault(); if (!state.busy) zone.classList.add('dragging'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
    zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('dragging'); loadFile(side, event.dataTransfer.files[0]); });
    $(side + '-key').addEventListener('change', () => { dirty(); mapping(); });
  }
  $('demo').addEventListener('click', async () => {
    if (state.busy) return; loads.left++; loads.right++;
    for (const side of ['left', 'right']) showSheets(side);
    const examples = {left: ['order.csv', 'sku,quantity,unit,price_rub\nCH-100,10,piece,189\nDS-200,5,piece,20\nLP-300,2,piece,30\nOLD-400,1,piece,40\n'], right: ['confirmation.csv', 'sku,quantity,unit,price_rub\nCH-100,10.00,piece,189.00\nDS-200,4,piece,22\nLP-300,2,box,30\nNEW-500,1,piece,40\n']};
    $('delimiter').value = 'auto'; $('settings').open = false;
    for (const side of ['left', 'right']) { const [name, text] = examples[side]; state.sources[side] = {name, data: encode(new TextEncoder().encode(text))}; $(side + '-file').value = ''; sourceLabel(side, {name}); }
    await prepare();
  });
  $('delimiter').addEventListener('change', prepare);
  $('membership').addEventListener('change', () => { dirty(); $('mapping-panel').hidden = $('membership').checked; });
  $('strip').addEventListener('change', dirty); $('compare').addEventListener('click', compare); $('answer').addEventListener('click', compare);
  $('search').addEventListener('input', () => { state.page = 0; state.active = -1; changePage = 0; renderRows(); });
  $('changes-previous').addEventListener('click', () => { changePage--; renderChanges(filtered()); });
  $('changes-next').addEventListener('click', () => { changePage++; renderChanges(filtered()); });
  $('document-zoom').addEventListener('change', () => {
    for (const size of ['85', '100', '115', '130']) $('document-scroll').classList.toggle('zoom-' + size, $('document-zoom').value === size);
  });
  $('previous').addEventListener('click', () => { state.page--; state.active = -1; renderRows(); });
  $('next').addEventListener('click', () => { state.page++; state.active = -1; renderRows(); });
  $('next-change').addEventListener('click', () => jumpChange(1)); $('previous-change').addEventListener('click', () => jumpChange(-1));
  $('download-html').addEventListener('click', () => download('html')); $('download-json').addEventListener('click', () => download('json'));
  $('download-xlsx').addEventListener('click', () => downloadExport('xlsx')); $('download-pdf').addEventListener('click', () => downloadExport('pdf'));
})();
