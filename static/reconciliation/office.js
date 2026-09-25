/* Kristina's deterministic office dialogue: facts from one report, no network. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KristinaOffice = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const MAX_TEXT = 12000, MAX_ACTIONS = 12, MAX_DRAFT_BYTES = 1024 * 1024;
  const categories = ['changed', 'only_left', 'only_right', 'matched'];
  const title = {changed: 'Есть изменения в проверенных полях', only_left: 'Есть только в A', only_right: 'Есть только в B', matched: 'Проверенные поля совпали'};
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const quote = value => JSON.stringify(String(value));
  const short = value => {
    const text = String(value);
    return text.length <= 240 ? quote(text) : quote(text.slice(0, 240)) + '… [значение сокращено; полное — в документе]';
  };
  const normalize = value => String(value).trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  const entries = report => categories.flatMap(category => (report[category] || []).map(item => ({item, category})));
  const fields = report => report.rules?.fields || [];
  const fieldKind = name => {
    const value = normalize(name);
    if (/^(price|цена)(?:$|[ _(/])/.test(value)) return 'price';
    if (/^(quantity|qty|количество)(?:$|[ _(/])/.test(value)) return 'quantity';
    if (['unit', 'единица', 'единица измерения', 'ед. изм.', 'ед.изм.'].includes(value)) return 'unit';
    return null;
  };
  const hasKind = (mapping, kind) => fieldKind(mapping[0]) === kind || fieldKind(mapping[1]) === kind;
  const action = (item, category, field) => ({label: `Открыть ${String(item.key).slice(0, 70)}${String(item.key).length > 70 ? '…' : ''}`, key: item.key, category, ...(field ? {field} : {})});

  function response(lines, actions = [], draft) {
    const kept = [];
    let size = 0, truncated = false;
    for (const line of lines) {
      if (size + line.length + 1 > MAX_TEXT - 500) { truncated = true; break; }
      kept.push(line); size += line.length + 1;
    }
    if (truncated) kept.push(`Ответ сокращён: показано ${kept.length} из ${lines.length} блоков. Остальные сведения доступны в документах и полном HTML-отчёте.`);
    if (actions.length > MAX_ACTIONS) kept.push(`Кнопки перехода: показано ${MAX_ACTIONS} из ${actions.length}. Остальные позиции доступны в документах и полном HTML-отчёте.`);
    return {text: kept.join('\n'), actions: actions.slice(0, MAX_ACTIONS), ...(draft === undefined ? {} : {draft})};
  }

  function unavailable(report) {
    if (!report || typeof report !== 'object') return response(['Я Кристина, ваш офисный помощник. Загрузите два CSV-файла — после сверки я объясню различия и помогу подготовить письмо.']);
    if (report.status !== 'complete') return response([
      'Сверка ещё не завершена. Пока нельзя делать выводы о совпадениях и различиях.',
      ...(Array.isArray(report.questions) && report.questions.length ? report.questions.map(q => short(q)) : ['Уточните данные или настройки сопоставления и повторите сверку.']),
    ]);
    return null;
  }

  function counts(report) {
    return `Изменились: ${report.changed.length}; только в A: ${report.only_left.length}; только в B: ${report.only_right.length}; ${fields(report).length ? 'совпали по проверенным полям' : 'ключи найдены в обоих файлах'}: ${report.matched.length}.`;
  }
  function sheetLines(report, compact = true) {
    const show = compact ? short : quote;
    return ['left', 'right'].flatMap((side, i) => report.sources[side].sheet ? [`${i ? 'B' : 'A'}: проверен только лист ${show(report.sources[side].sheet)}. Другие листы и оформление не проверялись.`] : []);
  }
  function ruleLines(report, compact = true) {
    const show = compact ? short : quote;
    const rules = report.rules || {}, selected = fields(report);
    const lines = [...sheetLines(report, compact), `Сопоставление по ключам: A ${show(rules.key?.[0] ?? '')} ↔ B ${show(rules.key?.[1] ?? '')}.`];
    if (!selected.length) lines.push('Проверялось только наличие ключей. Значения других столбцов не сравнивались.');
    else {
      lines.push('Проверенные поля:');
      for (const [a, b, mode] of selected) lines.push(`• A ${show(a)} ↔ B ${show(b)} — ${mode === 'number' ? 'число' : 'текст'}.`);
      lines.push('Поля, не включённые в эти правила, не оценивались на совпадение.');
    }
    lines.push(rules.strip ? 'При сравнении игнорировались пробелы по краям значений и ключей.' : 'Пробелы по краям значений и ключей учитывались.');
    return lines;
  }
  function noOverlap(report) {
    return !report.changed.length && !report.matched.length && report.only_left.length && report.only_right.length;
  }


  const textTitle = {changed: 'Текст изменился', only_left: 'Текст есть только в A', only_right: 'Текст есть только в B', matched: 'Текст совпал'};
  const textEntries = report => entries(report).sort((a, b) => Number(a.item.key.slice(5)) - Number(b.item.key.slice(5)));
  const textScope = 'Сравнивался извлечённый текст. Юридический смысл, достоверность фактов и орфография не оценивались.';
  function textCounts(report) {
    return `Изменённых блоков: ${report.changed.length}; только в A: ${report.only_left.length}; только в B: ${report.only_right.length}; совпавших: ${report.matched.length}.`;
  }
  function textSources(report, full = false) {
    const show = full ? quote : short, lines = [];
    for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
      const source = report.sources[side];
      lines.push(`${label} — ${show(source.name)}; текстовых блоков: ${source.block_count}.`);
      for (const note of source.notes || []) lines.push(`${label}: ${show(note)}`);
    }
    return lines;
  }
  function textLines(item, category, full = false) {
    const show = full ? quote : short;
    const lines = [`${show(item.key)}. ${textTitle[category]}.`];
    for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
      const block = item[side] || (category === `only_${side}` ? item.row : null);
      if (block) lines.push(`${label} · ${show(block.location)} (блок ${block.record}): ${show(block.text)}`);
      else lines.push(`${label}: сопоставленного текстового блока нет.`);
    }
    return lines;
  }
  function textSelection(found, heading) {
    if (!found.length) return response([heading, 'Подходящих блоков в текущем отчёте не найдено.']);
    const lines = [heading];
    for (const {item, category} of found) lines.push(...textLines(item, category));
    return response(lines, found.map(({item, category}) => action(item, category)));
  }
  function describeText(report) {
    const lines = ['Я Кристина, ваш офисный помощник. Сравнила текст двух файлов.', ...textSources(report), textCounts(report), textScope];
    if (!textEntries(report).length) lines.push('В обоих файлах нет извлечённых текстовых блоков.');
    const changed = textEntries(report).filter(entry => entry.category !== 'matched');
    for (const {item, category} of changed.slice(0, 2)) lines.push(...textLines(item, category));
    if (changed.length > 2) lines.push(`Примеры: показано 2 из ${changed.length} различий. Полный текст — в документах и HTML-отчёте.`);
    if (!changed.length && textEntries(report).length) lines.push('Извлечённый текст совпал по правилам сравнения.');
    lines.push('Можно открыть блок по номеру или фразе, показать добавления и удаления либо подготовить черновик письма.');
    return response(lines, categories.filter(category => report[category].length).map(category => ({label: `${textTitle[category]}: ${report[category].length}`, category})));
  }
  function draftTextLetter(report) {
    const encoder = new TextEncoder(), parts = []; let size = 0;
    function append(line) {
      const text = line + '\n';
      if (text.length > MAX_DRAFT_BYTES - size) throw new RangeError('draft_size');
      const bytes = encoder.encode(text).length;
      if (bytes > MAX_DRAFT_BYTES - size) throw new RangeError('draft_size');
      parts.push(text); size += bytes;
    }
    try {
      append('Здравствуйте!'); append('');
      append('При сравнении извлечённого текста двух файлов получены следующие результаты.');
      for (const line of textSources(report, true)) append(line);
      append(textCounts(report));
      append('Нормализованы переводы строк. Пробелы и регистр учитывались; исходная вёрстка не сравнивалась.');
      append(textScope); append('');
      append('Ниже перечислены все обнаруженные текстовые различия. Значения в кавычках — точные исходные фрагменты; переносы строк записаны как \\n.');
      for (const {item, category} of textEntries(report).filter(entry => entry.category !== 'matched')) {
        for (const line of textLines(item, category, true)) append(line);
      }
      if (!report.changed.length && !report.only_left.length && !report.only_right.length) append('Текстовых различий по указанным правилам не обнаружено.');
      append(''); append('Просьба проверить перечисленные текстовые различия и уточнить, какую редакцию следует использовать.');
      return response(['Черновик готов: в нём перечислены все текстовые различия, без оценки их смысла. Текст можно отредактировать. Письмо не отправлено.'], [], parts.join(''));
    } catch (error) {
      if (!(error instanceof RangeError) || error.message !== 'draft_size') throw error;
      return response(['Полный черновик превышает лимит 1 МиБ. Я не сформировала сокращённое письмо: скачайте полный HTML-отчёт и приложите его к сообщению.']);
    }
  }
  function answerText(report, question) {
    if (typeof question !== 'string' || !question.trim()) return response(['Можно спросить: «Что изменилось?», «Что добавилось?», «Что удалено?», «Покажи абзац 3 в A», «Найди «фразу»» или «Подготовь письмо».']);
    const raw = question.trim(), q = normalize(raw), all = textEntries(report);
    let key = raw.match(/^(?:покажи|найди|открой|расскажи про|что с)\s+(?:(?:позици[яю]|блок|ключ)\s+)?(text-\d+)[?!.]*$/iu)?.[1] || raw;
    const direct = all.find(({item}) => item.key === key);
    if (direct) return textSelection([direct], 'Текстовый блок из текущей сверки:');
    if (/письм|черновик/.test(q) && /(?:^|\s)(?:не|без)(?=\s)|отмен/.test(q)) return response(['Черновик не создаю. Можно продолжить обсуждение текстовых различий.']);
    if (/письм|черновик/.test(q) && /подготов|состав|напиш|сдела|черновик/.test(q)) return draftTextLetter(report);
    const position = raw.match(/(?:абзац|строк[ауи]?|блок|позици[яю])\s*№?\s*(\d+)/iu);
    if (position) {
      const number = Number(position[1]);
      const sideMatch = raw.match(/(?:в|из|стороне|файле|документе)\s+([abаб])(?=$|[\s?.!,])/iu) || raw.match(/^([abаб])\s*:/iu);
      const side = sideMatch ? (/^[aа]$/iu.test(sideMatch[1]) ? 'left' : 'right') : null;
      const found = all.filter(({item, category}) => (side ? [side] : ['left', 'right']).some(s => (item[s] || (category === `only_${s}` ? item.row : null))?.record === number));
      return textSelection(found, `Исходная позиция ${number}${side ? ' в ' + (side === 'left' ? 'A' : 'B') : ' (поиск в A и B; номера могут относиться к разным парам)'}.`);
    }
    const phraseRequest = raw.match(/^(?:найди|покажи|где|что с)\s+(?:(?:фразу|фраза|текст)\s+)?(.+?)\??$/iu);
    if (phraseRequest) {
      let phrase = phraseRequest[1];
      if ((phrase.startsWith('«') && phrase.endsWith('»')) || (phrase.startsWith('"') && phrase.endsWith('"'))) phrase = phrase.slice(1, -1);
      const query = normalize(phrase);
      if (query) {
        const found = all.filter(({item, category}) => ['left', 'right'].some(side => {
          const block = item[side] || (category === `only_${side}` ? item.row : null);
          return block && normalize(block.text).includes(query);
        }));
        if (found.length || /[«"]/.test(phraseRequest[1])) return textSelection(found, `Поиск фразы ${short(phrase)} в извлечённом тексте (без учёта регистра, е/ё).`);
      }
    }
    if (/юрид|законн|правомер|орфограф|пунктуац|граммат|достовер|факт|смысл|правильн|вычит|риск|обязательств|винов|причин/.test(q)) return response([textScope, 'Могу показать точные текстовые отличия и места в исходных документах.']);
    if (/почему.*(?:равн|совпал|одинаков)|как.*(?:сравнив|сопостав)|правил|что проверял/.test(q)) return response(['Сравнивался извлечённый текст блоков. Нормализованы только переводы строк; пробелы и регистр учитываются. Подсветка показывает изменённые фрагменты, а не оценку их смысла.', ...textSources(report), textScope]);
    if (/добав|только\s+(?:в\s+)?[bб](?=$|[\s?!.])/.test(q)) return textSelection(all.filter(entry => entry.category === 'only_right'), 'Текстовые блоки только в B:');
    if (/удал|только\s+(?:в\s+)?[aа](?=$|[\s?!.])/.test(q)) return textSelection(all.filter(entry => entry.category === 'only_left'), 'Текстовые блоки только в A:');
    if (/отсутств|без пары/.test(q)) return textSelection(all.filter(entry => entry.category === 'only_left' || entry.category === 'only_right'), 'Текстовые блоки без пары:');
    if (/^(?:что изменилось|что поменялось|какие (?:есть )?(?:различия|изменения|расхождения)|итог|результат|сводка|что получилось|объясни (?:результат|сверку))[?.! ]*$/.test(q)) return describeText(report);
    return response(['Этот вопрос не удалось связать с поддерживаемой текстовой проверкой.', 'Можно спросить: «Что изменилось?», «Что добавилось?», «Покажи text-2», «Покажи абзац 3 в A», «Найди «фразу»» или «Подготовь письмо».', textScope]);
  }

  function describe(report) {
    const missing = unavailable(report); if (missing) return missing;
    if (report.kind === 'text') return describeText(report);
    const lines = ['Я Кристина, ваш офисный помощник. Проверила два файла.',
      `A — ${short(report.sources.left.name)}; B — ${short(report.sources.right.name)}.`, counts(report)];
    lines.push(...sheetLines(report));
    if (!entries(report).length) lines.push('В обоих файлах нет строк данных; сравнивать позиции пока нечего.');
    if (noOverlap(report)) lines.push('По выбранным ключам общих позиций нет. Сначала проверьте, что ключи в A и B обозначают одно и то же.');
    if (!fields(report).length) lines.push('Проверила только наличие ключей. Значения других столбцов не сравнивались.');
    else lines.push('Сравнила выбранные поля; остальные не проверялись.');
    const allChanges = report.changed.flatMap(item => item.changes.map(change => ({item, change})));
    const names = [...new Set(allChanges.map(({change}) => change.left_column))];
    if (names.length) lines.push(`Изменившиеся поля: ${names.slice(0, 3).map(short).join(', ')}.${names.length > 3 ? ` Показано 3 из ${names.length}; остальные — в документах и полном HTML-отчёте.` : ''}`);
    const examples = [];
    if (allChanges.length) examples.push(changeLine(allChanges[0].item, allChanges[0].change));
    if (report.only_left.length) examples.push(`${short(report.only_left[0].key)} — только в A.`);
    if (report.only_right.length) examples.push(`${short(report.only_right[0].key)} — только в B.`);
    for (let i = 1; i < allChanges.length && examples.length < 3; i++) examples.push(changeLine(allChanges[i].item, allChanges[i].change));
    const total = allChanges.length + report.only_left.length + report.only_right.length;
    lines.push(...examples);
    if (examples.length < total) lines.push(`Примеры: показано ${examples.length} из ${total} различий. Остальные — в документах и полном HTML-отчёте.`);
    lines.push('Могу объяснить различия, показать позицию или подготовить письмо.');
    const actions = categories.filter(category => report[category].length).map(category => ({label: `${category === 'matched' && !fields(report).length ? 'Ключи найдены в обоих файлах' : title[category]}: ${report[category].length}`, category}));
    return response(lines, actions);
  }

  function explainRules(report) {
    const lines = [fields(report).length ? 'Совпадение относится только к выбранным полям и правилам сверки.' : 'В этой сверке проверялось только наличие ключей.', ...ruleLines(report)];
    if (fields(report).some(f => f[2] === 'number')) lines.push('В режиме «Число» сравнивается точное десятичное значение: например, 10 и 10.00 равны. Исходное написание в документах сохраняется.');
    if (fields(report).some(f => f[2] === 'text')) lines.push('В режиме «Текст» сравниваются символы; 10 и 10.00 различаются. Регистр учитывается.');
    if (noOverlap(report)) lines.push('В текущей сверке общих ключей нет, поэтому пары значений не сравнивались.');
    return response(lines, report.matched.length ? [{label: 'Открыть совпавшие позиции', category: 'matched'}] : []);
  }

  function changeLine(item, change, full = false) {
    const show = full ? quote : short;
    const reference = (row, column) => row.sheet ? `${show(row.sheet)}!${row.cells[column]}` : row.record;
    return `${show(item.key)}: A ${show(change.left_column)} = ${show(change.before)} → B ${show(change.right_column)} = ${show(change.after)} (строки A ${reference(item.left, change.left_column)}, B ${reference(item.right, change.right_column)}).`;
  }

  function changedFields(report, kind) {
    const selected = fields(report).filter(mapping => hasKind(mapping, kind));
    const label = {price: 'Цена', quantity: 'Количество', unit: 'Единица измерения'}[kind];
    if (!selected.length) return response([`${label}: это поле не включено в правила текущей сверки. Я не могу сказать, совпадает ли оно. Добавьте его в настройках и повторите сверку.`]);
    const changes = report.changed.flatMap(item => item.changes.filter(change => selected.some(([a, b]) => a === change.left_column && b === change.right_column)).map(change => ({item, change})));
    const lines = [`${label}: изменений в проверенных парах значений — ${changes.length}.`];
    if (!report.changed.length && !report.matched.length) lines.push('Общих позиций нет: значения между файлами не сравнивались.');
    else if (!changes.length) lines.push('В сопоставленных строках выбранные значения этого поля совпали по правилам сравнения.');
    lines.push(...changes.map(({item, change}) => changeLine(item, change)));
    if (report.only_left.length || report.only_right.length) lines.push(`Отдельно есть позиции без пары: только в A — ${report.only_left.length}, только в B — ${report.only_right.length}. Их значения между файлами не сравнивались.`);
    lines.push('Причины различий, правильность цен и фактическая поставка по этой сверке не устанавливаются.');
    return response(lines, changes.map(({item, change}) => action(item, 'changed', change.left_column)));
  }

  function membership(report, side) {
    const selected = side ? [side] : ['only_left', 'only_right'];
    const lines = ['Наличие проверено по выбранным ключам. «Только в A/B» означает отсутствие ключа в другом файле, а не установленный факт недопоставки.'];
    const actions = [];
    for (const category of selected) {
      const label = category === 'only_left' ? 'A' : 'B';
      lines.push(`Только в ${label}: ${report[category].length}.`);
      for (const item of report[category]) { lines.push(`• ${short(item.key)} — строка ${item.row.record} в ${label}.`); actions.push(action(item, category)); }
    }
    if (noOverlap(report)) lines.push('Общих позиций нет. Проверьте выбор ключей, прежде чем трактовать строки как добавленные или удалённые.');
    return response(lines, actions);
  }

  function lookup(report, key) {
    const found = entries(report).find(entry => entry.item.key === key);
    if (!found) return null;
    const {item, category} = found;
    const lines = [`Позиция ${short(item.key)}. ${category === 'matched' && !fields(report).length ? 'Ключ найден в обоих файлах' : title[category]}.`];
    if (category === 'only_left' || category === 'only_right') {
      const side = category === 'only_left' ? 'A' : 'B';
      lines.push(`Источник ${side}, строка ${item.row.record}. Пары в другом файле по выбранному ключу нет; сравнение значений для этой позиции не выполнено.`);
    } else {
      lines.push(`Исходные строки: A ${item.left.record}, B ${item.right.record}.`);
      if (!fields(report).length) lines.push('Проверялось только наличие ключа, значения столбцов не сравнивались.');
      for (const [a, b, mode] of fields(report)) {
        const before = item.left.values[a], after = item.right.values[b];
        const changed = (item.changes || []).some(change => change.left_column === a && change.right_column === b);
        lines.push(`• A ${short(a)} = ${short(before)}; B ${short(b)} = ${short(after)} — ${changed ? 'различаются' : 'совпали'} (${mode === 'number' ? 'сравнение как числа' : 'сравнение как текста'}).`);
        if (!changed && mode === 'number' && before !== after) lines.push('Написание чисел различается, но точное десятичное значение одинаково по выбранному правилу.');
      }
      lines.push('Остальные поля не оценивались на совпадение.');
    }
    return response(lines, [action(item, category)]);
  }

  function draftLetter(report) {
    const missing = unavailable(report); if (missing) return missing;
    if (report.kind === 'text') return draftTextLetter(report);
    const encoder = new TextEncoder(), parts = []; let size = 0;
    function append(line) {
      const text = line + '\n', bytes = encoder.encode(text).length;
      if (size + bytes > MAX_DRAFT_BYTES) throw new RangeError('draft_size');
      parts.push(text); size += bytes;
    }
    try {
      append('Здравствуйте!'); append('');
      append(`При сверке файлов A ${quote(report.sources.left.name)} и B ${quote(report.sources.right.name)} получены следующие результаты.`);
      append(counts(report));
      if (noOverlap(report)) append('По выбранным ключам общих позиций не найдено. Просьба сначала уточнить корректность ключей сопоставления.');
      if (!entries(report).length) append('В обоих файлах отсутствуют строки данных.');
      append(''); append('Правила выполненной проверки:');
      for (const line of ruleLines(report, false)) append(line);
      append(''); append('Ниже перечислены все обнаруженные различия по выбранным правилам.');
      for (const item of report.changed) for (const change of item.changes) append(changeLine(item, change, true));
      for (const [category, side, other] of [['only_left', 'A', 'B'], ['only_right', 'B', 'A']]) {
        for (const item of report[category]) append(`${quote(item.key)} — только в ${side}, строка ${item.row.record}; соответствующий ключ в ${other} не найден.`);
      }
      if (!report.changed.length && !report.only_left.length && !report.only_right.length) append('Различий по выбранным правилам не обнаружено.');
      append('');
      append(report.changed.length || report.only_left.length || report.only_right.length ? 'Просьба уточнить перечисленные различия и сообщить, какие данные следует использовать.' : 'Просьба подтвердить, что выбранных полей достаточно для поставленной задачи.');
      append('Эта сверка не устанавливает причины различий, корректность непроверенных полей или фактическое исполнение обязательств.');
      return response(['Черновик готов: он содержит все обнаруженные различия и правила текущей сверки. Проверьте адресата и текст перед отправкой. Письмо не отправлено.'], [], parts.join(''));
    } catch (error) {
      if (!(error instanceof RangeError) || error.message !== 'draft_size') throw error;
      return response(['Полный черновик превышает лимит 1 МиБ. Я не сформировала сокращённое письмо: скачайте полный HTML-отчёт и приложите его к сообщению.']);
    }
  }

  function answer(report, question) {
    const missing = unavailable(report); if (missing) return missing;
    if (report.kind === 'text') return answerText(report, question);
    if (typeof question !== 'string') return response(['Напишите вопрос о текущей сверке: цены, количество, отсутствующие позиции, правила сравнения или конкретный ключ.']);
    const direct = lookup(report, question) || lookup(report, question.trim());
    if (direct) return direct;
    const q = normalize(question);
    const keyRequest = question.trim().match(/^(?:покажи|найди|открой|расскажи про|что с|почему совпал[аи]?|почему изменил[ао]сь)\s+(?:(?:позици(?:ю|я|ей)|артикул|ключ)\s+)?(.+?)\??$/iu);
    if (keyRequest) {
      let key = keyRequest[1];
      if ((key.startsWith('«') && key.endsWith('»')) || (key.startsWith('"') && key.endsWith('"'))) key = key.slice(1, -1);
      const found = lookup(report, key); if (found) return found;
    }
    if (/письм|черновик/.test(q) && /(?:^|\s)(?:не|без)(?=\s)|отмен/.test(q)) return response(['Черновик не создаю. Можно продолжить обсуждение результатов сверки.']);
    if (/письм|черновик/.test(q) && /подготов|состав|напиш|сдела|черновик/.test(q)) return draftLetter(report);
    if (/почему.*(?:равн|совпал|одинаков|эквивалент)|как.*(?:сравнив|сопостав)|правил|что проверял/.test(q)) return explainRules(report);
    const fieldRequest = question.trim().match(/^(?:что с|проверял(?:ось|ась|ся|и) ли|сравнивал(?:ось|ась|ся|и) ли)\s+(?:полем |поле |столбцом |столбец )?(.+?)[?!.]*$/iu);
    if (fieldRequest) {
      const name = normalize(fieldRequest[1]);
      const mentioned = ['left', 'right'].flatMap(side => report.sources[side].headers.filter(header => normalize(header) === name).map(header => ({side, header})));
      if (mentioned.some(({side, header}) => report.rules?.key?.[side === 'left' ? 0 : 1] === header)) {
        return response(mentioned.map(({side, header}) => {
          const index = side === 'left' ? 0 : 1, label = index === 0 ? 'A' : 'B', other = index === 0 ? 'B' : 'A';
          if (report.rules.key[index] === header) return `В ${label} столбец ${short(header)} использован как ключ для сопоставления строк со столбцом ${short(report.rules.key[1 - index])} в ${other}. Отдельно добавлять его в сравниваемые поля не нужно.`;
          const mapping = fields(report).find(f => f[index] === header);
          if (mapping) return `В ${label} столбец ${short(header)} включён в сравнение значений со столбцом ${short(mapping[1 - index])} в ${other}; режим — ${mapping[2] === 'number' ? 'число' : 'текст'}.`;
          return `В ${label} столбец ${short(header)} не использован как ключ и не включён в сравниваемые поля. Его значения не проверялись на совпадение.`;
        }));
      }
      if (mentioned.length && mentioned.every(({side, header}) => !fields(report).some(f => f[side === 'left' ? 0 : 1] === header))) return response([`Поле ${short(fieldRequest[1])} не включено в правила текущей сверки. Его значения не проверялись на совпадение. Добавьте поле в настройках и повторите сверку.`]);
    }
    const kind = /цен|стоимост|\bprice\b/.test(q) ? 'price' : /количеств|\bqty\b|\bquantity\b/.test(q) ? 'quantity' : /единиц|\bunit\b/.test(q) ? 'unit' : null;
    const fieldIntent = /^(?:что|как) (?:с|по) (?:цен|количеств|единиц)/.test(q) || /^(?:где|какие|есть ли|покажи|проверь).*(?:измен|разниц|различ|совпа|отлич)/.test(q) || /^(?:покажи |проверь )?(?:цен[аыуе]|количество|единиц[аыуе](?: измерения)?)[?!. ]*$/.test(q);
    if (kind && !/прогноз|завтра|погод|анекдот|будет|ожида|через|совет/.test(q) && (fieldIntent || /почему|причин|винов|потер|убыт|правильн|справедлив/.test(q))) {
      if (/почему|причин|винов|потер|убыт|правильн|справедлив/.test(q)) return response(['Причины, виновника и денежные последствия по двум файлам установить нельзя. Я могу показать только различия в проверенных значениях.'], [{label: 'Открыть изменённые позиции', category: 'changed'}]);
      return changedFields(report, kind);
    }
    if (/^что не подтвердил поставщик[?!. ]*$/.test(q)) return membership(report, 'only_left');
    if (/только\s+(?:в\s+)?[aа](?=$|[\s?!.])|нет\s+(?:в\s+)?[bб](?=$|[\s?!.])/iu.test(q)) return membership(report, 'only_left');
    if (/только\s+(?:в\s+)?[bб](?=$|[\s?!.])|нет\s+(?:в\s+)?[aа](?=$|[\s?!.])/iu.test(q)) return membership(report, 'only_right');
    if (/отсутств|добавлен|удален|без пары|не хватает|не найден/.test(q)) return membership(report);
    if (/^(?:что изменилось|что поменялось|какие (?:есть )?(?:различия|изменения|расхождения)|итог|результат|сводка|что получилось|объясни (?:результат|сверку))[?.! ]*$/.test(q)) return describe(report);
    if (/^(?:покажи|найди|открой)\s+(?:позици(?:ю|я)|артикул|ключ)\s+/iu.test(question.trim())) return response(['Точного ключа с таким написанием в текущем отчёте не найдено. Скопируйте ключ из документа; регистр и ведущие нули имеют значение.']);
    return response(['Я отвечаю по результатам текущей сверки. Этот вопрос не удалось связать с поддерживаемой проверкой.', 'Можно спросить: «Что изменилось?», «Что с ценами?», «Что отсутствует?», «Почему совпали?», «Покажи [точный ключ]» или «Подготовь письмо». Для оценки содержания договора, доклада или книги эта версия пока не предназначена.']);
  }
  return Object.freeze({describe, answer, draftLetter});
});
