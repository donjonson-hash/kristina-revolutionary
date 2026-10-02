/** Standalone, offline reconciliation exports. No DOM, network, or model calls. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

class ReportBuffer {
  constructor(format) { this.format = format; this.size = 0; this.chunks = []; }
  append(text) {
    // UTF-8 never takes fewer bytes than this string's UTF-16 code units.
    if (text.length > MAX_REPORT_BYTES - this.size) this.fail();
    const size = encoder.encode(text).byteLength;
    if (size > MAX_REPORT_BYTES - this.size) this.fail();
    this.size += size; this.chunks.push(text);
  }
  fail() { throw new RangeError(`${this.format} report exceeds 16 MiB; split the input lists`); }
  finish() { return this.chunks.join(''); }
}

/** Serialize incrementally: repeated long headers cannot allocate an unbounded report. */
export function renderJson(report) {
  const output = new ReportBuffer('JSON'), ancestors = new Set();
  function write(value, depth) {
    if (depth > 100) throw new TypeError('Report nesting is too deep');
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Report numbers must be finite');
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new TypeError('Report contains a non-JSON value');
      output.append(encoded); return;
    }
    if (ancestors.has(value)) throw new TypeError('Report contains a cycle');
    ancestors.add(value);
    const array = Array.isArray(value), entries = array ? value : Object.entries(value);
    output.append(array ? '[' : '{');
    for (let i = 0; i < entries.length; i++) {
      output.append((i ? ',\n' : '\n') + '  '.repeat(depth + 1));
      if (array) write(entries[i], depth + 1);
      else { output.append(JSON.stringify(entries[i][0]) + ': '); write(entries[i][1], depth + 1); }
    }
    if (entries.length) output.append('\n' + '  '.repeat(depth));
    output.append(array ? ']' : '}'); ancestors.delete(value);
  }
  write(report, 0); output.append('\n'); return output.finish();
}

const escape = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

function highlight(value, other) {
  // Code points prevent splitting an emoji's surrogate pair at a mark boundary.
  const a = Array.from(value), b = Array.from(other);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  const stop = a.length - end, middle = escape(a.slice(start, stop).join(''));
  return escape(a.slice(0, start).join('')) + (middle ? `<mark>${middle}</mark>` : '') + escape(a.slice(stop).join(''));
}

const STYLE = `.commercial{padding:20px;border:1px solid #d5dbd1;border-radius:8px;background:#fff}.commercial h2{margin-top:0}.commercial-table{overflow-x:auto}.commercial table{border-collapse:collapse;width:100%}.commercial th,.commercial td{text-align:left;padding:8px;border-bottom:1px solid #dde1da;overflow-wrap:anywhere}.commercial li{overflow-wrap:anywhere}*{box-sizing:border-box}body{font:16px/1.6 system-ui,sans-serif;color:#263b34;background:#f3f4ee;margin:0;padding:32px}main{max-width:1280px;margin:auto}h1{font-size:32px;line-height:1.2}h2{font-size:23px;margin-top:32px}h3{font-size:18px;margin:0 0 14px}p{margin:10px 0}.field-note{color:#59685f;font-size:12px;display:block}.totals{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}.totals div{background:#fff;padding:16px 20px;border:1px solid #d9dfd5;border-radius:10px;flex:1;min-width:150px}.totals strong{font-size:28px;display:block}.totals span{display:block}.pair{margin:22px 0;break-inside:avoid}.documents{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:stretch}.paper{background:#fff;border:1px solid #d5dbd1;border-radius:4px;padding:24px;min-width:0;box-shadow:0 3px 10px #24362708}.paper.removed{border-left:5px solid #b95c40}.paper.added{border-left:5px solid #388058}.paper header{font-weight:650;border-bottom:1px solid #dde1da;padding-bottom:12px;margin-bottom:14px}.paper dl{margin:16px 0 0}.field{padding:10px 12px;border-bottom:1px solid #eceee9}.field.changed{border-radius:4px}.left .field.changed{background:#fff3ee}.right .field.changed{background:#eef8f0}dt{font-size:13px;color:#52645a}dd{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.left mark{background:#ffd5c5;color:#672a17}.right mark{background:#c5ebce;color:#164c2b}mark{border-radius:2px;padding:1px 0}.empty{color:#67756d;font-style:italic}.paper.absent{display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(135deg,#f8f7f1,#f8f7f1 6px,#f0efe8 6px,#f0efe8 7px);min-height:120px}.badge{font-size:13px;font-weight:500;border:1px solid #ced8cd;border-radius:20px;padding:2px 9px;display:inline-block;margin-left:8px}summary{cursor:pointer}summary:focus-visible{outline:3px solid #6c93db;outline-offset:3px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e9ede5;padding:16px;border-radius:6px}.metadata{margin-top:28px;padding:20px;border:1px solid #d5dbd1;border-radius:8px}.source{margin:14px 0}.hash{font:12px/1.5 monospace;overflow-wrap:anywhere}h3,header,dt,.source{overflow-wrap:anywhere}.key{white-space:pre-wrap}@media(max-width:700px){body{padding:14px}.documents{grid-template-columns:1fr;gap:10px}.paper{padding:16px}h1{font-size:27px}}@media print{body{padding:0;background:#fff}.paper{box-shadow:none}.documents{gap:12px}.totals div{padding:10px}}`;
const LABELS = {changed: "Differences found", only_left: "Only in A", only_right: "Only in B", matched: "Selected fields match"};

// Render the same worker result used by the UI and letter; never recalculate money.
function commercialSection(summary, append) {
  if (!summary) return;
  const money = value => escape(value === null ? "not calculated" : String(value).replace('.', ','));
  const delta = value => money(value !== '0' && !value.startsWith('-') ? '+' + value : value);
  const labels = {complete: "All items calculated", partial: "Partial calculation", unavailable: "Amount not calculated"};
  append(`<section class="commercial"><h2>Quantity, price, and amount</h2><p><strong>${labels[summary.status]}</strong> · calculated for ${summary.coverage.included} of ${summary.coverage.total} items.</p>`);
  append(`<p>Quantity changes: ${summary.counts.quantity_changed ?? "not checked"}; price changes: ${summary.counts.price_changed ?? "not checked"}; only in A: ${summary.counts.only_left}; only in B: ${summary.counts.only_right}.</p>`);
  append(`<p>${escape(summary.scope)}</p>`);
  for (const total of summary.totals) append(`<p><strong>${escape(total.currency)}</strong>: A ${money(total.before)} → B ${money(total.after)}; change B − A: <strong>${delta(total.delta)}</strong>.${summary.status === 'partial' ? " Based on the calculated items, not the total for all items." : ''}</p>`);
  if (summary.messages.length) {
    append('<ul>');
    for (const message of summary.messages) append(`<li>${escape(message)}</li>`);
    append('</ul>');
  }
  if (summary.items.length) {
    append("<details><summary>Item calculations and source rows</summary><div class=\"commercial-table\"><table><thead><tr><th>Key / presence</th><th>Amount A</th><th>Amount B</th><th>B − A</th><th>Currency</th><th>Sources</th></tr></thead><tbody>");
    for (const item of summary.items) {
      const refs = ['left', 'right'].map((side, i) => {
        const ref = item[side];
        if (!ref) return `${i ? 'B' : 'A'}: item missing`;
        const cells = ref.cells ? Object.values(ref.cells).join(', ') : '';
        return `${i ? 'B' : 'A'}: ${ref.sheet ? ref.sheet + ', ' : ''}row ${ref.record}${cells ? ', ' + cells : ''}`;
      }).join('; ');
      append(`<tr><td>${escape(item.key)} · ${LABELS[item.category]}</td><td>${money(item.before)}</td><td>${money(item.after)}</td><td>${delta(item.delta)}</td><td>${escape(item.currency)}</td><td>${escape(refs)}</td></tr>`);
    }
    append("</tbody></table></div><p>For an unpaired item, the missing side contributes zero to the list total; this does not indicate the quantity of goods or whether they were delivered. Original quantity and price values appear in the documents below.</p></details>");
  }
  if (summary.excluded.length) {
    append("<details open><summary>Excluded from calculation</summary><ul>");
    for (const item of summary.excluded) append(`<li><strong>${escape(item.key)}</strong>: ${item.reasons.map(escape).join(' ')}</li>`);
    append('</ul></details>');
  }
  append('</section>');
}

export function renderHtml(report) {
  const output = new ReportBuffer('HTML'), complete = report.status === 'complete';
  const title = complete ? "Comparison complete" : "Clarification needed — comparison not performed";
  const append = text => output.append(text);
  append(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${title} — Compare These Texts</title><style>${STYLE}</style></head><body><main><h1>${title}</h1><p>Changes are highlighted: A on the left, B on the right.</p>`);
  append(`<p>A · ${escape(report.sources.left.name)}<br>B · ${escape(report.sources.right.name)}</p>`);
  if (!complete) {
    append("<h2>Clarifications</h2><ul>");
    for (const question of report.questions) append(`<li>${escape(question)}</li>`);
    append('</ul>');
  } else {
    commercialSection(report.commercial, append);
    append('<div class="totals">');
    for (const [key, label] of Object.entries(LABELS)) append(`<div><strong>${escape(report.summary[key])}</strong><span>${label}</span></div>`);
    append("</div><p>Selected fields are compared. The row number appears next to each item.</p>");
    if (report.summary.left_rows && report.summary.right_rows && !report.summary.matched && !report.summary.changed) append("<p><strong>No matching items.</strong> Check the keys: a lack of matched pairs does not mean the documents are identical.</p>");
    const checked = [0, 1].map(index => new Map((report.rules.fields || []).map(field => [field[index], field[2]])));
    function paper(row, side, changes, only) {
      const index = side === 'left' ? 0 : 1, label = index === 0 ? 'A' : 'B';
      append(`<article class="paper ${side}${!row ? ' absent' : only ? (index === 0 ? ' removed' : ' added') : ''}"><header>${label} · ${escape(report.sources[side].name)}</header>`);
      if (!row) { append("<p class=\"empty\">No record with this key.</p></article>"); return; }
      append(`<details open><summary>${row.sheet ? "Sheet «" + escape(row.sheet) + "» · row " : "Source record "}${escape(row.record)}</summary><dl>`);
      const changed = new Map(changes.map(change => [change[index === 0 ? 'left_column' : 'right_column'], change]));
      // Preserve original column order, including numeric and prototype-like names.
      for (const column of report.sources[side].headers) {
        const value = row.values[column], change = changed.get(column);
        append(`<div class="field${change ? ' changed' : ''}"><dt>${escape(column)}${row.cells?.[column] ? ' · ' + escape(row.cells[column]) : ''}</dt><dd>`);
        if (only || change?.mode === 'number') append(`<mark>${escape(value)}</mark>`);
        else append(change ? highlight(value, change[index === 0 ? 'after' : 'before']) : escape(value));
        append('</dd>');
        let note;
        if (only) note = `Only in ${label} — no paired record`;
        else if (change) note = `Different · value ${label}`;
        else if (column === report.rules.key[index]) note = "Matching key";
        else if (!checked[index].has(column)) note = "Not compared";
        else note = checked[index].get(column) === 'number' ? "Matches numerically" : "Matches under the comparison rule";
        if (value === '') note = "Empty value · " + note;
        append(`<span class="field-note">${note}</span></div>`);
      }
      append('</dl></details></article>');
    }
    const records = [];
    for (const category of Object.keys(LABELS)) for (const item of report[category]) records.push({item, category});
    const record = ({item, category}, side) => item[side]?.record ?? (category === `only_${side}` ? item.row.record : Infinity);
    records.sort((a, b) => {
      const leftA = record(a, 'left'), leftB = record(b, 'left');
      return leftA === leftB ? record(a, 'right') - record(b, 'right') : leftA - leftB;
    });
    append("<h2>Documents</h2>");
    if (!records.length) append("<p>Neither file contains data records.</p>");
    for (const {item, category} of records) {
      append(`<section class="pair ${category}"><h3>Key: <span class="key">${escape(item.key)}</span><span class="badge">${LABELS[category]}</span></h3><div class="documents">`);
      const only = category === 'only_left' || category === 'only_right';
      for (const side of ['left', 'right']) paper(only ? (category === `only_${side}` ? item.row : null) : item[side], side, item.changes || [], only);
      append('</div></section>');
    }
  }
  for (const [side, label] of [['left', 'A'], ['right', 'B']]) {
    const source = report.sources[side];
    if (source.sheet) append(`<p>${label}: checked only sheet «${escape(source.sheet)}».</p>`);
  }
  append('</main></body></html>');
  return output.finish();
}
