// Literal evidence from current, already aligned text blocks. No inferred prices,
// currencies, dates, financial totals or semantic matching.
const currency = '(?:USD|EUR|GBP|RUB|[$€£₽])';
const number = '[+−-]?[0-9]+(?:[.,][0-9]+|[ \\u00a0\\u202f][0-9]{3}(?![0-9]))*';
const spacing = '[ \\t\\u00a0\\u202f]{0,12}';
// Scan number runs once, independently of whether a unit follows. Requiring a
// suffix inside the global regex would repeatedly scan long unmarked numbers.
const numberPattern = new RegExp(number, 'gu');
const prefixPattern = new RegExp(`[+−-]?${currency}${spacing}$`, 'iu');
const suffixPattern = new RegExp(`^${spacing}(?:${currency}|%)`, 'iu');
const compact = text => text.replace(/\s+/gu, ' ').trim();
const identity = token => token.raw.replace(/[ \t\u00a0\u202f]/gu, '').replace(/−/gu, '-').toUpperCase();

export function extractNumberTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(numberPattern)) {
    const numberStart = match.index, numberEnd = numberStart + match[0].length;
    const prefix = text.slice(Math.max(0, numberStart - 20), numberStart).match(prefixPattern);
    const suffix = text.slice(numberEnd, numberEnd + 20).match(suffixPattern);
    if ((!prefix && !suffix) || (prefix && suffix)) continue;
    const start = numberStart - (prefix?.[0].length ?? 0), end = numberEnd + (suffix?.[0].length ?? 0);
    // Do not extract fragments of identifiers, scientific notation or currencies
    // such as CAD$ and US$ that this first version does not interpret.
    if (/[\p{L}\p{N}_.,+−$€£₽-]/u.test(text[start - 1] || '') || /[\p{L}\p{N}_%$€£₽]/u.test(text[end] || '')) continue;
    if (/^[.,][0-9.,]/u.test(text.slice(end, end + 2))) continue;
    const raw = text.slice(start, end), unit = (prefix?.[0] ?? suffix[0]).match(/USD|EUR|GBP|RUB|[$€£₽%]/iu)[0].toUpperCase();
    tokens.push({raw, start, end, unit, kind: unit === '%' ? 'percentage' : 'amount'});
  }
  return tokens;
}

function skeleton(text, tokens) {
  const parts = []; let offset = 0;
  for (const token of tokens) {
    parts.push(text.slice(offset, token.start), `\uFFFC${token.unit}\uFFFC`);
    offset = token.end;
  }
  parts.push(text.slice(offset));
  return compact(parts.join(''));
}

export function numberExcerpt(text, token, limit = 180) {
  if (text === null) return 'No text in this version.';
  const start = Math.max(0, (token?.start ?? 0) - 65);
  const end = Math.min(text.length, start + limit);
  return (start ? '…' : '') + compact(text.slice(start, end)) + (end < text.length ? '…' : '');
}

/** Each result is one passage, with exact token offsets into its current text. */
export function findNumberChanges(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.left === block.right) continue;
    const before = extractNumberTokens(block.left ?? ''), after = extractNumberTokens(block.right ?? '');
    if (JSON.stringify(before.map(identity)) === JSON.stringify(after.map(identity))) continue;
    const paired = before.length === after.length && before.length > 0 &&
      skeleton(block.left, before) === skeleton(block.right, after);
    const pairs = paired ? before.flatMap((token, i) => identity(token) === identity(after[i]) ? [] : [{before: token, after: after[i]}]) : [];
    let first = 0;
    while (first < before.length && first < after.length && identity(before[first]) === identity(after[first])) first++;
    result.push({
      ...block, before, after, pairs,
      focusBefore: pairs[0]?.before ?? before[first] ?? before.at(-1),
      focusAfter: pairs[0]?.after ?? after[first] ?? after.at(-1),
      mode: paired ? 'paired' : block.left === null ? 'added' : block.right === null ? 'removed' : 'context',
      signature: JSON.stringify([block.left, block.right]),
    });
  }
  return result;
}
