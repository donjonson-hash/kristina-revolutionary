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
  const title = {changed: "Checked fields have changes", only_left: "Only in A", only_right: "Only in B", matched: "Checked fields match"};
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const quote = value => JSON.stringify(String(value));
  const short = value => {
    const text = String(value);
    return text.length <= 240 ? quote(text) : quote(text.slice(0, 240)) + "… [value shortened; see the document for the full value]";
  };
  const normalize = value => String(value).trim().toLocaleLowerCase('en-US').replaceAll('ё', 'е');
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
  const action = (item, category, field) => ({label: `Open ${String(item.key).slice(0, 70)}${String(item.key).length > 70 ? '…' : ''}`, key: item.key, category, ...(field ? {field} : {})});

  function response(lines, actions = [], draft) {
    const kept = [];
    let size = 0, truncated = false;
    for (const line of lines) {
      if (size + line.length + 1 > MAX_TEXT - 500) { truncated = true; break; }
      kept.push(line); size += line.length + 1;
    }
    if (truncated) kept.push(`Response shortened: showing ${kept.length} of ${lines.length} blocks. The rest is available in the documents and the full HTML report.`);
    if (actions.length > MAX_ACTIONS) kept.push(`Navigation buttons: showing ${MAX_ACTIONS} of ${actions.length}. The remaining items are available in the documents and the full HTML report.`);
    return {text: kept.join('\n'), actions: actions.slice(0, MAX_ACTIONS), ...(draft === undefined ? {} : {draft})};
  }

  function unavailable(report) {
    if (!report || typeof report !== 'object') return response(["I'm the CTT assistant. Upload two CSV files, and after the comparison I can explain the differences and help draft a letter."]);
    if (report.status !== 'complete') return response([
      "The comparison is not complete yet. Matches and differences cannot be determined yet.",
      ...(Array.isArray(report.questions) && report.questions.length ? report.questions.map(q => short(q)) : ["Review the data or matching settings and run the comparison again."]),
    ]);
    return null;
  }

  function counts(report) {
    return `Changed: ${report.changed.length}; only in A: ${report.only_left.length}; only in B: ${report.only_right.length}; ${fields(report).length ? "matched on the checked fields" : "keys found in both files"}: ${report.matched.length}.`;
  }
  function sheetLines(report, compact = true) {
    const show = compact ? short : quote;
    return ['left', 'right'].flatMap((side, i) => report.sources[side].sheet ? [`${i ? 'B' : 'A'}: only sheet ${show(report.sources[side].sheet)} was checked. Other sheets and formatting were not checked.`] : []);
  }
  function ruleLines(report, compact = true) {
    const show = compact ? short : quote;
    const rules = report.rules || {}, selected = fields(report);
    const lines = [...sheetLines(report, compact), `Key matching: A ${show(rules.key?.[0] ?? '')} ↔ B ${show(rules.key?.[1] ?? '')}.`];
    if (!selected.length) lines.push("Only key presence was checked. Values in other columns were not compared.");
    else {
      lines.push("Checked fields:");
      for (const [a, b, mode] of selected) lines.push(`• A ${show(a)} ↔ B ${show(b)} — ${mode === 'number' ? "number" : "text"}.`);
      lines.push("Fields outside these rules were not checked for matches.");
    }
    lines.push(rules.strip ? "Leading and trailing spaces in values and keys were ignored." : "Leading and trailing spaces in values and keys were included in the comparison.");
    return lines;
  }
  function noOverlap(report) {
    return !report.changed.length && !report.matched.length && report.only_left.length && report.only_right.length;
  }


  const textCategories = [...categories, 'moved', 'reflow'];
  const structuralScope = "Moved text and line break changes are shown separately from text changes.";
  const originalBlocks = block => block ? (block.source_blocks?.length ? block.source_blocks : [block]) : [];
  const textTitle = {moved: "Moved without text changes", reflow: "Line breaks changed", changed: "Text changed", only_left: "Text only in A", only_right: "Text only in B", matched: "Text matches"};
  const textEntries = report => textCategories.flatMap(category => (report[category] || []).map(item => ({item, category}))).sort((a, b) => Number(a.item.key.slice(5)) - Number(b.item.key.slice(5)));
  const textScope = "The extracted text was compared. Legal meaning, factual accuracy, and spelling were not assessed.";
  function textNormalization(report) {
    return Object.values(report.sources).some(source => source.format === 'pdf')
      ? "Text is compared; formatting and images are not checked."
      : "Only line endings were normalized; spaces and letter case are included in the comparison.";
  }
  function textCounts(report) {
    return `Changed blocks: ${report.changed.length}; only in A: ${report.only_left.length}; only in B: ${report.only_right.length}; matched: ${report.matched.length}.` + (report.moved?.length ? ` Moved without text changes: ${report.moved.length}.` : '') + (report.reflow?.length ? ` Line breaks changed: ${report.reflow.length}.` : '');
  }
  function textSources(report, full = false) {
    const show = full ? quote : short, lines = [];
    for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
      const source = report.sources[side];
      lines.push(`${label} — ${show(source.name)}.`);
    }
    return lines;
  }
  function textLines(item, category, full = false) {
    const show = full ? quote : short;
    const lines = [`${textTitle[category]}.`];
    for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
      const block = item[side] || (category === `only_${side}` ? item.row : null);
      if (block) {
        for (const original of originalBlocks(block)) lines.push(`${label} · ${show(original.location)}: ${show(original.text)}`);
      }
      else lines.push(`${label}: no matching text block.`);
    }
    return lines;
  }
  function textSelection(found, heading) {
    if (!found.length) return response([heading, "No matching blocks were found in the current report."]);
    const lines = [heading];
    for (const {item, category} of found) lines.push(...textLines(item, category));
    return response(lines, found.map(({item, category}) => action(item, category)));
  }
  function describeText(report) {
    const lines = ["The text in the two files has been compared.", ...textSources(report), textCounts(report), "Text is compared; formatting and images are not checked."];
    if (report.moved?.length || report.reflow?.length) lines.push(structuralScope);
    if (!textEntries(report).length) lines.push("Neither file contains any extracted text blocks.");
    const changed = textEntries(report).filter(entry => entry.category !== 'matched');
    for (const {item, category} of changed.slice(0, 2)) lines.push(...textLines(item, category));
    if (changed.length > 2) lines.push(`Examples: showing 2 of ${changed.length} differences. The full text is available in the documents and HTML report.`);
    if (!changed.length && textEntries(report).length) lines.push("The text matches.");
    lines.push("You can open a block by number or phrase, show additions and deletions, or draft a letter.");
    return response(lines, textCategories.filter(category => report[category]?.length).map(category => ({label: `${textTitle[category]}: ${report[category].length}`, category})));
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
      append("Hello,"); append('');
      append(`Comparing the extracted text in file A ${quote(report.sources.left.name)} and file B ${quote(report.sources.right.name)} produced the following results.`);
      append(textCounts(report));
      append(''); append("All detected text differences are listed below.");
      for (const {item, category} of textEntries(report).filter(entry => entry.category !== 'matched')) {
        for (const line of textLines(item, category, true)) append(line);
      }
      if (!report.changed.length && !report.only_left.length && !report.only_right.length && !report.moved?.length && !report.reflow?.length) append("No text differences were found.");
      append(''); append("Please review the text differences listed above and clarify which version to use.");
      append(''); append("Text is compared; formatting and images are not checked.");
      return response(["The draft is ready. It lists all text differences without assessing their meaning. You can edit the text. The letter has not been sent."], [], parts.join(''));
    } catch (error) {
      if (!(error instanceof RangeError) || error.message !== 'draft_size') throw error;
      return response(["The full draft exceeds the 1 MiB limit. No shortened letter was created. Download the full HTML report and attach it to your message."]);
    }
  }
  function answerText(report, question) {
    if (typeof question !== 'string' || !question.trim()) return response(["You can ask: “What changed?”, “What was added?”, “What was deleted?”, “Show paragraph 3 in A”, “Find \"phrase\"”, or “Draft a letter”."]);
    const raw = question.trim(), q = normalize(raw), all = textEntries(report);
    let key = raw.match(/^(?:покажи|найди|открой|расскажи про|что с|show|find|open|tell me about|what about)\s+(?:(?:позици[яю]|блок|ключ|item|block|key)\s+)?(text-\d+)[?!.]*$/iu)?.[1] || raw;
    const direct = all.find(({item}) => item.key === key);
    if (direct) return textSelection([direct], "Text block from the current comparison:");
    if (/письм|черновик|\b(?:letter|email|draft)\b/.test(q) && /(?:^|\s)(?:не|без)(?=\s)|отмен|\b(?:no|not|never|without|cancel|stop)\b|\bdon[’\x27]t\b/.test(q)) return response(["No draft will be created. You can continue discussing the text differences."]);
    if (/письм|черновик|\b(?:letter|email|draft)\b/.test(q) && /подготов|состав|напиш|сдела|черновик|\b(?:prepare|compose|write|create|make|draft)\b/.test(q)) return draftTextLetter(report);
    const position = raw.match(/(?:абзац|строк[ауи]?|блок|позици[яю]|\b(?:paragraph|line|row|block|position))\s*[№#]?\s*(\d+)/iu);
    if (position) {
      const number = Number(position[1]);
      const sideMatch = raw.match(/(?:в|из|стороне|файле|документе|\b(?:in|from|on|side|file|document))\s+([abаб])(?=$|[\s?.!,])/iu) || raw.match(/^([abаб])\s*:/iu);
      const side = sideMatch ? (/^[aа]$/iu.test(sideMatch[1]) ? 'left' : 'right') : null;
      const found = all.filter(({item, category}) => (side ? [side] : ['left', 'right']).some(s => originalBlocks(item[s] || (category === `only_${s}` ? item.row : null)).some(block => block.record === number)));
      return textSelection(found, `Original position ${number}${side ? " in " + (side === 'left' ? 'A' : 'B') : " (searching A and B; numbers may refer to different pairs)"}.`);
    }
    const pageRequest = raw.match(/(?:страниц[аыуе]|стр\.|\bpage)\s*[№#]?\s*(\d+)/iu);
    if (pageRequest) {
      const number = Number(pageRequest[1]);
      const sideMatch = raw.match(/(?:в|из|стороне|файле|документе|\b(?:in|from|on|side|file|document))\s+([abаб])(?=$|[\s?.!,])/iu);
      const sides = sideMatch ? [/^[aа]$/iu.test(sideMatch[1]) ? 'left' : 'right'] : ['left', 'right'];
      const found = all.filter(({item, category}) => sides.some(side => originalBlocks(item[side] || (category === `only_${side}` ? item.row : null)).some(block => block.page === number)));
      return textSelection(found, `Original page ${number}${sideMatch ? " in " + (sides[0] === 'left' ? 'A' : 'B') : " (searching A and B)"}.`);
    }
    const phraseRequest = raw.match(/^(?:найди|покажи|где|что с|find|show|where is|what about)\s+(?:(?:фразу|фраза|текст|phrase|text)\s+)?(.+?)\??$/iu);
    if (phraseRequest) {
      let phrase = phraseRequest[1];
      if ((phrase.startsWith('«') && phrase.endsWith('»')) || (phrase.startsWith('"') && phrase.endsWith('"'))) phrase = phrase.slice(1, -1);
      const query = normalize(phrase);
      if (query) {
        const found = all.filter(({item, category}) => ['left', 'right'].some(side => {
          const block = item[side] || (category === `only_${side}` ? item.row : null);
          return block && normalize(block.text).includes(query);
        }));
        if (found.length || /[«"]/.test(phraseRequest[1])) return textSelection(found, `Searching for the phrase ${short(phrase)} in the extracted text (ignoring letter case and normalizing Russian letter variants).`);
      }
    }
    if (/юрид|законн|правомер|орфограф|пунктуац|граммат|достовер|факт|смысл|правильн|вычит|риск|обязательств|винов|причин|\b(?:legal|lawful|legality|spelling|punctuation|grammar|accuracy|facts?|meaning|correct|proofread|risks?|obligations?|blame|causes?)\b/.test(q)) return response([textScope, "I can show the exact text differences and their locations in the source documents."]);
    if (/почему.*(?:равн|совпал|одинаков)|как.*(?:сравнив|сопостав)|правил|что проверял|\bwhy\b.*\b(?:equal|match|same)\b|\bhow\b.*\b(?:compared?|matched?|comparison)\b|\brules?\b|\bwhat\b.*\bchecked\b/.test(q)) return response(["The extracted text of the blocks was compared. " + textNormalization(report) + " Highlighting shows changed text, without assessing its meaning." + (report.moved?.length || report.reflow?.length ? ' ' + structuralScope : ''), ...textSources(report), textScope]);
    if (/перемещ|перестав|порядок|\b(?:moved?|reordered?|order)\b/.test(q)) return textSelection(all.filter(entry => entry.category === 'moved'), "Moved without text changes:");
    if (/перенос|разбиени[ея] строк|\b(?:line breaks?|reflow|wrapping)\b/.test(q)) {
      const selected = textSelection(all.filter(entry => entry.category === 'reflow'), "Line breaks changed:");
      return response([structuralScope, selected.text], selected.actions);
    }
    if (/добав|только\s+(?:в\s+)?[bб](?=$|[\s?!.])|\b(?:added|additions?)\b|\bonly\s+(?:in\s+)?b\b/.test(q)) return textSelection(all.filter(entry => entry.category === 'only_right'), "Text blocks only in B:");
    if (/удал|только\s+(?:в\s+)?[aа](?=$|[\s?!.])|\b(?:deleted|removed|deletions?)\b|\bonly\s+(?:in\s+)?a\b/.test(q)) return textSelection(all.filter(entry => entry.category === 'only_left'), "Text blocks only in A:");
    if (/отсутств|без пары|\b(?:missing|unmatched)\b|\bwithout a match\b/.test(q)) return textSelection(all.filter(entry => entry.category === 'only_left' || entry.category === 'only_right'), "Text blocks without a match:");
    if (/^(?:что изменилось|что поменялось|какие (?:есть )?(?:различия|изменения|расхождения)|итог|результат|сводка|что получилось|объясни (?:результат|сверку)|what (?:has )?changed|what (?:are the )?(?:differences|changes)|summary|results?|summarize(?: the results)?|explain (?:the )?(?:results?|comparison))[?.! ]*$/.test(q)) return describeText(report);
    return response(["I couldn't match this question to a supported text comparison request.", "You can ask: “What changed?”, “What was added?”, “Show text-2”, “Show paragraph 3 in A”, “Find \"phrase\"”, or “Draft a letter”.", textScope]);
  }

  // Decimal amounts stay strings; never round through JavaScript floating point.
  function commercialMoney(value) {
    const text = String(value ?? '');
    const match = text.match(/^(-?)(\d+)(?:\.(\d+))?$/);
    if (!match) return text;
    return match[1] + match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (match[3] ? '.' + match[3] : '');
  }
  function commercialTotalLine(total) {
    const delta = String(total.delta), sign = delta.startsWith('-') || /^0(?:\.0+)?$/.test(delta) ? '' : '+';
    return `${total.currency}: A ${commercialMoney(total.before)} → B ${commercialMoney(total.after)}; change B − A: ${sign}${commercialMoney(delta)}.`;
  }
  function commercialLines(report) {
    const impact = report?.kind !== 'text' && report?.status === 'complete' && report?.commercial;
    if (!impact) return [];
    const coverage = impact.coverage;
    const lines = [impact.status === 'complete' ? `Calculation includes all items: ${coverage.included} of ${coverage.total}.` : impact.status === 'partial' ? `Partial calculation: ${coverage.included} of ${coverage.total} items; excluded: ${coverage.excluded}. This is not the total for the entire document.` : `Financial impact was not calculated: not enough comparable data (${coverage.excluded} items excluded).`];
    lines.push(...impact.totals.map(commercialTotalLine));
    if (impact.totals.length > 1) lines.push("Currencies are shown separately; no combined total in a single currency was calculated.");
    lines.push("Calculation: quantity × listed unit price. Tax, shipping, and other charges are not calculated separately; this is not an amount due.");
    lines.push(...impact.messages);
    return lines;
  }
  function commercialAnswer(report) {
    if (!commercialLines(report).length) return response(["Financial impact was not calculated for this comparison. I can show price and quantity changes and missing items."]);
    const impact = report.commercial, lines = commercialLines(report), actions = [];
    const changed = impact.items.filter(item => !/^0(?:\.0+)?$/.test(String(item.delta)));
    for (const item of changed.slice(0, 6)) {
      lines.push(`${short(item.key)} — ${commercialTotalLine(item)}`);
      actions.push(action(item, item.category));
    }
    if (changed.length > 6) lines.push(`Showing 6 of ${changed.length} financial changes; the rest are in the full HTML report.`);
    for (const item of impact.excluded.slice(0, 6)) {
      lines.push(`${short(item.key)} — excluded from the calculation: ${item.reasons.join(' ')}`);
      actions.push(action(item, item.category));
    }
    if (impact.excluded.length > 6) lines.push(`Showing 6 of ${impact.excluded.length} excluded items; the rest are in the full HTML report.`);
    return response(lines, actions);
  }

  function describe(report) {
    const missing = unavailable(report); if (missing) return missing;
    if (report.kind === 'text') return describeText(report);
    const lines = ["I'm the CTT assistant. The two files have been compared.",
      `A — ${short(report.sources.left.name)}; B — ${short(report.sources.right.name)}.`, counts(report)];
    lines.push(...commercialLines(report), ...sheetLines(report));
    if (!entries(report).length) lines.push("Neither file contains data rows, so there are no items to compare yet.");
    if (noOverlap(report)) lines.push("No items share the selected keys. First check that the keys in A and B refer to the same thing.");
    if (!fields(report).length) lines.push("Only key presence was checked. Values in other columns were not compared.");
    else lines.push("The selected fields were compared; other fields were not checked.");
    const allChanges = report.changed.flatMap(item => item.changes.map(change => ({item, change})));
    const names = [...new Set(allChanges.map(({change}) => change.left_column))];
    if (names.length) lines.push(`Changed fields: ${names.slice(0, 3).map(short).join(', ')}.${names.length > 3 ? ` Showing 3 of ${names.length}; the rest are in the documents and the full HTML report.` : ''}`);
    const examples = [];
    if (allChanges.length) examples.push(changeLine(allChanges[0].item, allChanges[0].change));
    if (report.only_left.length) examples.push(`${short(report.only_left[0].key)} — only in A.`);
    if (report.only_right.length) examples.push(`${short(report.only_right[0].key)} — only in B.`);
    for (let i = 1; i < allChanges.length && examples.length < 3; i++) examples.push(changeLine(allChanges[i].item, allChanges[i].change));
    const total = allChanges.length + report.only_left.length + report.only_right.length;
    lines.push(...examples);
    if (examples.length < total) lines.push(`Examples: showing ${examples.length} of ${total} differences. The rest are in the documents and the full HTML report.`);
    lines.push("I can explain differences, show an item, or draft a letter.");
    const actions = categories.filter(category => report[category].length).map(category => ({label: `${category === 'matched' && !fields(report).length ? "Keys found in both files" : title[category]}: ${report[category].length}`, category}));
    return response(lines, actions);
  }

  function explainRules(report) {
    const lines = [fields(report).length ? "A match applies only to the selected fields and comparison rules." : "This comparison checked only whether keys were present.", ...ruleLines(report)];
    if (fields(report).some(f => f[2] === 'number')) lines.push("Number mode compares exact decimal values: for example, 10 and 10.00 are equal. The original text is preserved in the documents.");
    if (fields(report).some(f => f[2] === 'text')) lines.push("Text mode compares characters, so 10 and 10.00 differ. Letter case matters.");
    if (noOverlap(report)) lines.push("There are no shared keys in this comparison, so no pairs of values were compared.");
    return response(lines, report.matched.length ? [{label: "Open matching items", category: 'matched'}] : []);
  }

  function changeLine(item, change, full = false) {
    const show = full ? quote : short;
    const reference = (row, column) => row.sheet ? `${show(row.sheet)}!${row.cells[column]}` : row.record;
    return `${show(item.key)}: A ${show(change.left_column)} = ${show(change.before)} → B ${show(change.right_column)} = ${show(change.after)} (rows A ${reference(item.left, change.left_column)}, B ${reference(item.right, change.right_column)}).`;
  }

  function changedFields(report, kind) {
    const selected = fields(report).filter(mapping => hasKind(mapping, kind));
    const label = {price: "Price", quantity: "Quantity", unit: "Unit"}[kind];
    if (!selected.length) return response([`${label}: this field is not included in the current comparison rules. I cannot determine whether it matches. Add it in the settings and run the comparison again.`]);
    const changes = report.changed.flatMap(item => item.changes.filter(change => selected.some(([a, b]) => a === change.left_column && b === change.right_column)).map(change => ({item, change})));
    const lines = [`${label}: changes in the checked pairs of values: ${changes.length}.`];
    if (!report.changed.length && !report.matched.length) lines.push("There are no shared items, so values were not compared between files.");
    else if (!changes.length) lines.push("The selected values of this field match in the paired rows under the comparison rules.");
    lines.push(...changes.map(({item, change}) => changeLine(item, change)));
    if (report.only_left.length || report.only_right.length) lines.push(`There are also unmatched items: only in A — ${report.only_left.length}, only in B — ${report.only_right.length}. Their values were not compared between files.`);
    lines.push("This comparison does not determine why differences occurred, whether prices are correct, or what was actually delivered.");
    return response(lines, changes.map(({item, change}) => action(item, 'changed', change.left_column)));
  }

  function membership(report, side) {
    const selected = side ? [side] : ['only_left', 'only_right'];
    const lines = ["Presence was checked using the selected keys. “Only in A/B” means the key is missing from the other file; it does not establish that a delivery was short."];
    const actions = [];
    for (const category of selected) {
      const label = category === 'only_left' ? 'A' : 'B';
      lines.push(`Only in ${label}: ${report[category].length}.`);
      for (const item of report[category]) { lines.push(`• ${short(item.key)} — row ${item.row.record} in ${label}.`); actions.push(action(item, category)); }
    }
    if (noOverlap(report)) lines.push("There are no shared items. Check the selected keys before interpreting rows as added or deleted.");
    return response(lines, actions);
  }

  function lookup(report, key) {
    const found = entries(report).find(entry => entry.item.key === key);
    if (!found) return null;
    const {item, category} = found;
    const lines = [`Item ${short(item.key)}. ${category === 'matched' && !fields(report).length ? "Key found in both files" : title[category]}.`];
    if (category === 'only_left' || category === 'only_right') {
      const side = category === 'only_left' ? 'A' : 'B';
      lines.push(`Source ${side}, row ${item.row.record}. The selected key has no match in the other file, so values for this item were not compared.`);
    } else {
      lines.push(`Source rows: A ${item.left.record}, B ${item.right.record}.`);
      if (!fields(report).length) lines.push("Only key presence was checked; column values were not compared.");
      for (const [a, b, mode] of fields(report)) {
        const before = item.left.values[a], after = item.right.values[b];
        const changed = (item.changes || []).some(change => change.left_column === a && change.right_column === b);
        lines.push(`• A ${short(a)} = ${short(before)}; B ${short(b)} = ${short(after)} — ${changed ? "differ" : "match"} (${mode === 'number' ? "compared as numbers" : "compared as text"}).`);
        if (!changed && mode === 'number' && before !== after) lines.push("The numbers are written differently, but their exact decimal values are equal under the selected rule.");
      }
      lines.push("Other fields were not checked for matches.");
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
      append("Hello,"); append('');
      append(`Comparing file A ${quote(report.sources.left.name)} and file B ${quote(report.sources.right.name)} produced the following results.`);
      append(counts(report));
      for (const line of commercialLines(report)) append(line);
      for (const item of report.commercial?.excluded || []) append(`${quote(item.key)} — excluded from the financial calculation: ${item.reasons.join(' ')}`);
      if (noOverlap(report)) append("No items with shared keys were found. Please first confirm that the matching keys are correct.");
      if (!entries(report).length) append("Neither file contains data rows.");
      append(''); append("All differences detected under the selected rules are listed below.");
      for (const item of report.changed) for (const change of item.changes) append(changeLine(item, change, true));
      for (const [category, side, other] of [['only_left', 'A', 'B'], ['only_right', 'B', 'A']]) {
        for (const item of report[category]) append(`${quote(item.key)} — only in ${side}, row ${item.row.record}; no matching key was found in ${other}.`);
      }
      if (!report.changed.length && !report.only_left.length && !report.only_right.length) append("No differences were found under the selected rules.");
      append('');
      append(report.changed.length || report.only_left.length || report.only_right.length ? "Please clarify the differences listed above and let us know which data to use." : "Please confirm that the selected fields are sufficient for the task.");
      append(''); append("Only the selected fields were compared.");
      for (const line of sheetLines(report, false)) append(line);
      return response(["The draft is ready and includes all detected differences. Review the recipient and text before sending. The letter has not been sent."], [], parts.join(''));
    } catch (error) {
      if (!(error instanceof RangeError) || error.message !== 'draft_size') throw error;
      return response(["The full draft exceeds the 1 MiB limit. No shortened letter was created. Download the full HTML report and attach it to your message."]);
    }
  }

  function answer(report, question) {
    const missing = unavailable(report); if (missing) return missing;
    if (report.kind === 'text') return answerText(report, question);
    if (typeof question !== 'string') return response(["Ask about the current comparison: prices, quantities, missing items, comparison rules, or a specific key."]);
    const direct = lookup(report, question) || lookup(report, question.trim());
    if (direct) return direct;
    const q = normalize(question);
    const keyRequest = question.trim().match(/^(?:покажи|найди|открой|расскажи про|что с|почему совпал[аи]?|почему изменил[ао]сь|show|find|open|tell me about|what about|why did)\s+(?:(?:позици(?:ю|я|ей)|артикул|ключ|item|sku|key)\s+)?(.+?)\??$/iu);
    if (keyRequest) {
      let key = keyRequest[1];
      if ((key.startsWith('«') && key.endsWith('»')) || (key.startsWith('"') && key.endsWith('"'))) key = key.slice(1, -1);
      const found = lookup(report, key); if (found) return found;
    }
    if (/письм|черновик|\b(?:letter|email|draft)\b/.test(q) && /(?:^|\s)(?:не|без)(?=\s)|отмен|\b(?:no|not|never|without|cancel|stop)\b|\bdon[’\x27]t\b/.test(q)) return response(["No draft will be created. You can continue discussing the comparison results."]);
    if (/письм|черновик|\b(?:letter|email|draft)\b/.test(q) && /подготов|состав|напиш|сдела|черновик|\b(?:prepare|compose|write|create|make|draft)\b/.test(q)) return draftLetter(report);
    if (/^(?:как изменилась сумма|что с суммой|влияние на сумму|покажи влияние на сумму|на сколько(?: (?:стало|стали|в b|в б|второй файл))? (?:дороже|дешевле)|на сколько изменилась сумма|how did (?:the )?total change|what (?:is|was) (?:the )?(?:financial impact|total change)|show (?:the )?financial impact|how much (?:more|less) expensive(?: is b)?)[?!. ]*$/.test(q)) return commercialAnswer(report);
    if (/почему.*(?:равн|совпал|одинаков|эквивалент)|как.*(?:сравнив|сопостав)|правил|что проверял|\bwhy\b.*\b(?:equal|match|same|equivalent)\b|\bhow\b.*\b(?:compared?|matched?|comparison)\b|\brules?\b|\bwhat\b.*\bchecked\b/.test(q)) return explainRules(report);
    const fieldRequest = question.trim().match(/^(?:что с|проверял(?:ось|ась|ся|и) ли|сравнивал(?:ось|ась|ся|и) ли|what about|was|did you (?:check|compare))\s+(?:полем |поле |столбцом |столбец |(?:the )?(?:field|column) )?(.+?)(?: (?:checked|compared))?[?!.]*$/iu);
    if (fieldRequest) {
      const name = normalize(fieldRequest[1]);
      const mentioned = ['left', 'right'].flatMap(side => report.sources[side].headers.filter(header => normalize(header) === name).map(header => ({side, header})));
      if (mentioned.some(({side, header}) => report.rules?.key?.[side === 'left' ? 0 : 1] === header)) {
        return response(mentioned.map(({side, header}) => {
          const index = side === 'left' ? 0 : 1, label = index === 0 ? 'A' : 'B', other = index === 0 ? 'B' : 'A';
          if (report.rules.key[index] === header) return `In ${label}, column ${short(header)} is used as the key for matching rows to column ${short(report.rules.key[1 - index])} in ${other}. It does not need to be added separately to the fields being compared.`;
          const mapping = fields(report).find(f => f[index] === header);
          if (mapping) return `In ${label}, column ${short(header)} is included in the value comparison with column ${short(mapping[1 - index])} in ${other}; mode: ${mapping[2] === 'number' ? "number" : "text"}.`;
          return `In ${label}, column ${short(header)} is neither a matching key nor a field selected for comparison. Its values were not checked for matches.`;
        }));
      }
      if (mentioned.length && mentioned.every(({side, header}) => !fields(report).some(f => f[side === 'left' ? 0 : 1] === header))) return response([`Field ${short(fieldRequest[1])} is not included in the current comparison rules. Its values were not checked for matches. Add the field in the settings and run the comparison again.`]);
    }
    const kind = /цен|стоимост|\b(?:prices?|costs?)\b/.test(q) ? 'price' : /количеств|\b(?:qty|quantity|quantities)\b/.test(q) ? 'quantity' : /единиц|\bunits?\b/.test(q) ? 'unit' : null;
    const fieldIntent = /^(?:что|как) (?:с|по) (?:цен|количеств|единиц)/.test(q) || /^(?:где|какие|есть ли|покажи|проверь).*(?:измен|разниц|различ|совпа|отлич)/.test(q) || /^(?:покажи |проверь )?(?:цен[аыуе]|количество|единиц[аыуе](?: измерения)?)[?!. ]*$/.test(q) || /^(?:(?:what|how) (?:about|are) (?:the )?|(?:where|what|which|are there|show|check)\b.*\b(?:chang(?:e|ed|es)|differences?|match(?:es)?|differ(?:ent)?)|(?:show |check )?(?:prices?|costs?|quantity|quantities|qty|units?)[?!. ]*$)/.test(q);
    if (kind && !/прогноз|завтра|погод|анекдот|будет|ожида|через|совет|\b(?:forecast|tomorrow|weather|joke|future|expect|advice|predict)\b/.test(q) && (fieldIntent || /почему|причин|винов|потер|убыт|правильн|справедлив|\b(?:why|causes?|reasons?|blame|loss(?:es)?|correct|fair)\b/.test(q))) {
      if (/почему|причин|винов|потер|убыт|правильн|справедлив|\b(?:why|causes?|reasons?|blame|loss(?:es)?|correct|fair)\b/.test(q)) return response(["Two files cannot establish the cause, who is responsible, or actual losses. I can show only differences in the checked values."], [{label: "Open changed items", category: 'changed'}]);
      return changedFields(report, kind);
    }
    if (/^(?:что не подтвердил поставщик|what did (?:the )?supplier not confirm)[?!. ]*$/.test(q)) return membership(report, 'only_left');
    if (/только\s+(?:в\s+)?[aа](?=$|[\s?!.])|нет\s+(?:в\s+)?[bб](?=$|[\s?!.])|\bonly\s+(?:in\s+)?a\b|\b(?:missing|not)\s+(?:in|from)\s+b\b/iu.test(q)) return membership(report, 'only_left');
    if (/только\s+(?:в\s+)?[bб](?=$|[\s?!.])|нет\s+(?:в\s+)?[aа](?=$|[\s?!.])|\bonly\s+(?:in\s+)?b\b|\b(?:missing|not)\s+(?:in|from)\s+a\b/iu.test(q)) return membership(report, 'only_right');
    if (/отсутств|добавлен|удален|без пары|не хватает|не найден|\b(?:missing|added|deleted|removed|unmatched)\b|\b(?:without a match|not found)\b/.test(q)) return membership(report);
    if (/^(?:что изменилось|что поменялось|какие (?:есть )?(?:различия|изменения|расхождения)|итог|результат|сводка|что получилось|объясни (?:результат|сверку)|what (?:has )?changed|what (?:are the )?(?:differences|changes)|summary|results?|summarize(?: the results)?|explain (?:the )?(?:results?|comparison))[?.! ]*$/.test(q)) return describe(report);
    if (/^(?:покажи|найди|открой|show|find|open)\s+(?:позици(?:ю|я)|артикул|ключ|item|sku|key)\s+/iu.test(question.trim())) return response(["No exact key with that spelling was found in the current report. Copy the key from the document; letter case and leading zeros matter."]);
    return response(["I answer questions about the current comparison. I couldn't match this question to a supported comparison request.", "You can ask: “What changed?”, “What about prices?”, “What is missing?”, “Why do they match?”, “Show [exact key]”, or “Draft a letter”. This version does not assess the content of contracts, reports, or books."]);
  }
  return Object.freeze({describe, answer, draftLetter, commercialLines, commercialMoney, commercialTotalLine});
});
