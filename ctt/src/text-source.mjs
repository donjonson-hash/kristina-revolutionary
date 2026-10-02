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
const standardNotes = ["The extracted text is compared. Formatting, fonts, pagination, and legal meaning are not evaluated.", "Case, spaces, and Unicode are preserved; CRLF and CR line endings are converted to LF."];

function parseXml(raw, name) {
  let text;
  try { text = decode(raw); } catch { fail(`${name}: UTF-8 XML is required.`); }
  if (text.length > 8 * 1024 * 1024) fail(`${name}: XML exceeds 8 MiB.`);
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text)) fail(`${name}: DTDs and custom XML entities are not supported.`);
  let markers = 0, cursor = -1;
  while ((cursor = text.indexOf('<', cursor + 1)) !== -1) if (++markers > 100000) fail(`${name}: too many XML elements.`);
  let doc;
  try { doc = new DOMParser({onError: () => { throw new Error('invalid_xml'); }}).parseFromString(text, 'application/xml'); }
  catch { fail(`${name}: invalid XML.`); }
  if (!doc.documentElement) fail(`${name}: the root XML element is missing.`);
  const stack = [[doc.documentElement, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > 64) fail(`${name}: XML nesting exceeds 64 levels.`);
    for (const child of elements(node)) stack.push([child, depth + 1]);
  }
  return doc;
}

function checkPackage(entries) {
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) if (!entries.has(required)) fail("DOCX: required package parts are missing.");
  const docs = new Map();
  for (const [name, bytes] of entries) {
    if (/vba|embeddings|activeX|altChunk|glossary/i.test(name)) fail("The DOCX contains embedded, graphical, or additional data. Only standard text paragraphs are supported.");
    if (/word\/(?:header|footer|footnotes|endnotes|comments)/i.test(name)) fail("The DOCX contains headers, footers, footnotes, endnotes, or comments. Prepare a copy with their text in the main paragraphs.");
    if (/\.xml$|\.rels$/i.test(name)) docs.set(name, parseXml(bytes, name));
    else if (!name.endsWith('/') && !/^docProps\/thumbnail\.(?:jpeg|jpg|png|wmf)$/i.test(name) && !/^word\/media\/[^/]+\.(?:png|jpe?g)$/i.test(name)) fail(`DOCX: unsupported package part ${name}.`);
  }
  const contentTypes = docs.get('[Content_Types].xml').documentElement;
  if (contentTypes.namespaceURI !== CT || contentTypes.localName !== 'Types') fail("DOCX: invalid content type list.");
  const mainType = elements(contentTypes).find(node => node.getAttribute('PartName') === '/word/document.xml');
  if (!mainType || mainType.getAttribute('ContentType') !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') fail("DOCX: only standard Word documents without macros are supported.");
  const emptyBibliography = validateBibliography(docs);
  let foundMain = false, links = false;
  for (const [name, doc] of docs) {
    if (!name.endsWith('.rels')) continue;
    if (doc.documentElement.namespaceURI !== REL || doc.documentElement.localName !== 'Relationships') fail("DOCX: invalid package relationships.");
    const ids = new Set();
    for (const rel of elements(doc.documentElement)) {
      if (rel.namespaceURI !== REL || rel.localName !== 'Relationship') fail("DOCX: invalid package relationship.");
      const type = rel.getAttribute('Type').split('/').pop(), target = rel.getAttribute('Target'), id = rel.getAttribute('Id');
      if (!id || ids.has(id)) fail("DOCX: duplicate or empty relationship ID."); ids.add(id);
      if (name === '_rels/.rels' && type === 'officeDocument') { if (target !== 'word/document.xml' || rel.getAttribute('TargetMode') === 'External') fail("DOCX: unsupported main document."); foundMain = true; }
      else if (['header', 'footer', 'footnotes', 'endnotes', 'comments', 'numbering', 'aFChunk', 'subDocument', 'oleObject'].includes(type)) {
        if (type !== 'numbering') fail("The DOCX contains headers, footers, footnotes, endnotes, comments, images, or embedded documents. These parts are not supported.");
        // Resolve used list templates after bounded XML and package validation.
        if (name !== 'word/_rels/document.xml.rels' || target !== 'numbering.xml' || !entries.has('word/numbering.xml')) fail("DOCX: unsupported automatic numbering relationship.");
      } else if (type === 'customXml') {
        if (name !== 'word/_rels/document.xml.rels' || !/^\.\.\/customXml\/item\d+\.xml$/.test(target) || !emptyBibliography.has(target.slice(3))) fail("DOCX: custom XML data is not supported.");
      } else if (type === 'customXmlProps') {
        const number = /^customXml\/_rels\/item(\d+)\.xml\.rels$/.exec(name)?.[1];
        if (!number || target !== `itemProps${number}.xml` || !emptyBibliography.has(`customXml/item${number}.xml`)) fail("DOCX: unsupported custom XML relationships.");
      } else if (type === 'image') {
        if (name !== 'word/_rels/document.xml.rels' || !/^media\/[^/]+\.(?:png|jpe?g)$/i.test(target) || !entries.has(`word/${target}`)) fail("DOCX: only embedded PNG and JPEG images are supported.");
      } else if (type === 'hyperlink') links = true;
      else if (!['styles', 'stylesWithEffects', 'settings', 'webSettings', 'fontTable', 'theme', 'extended-properties', 'core-properties', 'custom-properties', 'thumbnail'].includes(type)) fail(`DOCX: unsupported relationship ${type}.`);
      if (rel.getAttribute('TargetMode') === 'External' && type !== 'hyperlink') fail("DOCX: external relationships other than hyperlink URLs are not supported.");
    }
  }
  if (!foundMain) fail("DOCX: the relationship to the main document is missing.");
  // Unknown Word parts could contain user-visible text, so never silently drop.
  for (const name of entries.keys()) if (name.startsWith('word/') && !name.endsWith('/') && !/^word\/(?:document\.xml|styles\.xml|stylesWithEffects\.xml|settings\.xml|webSettings\.xml|fontTable\.xml|numbering\.xml|theme\/theme\d+\.xml|_rels\/document\.xml\.rels|media\/[^/]+\.(?:png|jpe?g))$/i.test(name)) fail(`DOCX: additional part ${name} is not supported.`);
  for (const name of entries.keys()) if (!name.startsWith('word/') && !name.startsWith('customXml/') && !name.endsWith('/') && !['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml'].includes(name) && !/^docProps\/thumbnail\.(?:jpeg|jpg|png|wmf)$/i.test(name)) fail(`DOCX: additional part ${name} is not supported.`);
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
      if (root.namespaceURI !== BIB || root.localName !== 'Sources' || elements(root).length || root.textContent.trim() || attrs.some(attr => !['SelectedStyle', 'StyleName', 'LCID'].includes(attr.localName))) fail("The DOCX contains custom XML data or a nonempty bibliography. Prepare a copy containing only standard paragraphs.");
      safe.add(name);
    } else if (!/^customXml\/(?:itemProps\d+\.xml|_rels\/item\d+\.xml\.rels)$/.test(name)) fail("DOCX: custom XML data is not supported.");
  }
  for (const [name, doc] of docs) {
    const number = /^customXml\/itemProps(\d+)\.xml$/.exec(name)?.[1];
    if (!number) continue;
    if (!safe.has(`customXml/item${number}.xml`)) fail("DOCX: unsupported custom XML properties.");
    const stack = [doc.documentElement];
    while (stack.length) {
      const node = stack.pop();
      if (node.namespaceURI !== DS || !['datastoreItem', 'schemaRefs', 'schemaRef'].includes(node.localName) || node.textContent.trim()) fail("DOCX: unsupported custom XML properties.");
      if (node.localName === 'schemaRef' && node.getAttributeNS(DS, 'uri') !== BIB) fail("DOCX: custom XML schemas are not supported.");
      stack.push(...elements(node));
    }
  }
  return safe;
}

const wordAttribute = (node, name) => { for (const uri of W) { const value = node.getAttributeNS(uri, name); if (value !== null) return value; } return null; };
function walkElements(root) { const list = [], stack = [root]; while (stack.length) { const node = stack.pop(); list.push(node); stack.push(...elements(node)); } return list; }

function docxBlocks(doc, entries, docs, structure) {
  const root = doc.documentElement;
  if (!w(root, 'document')) fail("DOCX: the main XML is not a WordprocessingML document.");
  const bodies = elements(root).filter(node => w(node, 'body'));
  if (bodies.length !== 1 || elements(root).length !== 1) fail("DOCX: unsupported main document structure.");
  const output = [];
  const reject = node => fail(`DOCX: element ${node.localName} is not supported. Accept tracked changes and convert fields and additional objects to plain text.`);
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
  if (!item || typeof item.name !== 'string' || !item.name.trim() || [...item.name].length > 255 || item.name.includes('\0')) fail("Provide a text filename of up to 255 characters.");
  const format = /\.(txt|docx|pdf)$/i.exec(item.name)?.[1].toLowerCase();
  if (!format) fail("For text comparison, upload TXT, DOCX, or PDF files with a text layer.");
  const data = item.data;
  if (typeof data !== 'string' || data.length > 4 * Math.ceil(MAX_TEXT_SOURCE_BYTES / 3)) fail("The text file exceeds 2 MiB or has an invalid format.");
  if (/[^A-Za-z0-9+/=]/.test(data) || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail("Invalid base64 data.");
  let raw;
  try { raw = Uint8Array.from(atob(data), c => c.charCodeAt(0)); } catch { fail("Invalid base64 data."); }
  if (raw.length > MAX_TEXT_SOURCE_BYTES) fail("The text file exceeds 2 MiB.");
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (format === 'pdf') {
    const {readPdfBytes} = await import('./pdf-source.mjs');
    const {blocks, notes, page_count} = await readPdfBytes(raw);
    return {meta: {name: item.name, sha256, format, block_count: blocks.length, page_count, coverage: 'text_layer_only', notes}, blocks};
  }
  let texts, locations, notes = [...standardNotes];
  if (format === 'txt') {
    let text;
    try { text = normalizeLines(decode(raw)); } catch { fail(`${item.name}: save the TXT file as UTF-8.`); }
    if (text.includes('\0')) fail(`${item.name}: NUL characters are not allowed.`);
    texts = text === '' ? [] : text.split('\n');
    if (text.endsWith('\n')) texts.pop();
    notes.push("Each TXT line is a separate block, including empty lines. One final newline marks the end of the last line and does not create an extra block.");
  } else {
    const checked = await readDocxPackage(raw); texts = checked.texts; locations = checked.structure.locations;
    notes.push("Each main DOCX paragraph is a separate block, including empty paragraphs. Soft line breaks and tabs are preserved; displayed page numbers, styles, and formatting settings are not compared.");
    notes.push("Content hidden by formatting in the main paragraphs is included in the extracted text. File properties and the document thumbnail are not compared.");
    if (checked.structure.hasTables) notes.push("Table text is read by row and cell. Merged cells and formatting are preserved in the DOCX; cell content is compared.");
    if (checked.emptyBibliography) notes.push("The empty bibliography template is not compared; it contains no user entries.");
    if (checked.listData.paragraphs.some(Boolean)) notes.push("List numbers and bullets are preserved in the document; only the item text is compared, without automatic numbering.");
    if (checked.links) notes.push("Only the visible hyperlink text is compared; URLs are not opened or compared.");
  }
  if (texts.length > MAX_TEXT_BLOCKS) fail("The document contains more than 2,000 text blocks. Split it into smaller files.");
  let chars = 0;
  for (const text of texts) { chars += [...text].length; if (chars > MAX_TEXT_CHARS) fail("The extracted text exceeds 500,000 characters. Split the document into smaller files."); }
  return {meta: {name: item.name, sha256, format, block_count: texts.length, notes}, blocks: texts.map((text, i) => ({record: i + 1, text, ...(locations?.[i] ? {table: locations[i]} : {}), location: locations?.[i] ? `Table ${locations[i].table}, row ${locations[i].row}, column ${locations[i].column}, paragraph ${locations[i].paragraph}` : `${format === 'txt' ? "Line" : "Paragraph"} ${i + 1}`}))};
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
    if (!width || !height || width * height > 25000000) fail("DOCX: the image exceeds 25 million pixels.");
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
        if (!width || !height || width * height > 25000000) fail("DOCX: the image exceeds 25 million pixels.");
        return {mime:'image/jpeg',pixels:width*height};
      }
      offset += length;
    }
  }
  fail("DOCX: the PNG or JPEG image is damaged or has an unsupported format.");
}
export function validateDocxDrawing(drawing, entries, docs) {
  const nodes = walkElements(drawing).slice(1);
  const unsupported = () => fail("DOCX: this image is not supported. Use an embedded PNG or JPEG image placed inline with the text.");
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
  if (pictures.length > 100 || pictures.reduce((sum,node) => sum + validateDocxDrawing(node,checked.entries,checked.docs).pixels,0) > 50000000) fail("DOCX: too many images to preview. Split the document into smaller files.");
  if (checked.texts.length > MAX_TEXT_BLOCKS || checked.texts.reduce((n,t) => n + [...t].length,0) > MAX_TEXT_CHARS) fail("The DOCX exceeds the text size limit.");
  return checked;
}
