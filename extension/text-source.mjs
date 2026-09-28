/** Bounded TXT, plain-paragraph DOCX and PDF text-layer extraction, offline. */
import {DOMParser} from './xml-vendor.mjs';
import {unzipDocument} from './text-zip.mjs';
import {parseDocxNumbering} from './docx-numbering.mjs';
import {readDocxStructure} from './docx-structure.mjs';
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
    if (/vba|embeddings|activeX|altChunk|glossary/i.test(name)) fail('DOCX содержит вложенные, графические или дополнительные данные. Поддерживаются только обычные текстовые абзацы.');
    if (/word\/(?:header|footer|footnotes|endnotes|comments)/i.test(name)) fail('DOCX содержит колонтитулы, сноски или комментарии. Подготовьте копию с их текстом в основных абзацах.');
    if (/\.xml$|\.rels$/i.test(name)) docs.set(name, parseXml(bytes, name));
    else if (!name.endsWith('/') && !/^docProps\/thumbnail\.(?:jpeg|jpg|png|wmf)$/i.test(name) && !/^word\/media\/[^/]+\.(?:png|jpe?g)$/i.test(name)) fail(`DOCX: неподдерживаемая часть пакета ${name}.`);
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
      else if (['header', 'footer', 'footnotes', 'endnotes', 'comments', 'numbering', 'aFChunk', 'subDocument', 'oleObject'].includes(type)) {
        if (type !== 'numbering') fail('DOCX содержит колонтитулы, сноски, комментарии, рисунки или вложенные документы. Эти части не поддерживаются.');
        // Resolve used list templates after bounded XML and package validation.
        if (name !== 'word/_rels/document.xml.rels' || target !== 'numbering.xml' || !entries.has('word/numbering.xml')) fail('DOCX: неподдерживаемая связь автоматической нумерации.');
      } else if (type === 'customXml') {
        if (name !== 'word/_rels/document.xml.rels' || !/^\.\.\/customXml\/item\d+\.xml$/.test(target) || !emptyBibliography.has(target.slice(3))) fail('DOCX: пользовательские XML-данные не поддерживаются.');
      } else if (type === 'customXmlProps') {
        const number = /^customXml\/_rels\/item(\d+)\.xml\.rels$/.exec(name)?.[1];
        if (!number || target !== `itemProps${number}.xml` || !emptyBibliography.has(`customXml/item${number}.xml`)) fail('DOCX: неподдерживаемые пользовательские XML-связи.');
      } else if (type === 'image') {
        if (name !== 'word/_rels/document.xml.rels' || !/^media\/[^/]+\.(?:png|jpe?g)$/i.test(target) || !entries.has(`word/${target}`)) fail('DOCX: поддерживаются только встроенные изображения PNG и JPEG.');
      } else if (type === 'hyperlink') links = true;
      else if (!['styles', 'stylesWithEffects', 'settings', 'webSettings', 'fontTable', 'theme', 'extended-properties', 'core-properties', 'custom-properties', 'thumbnail'].includes(type)) fail(`DOCX: неподдерживаемая связь ${type}.`);
      if (rel.getAttribute('TargetMode') === 'External' && type !== 'hyperlink') fail('DOCX: внешние связи, кроме адресов гиперссылок, не поддерживаются.');
    }
  }
  if (!foundMain) fail('DOCX: отсутствует связь с основным документом.');
  // Unknown Word parts could contain user-visible text, so never silently drop.
  for (const name of entries.keys()) if (name.startsWith('word/') && !name.endsWith('/') && !/^word\/(?:document\.xml|styles\.xml|stylesWithEffects\.xml|settings\.xml|webSettings\.xml|fontTable\.xml|numbering\.xml|theme\/theme\d+\.xml|_rels\/document\.xml\.rels|media\/[^/]+\.(?:png|jpe?g))$/i.test(name)) fail(`DOCX: дополнительная часть ${name} не поддерживается.`);
  for (const name of entries.keys()) if (!name.startsWith('word/') && !name.startsWith('customXml/') && !name.endsWith('/') && !['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml'].includes(name) && !/^docProps\/thumbnail\.(?:jpeg|jpg|png|wmf)$/i.test(name)) fail(`DOCX: дополнительная часть ${name} не поддерживается.`);
  return {doc: docs.get('word/document.xml'), docs, entries, links, emptyBibliography: emptyBibliography.size > 0};
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

function docxBlocks(doc, entries, docs, structure) {
  const root = doc.documentElement;
  if (!w(root, 'document')) fail('DOCX: основной XML не является WordprocessingML-документом.');
  const bodies = elements(root).filter(node => w(node, 'body'));
  if (bodies.length !== 1 || elements(root).length !== 1) fail('DOCX: неподдерживаемая структура основного документа.');
  const output = [];
  const reject = node => fail(`DOCX: элемент ${node.localName} не поддерживается. Принимайте исправления и преобразуйте поля и дополнительные объекты в обычный текст.`);
  // Reject visible content that is not represented by w:t, irrespective of prefix.
  const inspect = [root];
  while (inspect.length) {
    const node = inspect.pop();
    if (w(node, 'drawing')) { validateDocxDrawing(node, entries, docs); continue; }
    if (!W.has(node.namespaceURI)) reject(node);
    if (w(node, 'numPr') && (!w(node.parentNode, 'pPr') || !w(node.parentNode.parentNode, 'p'))) reject(node);
    if (/^(?:ins|del|moveFrom|moveTo|fldSimple|fldChar|instrText|delText|numberingChange|drawing|pict|object|txbxContent|sdt|dataBinding|altChunk|subDoc|sym|footnoteReference|endnoteReference|commentReference|headerReference|footerReference)$/.test(node.localName) || /Change$/.test(node.localName)) reject(node);
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
      } else if (w(child, 'drawing') && w(node, 'r')) { validateDocxDrawing(child, entries, docs);
      } else if (['r', 'hyperlink'].includes(local)) inline(child, parts);
      else if (['tab', 'br', 'cr', 'noBreakHyphen', 'softHyphen'].includes(local)) {
        if (!w(node, 'r') || elements(child).length) reject(child);
        parts.push(local === 'tab' ? '\t' : local === 'noBreakHyphen' ? '\u2011' : local === 'softHyphen' ? '\u00ad' : '\n');
      } else if (['pPr', 'rPr'].includes(local)) formatting(child);
      else if (['bookmarkStart', 'bookmarkEnd', 'proofErr', 'lastRenderedPageBreak', 'permStart', 'permEnd'].includes(local)) { if (elements(child).length || child.textContent.trim()) reject(child); }
      else reject(child);
    }
  }
  for (const node of structure.paragraphs) {
    const parts = []; inline(node, parts); output.push(normalizeLines(parts.join('')));
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
  let texts, locations, notes = [...standardNotes];
  if (format === 'txt') {
    let text;
    try { text = normalizeLines(decode(raw)); } catch { fail(`${item.name}: сохраните TXT в UTF-8.`); }
    if (text.includes('\0')) fail(`${item.name}: NUL-символы не допускаются.`);
    texts = text === '' ? [] : text.split('\n');
    if (text.endsWith('\n')) texts.pop();
    notes.push('Каждая строка TXT — отдельный блок, включая пустые строки. Один завершающий перевод строки обозначает конец последней строки и не создаёт дополнительный блок.');
  } else {
    const checked = await readDocxPackage(raw); texts = checked.texts; locations = checked.structure.locations;
    notes.push('Каждый основной абзац DOCX — отдельный блок, включая пустые абзацы. Мягкие переносы и табуляция сохранены; отображаемые номера страниц, стили и параметры форматирования не сравниваются.');
    notes.push('Скрытое форматированием содержимое основных абзацев включено в извлечённый текст. Свойства файла и эскиз документа не сравниваются.');
    if (checked.structure.hasTables) notes.push('Текст таблиц читается по строкам и ячейкам. Объединения и оформление сохраняются в DOCX; сравнивается содержимое ячеек.');
    if (checked.emptyBibliography) notes.push('Пустой служебный шаблон библиографии не сравнивается; пользовательских записей в нём нет.');
    if (checked.listData.paragraphs.some(Boolean)) notes.push('Номера и маркеры списков сохранены в документе; сравнивается только текст пунктов, без автоматической нумерации.');
    if (checked.links) notes.push('Сравнивается видимый текст гиперссылок; адреса не открываются и не сравниваются.');
  }
  if (texts.length > MAX_TEXT_BLOCKS) fail('Документ содержит более 2000 текстовых блоков. Разделите его.');
  let chars = 0;
  for (const text of texts) { chars += [...text].length; if (chars > MAX_TEXT_CHARS) fail('Извлечённый текст превышает 500 000 символов. Разделите документ.'); }
  return {meta: {name: item.name, sha256, format, block_count: texts.length, notes}, blocks: texts.map((text, i) => ({record: i + 1, text, ...(locations?.[i] ? {table: locations[i]} : {}), location: locations?.[i] ? `Таблица ${locations[i].table}, строка ${locations[i].row}, столбец ${locations[i].column}, абзац ${locations[i].paragraph}` : `${format === 'txt' ? 'Строка' : 'Абзац'} ${i + 1}`}))};
}

const DRAWING_NS = {
  'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing': new Set(['inline','extent','effectExtent','docPr','cNvGraphicFramePr']),
  'http://schemas.openxmlformats.org/drawingml/2006/main': new Set(['graphic','graphicData','graphicFrameLocks','picLocks','blip','stretch','fillRect','xfrm','off','ext','prstGeom','avLst','srcRect','alphaModFix']),
  'http://schemas.openxmlformats.org/drawingml/2006/picture': new Set(['pic','nvPicPr','cNvPr','cNvPicPr','blipFill','spPr']),
};
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function imageMime(bytes) {
  let width = 0, height = 0;
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16); height = view.getUint32(20);
    if (!width || !height || width * height > 25000000) fail('DOCX: размер изображения превышает 25 млн пикселей.');
    return {mime:'image/png',pixels:width*height};
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if ([216,217,218].includes(marker)) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
        height = bytes[offset + 3] * 256 + bytes[offset + 4]; width = bytes[offset + 5] * 256 + bytes[offset + 6];
        if (!width || !height || width * height > 25000000) fail('DOCX: размер изображения превышает 25 млн пикселей.');
        return {mime:'image/jpeg',pixels:width*height};
      }
      offset += length;
    }
  }
  fail('DOCX: изображение PNG или JPEG повреждено либо имеет неподдерживаемый формат.');
}
export function validateDocxDrawing(drawing, entries, docs) {
  const nodes = walkElements(drawing).slice(1);
  const unsupported = () => fail('DOCX: этот рисунок не поддерживается. Используйте встроенное изображение PNG или JPEG в строке текста.');
  if (elements(drawing).length !== 1 || elements(drawing)[0].localName !== 'inline') unsupported();
  for (const node of nodes) {
    if (!DRAWING_NS[node.namespaceURI]?.has(node.localName)) unsupported();
    if (Array.from(node.childNodes).some(child => child.nodeType === 3 && child.data.trim())) unsupported();
    if (node.localName === 'srcRect' && ['t','b','l','r'].some(attr => Number(node.getAttribute(attr) || 0))) unsupported();
    if (node.localName === 'xfrm' && ['rot','flipH','flipV'].some(attr => !['','0','false',null].includes(node.getAttribute(attr)))) unsupported();
    if (node.localName === 'alphaModFix' && node.getAttribute('amt') !== '100000') unsupported();
    if (node.localName === 'prstGeom' && node.getAttribute('prst') !== 'rect') unsupported();
  }
  const blips = nodes.filter(node => node.localName === 'blip');
  const extent = nodes.find(node => node.localName === 'extent');
  if (blips.length !== 1 || !extent || blips[0].getAttributeNS(R,'link')) unsupported();
  const width = Number(extent.getAttribute('cx')) / 9525, height = Number(extent.getAttribute('cy')) / 9525;
  if (!(width > 0 && height > 0 && width <= 5000 && height <= 5000)) unsupported();
  const id = blips[0].getAttributeNS(R, 'embed');
  const rels = docs?.get('word/_rels/document.xml.rels');
  const rel = rels && elements(rels.documentElement).find(node => node.getAttribute('Id') === id && node.getAttribute('Type').endsWith('/image'));
  if (!rel || rel.getAttribute('TargetMode') === 'External') unsupported();
  const path = `word/${rel.getAttribute('Target')}`, bytes = entries?.get(path);
  if (!bytes) unsupported();
  const {mime,pixels} = imageMime(bytes), description = nodes.find(node => node.localName === 'docPr');
  return {path, bytes, mime, pixels, width, height, alt: (description?.getAttribute('descr') || description?.getAttribute('name') || '').slice(0,500)};
}

export async function readDocxPackage(raw) {
  const checked = checkPackage(await unzipDocument(raw));
  checked.structure = readDocxStructure(checked.doc, checked.docs);
  checked.texts = docxBlocks(checked.doc, checked.entries, checked.docs, checked.structure);
  checked.listData = parseDocxNumbering(checked.docs, checked.structure.paragraphs);
  const pictures = walkElements(checked.doc.documentElement).filter(node => w(node,'drawing'));
  if (pictures.length > 100 || pictures.reduce((sum,node) => sum + validateDocxDrawing(node,checked.entries,checked.docs).pixels,0) > 50000000) fail('DOCX: слишком много изображений для просмотра. Разделите документ.');
  if (checked.texts.length > MAX_TEXT_BLOCKS || checked.texts.reduce((n,t) => n + [...t].length,0) > MAX_TEXT_CHARS) fail('DOCX превышает ограничение по объёму текста.');
  return checked;
}
