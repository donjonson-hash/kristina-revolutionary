/** Bounded TXT, plain-paragraph DOCX and PDF text-layer extraction, offline. */
import {DOMParser} from './xml-vendor.mjs';
import {unzipDocument} from './text-zip.mjs';
export const MAX_TEXT_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_CHARS = 500000;
export const MAX_TEXT_BLOCKS = 2000;
const W = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const decode = raw => new TextDecoder('utf-8', {fatal: true}).decode(raw);
const fail = message => { throw new Error(message); };
const normalizeLines = text => text.replace(/\r\n?/g, '\n');
const elements = node => Array.from(node.childNodes || []).filter(child => child.nodeType === 1);
const w = (node, local) => W.has(node.namespaceURI) && node.localName === local;
const standardNotes = ['Сравнивается извлечённый текст. Оформление, шрифты, разбиение на страницы и юридический смысл не оцениваются.', 'Регистр, пробелы и Unicode сохраняются; CRLF и CR приведены к LF.'];

function parseXml(raw, name) {
  let text;
  try { text = decode(raw); } catch { fail(`${name}: ожидается XML в UTF-8.`); }
  if (text.length > 8 * 1024 * 1024) fail(`${name}: XML превышает 8 МиБ.`);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) fail(`${name}: DTD и пользовательские XML-сущности не поддерживаются.`);
  let markers = 0, cursor = -1;
  while ((cursor = text.indexOf('<', cursor + 1)) !== -1) if (++markers > 100000) fail(`${name}: слишком много XML-элементов.`);
  let doc;
  try { doc = new DOMParser({onError: () => { throw new Error('invalid_xml'); }}).parseFromString(text, 'application/xml'); }
  catch { fail(`${name}: некорректный XML.`); }
  if (!doc.documentElement) fail(`${name}: отсутствует корневой XML-элемент.`);
  const stack = [[doc.documentElement, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > 64) fail(`${name}: вложенность XML превышает 64 уровня.`);
    for (const child of elements(node)) stack.push([child, depth + 1]);
  }
  return doc;
}

function checkPackage(entries) {
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) if (!entries.has(required)) fail('DOCX: отсутствуют обязательные части пакета.');
  const docs = new Map();
  for (const [name, bytes] of entries) {
    if (/vba|embeddings|activeX|altChunk|glossary|media\//i.test(name)) fail('DOCX содержит вложенные, графические или дополнительные данные. Поддерживаются только обычные текстовые абзацы.');
    if (/word\/(?:header|footer|footnotes|endnotes|comments)/i.test(name)) fail('DOCX содержит колонтитулы, сноски или комментарии. Подготовьте копию с их текстом в основных абзацах.');
    if (/\.xml$|\.rels$/i.test(name)) docs.set(name, parseXml(bytes, name));
    else if (!name.endsWith('/') && !/^docProps\/thumbnail\.(?:jpeg|jpg|png|wmf)$/i.test(name)) fail(`DOCX: неподдерживаемая часть пакета ${name}.`);
  }
  const contentTypes = docs.get('[Content_Types].xml').documentElement;
  if (contentTypes.namespaceURI !== CT || contentTypes.localName !== 'Types') fail('DOCX: некорректный список типов содержимого.');
  const mainType = elements(contentTypes).find(node => node.getAttribute('PartName') === '/word/document.xml');
  if (!mainType || mainType.getAttribute('ContentType') !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') fail('DOCX: поддерживается только обычный документ Word без макросов.');
  const emptyBibliography = validateBibliography(docs);
  let foundMain = false, links = false;
  for (const [name, doc] of docs) {
    if (!name.endsWith('.rels')) continue;
    if (doc.documentElement.namespaceURI !== REL || doc.documentElement.localName !== 'Relationships') fail('DOCX: некорректные связи пакета.');
    const ids = new Set();
    for (const rel of elements(doc.documentElement)) {
      if (rel.namespaceURI !== REL || rel.localName !== 'Relationship') fail('DOCX: некорректная связь пакета.');
      const type = rel.getAttribute('Type').split('/').pop(), target = rel.getAttribute('Target'), id = rel.getAttribute('Id');
      if (!id || ids.has(id)) fail('DOCX: повторяющийся или пустой идентификатор связи.'); ids.add(id);
      if (name === '_rels/.rels' && type === 'officeDocument') { if (target !== 'word/document.xml' || rel.getAttribute('TargetMode') === 'External') fail('DOCX: неподдерживаемый основной документ.'); foundMain = true; }
      else if (['header', 'footer', 'footnotes', 'endnotes', 'comments', 'numbering', 'aFChunk', 'subDocument', 'oleObject', 'image'].includes(type)) {
        if (type !== 'numbering') fail('DOCX содержит колонтитулы, сноски, комментарии, рисунки или вложенные документы. Эти части не поддерживаются.');
        // A numbering part may contain unused templates; actual numPr is refused.
      } else if (type === 'customXml') {
        if (name !== 'word/_rels/document.xml.rels' || !/^\.\.\/customXml\/item\d+\.xml$/.test(target) || !emptyBibliography.has(target.slice(3))) fail('DOCX: пользовательские XML-данные не поддерживаются.');
      } else if (type === 'customXmlProps') {
        const number = /^customXml\/_rels\/item(\d+)\.xml\.rels$/.exec(name)?.[1];
        if (!number || target !== `itemProps${number}.xml` || !emptyBibliography.has(`customXml/item${number}.xml`)) fail('DOCX: неподдерживаемые пользовательские XML-связи.');
      } else if (type === 'hyperlink') links = true;
      else if (!['styles', 'stylesWithEffects', 'settings', 'webSettings', 'fontTable', 'theme', 'extended-properties', 'core-properties', 'custom-properties', 'thumbnail'].includes(type)) fail(`DOCX: неподдерживаемая связь ${type}.`);
      if (rel.getAttribute('TargetMode') === 'External' && type !== 'hyperlink') fail('DOCX: внешние связи, кроме адресов гиперссылок, не поддерживаются.');
    }
  }
  if (!foundMain) fail('DOCX: отсутствует связь с основным документом.');
  // Unknown Word parts could contain user-visible text, so never silently drop.
  for (const name of entries.keys()) if (name.startsWith('word/') && !name.endsWith('/') && !/^word\/(?:document\.xml|styles\.xml|stylesWithEffects\.xml|settings\.xml|webSettings\.xml|fontTable\.xml|numbering\.xml|theme\/theme\d+\.xml|_rels\/document\.xml\.rels)$/.test(name)) fail(`DOCX: дополнительная часть ${name} не поддерживается.`);
  for (const name of entries.keys()) if (!name.startsWith('word/') && !name.startsWith('customXml/') && !name.endsWith('/') && !['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml'].includes(name) && !/^docProps\/thumbnail\.(?:jpeg|jpg|png|wmf)$/i.test(name)) fail(`DOCX: дополнительная часть ${name} не поддерживается.`);
  validateNumbering(docs);
  return {doc: docs.get('word/document.xml'), links, emptyBibliography: emptyBibliography.size > 0};
}

function validateBibliography(docs) {
  const BIB = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography';
  const DS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml';
  const safe = new Set();
  for (const [name, doc] of docs) {
    if (!name.startsWith('customXml/')) continue;
    const number = /^customXml\/item(\d+)\.xml$/.exec(name)?.[1];
    if (number) {
      const root = doc.documentElement;
      const attrs = Array.from(root.attributes).filter(attr => attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/');
      if (root.namespaceURI !== BIB || root.localName !== 'Sources' || elements(root).length || root.textContent.trim() || attrs.some(attr => !['SelectedStyle', 'StyleName', 'LCID'].includes(attr.localName))) fail('DOCX содержит пользовательские XML-данные или непустую библиографию. Подготовьте копию только с обычными абзацами.');
      safe.add(name);
    } else if (!/^customXml\/(?:itemProps\d+\.xml|_rels\/item\d+\.xml\.rels)$/.test(name)) fail('DOCX: пользовательские XML-данные не поддерживаются.');
  }
  for (const [name, doc] of docs) {
    const number = /^customXml\/itemProps(\d+)\.xml$/.exec(name)?.[1];
    if (!number) continue;
    if (!safe.has(`customXml/item${number}.xml`)) fail('DOCX: неподдерживаемые пользовательские XML-свойства.');
    const stack = [doc.documentElement];
    while (stack.length) {
      const node = stack.pop();
      if (node.namespaceURI !== DS || !['datastoreItem', 'schemaRefs', 'schemaRef'].includes(node.localName) || node.textContent.trim()) fail('DOCX: неподдерживаемые пользовательские XML-свойства.');
      if (node.localName === 'schemaRef' && node.getAttributeNS(DS, 'uri') !== BIB) fail('DOCX: пользовательская XML-схема не поддерживается.');
      stack.push(...elements(node));
    }
  }
  return safe;
}

const wordAttribute = (node, name) => { for (const uri of W) { const value = node.getAttributeNS(uri, name); if (value !== null) return value; } return null; };
function walkElements(root) { const list = [], stack = [root]; while (stack.length) { const node = stack.pop(); list.push(node); stack.push(...elements(node)); } return list; }
function validateNumbering(docs) {
  const numbered = () => fail('DOCX содержит автоматическую нумерацию в применённых стилях. Преобразуйте номера в обычный текст.');
  const paragraphs = walkElements(docs.get('word/document.xml').documentElement).filter(node => w(node, 'p'));
  const used = new Set();
  for (const filename of ['word/styles.xml', 'word/stylesWithEffects.xml']) {
    const doc = docs.get(filename); if (!doc) continue;
    const root = doc.documentElement, styles = new Map(); let defaultStyle = null;
    for (const node of elements(root)) {
      if (w(node, 'docDefaults') && walkElements(node).some(child => w(child, 'numPr'))) numbered();
      if (!w(node, 'style')) continue;
      const id = wordAttribute(node, 'styleId');
      if (!id || styles.has(id)) fail('DOCX: неоднозначные идентификаторы стилей.'); styles.set(id, node);
      if (wordAttribute(node, 'type') === 'paragraph' && ['1', 'true', 'on'].includes(wordAttribute(node, 'default'))) {
        if (defaultStyle !== null) fail('DOCX: несколько стилей абзаца по умолчанию.'); defaultStyle = id;
      }
    }
    for (const paragraph of paragraphs) {
      const pr = elements(paragraph).find(child => w(child, 'pPr'));
      const applied = pr && elements(pr).find(child => w(child, 'pStyle'));
      let id = applied ? wordAttribute(applied, 'val') : defaultStyle;
      const chain = new Set();
      while (id !== null) {
        if (chain.has(id) || chain.size >= 64) fail('DOCX: циклическое или слишком глубокое наследование стилей.');
        chain.add(id); used.add(id); const style = styles.get(id);
        if (!style) fail('DOCX: применённый стиль абзаца отсутствует в документе.');
        if (walkElements(style).some(node => w(node, 'numPr'))) numbered();
        const base = elements(style).find(node => w(node, 'basedOn')); id = base ? wordAttribute(base, 'val') : null;
      }
    }
  }
  const numbering = docs.get('word/numbering.xml');
  if (numbering && walkElements(numbering.documentElement).some(node => w(node, 'pStyle') && used.has(wordAttribute(node, 'val')))) numbered();
}

function docxBlocks(doc) {
  const root = doc.documentElement;
  if (!w(root, 'document')) fail('DOCX: основной XML не является WordprocessingML-документом.');
  const bodies = elements(root).filter(node => w(node, 'body'));
  if (bodies.length !== 1 || elements(root).length !== 1) fail('DOCX: неподдерживаемая структура основного документа.');
  const body = bodies[0], output = [];
  const reject = node => fail(`DOCX: элемент ${node.localName} не поддерживается. Принимайте исправления и преобразуйте поля, списки, таблицы и дополнительные объекты в обычный текст.`);
  // Reject visible content that is not represented by w:t, irrespective of prefix.
  const inspect = [root];
  while (inspect.length) {
    const node = inspect.pop();
    if (!W.has(node.namespaceURI)) reject(node);
    if (/^(?:ins|del|moveFrom|moveTo|fldSimple|fldChar|instrText|delText|numPr|numberingChange|drawing|pict|object|txbxContent|tbl|sdt|dataBinding|altChunk|subDoc|sym|footnoteReference|endnoteReference|commentReference|headerReference|footerReference)$/.test(node.localName) || /Change$/.test(node.localName)) reject(node);
    inspect.push(...elements(node));
  }
  function formatting(node) {
    // Properties may affect visibility or automatic numbering. Reject their
    // semantic forms above; all remaining formatting is explicitly out of scope.
    if (node.textContent.trim()) reject(node);
  }
  function inline(node, parts) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 || child.nodeType === 4) { if (child.data.trim()) reject(node); continue; }
      if (child.nodeType === 8) continue;
      if (child.nodeType !== 1) reject(node);
      const local = child.localName;
      if (w(child, 't')) {
        if (!w(node, 'r') || elements(child).length) reject(child);
        parts.push(child.textContent);
      } else if (['r', 'hyperlink'].includes(local)) inline(child, parts);
      else if (['tab', 'br', 'cr', 'noBreakHyphen', 'softHyphen'].includes(local)) {
        if (!w(node, 'r') || elements(child).length) reject(child);
        parts.push(local === 'tab' ? '\t' : local === 'noBreakHyphen' ? '\u2011' : local === 'softHyphen' ? '\u00ad' : '\n');
      } else if (['pPr', 'rPr'].includes(local)) formatting(child);
      else if (['bookmarkStart', 'bookmarkEnd', 'proofErr', 'lastRenderedPageBreak', 'permStart', 'permEnd'].includes(local)) { if (elements(child).length || child.textContent.trim()) reject(child); }
      else reject(child);
    }
  }
  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === 3 && !node.data.trim() || node.nodeType === 8) continue;
    if (node.nodeType !== 1) fail('DOCX: неподдерживаемое содержимое документа.');
    if (w(node, 'sectPr')) { formatting(node); continue; }
    if (!w(node, 'p')) reject(node);
    const parts = []; inline(node, parts); output.push(normalizeLines(parts.join('')));
    if (output.length > MAX_TEXT_BLOCKS) fail('Документ содержит более 2000 текстовых блоков. Разделите его.');
  }
  return output;
}

export async function readTextSource(item) {
  if (!item || typeof item.name !== 'string' || !item.name.trim() || [...item.name].length > 255 || item.name.includes('\0')) fail('Укажите имя текстового файла длиной до 255 символов.');
  const format = /\.(txt|docx|pdf)$/i.exec(item.name)?.[1].toLowerCase();
  if (!format) fail('Для текстовой сверки загрузите TXT, DOCX или PDF с текстовым слоем.');
  const data = item.data;
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(MAX_TEXT_SOURCE_BYTES / 3)) fail('Текстовый файл превышает 2 МиБ или имеет неверный формат.');
  if (/[^A-Za-z0-9+/=]/.test(data) || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('Некорректные данные base64.');
  let raw;
  try { raw = Uint8Array.from(atob(data), c => c.charCodeAt(0)); } catch { fail('Некорректные данные base64.'); }
  if (raw.length > MAX_TEXT_SOURCE_BYTES) fail('Текстовый файл превышает 2 МиБ.');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (format === 'pdf') {
    const {readPdfBytes} = await import('./pdf-source.mjs');
    const {blocks, notes, page_count} = await readPdfBytes(raw);
    return {meta: {name: item.name, sha256, format, block_count: blocks.length, page_count, coverage: 'text_layer_only', notes}, blocks};
  }
  let texts, notes = [...standardNotes];
  if (format === 'txt') {
    let text;
    try { text = normalizeLines(decode(raw)); } catch { fail(`${item.name}: сохраните TXT в UTF-8.`); }
    if (text.includes('\0')) fail(`${item.name}: NUL-символы не допускаются.`);
    texts = text === '' ? [] : text.split('\n');
    if (text.endsWith('\n')) texts.pop();
    notes.push('Каждая строка TXT — отдельный блок, включая пустые строки. Один завершающий перевод строки обозначает конец последней строки и не создаёт дополнительный блок.');
  } else {
    const checked = checkPackage(await unzipDocument(raw)); texts = docxBlocks(checked.doc);
    notes.push('Каждый основной абзац DOCX — отдельный блок, включая пустые абзацы. Мягкие переносы и табуляция сохранены; отображаемые номера страниц, стили и параметры форматирования не сравниваются.');
    notes.push('Скрытое форматированием содержимое основных абзацев включено в извлечённый текст. Свойства файла и эскиз документа не сравниваются.');
    if (checked.emptyBibliography) notes.push('Пустой служебный шаблон библиографии не сравнивается; пользовательских записей в нём нет.');
    if (checked.links) notes.push('Сравнивается видимый текст гиперссылок; адреса не открываются и не сравниваются.');
  }
  if (texts.length > MAX_TEXT_BLOCKS) fail('Документ содержит более 2000 текстовых блоков. Разделите его.');
  let chars = 0;
  for (const text of texts) { chars += [...text].length; if (chars > MAX_TEXT_CHARS) fail('Извлечённый текст превышает 500 000 символов. Разделите документ.'); }
  return {meta: {name: item.name, sha256, format, block_count: texts.length, notes}, blocks: texts.map((text, i) => ({record: i + 1, text, location: `${format === 'txt' ? 'Строка' : 'Абзац'} ${i + 1}`}))};
}
