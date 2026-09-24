"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const MAX_FILE_BYTES = 2 * 1024 * 1024;
  const PAGE_SIZE = 25;
  const state = {sources: {left: null, right: null}, metadata: null, report: null, html: null,
    busy: false, revision: 0, filter: "changed", page: 0};
  const loads = {left: 0, right: 0};
  const selectColumns = new WeakMap();
  let controller = null;
  const categories = [
    ["changed", "Изменились", "Изменённые записи"],
    ["only_left", "Только в A", "Есть в исходном списке, нет во втором"],
    ["only_right", "Только в B", "Есть во втором списке, нет в исходном"],
    ["matched", "Совпали", "Совпали по выбранным полям"],
  ];

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function notice(message = "", error = false) {
    $("notice").textContent = message;
    $("notice").classList.toggle("error", error);
    $("notice").hidden = !message;
  }

  function busy(value) {
    state.busy = value;
    for (const id of ["demo", "left-file", "right-file", "delimiter", "compare"]) $(id).disabled = value;
    $("rules").disabled = value || !state.metadata;
    $("compare").textContent = value ? "Обрабатываю…" : "Сверить списки →";
  }

  function clearResult() {
    state.revision += 1;
    if (controller) controller.abort();
    state.report = null;
    state.html = null;
    $("results").hidden = true;
    $("result-rows").replaceChildren();
    $("step-result").classList.remove("current");
    $("step-rules").classList.toggle("current", !!state.metadata);
  }

  function delimiter() { return $("delimiter").value === "tab" ? "\t" : $("delimiter").value; }

  function encode(bytes) {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(text);
  }

  async function api(path, payload) {
    controller = new AbortController();
    const response = await fetch(path, {method: "POST", signal: controller.signal,
      headers: {"Content-Type": "application/json", "X-Kristina-Reconcile": "1"}, body: JSON.stringify(payload)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось выполнить запрос.");
    return result;
  }

  function payload() { return {...state.sources, delimiter: delimiter()}; }

  function sourceLabel(side, file) {
    $(side + "-filename").textContent = file ? file.name : "Выберите файл или перетащите сюда";
    $(side + "-meta").textContent = file ? "Файл выбран · нажмите, чтобы заменить" : "CSV · UTF-8 · до 2 MiB";
    $(side + "-preview").replaceChildren();
    $(side + "-preview").hidden = true;
  }

  function preview(side, metadata) {
    $(side + "-meta").textContent = `${metadata.row_count} строк · ${metadata.headers.length} столбцов · нажмите, чтобы заменить`;
    const wrap = $(side + "-preview");
    const table = element("table");
    table.append(element("caption", "Предпросмотр первых строк"));
    const thead = element("thead");
    const header = element("tr");
    for (const name of metadata.headers) header.append(element("th", name.length > 80 ? name.slice(0, 80) + "…" : name));
    thead.append(header);
    table.append(thead);
    const body = element("tbody");
    for (const row of metadata.preview) {
      const tr = element("tr");
      for (const name of metadata.headers) {
        const raw = row.values[name];
        tr.append(element("td", raw.length > 160 ? raw.slice(0, 160) + "…" : raw));
      }
      body.append(tr);
    }
    table.append(body);
    wrap.replaceChildren(table);
    wrap.hidden = false;
  }

  function options(select, names, placeholder) {
    selectColumns.set(select, names);
    select.replaceChildren(new Option(placeholder, ""));
    names.forEach((name, index) => {
      // Never repeat arbitrarily long headers in every option's label/value.
      const label = name.length > 80 ? name.slice(0, 80) + `… [${index + 1}]` : name;
      select.add(new Option(label, String(index)));
    });
  }

  function selectedColumn(select) {
    return select.value === "" ? "" : selectColumns.get(select)[Number(select.value)];
  }

  function chooseColumn(select, name) {
    const index = selectColumns.get(select).indexOf(name);
    select.value = index < 0 ? "" : String(index);
  }

  function mapping() {
    if (!state.metadata) return;
    const body = $("field-mapping");
    body.replaceChildren();
    const leftKey = selectedColumn($("left-key"));
    const rightKey = selectedColumn($("right-key"));
    for (const name of state.metadata.left.headers.filter((n) => n !== leftKey)) {
      const row = element("tr");
      row.dataset.left = name;
      row.append(element("td", name));
      const targetCell = element("td");
      const target = element("select");
      target.className = "field-target";
      target.setAttribute("aria-label", `Столбец B для ${name}`);
      const available = state.metadata.right.headers.filter((n) => n !== rightKey);
      options(target, available, "Не сравнивать");
      chooseColumn(target, name);
      targetCell.append(target);
      const modeCell = element("td");
      const mode = element("select");
      mode.className = "field-mode";
      mode.setAttribute("aria-label", `Режим для ${name}`);
      mode.add(new Option("Текст — точное совпадение", "text"));
      mode.add(new Option("Число — десятичное с точкой", "number"));
      mode.disabled = !target.value;
      target.addEventListener("change", () => { mode.disabled = !target.value; clearResult(); });
      mode.addEventListener("change", clearResult);
      modeCell.append(mode);
      row.append(targetCell, modeCell);
      body.append(row);
    }
  }

  async function inspect(useDemoRules = false) {
    clearResult();
    state.metadata = null;
    $("rules").hidden = true;
    $("rules").disabled = true;
    $("rules-empty").hidden = false;
    if (!state.sources.left || !state.sources.right) {
      $("rules-empty").textContent = "Добавьте оба списка — здесь появятся их столбцы.";
      notice();
      return;
    }
    busy(true);
    notice("Читаю таблицы и проверяю структуру…");
    const revision = state.revision;
    try {
      const metadata = await api("/api/inspect", payload());
      if (revision !== state.revision) return;
      state.metadata = metadata;
      for (const side of ["left", "right"]) {
        preview(side, metadata[side]);
        options($(side + "-key"), metadata[side].headers, "Выберите ключевой столбец");
      }
      $("membership").checked = false;
      $("strip").checked = false;
      $("mapping-panel").hidden = false;
      if (useDemoRules) {
        chooseColumn($("left-key"), "sku");
        chooseColumn($("right-key"), "sku");
      }
      mapping();
      if (useDemoRules) {
        for (const row of $("field-mapping").rows) {
          if (row.dataset.left === "quantity") row.querySelector(".field-mode").value = "number";
        }
      }
      $("rules").hidden = false;
      $("rules-empty").hidden = true;
      $("step-rules").classList.add("current");
      notice(useDemoRules ? "Пример загружен. Сопоставляем по артикулу sku, количество — как число, единицы — как текст. Нажмите «Сверить списки»." : "Таблицы прочитаны. Выберите ключ и проверьте соответствие столбцов.");
    } catch (error) {
      if (error.name !== "AbortError") {
        notice("Не удалось прочитать таблицы. " + error.message, true);
        $("rules-empty").textContent = "Проверьте формат файлов и разделитель CSV, затем загрузите исправленные данные.";
      }
    } finally { if (revision === state.revision) busy(false); }
  }

  async function loadFile(side, file) {
    if (!file || state.busy) return;
    const version = ++loads[side];
    clearResult();
    state.metadata = null;
    state.sources[side] = null;
    $("rules").hidden = true;
    $("rules").disabled = true;
    $("rules-empty").hidden = false;
    sourceLabel(side, null);
    if (file.size > MAX_FILE_BYTES) {
      notice("Файл превышает 2 MiB. Выберите меньший CSV.", true);
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (version !== loads[side]) return;
      state.sources[side] = {name: file.name, data: encode(bytes)};
      sourceLabel(side, file);
      await inspect();
    } catch (error) { notice("Не удалось открыть файл. " + error.message, true); }
  }

  function selectedRules() {
    const key = [selectedColumn($("left-key")), selectedColumn($("right-key"))];
    if (key.some((value) => !value)) throw new Error("Выберите ключевой столбец в каждом списке.");
    const fields = [];
    const used = new Set();
    if (!$("membership").checked) {
      for (const row of $("field-mapping").rows) {
        const right = selectedColumn(row.querySelector(".field-target"));
        if (!right) continue;
        if (used.has(right)) throw new Error("Столбец B «" + right + "» выбран несколько раз. Каждому столбцу нужна одна пара.");
        used.add(right);
        fields.push([row.dataset.left, right, row.querySelector(".field-mode").value]);
      }
      if (!fields.length) throw new Error("Выберите хотя бы одну пару столбцов или включите сравнение только наличия строк.");
    }
    return {key, fields, strip: $("strip").checked};
  }

  async function compare() {
    if (state.busy || !state.metadata) return;
    let rules;
    try { rules = selectedRules(); } catch (error) { notice(error.message, true); return; }
    clearResult();
    busy(true);
    const revision = state.revision;
    notice("Сверяю выбранные столбцы…");
    try {
      const result = await api("/api/compare", {...payload(), ...rules});
      if (revision !== state.revision) return;
      state.report = result.report;
      state.html = result.html;
      renderResult();
      notice();
      $("result-heading").focus({preventScroll: true});
      $("results").scrollIntoView({behavior: "smooth", block: "start"});
    } catch (error) { if (error.name !== "AbortError") notice("Сверка не выполнена. " + error.message, true); }
    finally { if (revision === state.revision) busy(false); }
  }

  function renderResult() {
    const report = state.report;
    $("results").hidden = false;
    $("step-result").classList.add("current");
    $("result-heading").textContent = report.status === "complete" ? "Сверка завершена" : "Нужно уточнить данные";
    $("result-context").textContent = `A: ${report.sources.left.name} · B: ${report.sources.right.name}`;
    $("audit-details").textContent = JSON.stringify({sources: report.sources, rules: report.rules}, null, 2);
    $("complete-result").hidden = report.status !== "complete";
    $("clarification").hidden = report.status === "complete";
    $("search").value = "";
    if (report.status !== "complete") {
      const box = $("clarification");
      box.replaceChildren(element("h3", "Сравнение не выполнено — частичных итогов нет"), element("p", "Исправьте отмеченные данные и загрузите файлы повторно. Правила можно изменить выше."));
      const list = element("ul");
      for (const question of report.questions) list.append(element("li", question));
      box.append(list);
      const details = element("details");
      details.append(element("summary", "Подробности замечаний"), element("pre", JSON.stringify(report.issues, null, 2), "raw"));
      box.append(details);
      return;
    }
    state.filter = categories.find(([key]) => report[key].length)?.[0] || "matched";
    state.page = 0;
    $("totals").replaceChildren();
    for (const [key, label] of categories) {
      const button = element("button", undefined, "total");
      button.type = "button";
      button.dataset.category = key;
      button.append(element("strong", report.summary[key]), element("span", label));
      button.addEventListener("click", () => { state.filter = key; state.page = 0; renderRows(); });
      $("totals").append(button);
    }
    renderRows();
  }

  function evidence(item) {
    const details = element("details", undefined, "evidence");
    details.append(element("summary", "Проверить исходные строки"));
    let populated = false;
    details.addEventListener("toggle", () => {
      if (!details.open || populated) return;
      populated = true;
      const grid = element("div", undefined, "evidence-grid");
      const rows = item.row ? [[state.filter === "only_left" ? "A" : "B", item.row]] : [["A", item.left], ["B", item.right]];
      for (const [side, row] of rows) {
        const column = element("div");
        column.append(element("h4", `${side} · исходная запись ${row.record} (заголовок — запись 1)`), element("pre", JSON.stringify(row.values, null, 2)));
        grid.append(column);
      }
      details.append(grid);
    });
    return details;
  }

  function renderRows() {
    if (!state.report || state.report.status !== "complete") return;
    for (const button of $("totals").children) button.setAttribute("aria-pressed", String(button.dataset.category === state.filter));
    $("category-heading").textContent = categories.find(([key]) => key === state.filter)[2];
    const query = $("search").value.toLocaleLowerCase();
    const records = state.report[state.filter].filter((item) => item.key.toLocaleLowerCase().includes(query));
    const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const start = state.page * PAGE_SIZE;
    $("record-range").textContent = records.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, records.length)} из ${records.length} записей` : "0 записей";
    const root = $("result-rows");
    root.replaceChildren();
    for (const item of records.slice(start, start + PAGE_SIZE)) {
      const card = element("article", undefined, "result-record");
      const header = element("div", undefined, "record-header");
      header.append(element("strong", item.key), element("span", item.changes ? `${item.changes.length} изм.` : "Исходные данные"));
      card.append(header);
      if (item.changes) {
        const table = element("table", undefined, "changes");
        const thead = element("thead");
        const tr = element("tr");
        for (const name of ["Поле A → B", "Было · A", "Стало · B"]) tr.append(element("th", name));
        thead.append(tr);
        const body = element("tbody");
        for (const change of item.changes) {
          const row = element("tr");
          row.append(element("td", change.left_column === change.right_column ? change.left_column : `${change.left_column} → ${change.right_column}`), element("td", change.before, "raw before"), element("td", change.after, "raw after"));
          body.append(row);
        }
        table.append(thead, body);
        card.append(table);
      }
      card.append(evidence(item));
      root.append(card);
    }
    if (!records.length) root.append(element("p", query ? "По этому ключу ничего не найдено." : "В этой категории записей нет.", "zero-state"));
    $("page-info").textContent = `Страница ${state.page + 1} из ${pages}`;
    $("previous").disabled = state.page === 0;
    $("next").disabled = state.page >= pages - 1;
  }

  function download(format) {
    if (!state.report) return;
    const html = format === "html";
    const content = html ? state.html : JSON.stringify(state.report, null, 2) + "\n";
    const url = URL.createObjectURL(new Blob([content], {type: html ? "text/html;charset=utf-8" : "application/json;charset=utf-8"}));
    const link = element("a");
    link.href = url;
    link.download = "kristina-reconciliation." + format;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  for (const side of ["left", "right"]) {
    $(side + "-file").addEventListener("change", (event) => loadFile(side, event.target.files[0]));
    const zone = $(side + "-drop");
    zone.addEventListener("dragover", (event) => { event.preventDefault(); if (!state.busy) zone.classList.add("dragging"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
    zone.addEventListener("drop", (event) => { event.preventDefault(); zone.classList.remove("dragging"); loadFile(side, event.dataTransfer.files[0]); });
    $(side + "-key").addEventListener("change", () => { clearResult(); mapping(); });
  }
  $("demo").addEventListener("click", async () => {
    if (state.busy) return;
    loads.left += 1; loads.right += 1;
    const examples = {
      left: ["order.csv", "sku,quantity,unit\nCH-100,10,piece\nDS-200,5,piece\nLP-300,2,piece\nOLD-400,1,piece\n"],
      right: ["confirmation.csv", "sku,quantity,unit\nCH-100,10.00,piece\nDS-200,4,piece\nLP-300,2,box\nNEW-500,1,piece\n"],
    };
    $("delimiter").value = ",";
    for (const side of ["left", "right"]) {
      const [name, text] = examples[side];
      state.sources[side] = {name, data: encode(new TextEncoder().encode(text))};
      $(side + "-file").value = "";
      sourceLabel(side, {name});
    }
    await inspect(true);
    if (state.metadata) $("rules-heading").scrollIntoView({behavior: "smooth", block: "start"});
  });
  $("delimiter").addEventListener("change", () => inspect());
  $("membership").addEventListener("change", () => { clearResult(); $("mapping-panel").hidden = $("membership").checked; });
  $("strip").addEventListener("change", clearResult);
  $("compare").addEventListener("click", compare);
  $("search").addEventListener("input", () => { state.page = 0; renderRows(); });
  $("previous").addEventListener("click", () => { state.page -= 1; renderRows(); });
  $("next").addEventListener("click", () => { state.page += 1; renderRows(); });
  $("download-html").addEventListener("click", () => download("html"));
  $("download-json").addEventListener("click", () => download("json"));
})();
