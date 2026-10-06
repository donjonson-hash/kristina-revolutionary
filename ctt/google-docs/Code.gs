/** @OnlyCurrentDoc */
// Bound Google Docs prototype. No URL fetch, LLM, or external document upload.
const CTT_LIMIT = 4000;
const CTT_TTL = 900;

function onOpen() {
  DocumentApp.getUi().createMenu('Compare These Texts')
    .addItem('Edit selected text', 'showEditor').addToUi();
}

function showEditor() {
  DocumentApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Compare These Texts'));
}

function cttAttributes_(attributes) {
  return Object.keys(attributes).sort().map(function (key) {
    const value = attributes[key];
    return [key, value === null ? null : String(value)];
  });
}

function cttBoundary_(text, offset) {
  return !(offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) &&
    /[\uDC00-\uDFFF]/.test(text.charAt(offset)));
}

function cttValidateText_(text, allowEmpty) {
  if (typeof text !== 'string' || text.length > CTT_LIMIT || (!allowEmpty && !text.length) ||
      /[\u0000-\u0008\u000A-\u001F\u007F\u2028\u2029]/.test(text) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
    throw new Error('Use one paragraph, up to 4,000 characters, without paragraph breaks or invalid characters.');
  }
}

function cttParagraph_(paragraph) {
  const types = DocumentApp.ElementType;
  if (paragraph.getType() !== types.PARAGRAPH ||
      paragraph.getParent().getType() !== types.BODY_SECTION ||
      paragraph.getNumChildren() !== 1 || paragraph.getChild(0).getType() !== types.TEXT) {
    throw new Error('Select ordinary body text in one paragraph. Tables, lists and inline objects are not supported yet.');
  }
  const text = paragraph.getChild(0).asText();
  const value = text.getText();
  if (value.length > 12000) throw new Error('This paragraph is too long for the prototype. Use a shorter paragraph.');
  const indices = text.getTextAttributeIndices();
  if (indices.length > 500) throw new Error('This paragraph has too many formatting runs for the prototype.');
  const runs = indices.map(function (offset) {
    if (text.getLinkUrl(offset)) throw new Error('Paragraphs containing hyperlinks are not supported yet.');
    return [offset, cttAttributes_(text.getAttributes(offset))];
  });
  return {text: text, value: value, signature: JSON.stringify({
    text: value, paragraph: cttAttributes_(paragraph.getAttributes()), runs: runs
  })};
}

// A body-position alone is ambiguous when identical paragraphs are inserted/removed.
// Retain only a digest of the surrounding body, never its text in the client/cache.
function cttBodyFingerprint_(body) {
  const count = body.getNumChildren();
  if (count > 1000) throw new Error('This document tab is too large for the prototype (maximum 1,000 body elements).');
  const value = body.getText();
  if (value.length > 200000) throw new Error('This document tab is too large for the prototype (maximum 200,000 characters).');
  const types = [];
  for (let i = 0; i < count; i++) types.push(String(body.getChild(i).getType()));
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify([value, types]), Utilities.Charset.UTF_8)
    .map(function (byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}

function loadSelection() {
  const doc = DocumentApp.getActiveDocument();
  const tab = doc.getActiveTab();
  const selection = doc.getSelection();
  if (!tab || !selection) throw new Error('Select text in one paragraph in Google Docs, then click Load selection.');
  const elements = selection.getRangeElements();
  if (elements.length !== 1 || elements[0].getElement().getType() !== DocumentApp.ElementType.TEXT) {
    throw new Error('Select one continuous passage within a single ordinary paragraph.');
  }
  const element = elements[0];
  const paragraph = element.getElement().getParent();
  const before = cttParagraph_(paragraph);
  const start = element.isPartial() ? element.getStartOffset() : 0;
  const end = element.isPartial() ? element.getEndOffsetInclusive() + 1 : before.value.length;
  if (start < 0 || end <= start || end > before.value.length ||
      !cttBoundary_(before.value, start) || !cttBoundary_(before.value, end)) {
    throw new Error('Select complete characters within one paragraph.');
  }
  const original = before.value.slice(start, end);
  cttValidateText_(original, false);
  const body = tab.asDocumentTab().getBody();
  const index = body.getChildIndex(paragraph);
  if (index < 0) throw new Error('Select text in the active document tab.');
  const bodyFingerprint = cttBodyFingerprint_(body);
  const token = Utilities.getUuid();
  const snapshot = JSON.stringify({docId: doc.getId(), tabId: tab.getId(), index: index, bodyFingerprint: bodyFingerprint,
    start: start, end: end, original: original, signature: before.signature, expires: Date.now() + CTT_TTL * 1000});
  // Cache entries are limited to 100 KB; leave ample room for UTF-8 encoding.
  if (Utilities.newBlob(snapshot).getBytes().length > 90000) {
    throw new Error('This paragraph is too complex for the prototype. Select a simpler paragraph.');
  }
  CacheService.getUserCache().put('ctt:' + token, snapshot, CTT_TTL);
  return {token: token, original: original, limit: CTT_LIMIT, expiresInSeconds: CTT_TTL};
}

// One minimal contiguous replacement; unchanged prefix/suffix are never rewritten.
function cttChange_(original, edited) {
  let start = 0;
  while (start < original.length && start < edited.length && original[start] === edited[start]) start++;
  while (!cttBoundary_(original, start) || !cttBoundary_(edited, start)) start--;
  let end = original.length, newEnd = edited.length;
  while (end > start && newEnd > start && original[end - 1] === edited[newEnd - 1]) { end--; newEnd--; }
  while (!cttBoundary_(original, end) || !cttBoundary_(edited, newEnd)) { end++; newEnd++; }
  return {start: start, end: end, replacement: edited.slice(start, newEnd)};
}

function applyEdit(token, edited) {
  cttValidateText_(edited, true);
  if (typeof token !== 'string' || !/^[a-zA-Z0-9-]{20,80}$/.test(token)) throw new Error('Load the selection again.');
  const lock = LockService.getDocumentLock();
  if (!lock || !lock.tryLock(5000)) throw new Error('Another edit is in progress. Try again.');
  let mutationStarted = false;
  try {
    const cache = CacheService.getUserCache();
    const saved = cache.get('ctt:' + token);
    if (!saved) throw new Error('The selection expired or was already applied. Load it again.');
    const snapshot = JSON.parse(saved);
    const doc = DocumentApp.getActiveDocument(), tab = doc.getActiveTab();
    if (snapshot.expires <= Date.now() || doc.getId() !== snapshot.docId || !tab || tab.getId() !== snapshot.tabId) {
      throw new Error('The document or active tab changed, or the selection expired. Load the selection again.');
    }
    const body = tab.asDocumentTab().getBody();
    if (cttBodyFingerprint_(body) !== snapshot.bodyFingerprint) {
      throw new Error('The document body changed. Load the selection again.');
    }
    if (snapshot.index >= body.getNumChildren()) throw new Error('The paragraph moved. Load the selection again.');
    const paragraph = body.getChild(snapshot.index);
    const before = cttParagraph_(paragraph);
    if (before.signature !== snapshot.signature) {
      throw new Error('The original paragraph or its formatting changed. Load the selection again.');
    }
    if (edited === snapshot.original) return {changed: false, message: 'No changes to apply.'};
    const change = cttChange_(snapshot.original, edited);
    const start = snapshot.start + change.start, end = snapshot.start + change.end;
    const sample = Math.min(start, snapshot.end - 1);
    const attributes = before.text.getAttributes(sample);
    const style = JSON.stringify(cttAttributes_(attributes));
    if (change.replacement && end > start) {
      const runs = before.text.getTextAttributeIndices().filter(function (offset) { return offset > start && offset < end; });
      if (runs.some(function (offset) { return JSON.stringify(cttAttributes_(before.text.getAttributes(offset))) !== style; })) {
        throw new Error('This replacement crosses different text formatting. Make a smaller edit within one formatted part.');
      }
    }
    // DocumentLock serializes this script, not collaborators. Recheck immediately before writes.
    if (cttBodyFingerprint_(body) !== snapshot.bodyFingerprint ||
        cttParagraph_(paragraph).signature !== snapshot.signature) throw new Error('The paragraph changed. Load the selection again.');
    cache.remove('ctt:' + token); // Consume before writes: a failed/ambiguous request must not be replayed.
    mutationStarted = true;
    // Insert first so replacing all text does not invalidate an empty Text element.
    if (change.replacement) {
      before.text.insertText(start, change.replacement);
      before.text.setAttributes(start, start + change.replacement.length - 1, attributes);
    }
    if (end > start) before.text.deleteText(start + change.replacement.length, end + change.replacement.length - 1);
    const expected = before.value.slice(0, snapshot.start) + edited + before.value.slice(snapshot.end);
    if (before.text.getText() !== expected) throw new Error('The final paragraph could not be verified.');
    return {changed: true, message: 'Changes applied to the document. Review the result in Google Docs.'};
  } catch (error) {
    if (mutationStarted) {
      throw new Error('The edit could not be completed or verified. Some changes may have been applied. Check the document and use Google Docs Undo or version history before loading again.');
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
