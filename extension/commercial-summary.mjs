/** Pure, offline commercial evidence. Values never pass through floating point. */
const MAX_DIGITS = 120;
const normalize = value => String(value ?? '').trim().toLowerCase();
const aliases = {
  quantity: ['quantity', 'qty', 'количество'],
  price: ['price', 'unit_price', 'unit price', 'цена', 'price_rub', 'цена_руб'],
  unit: ['unit', 'uom', 'единица', 'единица измерения', 'единица_измерения', 'ед. изм.'],
  currency: ['currency', 'валюта'],
  tax: ['tax', 'vat', 'ндс', 'tax_rate', 'vat_rate', 'ставка ндс', 'ставка_ндс'],
  tax_basis: ['tax_included', 'vat_included', 'ндс включен', 'ндс_включен', 'с ндс'],
  price_basis: ['price_basis', 'pricing_basis', 'price_per', 'цена за', 'цена_за'],
};
const kind = header => Object.keys(aliases).find(role => aliases[role].includes(normalize(header)));
const rubHeader = header => ['price_rub', 'цена_руб'].includes(normalize(header));
const zero = {n: 0n, scale: 0};
const pow = scale => 10n ** BigInt(scale);
const add = (a, b) => {
  const scale = Math.max(a.scale, b.scale);
  return {n: a.n * pow(scale - a.scale) + b.n * pow(scale - b.scale), scale};
};
const subtract = (a, b) => add(a, {n: -b.n, scale: b.scale});
const multiply = (a, b) => ({n: a.n * b.n, scale: a.scale + b.scale});
function decimal(value, trim) {
  if (typeof value !== 'string' || !value.length) return {error: 'значение отсутствует'};
  const raw = trim ? value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '') : value;
  if (raw.length > MAX_DIGITS + 2) return {error: `число длиннее ${MAX_DIGITS} цифр`};
  if (!/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(raw) || /[\r\n]$/.test(raw)) return {error: 'нужны десятичные цифры с точкой, без валюты и единиц'};
  const digits = raw.replace(/[+.-]/g, '');
  if (digits.length > MAX_DIGITS) return {error: `число длиннее ${MAX_DIGITS} цифр`};
  const n = BigInt(digits) * (raw[0] === '-' ? -1n : 1n);
  if (n < 0n) return {error: 'отрицательное значение не поддерживается'};
  return {n, scale: raw.includes('.') ? raw.length - raw.indexOf('.') - 1 : 0};
}
function format(value) {
  const negative = value.n < 0n, raw = (negative ? -value.n : value.n).toString().padStart(value.scale + 1, '0');
  const text = value.scale ? `${raw.slice(0, -value.scale)}.${raw.slice(-value.scale)}`.replace(/\.?0+$/, '') : raw;
  return (negative ? '-' : '') + text;
}
function unit(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 40 || !/^[\p{L}\p{N}. /_-]+$/u.test(raw)) return null;
  if (['pcs', 'pc', 'piece', 'pieces', 'шт', 'шт.', 'штука', 'штук', 'штуки'].includes(raw.toLowerCase())) return 'pcs';
  // Identically spelled explicit units are comparable; no conversions are inferred.
  return raw;
}
function currency(value) {
  const raw = normalize(value);
  if (['rub', 'руб', 'руб.', '₽'].includes(raw)) return 'RUB';
  if (['usd', 'доллар сша', 'доллары сша'].includes(raw)) return 'USD';
  if (['eur', 'евро', '€'].includes(raw)) return 'EUR';
  // An explicit three-letter currency code is retained, never converted or merged.
  return /^[a-z]{3}$/.test(raw) ? raw.toUpperCase() : null;
}
function findRole(headers, role) {
  const columns = headers.filter(header => kind(header) === role);
  return columns.length === 1 ? columns[0] : null;
}
function resolve(report) {
  const headers = ['left', 'right'].map(side => report.sources?.[side]?.headers || []);
  const roles = Object.fromEntries(Object.keys(aliases).map(role => [role, headers.map(h => findRole(h, role))]));
  // Explicit field selection can resolve duplicate semantic headers; two selected
  // price/quantity mappings remain ambiguous. Cross-role mappings never qualify.
  for (const role of ['quantity', 'price']) {
    const candidates = (report.rules?.fields || []).filter(field => field[2] === 'number' && kind(field[0]) === role && kind(field[1]) === role && headers.every((h, i) => h.includes(field[i])));
    roles[role] = candidates.length === 1 ? candidates[0].slice(0, 2) : [null, null];
  }
  const selected = role => roles[role].every(Boolean) && (report.rules?.fields || []).some(field => field[0] === roles[role][0] && field[1] === roles[role][1] && field[2] === 'number');
  const problems = [];
  for (const [role, label] of [['quantity', 'количество'], ['price', 'цена']]) {
    if (!selected(role)) problems.push(`Не выбраны однозначные столбцы «${label}» в числовом режиме.`);
  }
  for (const [role, label] of [['unit', 'единицы'], ['currency', 'валюты'], ['tax', 'НДС'], ['tax_basis', 'включение НДС'], ['price_basis', 'база цены']]) {
    if (headers.some(h => h.filter(header => kind(header) === role).length > 1)) problems.push(`Неоднозначные столбцы: ${label}.`);
  }
  const key = report.rules?.key || [];
  if (['quantity', 'price'].some(role => roles[role].some((column, i) => column && column === key[i]))) problems.push('Ключ строки совпадает со столбцом количества или цены.');
  return {roles, selected, problems};
}
function reference(row, index, roles, quantity, price) {
  if (!row) return null;
  const result = {record: row.record, quantity: format(quantity), price: format(price), quantity_column: roles.quantity[index], price_column: roles.price[index], unit_column: roles.unit[index], currency_column: roles.currency[index]};
  if (row.sheet !== undefined) result.sheet = row.sheet;
  if (row.cells) result.cells = Object.fromEntries(Object.values(roles).map(columns => columns[index]).filter(column => column && Object.hasOwn(row.cells, column)).map(column => [column, row.cells[column]]));
  return result;
}

/** Returns JSON-serializable evidence; no report mutation or source-value execution. */
export function buildCommercialSummary(report) {
  if (!report || report.kind === 'text' || report.status !== 'complete') return null;
  const {roles, selected, problems} = resolve(report);
  const paired = [...(report.matched || []), ...(report.changed || [])];
  const entries = [
    ...(report.matched || []).map(item => ({...item, category: 'matched'})),
    ...(report.changed || []).map(item => ({...item, category: 'changed'})),
    ...(report.only_left || []).map(item => ({key: item.key, left: item.row, right: null, category: 'only_left'})),
    ...(report.only_right || []).map(item => ({key: item.key, left: null, right: item.row, category: 'only_right'})),
  ];
  const counts = {paired: paired.length, price_changed: null, quantity_changed: null, only_left: (report.only_left || []).length, only_right: (report.only_right || []).length};
  for (const role of ['price', 'quantity']) {
    if (!paired.length || !selected(role) || roles[role].some((column, i) => column === report.rules?.key?.[i])) continue;
    let count = 0, valid = true;
    for (const item of paired) {
      const a = decimal(item.left.values[roles[role][0]], report.rules?.strip), b = decimal(item.right.values[roles[role][1]], report.rules?.strip);
      if (a.error || b.error) { valid = false; break; }
      if (subtract(a, b).n !== 0n) count++;
    }
    if (valid) counts[`${role}_changed`] = count;
  }
  if (!paired.length && counts.only_left && counts.only_right) problems.push('Нет общих ключей: подтвердите, что файлы относятся к одному списку.');
  const result = {
    schema_version: 1, status: 'unavailable',
    scope: 'Переход A → B: количество × указанная цена, отдельно по валютам. Это не сумма к оплате и не факт поставки; НДС, доставка и пересчёт единиц не рассчитываются.',
    counts, coverage: {total: entries.length, included: 0, excluded: 0}, totals: [], items: [], excluded: [], messages: [],
  };
  const totals = new Map();
  for (const item of entries) {
    const reasons = [...problems], sides = [item.left, item.right], values = [];
    sides.forEach((row, index) => {
      if (!row) { values.push(null); return; }
      const label = index ? 'B' : 'A';
      const q = decimal(row.values[roles.quantity[index]], report.rules?.strip), p = decimal(row.values[roles.price[index]], report.rules?.strip);
      if (selected('quantity') && q.error) reasons.push(`${label}, количество: ${q.error}.`);
      if (selected('price') && p.error) reasons.push(`${label}, цена: ${p.error}.`);
      const u = roles.unit[index] ? unit(row.values[roles.unit[index]]) : null;
      if (!u) reasons.push(`${label}: укажите единицу измерения в столбце unit/единица.`);
      const explicit = roles.currency[index] ? currency(row.values[roles.currency[index]]) : null;
      const inferred = rubHeader(roles.price[index]) ? 'RUB' : null;
      if (roles.currency[index] && !explicit) reasons.push(`${label}: валюта отсутствует или не распознана.`);
      if (explicit && inferred && explicit !== inferred) reasons.push(`${label}: валюта противоречит заголовку цены в рублях.`);
      const c = explicit || inferred;
      if (!c && !(roles.currency[index] && !explicit)) reasons.push(`${label}: укажите валюту в столбце currency/валюта или заголовке price_rub/цена_руб.`);
      const basis = roles.price_basis[index] ? normalize(row.values[roles.price_basis[index]]) : '';
      if (basis && !['1', 'per unit', 'за единицу'].includes(basis)) reasons.push(`${label}: база цены требует пересчёта. Укажите цену за одну единицу.`);
      values.push({q, p, u, c});
    });
    if (item.left && item.right) {
      if (values[0].u && values[1].u && values[0].u !== values[1].u) reasons.push('Единицы A и B различаются; пересчёт не выполняется.');
      if (values[0].c && values[1].c && values[0].c !== values[1].c) reasons.push('Валюты A и B различаются; конвертация не выполняется.');
      for (const [role, label] of [['tax', 'НДС'], ['tax_basis', 'Включение НДС'], ['price_basis', 'База цены']]) {
        if (!roles[role].some(Boolean)) continue;
        const a = roles[role][0] ? normalize(item.left.values[roles[role][0]]) : '', b = roles[role][1] ? normalize(item.right.values[roles[role][1]]) : '';
        if (a !== b) reasons.push(`${label}: условия A и B различаются или не указаны с одной стороны.`);
      }
    }
    if (reasons.length) { result.excluded.push({key: item.key, category: item.category, reasons: [...new Set(reasons)]}); continue; }
    const before = values[0] ? multiply(values[0].q, values[0].p) : zero;
    const after = values[1] ? multiply(values[1].q, values[1].p) : zero;
    const delta = subtract(after, before), existing = values[0] || values[1];
    const group = totals.get(existing.c) || {before: zero, after: zero};
    group.before = add(group.before, before); group.after = add(group.after, after); totals.set(existing.c, group);
    result.items.push({key: item.key, category: item.category, currency: existing.c, unit: existing.u, before: format(before), after: format(after), delta: format(delta), left: item.left ? reference(item.left, 0, roles, values[0].q, values[0].p) : null, right: item.right ? reference(item.right, 1, roles, values[1].q, values[1].p) : null});
  }
  result.coverage.included = result.items.length;
  result.coverage.excluded = result.excluded.length;
  result.totals = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, group]) => ({currency, before: format(group.before), after: format(group.after), delta: format(subtract(group.after, group.before))}));
  result.status = result.items.length ? (result.excluded.length ? 'partial' : 'complete') : 'unavailable';
  result.messages = [...problems];
  if (counts.only_left || counts.only_right) result.messages.push('Для позиции без пары ноль означает отсутствие вклада в сумму списка, а не нулевое количество или факт поставки.');
  if (result.status === 'partial') result.messages.push(`Расчёт частичный: включено ${result.items.length} из ${entries.length} позиций. Исключённые строки не входят в суммы.`);
  if (result.status === 'unavailable') result.messages.push(entries.length ? 'Денежное влияние не рассчитано. Уточните причины исключения строк.' : 'В файлах нет строк для расчёта.');
  if (result.status === 'complete') result.messages.push(`Расчёт охватывает все ${entries.length} позиций.`);
  if (result.totals.length > 1) result.messages.push('Итоги разных валют показаны отдельно и не складываются.');
  return result;
}
