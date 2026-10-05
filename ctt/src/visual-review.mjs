import {mountWordingOptions} from './wording-options.mjs';
import {mountFindReplace} from './find-replace.mjs';
import {createFinalCheck} from './final-check.mjs';
import {createReviewQueue} from './review-queue.mjs';
/* Documents first: original pages, local corrections, and two editable versions. */
const sides = ['left', 'right'];
const letter = side => side === 'left' ? 'A' : 'B';
const other = side => side === 'left' ? 'right' : 'left';
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (label, action, className = 'button secondary') => { const node = el('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node; };
const categories = ['matched', 'changed', 'only_left', 'only_right', 'moved', 'reflow'];
const styleKeys = ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'textDecoration', 'color', 'backgroundColor', 'textAlign', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'paddingLeft', 'paddingRight', 'textIndent', 'lineHeight', 'width', 'verticalAlign', 'paddingTop', 'paddingBottom', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft'];
const style = (node, values = {}) => { for (const key of styleKeys) if (values[key] !== undefined) node.style[key] = values[key]; };
function download(data, filename, mime) {
  const url = URL.createObjectURL(new Blob([data], {type: mime})), anchor = el('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pdfIssue(message = '') {
  if (/replacement block.*page reflow/i.test(message)) return ['This document combines a replacement block with text that needs new pages.', 'Undo or shorten the overflowing edit to keep the replacement block in place.'];
  if (/replacement block overlaps|extra space contains/i.test(message)) return ['The replacement block reaches nearby text or an image.', 'Select the text and use Replace block to make the area smaller.'];
  if (/needs more room|word does not fit/i.test(message)) return ['The new text needs more room.', 'Select the text and use Replace block to widen the area or make it taller.'];
  if (/shares a band with an image/i.test(message)) return ['This edit is too close to an image to update safely.', 'Use Adjust text area to fit the replacement while keeping nearby content in place.'];
  if (/Moving sections|Section order changed/i.test(message)) return ['The new section order cannot keep the original page layout.', 'Restore the original section order to keep the images.'];
  if (/background.*not uniform|background cannot be determined/i.test(message)) return ['This text sits on a background we cannot preserve.', 'Undo this change to keep the original appearance.'];
  if (/Text areas overlap/i.test(message)) return ['This change overlaps nearby text.', 'Undo the change or adjust the text, then preview again.'];
  if (/cannot be split safely/i.test(message)) return ['An image or text block cannot fit safely on the next page.', 'Undo the change or reduce the added text, then preview again.'];
  if (/visible text boundaries/i.test(message)) return ['The visible text does not line up clearly with the PDF text layer.', 'Undo this change to keep the original appearance.'];
  if (/rotated|unsupported text geometry/i.test(message)) return ['This text position cannot be rebuilt with the original layout.', 'Undo this change to keep the original appearance.'];
  if (/too narrow|extends beyond the page/i.test(message)) return ['There is not enough room for this text on the page.', 'Undo the change or adjust the text, then preview again.'];
  if (/too large|too many pages/i.test(message)) return ['The updated document is too large to prepare with its images.', 'Undo the change or reduce the added text, then preview again.'];
  return ['We could not prepare this PDF with its images.', 'Try Preview PDF again, or undo the last change.'];
}
export async function mountVisualReview(root, {report, sources, single = false, signal, onRevision = () => {}, restoredState, onStateChange = () => {}, onSelectionChange = () => {}, onExplain = () => {}}) {
  const originalGroups = categories.flatMap(category => (report[category] || []).map(item => ({...item, category})));
  originalGroups.sort((a, b) => Number(a.key.slice(5)) - Number(b.key.slice(5)));
  let groups = [...originalGroups];
  const byKey = new Map(groups.map(group => [group.key, group]));
  const reviewQueue = createReviewQueue(originalGroups.filter(group => group.category !== 'matched').map(group => group.key), restoredState?.review);
  const STRUCTURE_KEY = '__document_structure__';
  let reviewStarted = restoredState?.review?.started ?? false, reviewingStructure = false;
  let reviewHistory = [], decisionInProgress = false, lastRevisions = null;
  let reviewItems = [];

  const drafts = Object.fromEntries(sides.map(side => [side, window.KristinaTextEditor.create(report, side)]));
  let projectWord, normalizeWordRows;
  const exporting = {left:false,right:false}, pdfChecking = {left:false,right:false}, pdfRevision = {left:-1,right:-1};
  const pdfErrors = {left: null, right: null}, textViews = {left: false, right: false};
  const pdfPreviews = {}, previewJobs = {}, previewFailures = {}, automaticText = {};
  const activeViewer = side => pdfPreviews[side]?.viewer || viewers[side];
  const viewers = {}, models = {}, pages = {left: 1, right: 1}, generations = {left: 0, right: 0}, ui = {};
  const row = (group, side) => group?.[side] || (group?.category === `only_${side}` ? group.row : null);
  const sourceBlocks = side => originalGroups.flatMap(group => { const block = row(group, side); return block ? (block.source_blocks || [block]).map(part=>({...part,key:group.key})) : []; }).sort((a, b) => a.record - b.record);
  let finder = null, wording = null;
  let disposed = false, selected = null, selectionGeneration = 0, blockDialog = null, documentPdfDialog = null;
  const typingTimers = {}; let diffKeys = new Set();
  const alive = () => !disposed && !signal?.aborted;
  const scrollPositions = {left: {top: 0, left: 0}, right: {top: 0, left: 0}};
  let restoring = true;
  function stateChanged() { if (alive() && !restoring) onStateChange(); }
  function readScroll(side) { return {top: ui[side].scroll.scrollTop, left: ui[side].scroll.scrollLeft}; }
  function snapshot() { return {version: 1, review: reviewQueue.snapshot(reviewStarted), drafts: Object.fromEntries(sides.map(side => [side, drafts[side].snapshot()])), selected, ...(single && report.sources.left.format === 'pdf' ? {pdfTextView:textViews.left} : {}), pages: {...pages}, zoom: zoom.value, scroll: Object.fromEntries(sides.map(side => [side, readScroll(side)]))}; }
  function validateState(state) {
    const invalid = () => { throw new Error("Couldn't restore saved work: the data is corrupted."); };
    if (!state || state.version !== 1 || !['0', '794', '1191'].includes(state.zoom) || state.selected !== null && typeof state.selected !== 'string') invalid();
    if (state.pdfTextView !== undefined && typeof state.pdfTextView !== 'boolean') invalid();
    for (const side of sides) {
      const position = state.scroll?.[side], page = state.pages?.[side];
      if (!position || !Number.isFinite(position.top) || position.top < 0 || position.top > 100000000 || !Number.isFinite(position.left) || position.left < 0 || position.left > 100000000 || !Number.isInteger(page) || page < 1 || page > 500) invalid();
      if (report.sources[side].format !== 'pdf' && page !== 1) invalid();
      drafts[side].restore(state.drafts?.[side]);
    }
    syncGroups();
    if (state.selected !== null && !byKey.has(state.selected)) invalid();
  }
  const loadMessages = [];
  await Promise.all(sides.map(async side => {
    if (single && side === 'right' && report.sources[side].format === 'pdf') return;
    const format = report.sources[side].format;
    try {
      if (format === 'pdf') { const {openPdfVisual} = await import('./pdf-visual.mjs'); const viewer = await openPdfVisual(sources[side], {signal}); if (!alive()) { await viewer.dispose(); return; } let refined;try{refined=await viewer.refineBlocks(sourceBlocks(side));}catch(error){await viewer.dispose();throw error;}const map=new Map(refined.map(b=>[b.record,b.visual]));for(const group of originalGroups){const block=row(group,side);if(block)for(const part of block.source_blocks||[block])part.visual=map.get(part.record)||part.visual;}if(!alive()){await viewer.dispose();return;}viewers[side] = viewer; }
      if (format === 'docx') { const {readDocxVisual, projectDocxVisual} = await import('./docx-visual.mjs'); projectWord = projectDocxVisual; models[side] = await readDocxVisual(sources[side]);
        if (models[side].hasTables) {
          const {createDocxRowEditor} = await import('./docx-row-editor.mjs');
          ({normalizeDocxRowPlan: normalizeWordRows} = await import('./docx-structure.mjs'));
          drafts[side] = createDocxRowEditor(report, side, models[side]);
        }
      }
    } catch (error) { if (format === 'docx') delete models[side]; if (format === 'pdf') { pdfErrors[side] = error.message; textViews[side] = true; } loadMessages.push(single ? `Your document is shown as text. ${error.message}` : `Version ${letter(side)} is shown as text. ${error.message}`); }
  }));
  try {
    if (restoredState !== undefined) {
      validateState(restoredState);
      for (const side of sides) if (viewers[side] && !drafts[side].changed && restoredState.pages[side] > viewers[side].pageCount) throw new Error("Couldn't restore saved work: page not found.");
    }
    if (!alive()) throw new DOMException("Preview canceled.", 'AbortError');
  } catch (error) { for (const viewer of Object.values(viewers)) await viewer.dispose().catch(() => {}); throw error; }
  root.replaceChildren(); root.classList.add('visual-review'); root.classList.toggle('single-review', single);
  const toolbar = el('div', undefined, 'visual-toolbar'), progress = el('strong', '', 'visual-progress'); progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
  const navigation = el('div', undefined, 'visual-navigation');
  const back = button('↑', () => jump(-1)), next = button("Next difference ↓", () => jump(1)); back.setAttribute('aria-label', "Previous difference");
  navigation.append(back, next);
  const all = button("Make B match A", () => act('right', draft => draft.replaceAll(drafts.left.entries(), {rowPlan: drafts.left.rowPlan?.(), content: models.left?.content}))); all.dataset.action = 'copy-all-right';
  const tools = el('details', undefined, 'visual-more'); tools.append(el('summary', "More"));
  tools.append(button("Make A match B", () => act('left', draft => draft.replaceAll(drafts.right.entries(), {rowPlan: drafts.right.rowPlan?.(), content: models.right?.content}))));
  tools.append(button("Restore original documents", () => { if (!alive()) return; for (const side of sides) drafts[side].reset(); reviewQueue.reset(); reviewHistory = []; refresh(); stateChanged(); }));
  const saveNote = el('p', "Click any text to edit it. Highlights show text differences.", 'visual-instruction');
  const zoom = el('select'); zoom.setAttribute('aria-label', "Document zoom");
  for (const [value, label] of [['0', "Fit to width"], ['794', '100%'], ['1191', '150%']]) { const option = el('option', label); option.value = value; zoom.append(option); }
  zoom.addEventListener('change', () => { if (!alive()) return; root.style.setProperty('--sheet-min-width', zoom.value + 'px'); stateChanged(); });
  toolbar.append(progress, navigation, all, zoom, tools); if(single){navigation.hidden=all.hidden=tools.hidden=true;saveNote.textContent="Click any text to edit it. Download when you are ready.";} root.append(toolbar, saveNote);
  const findHost=el('div',undefined,'document-find');root.append(findHost);
  const status = el('p', '', 'visual-notice'); status.hidden = true; status.setAttribute('role', 'status'); root.append(status);
  if (loadMessages.length) message(loadMessages.join('\n'));
  const reviewBar = el('section', undefined, 'review-flow'); reviewBar.setAttribute('aria-label', 'Review differences');
  const reviewProgress = el('strong', '', 'review-flow-progress'); reviewProgress.setAttribute('role', 'status');
  const reviewNext = button('Start review', () => { reviewStarted = true; void advanceReview(); stateChanged(); }, 'button primary'); reviewNext.dataset.reviewAction = 'start';
  const reviewUndo = button('Undo decision', undoReview); reviewUndo.dataset.reviewAction = 'undo';
  const reviewDownload = button('Download updated B', () => saveSide('right'), 'button primary'); reviewDownload.dataset.reviewAction = 'download'; reviewDownload.hidden = true;
  const reviewHint = el('p', 'Choose what to keep, one difference at a time.', 'review-flow-hint');
  reviewBar.append(reviewProgress, reviewNext, reviewUndo, reviewHint);
  const finalCheck = createFinalCheck(reviewBar, {beforeCheck: () => {if (!alive()) return false; for (const side of sides) drafts[side].endEdit(); changed(); return true;}, onGo: () => {reviewStarted = true; void advanceReview();}, scope: 'Current text, text order and supported Word table structure are checked. Images, fonts and page appearance are not compared.'});
  reviewBar.append(reviewDownload); root.append(reviewBar); if(single)reviewBar.hidden=true;
  const structureReview = el('section', undefined, 'review-structure'); structureReview.hidden = true;
  structureReview.append(el('p', 'Review the document order and table layout in both versions.'), button('Keep B layout', () => decideReview('keep', STRUCTURE_KEY)), button('Back to text', () => { reviewingStructure = false; structureReview.hidden = true; }));
  root.append(structureReview);
  const grid = el('div', undefined, 'visual-columns'); root.append(grid);
  const inspector = el('section', undefined, 'visual-inspector'); inspector.hidden = true; inspector.setAttribute('aria-label', "Edit selected text");
  const inspectorHead = el('div', undefined, 'visual-inspector-head');
  const inspectorTitle = el('strong', "Selected text");
  const done = button("Done ✓", () => {
    if (!alive()) return;
    for (const timer of Object.values(typingTimers)) clearTimeout(timer);
    for (const side of sides) drafts[side].endEdit();
    if (reviewStarted && selected && reviewQueue.has(selected)) { decideReview('keep'); return; }
    selectionGeneration++; inspector.hidden = true; root.classList.remove('is-editing'); selected = null; refresh(); stateChanged();
  });
  inspectorHead.append(inspectorTitle); if(!single)inspectorHead.append(button("Explain this change", () => onExplain(getAssistantContext()))); inspectorHead.append(done);
  const reviewActions = el('div', undefined, 'review-decision-actions');
  const reviewUse = button('Use A', () => decideReview('use-a'), 'button primary'); reviewUse.dataset.reviewAction = 'use-a';
  const reviewKeep = button('Keep B', () => decideReview('keep')); reviewKeep.dataset.reviewAction = 'keep';
  const reviewReopen = button('Review again', () => { if (!selected) return; reviewQueue.reopen(selected); reviewHistory = []; changed(); stateChanged(); }); reviewReopen.dataset.reviewAction = 'reopen';
  const reviewDecisionHint = el('span', 'Or edit below, then choose Done.', 'review-decision-hint');
  reviewActions.append(reviewUse, reviewKeep, reviewReopen, reviewDecisionHint);
  inspector.append(inspectorHead, reviewActions); if(single)reviewActions.hidden=true;
  const fields = el('div', undefined, 'visual-edit-fields'); inspector.append(fields); root.append(inspector);
  const input = {};
  for (const side of sides) {
    const panel = el('section', undefined, 'visual-column'), heading = el('div', undefined, 'visual-column-heading');
    const name = el('span', sources[side].name, 'visual-file-name'); name.title = sources[side].name;
    const undo = button('↶', () => act(side, draft => draft.undo())); undo.setAttribute('aria-label', single ? "Undo edit" : `Undo edit in ${letter(side)}`);
    const save = button(single ? "Download" : `Download ${letter(side)}`, () => saveSide(side), 'button primary'); save.dataset.saveSide = side;
    let outputFormat;
    if(report.sources[side].format==='docx'){outputFormat=el('select',undefined,'document-download-format');outputFormat.setAttribute('aria-label',single ? "Download format" : `Download format for ${letter(side)}`);outputFormat.dataset.downloadFormat=side;for(const [value,label]of [['docx','Word (.docx)'],['pdf','PDF (.pdf)']]){const option=el('option',label);option.value=value;if(value==='pdf'&&models[side]?.headersFooters?.length){option.disabled=true;option.textContent='PDF (headers/footers not supported)';}outputFormat.append(option);}}
    const menu = el('details', undefined, 'visual-more'); menu.append(el('summary', '⋯'));
    if(report.sources[side].format==='pdf'){const textPdf=button('Download text-only PDF',()=>saveSide(side,{textOnly:true}));textPdf.dataset.pdfTextOnly=side;menu.append(textPdf,el('p','Text-only PDF and TXT downloads do not include images or page formatting.','pdf-export-hint'));}
    menu.append(button(`Download ${letter(side)} as TXT`, () => download(drafts[side].exportText(), filename(side, 'txt'), 'text/plain;charset=utf-8')));
    heading.append(el('span', letter(side), 'letter'), name, undo);if(outputFormat)heading.append(outputFormat);heading.append(save, menu); panel.append(heading); if(single){panel.hidden=side==='right';heading.querySelector('.letter').hidden=true;menu.hidden=true;}
    if (models[side]?.headersFooters?.length) {
      const note=el('p','Only the main body is compared and edited. Headers and footers are kept unchanged in Word downloads. PDF export is unavailable for this document.','docx-coverage-note');
      note.dataset.docxPeripheralNote=side;
      const details=el('details',undefined,'docx-peripheral-parts');details.dataset.docxPeripheral=side;
      details.append(el('summary','Headers and footers — read-only, not compared'));
      const counts={header:0,footer:0};
      for(const part of models[side].headersFooters){
        details.append(el('strong',`${part.kind==='header'?'Header':'Footer'} ${++counts[part.kind]}`));
        const text=el('p',part.text || '(Empty)');text.style.whiteSpace='pre-wrap';details.append(text);
      }
      panel.append(note,details);
    }
    let pdfDocument, pdfText, pdfPreview, pdfHint, pdfRecovery, pdfUndo, pdfAdjust;
    const pdfState = el('p', '', 'pdf-export-state'); pdfState.setAttribute('role', 'status'); pdfState.id = `${single ? "single-" : ""}pdf-status-${side}`;
    if (report.sources[side].format === 'pdf') {
      const controls = el('div', undefined, 'pdf-view-controls'), views = el('div', undefined, 'pdf-view-switch');
      views.setAttribute('role','group'); views.setAttribute('aria-label', `View of document ${letter(side)}`);
      pdfDocument = button('Document', () => changePdfView(side, false)); pdfDocument.dataset.pdfView = side;
      pdfText = button('Text', () => changePdfView(side, true)); pdfText.dataset.pdfTextView = side;
      pdfPreview = button('Preview PDF', () => changePdfView(side, false), 'button primary'); pdfPreview.dataset.pdfPreview = side;
      views.append(pdfDocument, pdfText); controls.append(views, pdfPreview);
      pdfHint = el('p', '', 'pdf-view-hint');
      pdfRecovery = el('div', undefined, 'pdf-recovery'); pdfRecovery.hidden = true;
      pdfUndo = button('Undo last edit', () => act(side, draft => draft.undo())); pdfUndo.dataset.pdfUndo = side;
      const keepEditing = button('Continue editing', () => {const key=selected || drafts[side].entries()[0]?.key;if(key)void select(key,side);}); keepEditing.dataset.pdfContinue = side;
      const textOnly = button('Download text-only PDF', () => saveSide(side,{textOnly:true})); textOnly.dataset.pdfFallback = side;
      pdfAdjust = button('Adjust text area', async () => {const key=pdfRepairKey(side);if(key){await select(key,side);await replacePdfBlock(side);}}, 'button primary');pdfAdjust.dataset.pdfAdjust=side;
      pdfRecovery.append(pdfAdjust, pdfUndo, keepEditing, textOnly);
      save.setAttribute('aria-describedby',pdfState.id);
      panel.append(controls, pdfHint, pdfState, pdfRecovery);
      if (report.sources[side].link_count > 0) {
        const linkHint = el('p', 'Link destinations are not compared. Edited PDF downloads do not retain clickable links; the unchanged original keeps its links.', 'pdf-export-hint');
        linkHint.dataset.pdfLinkNote = side;
        panel.append(linkHint);
      }
    }
    const pageNav = el('div', undefined, 'visual-page-nav'), pageLabel = el('span'); pageNav.hidden = report.sources[side].format !== 'pdf';
    const navigate = offset => { if (!alive() || !activeViewer(side)) return; const page = Math.max(1, Math.min(activeViewer(side).pageCount, pages[side] + offset)); if (page === pages[side]) return; pages[side] = page; void renderSide(side); stateChanged(); };
    const previous = button('←', () => navigate(-1)), following = button('→', () => navigate(1));
    previous.disabled = following.disabled = true;
    previous.setAttribute('aria-label', single ? "Previous page" : `Previous page of ${letter(side)}`); following.setAttribute('aria-label', single ? "Next page" : `Next page of ${letter(side)}`);
    pageNav.append(previous, pageLabel, following); panel.append(pageNav);
    const scroll = el('div', undefined, 'visual-scroll'); scroll.setAttribute('aria-label', single ? "Document" : `Document ${letter(side)}`); panel.append(scroll); grid.append(panel);
    ui[side] = {panel, scroll, pageLabel, previous, following, undo, save, outputFormat, pdfState, pdfDocument, pdfText, pdfPreview, pdfHint, pdfRecovery, pdfUndo, pdfAdjust, pageNav};
    scroll.addEventListener('scroll', () => { if (!alive()) return; const position = readScroll(side), before = scrollPositions[side]; if (position.top !== before.top || position.left !== before.left) { scrollPositions[side] = position; stateChanged(); } });
    const fieldLabel = el('div', undefined, 'visual-edit-label'), field = el('textarea'); field.rows = 3; field.maxLength = 500000;
    field.id = `${single ? "single-" : ""}visual-edit-${side}`;
    const caption = el('label', single ? "Selected text" : `Version ${letter(side)} · Selected text`, 'visual-edit-caption'); caption.htmlFor = field.id;
    field.setAttribute('aria-label', single ? "Edit selected text" : `Edit version ${letter(side)}`); field.dataset.editSide = side; fieldLabel.append(caption, field);
    const copy = button(`Use text from ${letter(other(side))} ${side === 'right' ? '→' : '←'}`, () => copyTo(side)); copy.dataset.copyTo = side;
    fieldLabel.append(copy); if(single){copy.hidden=true;fieldLabel.hidden=side==='right';}
    const replaceBlock = button('Replace block', () => replacePdfBlock(side)); replaceBlock.dataset.replaceBlock = side; replaceBlock.hidden = true;
    fieldLabel.append(replaceBlock); ui[side].replaceBlock = replaceBlock;
    const rowTools = el('section', undefined, 'visual-row-tools'), rowTitle = el('strong', '', 'visual-row-title'), rowHint = el('small'); rowTools.hidden = true;
    rowTitle.id = `${single ? "single-" : ""}visual-row-title-${side}`; rowHint.id = `${single ? "single-" : ""}visual-row-hint-${side}`;
    rowTools.setAttribute('aria-labelledby', rowTitle.id);
    const above = button("+ Add above", () => editRow(side, 'before'));
    const below = button("+ Add below", () => editRow(side, 'after'));
    const remove = button("Delete row", () => editRow(side, 'delete'));
    const transfer = button('', () => copyRowTo(other(side)), 'button primary visual-row-transfer'); transfer.dataset.copyRowFrom = side; transfer.hidden = true;
    transfer.title = "Copy every cell in this row. Other edits in the adjacent version will be preserved.";
    const replaceRow = button('', () => replaceRowText(other(side)), 'button primary visual-row-transfer');
    replaceRow.dataset.copyRowTextFrom = side; replaceRow.hidden = true; replaceRow.setAttribute('aria-describedby', rowHint.id);
    above.dataset.insertRow = 'before'; below.dataset.insertRow = 'after'; remove.dataset.deleteRow = '';
    for (const control of [above, below, remove]) { control.dataset.rowSide = side; control.setAttribute('aria-describedby', rowHint.id); }
    rowTools.append(rowTitle, rowHint, replaceRow, transfer, above, below, remove); fieldLabel.append(rowTools);
    Object.assign(ui[side], {copy, rowTools, rowTitle, rowHint, above, below, remove, transfer, replaceRow});
    fields.append(fieldLabel); input[side] = field;
    field.addEventListener('input', () => {
      if (!alive() || !selected) return;
      try { const before = drafts[side].revision; drafts[side].edit(selected, field.value); changed(); if (drafts[side].revision !== before) stateChanged(); } catch (error) { field.value = value(side, selected) ?? ''; message(error.message); }
      clearTimeout(typingTimers[side]); typingTimers[side] = setTimeout(() => { if (alive()) renderSide(side); }, 350);
    });
    field.addEventListener('blur', () => drafts[side].endEdit());
    if(single&&side==='left'&&['txt','docx'].includes(report.sources[side].format))wording=mountWordingOptions(fieldLabel,{
      field,context:()=>({key:selected,revision:drafts[side].revision}),
      apply:text=>{if(!alive()||!selected||field.disabled)throw Error('Select text to edit first.');drafts[side].endEdit();drafts[side].edit(selected,text);drafts[side].endEdit();field.value=text;changed();stateChanged();void renderSide(side);}
    });
  }
  function changePdfView(side, asText) {
    if (!alive()) return;
    clearTimeout(typingTimers[side]); drafts[side].endEdit();
    // An explicit preview retries a failed attempt while keeping all document edits.
    if (!asText && previewFailures[side]) clearPdfPreview(side);
    automaticText[side] = false; textViews[side] = asText;
    updatePdfControls(side); void renderSide(side); if(single)stateChanged();
  }
  function pdfRepairKey(side) {
    const entries=drafts[side].entries(), eligible=entry=>{const block=row(byKey.get(entry.key),side);return block&&(block.source_blocks||[block]).length===1&&entry.text!==block.text;};
    return (entries.find(entry=>entry.key===selected&&eligible(entry))||entries.find(eligible))?.key;
  }
  function updatePdfControls(side) {
    const controls = ui[side]; if (!controls.pdfDocument) return;
    controls.pdfAdjust.disabled = !pdfRepairKey(side);
    controls.pdfDocument.setAttribute('aria-pressed', String(!textViews[side]));
    controls.pdfText.setAttribute('aria-pressed', String(textViews[side]));
    controls.pdfPreview.hidden = !textViews[side];
    controls.pdfHint.textContent = textViews[side] ? 'Your images are kept. Preview PDF to see your edits in the document.' : '';
    controls.pageNav.hidden = textViews[side];
  }
  function pdfStateChanged(side, error) {
    pdfErrors[side] = error;
    const failure = previewFailures[side]?.revision === drafts[side].revision ? previewFailures[side] : null;
    const issue = failure ? pdfIssue(failure.message) : null;
    ui[side].pdfState.textContent = issue ? `${issue[0]} Your edits are kept. ${issue[1]} A text-only PDF will not include images or page formatting.` : '';
    ui[side].pdfRecovery.hidden = !issue;
    ui[side].pdfUndo.disabled = !drafts[side].canUndo;
    ui[side].save.textContent = 'Download PDF';
    ui[side].save.dataset.pdfMode = error ? 'reflow' : 'original';
    ui[side].save.disabled = exporting[side] || pdfChecking[side] || !!failure;
    updatePdfControls(side);
    reviewDownload.textContent = 'Download updated B';
    if (side === 'right') reviewDownload.disabled = ui[side].save.disabled;
  }
  function filename(side, ext) { return sources[side].name.replace(/\.[^.]*$/, '') + (single ? `-edited.${ext}` : `-version-${letter(side)}.${ext}`); }
  function message(text = '') { if (!alive()) return; status.textContent = text; status.hidden = !text; }
  function value(side, key) {
    if (key?.startsWith('row-') && !drafts[side].entries().some(entry => entry.key === key)) return null;
    return drafts[side].get(key);
  }
  function syncGroups() {
    groups = [...originalGroups]; byKey.clear();
    for (const group of groups) byKey.set(group.key, group);
    for (const side of sides) for (const entry of drafts[side].entries()) {
      if (byKey.has(entry.key) && !byKey.get(entry.key).dynamic) continue;
      let group = byKey.get(entry.key);
      if (!group) { group = {key: entry.key, category: 'changed', dynamic: true}; groups.push(group); byKey.set(entry.key, group); }
      group[side] = entry;
    }
    if (selected && !byKey.has(selected)) { selected = null; inspector.hidden = true; root.classList.remove('is-editing'); }
  }
  function rowPosition(side) {
    if (!selected || !models[side]?.hasTables || !drafts[side].rowPlan) return null;
    const entry = drafts[side].entries().find(entry => entry.key === selected);
    if (!entry) return null;
    const layout = normalizeWordRows(models[side].content, drafts[side].rowPlan()).content;
    for (const table of layout.filter(item => item.type === 'table')) for (let i = 0; i < table.rows.length; i++) {
      const row = table.rows[i];
      if (row.cells.some(cell => cell.content.some(p => p.record === entry.record))) return {table: table.index, index: i + 1, row, count: table.rows.length};
    }
    return null;
  }
  function updateRowTools() {
    for (const side of sides) {
      const position = rowPosition(side), controls = ui[side]; controls.rowTools.hidden = !position;
      controls.replaceRow.hidden = !position?.row.source || !drafts[side].rowTextCopyState || !drafts[other(side)].rowTextCopyState;
      const rowCopyState = controls.replaceRow.hidden ? null : drafts[other(side)].rowTextCopyState(drafts[side], selected);
      if (rowCopyState) {
        controls.replaceRow.disabled = !rowCopyState.available || rowCopyState.equal;
        controls.replaceRow.textContent = rowCopyState.equal ? "Row text matches ✓" : `Make row in ${letter(other(side))} match ${letter(side)} ${side === 'left' ? '→' : '←'}`;
      }
      controls.transfer.hidden = !position?.row.id || !drafts[other(side)].copyRowFrom;
      if (!controls.transfer.hidden) {
        const target = other(side), exists = value(target, selected) !== null;
        const same = exists && position.row.cells.every(cell => cell.content.every(p => {
          const entry = drafts[side].entries().find(entry => entry.record === p.record);
          return entry && value(target, entry.key) === entry.text;
        }));
        controls.transfer.textContent = same ? `Row already in ${letter(target)} ✓` : `${exists ? "Update" : "Copy"} row to ${letter(target)} ${target === 'right' ? '→' : '←'}`;
        controls.transfer.disabled = same;
      }
      if (position) {
        const locked = position.row.mutable === false;
        controls.rowTitle.textContent = `${position.row.id ? "New row" : "Table row"} · ${position.index}`;
        controls.rowTools.classList.toggle('is-locked', locked);
        controls.above.disabled = controls.below.disabled = locked;
        controls.remove.disabled = locked || position.count === 1;
        const transferable = !!drafts[other(side)].copyRowFrom;
        controls.rowHint.textContent = locked ? "A cell here spans multiple rows. You can edit the text. To add a row, select a different table row." : position.row.id ? transferable ? `Version ${letter(other(side))} receives a copy of the entire row. Version ${letter(side)} keeps the row. Repeating this action updates the copied text.` : "Fill in the new row's cells." : transferable ? `Add a blank row, fill it in, and copy it to ${letter(other(side))}.` : "Add a blank row and fill it in.";
        if (rowCopyState) controls.rowHint.textContent = rowCopyState.available ? `Version ${letter(other(side))} will have all text in the row updated. Photos and formatting in ${letter(other(side))} will be preserved.` : rowCopyState.reason;
        if (!locked && position.count === 1) controls.rowHint.textContent += " The last row cannot be deleted.";
      }
      const absent = !!selected && value(side, selected) === null;
      const unavailable = absent && (models[side]?.hasTables || byKey.get(selected)?.dynamic);
      input[side].disabled = unavailable;
      controls.copy.disabled = unavailable || !!selected && value(other(side), selected) === null && models[side]?.hasTables;
      input[side].placeholder = unavailable ? byKey.get(selected)?.dynamic && drafts[side].copyRowFrom ? `This row is missing here. Click “Copy row to ${letter(side)}” in the adjacent version.` : "This row is missing here. Copy the entire document or undo the deletion." : '';
    }
  }
  function replaceRowText(side) {
    if (!alive() || !selected || !drafts[side].replaceRowTextFrom) return;
    try {
      const before = drafts[side].revision;
      selected = drafts[side].replaceRowTextFrom(drafts[other(side)], selected);
      refresh();
      if (drafts[side].revision !== before) stateChanged();
      message(`Row text in ${letter(side)} updated. To undo, click ↶ next to version ${letter(side)}.`);
      if (reviewStarted && reviewQueue.reviewed(selected)) void advanceReview(selected);
      else void select(selected, side);
    } catch (error) { message(error.message); }
  }
  function copyRowTo(side) {
    if (!alive() || !selected || !drafts[side].copyRowFrom) return;
    try {
      const before = drafts[side].revision;
      drafts[side].copyRowFrom(drafts[other(side)], selected);
      refresh();
      if (drafts[side].revision !== before) stateChanged();
      message(`Row copied to ${letter(side)}. To undo, click ↶ next to version ${letter(side)}.`);
      if (reviewStarted && reviewQueue.reviewed(selected)) void advanceReview(selected);
      else void select(selected, side);
    } catch (error) { message(error.message); }
  }
  function editRow(side, action) {
    if (!alive()) return;
    const position = rowPosition(side); if (!position) return;
    try {
      for (const timer of Object.values(typingTimers)) clearTimeout(timer);
      drafts[side].endEdit();
      if (action === 'delete') {
        drafts[side].deleteRow(position.table, position.index); selected = null;
        inspector.hidden = true; root.classList.remove('is-editing');
      } else {
        const inserted = drafts[side].insertRow(position.table, position.index, action);
        selected = typeof inserted === 'string' ? inserted : inserted?.key || null;
      }
      refresh(); stateChanged();
      message(action === 'delete' ? "Row deleted. Click ↶ to restore it." : "Blank row added. Click a cell and enter text.");
      if (selected) void select(selected, side);
    } catch (error) { message(error.message); }
  }
  function updateDifferences() {
    if(single){diffKeys.clear();return;}
    const values = {}, orders = {};
    for (const side of sides) {
      values[side] = new Map(); orders[side] = [];
      for (const entry of drafts[side].entries()) {
        if (!values[side].has(entry.key)) { values[side].set(entry.key, []); orders[side].push(entry.key); }
        values[side].get(entry.key).push(entry.text);
      }
    }
    const shared = new Set(orders.left.filter(key => values.right.has(key)));
    const indexes = Object.fromEntries(sides.map(side => [side, new Map(orders[side].filter(key => shared.has(key)).map((key, i) => [key, i]))]));
    diffKeys = new Set(groups.filter(group => {
      const a = values.left.has(group.key) ? values.left.get(group.key).join('\n') : null;
      const b = values.right.has(group.key) ? values.right.get(group.key).join('\n') : null;
      return a !== b || group.category === 'moved' && indexes.left.get(group.key) !== indexes.right.get(group.key);
    }).map(group => group.key));
  }
  function different(group) { return !single && !!group && diffKeys.has(group.key); }
  function differences() { return groups.filter(different); }
  let assistantEquality = {textsEqual: false, structureDiffers: false};
  function getAssistantContext() {
    const texts = side => { const entries = drafts[side].entries().filter(entry => entry.key === selected); return entries.length ? entries.map(entry => entry.text).join('\n') : null; };
    return {edited: drafts.left.changed || drafts.right.changed, count: differences().length, ...assistantEquality,
      selected: selected ? {key: selected, different: diffKeys.has(selected), left: texts('left'), right: texts('right')} : null};
  }
  function changed() {
    if (!alive()) return;
    syncGroups(); updateDifferences();
    for (const side of sides) if (report.sources[side].format === 'pdf' && pdfRevision[side] !== drafts[side].revision) { pdfRevision[side] = drafts[side].revision; if (automaticText[side] && viewers[side]) {textViews[side] = false; automaticText[side] = false;} clearPdfPreview(side); generations[side]++; pdfChecking[side] = true; ui[side].save.disabled = true; }
    const shape = side => models[side]?.hasTables ? normalizeWordRows(models[side].content, drafts[side].rowPlan?.()).content.filter(item => item.type === 'table').map(table => table.rows.map(row => row.cells.map(cell => [cell.column, cell.colSpan, cell.rowSpan, cell.content.length]))) : null;
    const structureDiffers = models.left?.hasTables && models.right?.hasTables && JSON.stringify(shape('left')) !== JSON.stringify(shape('right'));
    const count = differences().length, equal = drafts.left.text() === drafts.right.text() && !structureDiffers;
    if (equal) diffKeys.clear();
    assistantEquality = {textsEqual: equal, structureDiffers: !!structureDiffers};
    progress.textContent = equal ? "Texts match ✓" : count ? `Differences: ${count}` : structureDiffers ? "Table structures differ" : "Text order differs";
    next.disabled = back.disabled = equal;
    all.disabled = equal;
    for (const side of sides) ui[side].undo.disabled = !drafts[side].canUndo;
    for (const side of sides) {const block=selected&&row(byKey.get(selected),side);ui[side].replaceBlock.hidden=report.sources[side].format!=='pdf'||!block||(block.source_blocks||[block]).length!==1||value(side,selected)===null;}
    if (selected) inspectorTitle.textContent = different(byKey.get(selected)) ? "Edit here or use the text from the adjacent version" : "This section matches ✓";
    updateRowTools();
    wording?.refresh();
    updateReviewProgress();
    if(single){progress.textContent=drafts.left.changed ? "Edited document" : "Your document";inspectorTitle.textContent="Edit selected text";for(const side of sides){ui[side].transfer.hidden=ui[side].replaceRow.hidden=true;if(!ui[side].rowTools.hidden)ui[side].rowHint.textContent=ui[side].rowTools.classList.contains("is-locked") ? "A cell spans multiple rows. You can edit the text; select another row to add a row." : ui[side].remove.disabled ? "Edit the cells or add a blank row. The last row cannot be deleted." : "Edit the cells, add a blank row, or delete this row. Undo restores your last change.";}}
    onRevision(drafts.left.changed || drafts.right.changed);
    onSelectionChange(getAssistantContext());
    for (const node of root.querySelectorAll('[data-group]')) {
      node.classList.toggle('has-difference', different(byKey.get(node.dataset.group)));
      node.classList.toggle('is-selected', node.dataset.group === selected);
      node.classList.toggle('is-reviewed', reviewQueue.has(node.dataset.group) && reviewQueue.reviewed(node.dataset.group));
    }
    finder?.refresh();
  }
  function updateReviewProgress() {
    if(single){reviewActions.hidden=true;return;}
    const revisions = sides.map(side => drafts[side].revision).join(':');
    if (lastRevisions !== null && lastRevisions !== revisions && !decisionInProgress) reviewHistory = [];
    lastRevisions = revisions;
    const entries = Object.fromEntries(sides.map(side => [side, drafts[side].entries()]));
    const values = Object.fromEntries(sides.map(side => { const map = new Map(); for (const entry of entries[side]) { if (!map.has(entry.key)) map.set(entry.key, []); map.get(entry.key).push(entry.text); } return [side, map]; }));
    reviewItems = groups.map(group => ({key: group.key, differs: different(group), signature: JSON.stringify(sides.map(side => [values[side].get(group.key) ?? null, group.category === 'moved' ? entries[side].findIndex(entry => entry.key === group.key) : null]))}));
    const structureDiffers = assistantEquality.structureDiffers || !assistantEquality.textsEqual && !diffKeys.size;
    // Keep a tracked layout item after it resolves, so the total does not jump.
    if (structureDiffers || reviewQueue.has(STRUCTURE_KEY)) reviewItems.push({key: STRUCTURE_KEY, differs: structureDiffers, signature: JSON.stringify(sides.map(side => [entries[side].map(entry => entry.key), drafts[side].rowPlan?.() ?? null]))});
    reviewQueue.sync(reviewItems);
    finalCheck.update(reviewItems, reviewQueue, revisions);
    const progress = reviewQueue.progress();
    reviewProgress.textContent = progress.total ? `Reviewed ${progress.reviewed} of ${progress.total}` : 'No text differences to review';
    const complete = progress.pending === 0;
    const remaining = reviewItems.filter(item => item.differs).length;
    reviewBar.classList.toggle('is-complete', complete);
    reviewHint.textContent = complete ? (remaining ? 'All differences reviewed. Your chosen differences remain. Check again to finish.' : 'All differences reviewed. Check again, then download your updated document.') : 'Choose Use A or Keep B. You can also edit either version.';
    reviewNext.textContent = reviewStarted ? 'Next to review' : 'Start review'; reviewNext.disabled = !progress.pending;
    reviewUndo.disabled = !reviewHistory.length || reviewHistory.at(-1).copied && !drafts.right.canUndo;
    reviewDownload.hidden = !complete; reviewDownload.disabled = exporting.right || pdfChecking.right || ui.right.save.disabled;
    reviewDownload.textContent = 'Download updated B';
    if (complete && previewFailures.right?.revision === drafts.right.revision) reviewHint.textContent = 'Text review complete. Check the saving options in version B.';
    structureReview.hidden = !reviewingStructure || !reviewQueue.pending().includes(STRUCTURE_KEY);
    const tracked = selected && reviewQueue.has(selected), pending = tracked && !reviewQueue.reviewed(selected);
    reviewActions.hidden = !tracked;
    reviewUse.disabled = !pending || ui.right.copy.disabled;
    reviewUse.title = ui.right.copy.disabled ? 'Use the table row controls below for this change.' : 'Use the text from A in B and continue';
    reviewKeep.disabled = !pending;
    reviewReopen.hidden = !tracked || pending || !different(byKey.get(selected));
    done.textContent = reviewStarted && tracked ? 'Done — next difference' : 'Done ✓';
  }
  async function advanceReview(after) {
    if (!alive()) return;
    const key = reviewQueue.next(after);
    reviewingStructure = key === STRUCTURE_KEY;
    if (reviewingStructure || key === null) {
      selected = null; selectionGeneration++; inspector.hidden = true; root.classList.remove('is-editing'); changed();
      (reviewingStructure ? structureReview : reviewBar).scrollIntoView({behavior: 'smooth', block: 'nearest'});
      const target = reviewingStructure ? structureReview.querySelector('button') : reviewDownload.hidden ? reviewNext : reviewDownload;
      target.focus({preventScroll: true});
    } else {
      await select(key);
      if (!alive()) return;
      (reviewUse.disabled ? reviewKeep : reviewUse).focus({preventScroll: true});
      inspector.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }
    stateChanged();
  }
  function decideReview(action, key = selected) {
    if (!alive() || !key || !reviewQueue.has(key)) return;
    const alreadyReviewed = reviewQueue.reviewed(key);
    if (action === 'use-a' && (key === STRUCTURE_KEY || ui.right.copy.disabled || alreadyReviewed)) return;
    decisionInProgress = true;
    try {
      const before = drafts.right.revision;
      if (action === 'use-a') drafts.right.set(key, value('left', key), {relocate: byKey.get(key).category === 'moved'});
      refresh();
      if (!reviewQueue.accept(key)) return;
      reviewStarted = true;
      if (!alreadyReviewed || drafts.right.revision !== before) {
        reviewHistory.push({key, copied: drafts.right.revision !== before});
        if (reviewHistory.length > 20) reviewHistory.shift();
      }
      changed(); stateChanged(); void advanceReview(key);
    } catch (error) { message(error.message); }
    finally { decisionInProgress = false; }
  }
  function undoReview() {
    if (!alive() || !reviewHistory.length || reviewUndo.disabled) return;
    const decision = reviewHistory.pop(); decisionInProgress = true;
    try {
      if (decision.copied) drafts.right.undo();
      reviewQueue.reopen(decision.key); refresh();
      if (decision.key === STRUCTURE_KEY) { reviewingStructure = true; changed(); }
      else if (byKey.has(decision.key)) void select(decision.key);
      stateChanged();
    } finally { decisionInProgress = false; }
  }
  function act(side, callback) {
    if (!alive()) return;
    try { const before = drafts[side].revision; callback(drafts[side]); message(); refresh(); if (drafts[side].revision !== before) stateChanged(); } catch (error) { message(error.message); }
  }
  function copyTo(side) {
    if (!selected) return;
    if (reviewStarted && side === 'right' && reviewQueue.has(selected) && !reviewQueue.reviewed(selected)) { decideReview('use-a'); return; }
    const text = value(other(side), selected), group = byKey.get(selected);
    act(side, draft => draft.set(selected, text, {relocate: group.category === 'moved'}));
  }
  function refresh() {
    if (!alive()) return;
    changed();
    if (selected) for (const side of sides) input[side].value = value(side, selected) ?? '';
    for (const side of sides) void renderSide(side);
  }
  async function select(key, focusSide) {
    if (!alive()) return;
    if (!byKey.has(key)) throw new Error("Section not found.");
    reviewingStructure = false;
    for (const timer of Object.values(typingTimers)) clearTimeout(timer); const selection = ++selectionGeneration; selected = key; inspector.hidden = false; root.classList.add('is-editing');
    const group = byKey.get(key);
    inspectorTitle.textContent = different(group) ? "Edit here or use the text from the adjacent version" : "You can edit both versions";
    for (const side of sides) {
      if (!alive() || selection !== selectionGeneration) return;
      input[side].value = value(side, key) ?? '';
      if (pdfChecking[side]) await renderSide(side);
      if (!alive() || selection !== selectionGeneration) return;
      const rects = pdfPreviews[side]?.layout.filter(rect => rect.key === key), location = row(group, side);
      const page = rects ? (rects.find(rect => rect.page === pages[side]) || rects[0])?.page : location?.page || location?.source_blocks?.[0]?.page;
      if (page && pages[side] !== page) { pages[side] = page; await renderSide(side); }
      if (!alive() || selection !== selectionGeneration) return;
      const target = [...ui[side].scroll.querySelectorAll('[data-group]')].find(node => node.dataset.group === key);
      if (target) alignTarget(ui[side].scroll, target);
    }
    changed(); if (focusSide) input[focusSide].focus({preventScroll: true});
    for (const side of sides) scrollPositions[side] = readScroll(side);
    stateChanged();
  }
  function alignTarget(scroll, target) {
    scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - Math.min(140, scroll.clientHeight / 3);
  }
  function jump(direction) {
    const diff = differences(); if (!diff.length) return;
    const index = diff.findIndex(group => group.key === selected);
    const nextIndex = index < 0 ? (direction > 0 ? 0 : diff.length - 1) : (index + direction + diff.length) % diff.length;
    void select(diff[nextIndex].key);
  }
  async function replacePdfBlock(side) {
    if(!alive()||!selected)return;
    const key=selected,block=row(byKey.get(key),side),parts=block?.source_blocks||[block];
    if(parts.length!==1||!parts[0]?.visual)return;
    blockDialog?.close();drafts[side].endEdit();
    const revision=drafts[side].revision,entries=drafts[side].entries(),entry=entries.find(e=>e.key===key);
    if(!entry)return;
    const {openBlockDialog}=await import('./pdf-block-dialog.mjs');
    if(!alive()||selected!==key||drafts[side].revision!==revision||blockDialog)return;
    blockDialog=openBlockDialog({host:root,source:sources[side],block:parts[0],blocks:sourceBlocks(side),entry,
      edits:(text,box)=>pdfEdits(side,entries.map(e=>e.key===key?{...e,text,pdfBox:box}:e)),
      current:()=>alive()&&drafts[side].revision===revision,
      apply:(text,box)=>{drafts[side].replaceBlock(key,text,box);textViews[side]=false;automaticText[side]=false;refresh();stateChanged();},
      onClose:()=>{blockDialog=null;}});
  }
  function pdfEdits(side, entries = drafts[side].entries()) {
    const records = entries.map(entry => entry.record);
    if (records.some((record, i) => i && record < records[i - 1])) throw new Error("Section order changed.");
    const edits = [];
    for (const group of groups) {
      const block = row(group, side),items=entries.filter(e=>e.key===group.key),current=items.length?items.map(e=>e.text).join('\n'):null;
      if (!block) { if (current !== null) throw new Error("New section added."); continue; }
      const parts = block.source_blocks || [block], original = parts.map(part => part.text).join('\n');
      if(items[0]?.pdfBox){if(parts.length!==1||items.length!==1)throw new Error('Select one text block to replace.');edits.push({block:parts[0],text:current,box:items[0].pdfBox});continue;}
      if (current === original) continue;
      const texts = current === null ? parts.map(() => '') : current.split('\n');
      if (texts.length !== parts.length) throw new Error("Line breaks changed.");
      parts.forEach((part, i) => edits.push({block: part, text: texts[i]}));
    }
    return edits;
  }
  function clearPdfPreview(side) {
    previewJobs[side]?.controller.abort(); delete previewJobs[side];
    if (pdfPreviews[side]) void pdfPreviews[side].viewer.dispose().catch(() => {});
    delete pdfPreviews[side]; delete previewFailures[side];
  }
  async function ensurePdfPreview(side) {
    const revision = drafts[side].revision;
    if (pdfPreviews[side]?.revision === revision) return pdfPreviews[side];
    if (previewFailures[side]?.revision === revision) throw Error(previewFailures[side].message);
    if (previewJobs[side]?.revision === revision) return previewJobs[side].promise;
    const controller = new AbortController(), entries = drafts[side].entries(), blocks = sourceBlocks(side);
    const job = {revision, controller}; previewJobs[side] = job;
    job.promise = (async () => {
      let viewer;
      try {
        const {renderPreservedPdf} = await import('./pdf-layout.mjs');
        let layout;
        const data = await renderPreservedPdf(sources[side], entries, {blocks, signal:controller.signal, onLayout:rects => {layout = rects;}});
        const {openPdfVisual} = await import('./pdf-visual.mjs');
        viewer = await openPdfVisual({data}, {signal:controller.signal, generated:true});
        if (!alive() || controller.signal.aborted || drafts[side].revision !== revision) throw new DOMException('Canceled', 'AbortError');
        return pdfPreviews[side] = {revision, data, layout, viewer};
      } catch (error) {
        if (viewer) await viewer.dispose().catch(() => {});
        if (alive() && !controller.signal.aborted && drafts[side].revision === revision) previewFailures[side] = {revision, message:error.message};
        throw error;
      }
    })();
    return job.promise;
  }
  async function renderSide(side) {
    if (!alive() || single && side === 'right') return;
    const generation = ++generations[side], {scroll} = ui[side], scrollTop = scroll.scrollTop; scroll.setAttribute('aria-busy', 'true');
    try {
      let checkedEdits = [], checkedError = null, preview = null;
      if (report.sources[side].format === 'pdf') {
        ui[side].pageNav.hidden = textViews[side];
        updatePdfControls(side);
        if (!viewers[side] && !textViews[side]) {
          try {
            const {openPdfVisual} = await import('./pdf-visual.mjs');
            const viewer = await openPdfVisual(sources[side], {signal});
            if (!alive() || generation !== generations[side]) {await viewer.dispose(); return;}
            viewers[side] = viewer;
          } catch (error) {
            if (!alive() || generation !== generations[side]) return;
            previewFailures[side] = {revision:drafts[side].revision,message:error.message};
            textViews[side] = true; automaticText[side] = true;
          }
        }
        try {
          checkedEdits = pdfEdits(side);
          const {validatePdfEdits} = await import('./pdf-visual.mjs'); await validatePdfEdits(checkedEdits,{blocks:sourceBlocks(side),viewer:viewers[side]});
          if (checkedEdits.length && !viewers[side]) throw new Error('The original PDF pages could not be rendered.');
          // Background checks apply to every edited page, even in text view.
          for (const page of new Set(checkedEdits.map(edit=>edit.block.visual.page))) {
            if (!alive() || generation !== generations[side]) return;
            const canvas = el('canvas');
            try { await viewers[side].renderPage(page, canvas, {scale:1.5, edits:checkedEdits, blocks:sourceBlocks(side)}); }
            finally {canvas.width=canvas.height=0;}
          }
        } catch(error) {checkedError=error;}
        if (!alive() || generation !== generations[side]) return;
        if (checkedError && drafts[side].changed && !textViews[side]) {
          ui[side].pdfState.textContent = 'Updating document…';
          try { preview = await ensurePdfPreview(side); }
          catch (error) {
            if (!alive() || generation !== generations[side]) return;
            textViews[side] = true; automaticText[side] = true;
          }
          if (!alive() || generation !== generations[side]) return;
        }
        pdfChecking[side] = false; pdfStateChanged(side, checkedError?.message ?? null);
        ui[side].pageNav.hidden = textViews[side];
        updatePdfControls(side);
      }
      if (viewers[side] && !textViews[side]) {
        const viewer = preview?.viewer || viewers[side];
        pages[side] = Math.min(pages[side], viewer.pageCount);
        const pageNumber = pages[side];
        ui[side].previous.disabled = pageNumber <= 1; ui[side].following.disabled = pageNumber >= viewer.pageCount;
        ui[side].pageLabel.textContent = `${pageNumber} / ${viewer.pageCount}${preview ? ' · Updated' : ''}`;
        const paper = el('div', undefined, 'visual-pdf-page'), canvas = el('canvas');
        canvas.setAttribute('aria-label', single ? `Page ${pageNumber}` : `Page ${pageNumber} of document ${letter(side)}`);
        let edits = preview || checkedError ? [] : checkedEdits, editError = checkedError, painted = [];
        try { ({painted} = await viewer.renderPage(pageNumber, canvas, {scale: 1.5, edits, blocks:sourceBlocks(side)})); }
        catch (error) { if (!edits.length) throw error; editError = error; await viewer.renderPage(pageNumber, canvas, {scale: 1.5}); }
        if (!alive() || generation !== generations[side]) { canvas.width = canvas.height = 0; return; }
        paper.dataset.pdfRevision = String(drafts[side].revision); paper.dataset.pdfLayout = preview ? 'updated' : 'original';
        paper.append(canvas);
        const layer = el('div', undefined, 'visual-hotspots');
        for (const group of groups) {
          const source = row(group, side);
          let rects = preview ? preview.layout.filter(rect => rect.key === group.key) : source ? viewer.rects(source) : [];
          if(!preview&&!checkedError&&source&&painted.some(p=>p.autoFit))rects=(source.source_blocks||[source]).flatMap(part=>{const fitted=painted.find(p=>p.autoFit&&p.record===part.record);return fitted?[{page:fitted.page,x:fitted.x/part.visual.width,y:fitted.y/part.visual.height,width:fitted.width/part.visual.width,height:fitted.height/part.visual.height}]:viewer.rects(part);});
          const box=drafts[side].entries().find(e=>e.key===group.key)?.pdfBox;
          if(!preview&&!checkedError&&box&&source){const visual=(source.source_blocks||[source])[0].visual;rects=[{page:visual.page,x:Math.min(...visual.rects.map(r=>r.x))/visual.width,y:Math.min(...visual.rects.map(r=>r.y))/visual.height,width:box.width/visual.width,height:box.height/visual.height}];}
          for (const rect of rects.filter(rect => rect.page === pageNumber)) {
            const target = button('', () => select(group.key, side), 'visual-hotspot');
            target.dataset.group = group.key; target.setAttribute('aria-label', `${different(group) ? "Difference. " : ''}Edit${single ? '' : ' '+letter(side)}: ${(value(side, group.key) ?? '').slice(0, 120)}`);
            target.title = "Click to edit";
            Object.assign(target.style, {left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${Math.max(.3, rect.width * 100)}%`, height: `${Math.max(.7, rect.height * 100)}%`}); layer.append(target);
          }
        }
        paper.append(layer); scroll.replaceChildren(paper);
        pdfStateChanged(side, editError?.message ?? null);
        if (editError && !preview) { const note = el('p', 'Original page shown for reference. Download the updated PDF to see the new text layout with its images.', 'visual-inline-notice'); scroll.prepend(note); }
      } else {
        const paper = el('div', undefined, 'visual-paper');
        if (report.sources[side].format === 'pdf') paper.append(el('p', 'Click any text to edit. Your changes also appear in Document view.', 'visual-instruction'));
        const model = models[side]; if (model) paper.classList.add('visual-word');
        if (model) {
          paper.style.paddingLeft = `${model.page.marginLeft / model.page.width * 100}%`;
          paper.style.paddingRight = `${model.page.marginRight / model.page.width * 100}%`;
        }
        const projected = model ? projectWord(model, docxSequence(side), {rowPlan: drafts[side].rowPlan?.()}) : null;
        const entries = projected ? projected.blocks : drafts[side].entries();
        function paragraph(entry) {
          const p = el(entry.heading ? `h${entry.heading}` : 'p', undefined, 'visual-paragraph');
          style(p, entry.style);
          let content = p;
          if (entry.list) {
            const list = entry.list, marker = el('span', list.label, 'visual-list-marker');
            content = el('span', undefined, 'visual-list-content');
            p.classList.add('visual-list-item'); p.dataset.listLevel = String(list.level);
            marker.setAttribute('aria-hidden', 'true');
            const hanging = Math.max(0, list.indent?.hanging ?? 18), left = Math.max(0, list.indent?.left ?? (list.level + 1) * 36);
            const aligned = list.align === 'right' ? hanging : list.align === 'center' ? hanging / 2 : 0;
            p.style.paddingLeft = `${Math.max(0, left - hanging - aligned)}pt`;
            p.style.textIndent = '0';
            p.style.setProperty('--list-marker-width', list.suffix === 'tab' ? `max(0px, calc(${hanging}pt - .3em))` : '0px');
            p.style.setProperty('--list-gap', list.suffix === 'space' ? '.3em' : list.suffix === 'tab' ? `calc(${aligned}pt + .3em)` : '0px');
            marker.style.textAlign = list.align;
            if (list.fontFamily) marker.style.fontFamily = list.fontFamily;
            style(marker, list.markerStyle);
            p.append(marker, content);
          }
          if (entry.runs) for (const run of entry.runs) {
            if (run.image) { const img = el('img'); img.src = run.image.src; img.alt = run.image.alt || ''; img.width = run.image.width; img.height = run.image.height; content.append(img); }
            else { const span = el('span', run.text); style(span, run.style); content.append(span); }
          }
          else content.append(document.createTextNode(entry.text));
          if (!content.hasChildNodes()) content.append(el('br'));
          if (entry.key) {
            p.dataset.group = entry.key; p.tabIndex = 0; p.setAttribute('role', 'button'); p.setAttribute('aria-label', `Edit${single ? '' : ' '+letter(side)}: ${entry.list ? entry.list.label + ' ' : ''}${entry.text.slice(0, 100) || "Empty paragraph"}`);
            p.addEventListener('click', () => select(entry.key, side));
            p.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(entry.key, side); } });
          }
          return p;
        }
        if (model?.hasTables) {
          const byRecord = new Map(entries.map(entry => [entry.record, entry]));
          for (const item of projected.content) {
            if (item.type === 'paragraph') { paper.append(paragraph(byRecord.get(item.record))); continue; }
            const table = el('table', undefined, 'visual-table');
            table.setAttribute('aria-label', `Table ${item.index}, version ${letter(side)}`); style(table, item.style);
            const colgroup = el('colgroup'), total = item.widths.reduce((n, w) => n + w, 0);
            for (const width of item.widths) { const col = el('col'); if (total) col.style.width = `${width / total * 100}%`; colgroup.append(col); }
            table.append(colgroup); const tbody = el('tbody'); table.append(tbody);
            for (const row of item.rows) {
              const tr = el('tr'); tbody.append(tr);
              for (const cell of row.cells) {
                const td = el('td'); td.colSpan = cell.colSpan; td.rowSpan = cell.rowSpan; style(td, cell.style);
                for (const p of cell.content) td.append(paragraph(byRecord.get(p.record)));
                tr.append(td);
              }
            }
            paper.append(table);
          }
        } else for (const entry of entries) paper.append(paragraph(entry));
        scroll.replaceChildren(paper);
      }
      const absent = groups.filter(group => !group.dynamic && !models[side]?.hasTables && value(side, group.key) === null && value(other(side), group.key) !== null);
      if (absent.length) {
        const missing = el('div', undefined, 'visual-missing'); missing.append(el('strong', `Missing in ${letter(side)}`));
        for (const group of absent) { const add = button(`＋ ${value(other(side), group.key).slice(0, 100) || "Empty paragraph"}`, () => { if (!alive()) return; void select(group.key); copyTo(side); }); add.title = `Add from ${letter(other(side))}`; add.dataset.missingKey = group.key; missing.append(add); }
        scroll.append(missing);
      }
      scroll.scrollTop = scrollTop;
      if (selected) { const target = [...scroll.querySelectorAll('[data-group]')].find(node => node.dataset.group === selected); if (target) alignTarget(scroll, target); }
      scrollPositions[side] = readScroll(side);
      changed();
    } catch (error) { if (alive() && generation === generations[side]) { if (report.sources[side].format === 'pdf' && !textViews[side]) { textViews[side] = true; automaticText[side] = true; previewFailures[side] = {revision:drafts[side].revision,message:error.message}; pdfStateChanged(side, error.message); await renderSide(side); } else { scroll.replaceChildren(el('p', `Couldn't display the page. ${error.message}`, 'visual-inline-notice')); } } }
    finally { if (alive() && generation === generations[side]) scroll.setAttribute('aria-busy', 'false'); }
  }
  function docxSequence(side) {
    if (drafts[side].rowPlan) return drafts[side].entries();
    const sequence = [];
    for (const entry of drafts[side].entries()) {
      const source = row(byKey.get(entry.key), side);
      const original = source?.source_blocks?.[0] || source;
      const previous = sequence.at(-1);
      if (previous?.key === entry.key) previous.text += '\n' + entry.text;
      else sequence.push({key: entry.key, ...(original ? {record: original.record} : {}), text: entry.text});
    }
    return sequence;
  }
  async function previewWordPdf(side){
    if(!models[side]){message('The Word layout could not be read. Choose Word (.docx) to download your edits.');return;}
    const revision=drafts[side].revision,projected=projectWord(models[side],docxSequence(side),{rowPlan:drafts[side].rowPlan?.()});
    documentPdfDialog?.close();
    const {openDocumentPdfDialog}=await import('./document-pdf-dialog.mjs');if(!alive()||documentPdfDialog)return;
    documentPdfDialog=openDocumentPdfDialog({host:root,label:single ? sources[side].name : `Version ${letter(side)}`,current:()=>alive()&&drafts[side].revision===revision,
      prepare:async signal=>{const {renderDocxPdf}=await import('./docx-pdf.mjs');return renderDocxPdf(projected,{signal});},
      download:data=>download(data,filename(side,'pdf'),'application/pdf'),onClose:()=>{documentPdfDialog=null;}});
  }
  async function saveSide(side, {textOnly=false}={}) {
    if (!alive() || exporting[side] || !textOnly && ui[side].save.disabled) return;
    if(ui[side].outputFormat?.value==='pdf'){try{await previewWordPdf(side);}catch(error){message(error.message);}return;}
    exporting[side] = true; ui[side].save.disabled = true; if (side === 'right') reviewDownload.disabled = true; message("Preparing document…");
    const revision = drafts[side].revision;
    try {
      const format = report.sources[side].format;
      // Capture the requested revision before any asynchronous module load or generation.
      // The editor can keep changing while this detached document is prepared.
      const edited = drafts[side].changed;
      const word = format === 'docx' ? {sequence: docxSequence(side), rowPlan: drafts[side].rowPlan?.()} : null;
      let pdf = null;
      if(format === 'pdf' && (edited||textOnly)){pdf={entries:drafts[side].entries(),blocks:sourceBlocks(side),edits:null,data:pdfPreviews[side]?.revision===revision?pdfPreviews[side].data:null,reflow:textOnly||!!pdfErrors[side]};try{pdf.edits=pdfEdits(side);}catch{pdf.reflow=true;}}
      if (format === 'pdf') {
        if (!edited&&!textOnly) download(Uint8Array.from(atob(sources[side].data), c => c.charCodeAt(0)), filename(side, 'pdf'), 'application/pdf');
        else {
          const {renderPdfRevision,renderReflowedPdf} = await import('./pdf-visual.mjs');
          if (!alive()) return;
          let data;
          if(!pdf.reflow){try{data=await renderPdfRevision(sources[side],pdf.edits,{signal,blocks:pdf.blocks});}catch(error){if(error.name==='AbortError'||!alive())throw error;pdf.reflow=true;}}
          if(pdf.reflow){
            if(textOnly){const visual=pdf.blocks[0]?.visual;data=await renderReflowedPdf(pdf.entries,{signal,pageSize:visual?[visual.width,visual.height]:undefined});}
            else{const {renderPreservedPdf}=await import('./pdf-layout.mjs');if(!alive())return;data=pdf.data || await renderPreservedPdf(sources[side],pdf.entries,{blocks:pdf.blocks,signal});if(drafts[side].revision===revision)pdfStateChanged(side,'Expanded layout');}
          }
          if (!alive()) return;
          download(data, pdf.reflow ? filename(side, 'pdf').replace(/\.pdf$/, textOnly?'-text-only.pdf':'-updated-layout.pdf') : filename(side, 'pdf'), 'application/pdf');
        }
      } else if (format === 'docx') {
        const {writeDocxVisual} = await import('./docx-visual.mjs');
        if (!alive()) return;
        const data = await writeDocxVisual(sources[side], [], word);
        if (!alive()) return;
        download(data, filename(side, 'docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      } else download(drafts[side].exportText(), filename(side, 'txt'), 'text/plain;charset=utf-8');
      message(single ? (drafts[side].revision === revision ? "Your document is ready to download." : "Your document was downloaded. Download again to include your latest edits.") : drafts[side].revision === revision ? pdf?.reflow ? textOnly ? `Text-only PDF ${letter(side)} is ready. Original images and page formatting are not included.` : `Updated PDF ${letter(side)} is ready, with images and unchanged page content preserved.` : `Version ${letter(side)} is ready to download.` : `Version ${letter(side)} downloaded as it was when you clicked. You continued editing while it was being prepared. Download again for your latest version.`);
    } catch (error) {
      if (!alive()) return;
      if (report.sources[side].format === 'pdf' && !textOnly && drafts[side].revision === revision) {
        previewFailures[side] = {revision, message:error.message}; textViews[side] = true; automaticText[side] = true;
        pdfStateChanged(side,error.message); message(single ? 'Your edits are kept. Check the saving options above your document.' : 'Your edits are kept. Check the saving options in version '+letter(side)+'.'); void renderSide(side);
      } else message(report.sources[side].format === 'pdf' ? 'The PDF could not be downloaded. Your edits are kept. Please try again.' : error.message);
    }
    finally { if (alive()) { exporting[side] = false; if(report.sources[side].format==='pdf')pdfStateChanged(side,pdfErrors[side]);else ui[side].save.disabled = pdfChecking[side]; if (side === 'right') reviewDownload.disabled = ui[side].save.disabled; } }
  }
  finder=mountFindReplace(findHost,{
    single,getEntries:side=>drafts[side].entries(),canUndo:side=>drafts[side].canUndo,undo:side=>act(side,draft=>draft.undo()),
    apply:(side,patches)=>{if(!alive())return;for(const timer of Object.values(typingTimers))clearTimeout(timer);const before=drafts[side].revision;drafts[side].endEdit();drafts[side].updateTexts(patches);message();refresh();if(before!==drafts[side].revision)stateChanged();},
    jump:async(side,hit,focus,current)=>{
      if(!alive()||!current())return;await select(hit.key);if(!alive()||!current())return;
      const block=row(byKey.get(hit.key),side),part=(block?.source_blocks||[block]).find(b=>b?.record===hit.record);
      const locations=pdfPreviews[side]?.layout.filter(r=>r.key===hit.key)||[];
      const page=(locations.find(r=>r.textStart<=hit.offset&&r.textEnd>hit.offset)||locations.find(r=>r.record===hit.record)||locations.find(r=>r.textEnd>hit.offset)||locations[0])?.page||part?.page;
      if(page&&pages[side]!==page){pages[side]=page;await renderSide(side);if(!alive()||!current())return;stateChanged();}
      input[side].setSelectionRange(hit.offset,hit.offset+hit.end-hit.start);if(focus)input[side].focus({preventScroll:true});
    },
    highlight:(matches,side,active)=>{const keys=new Set(matches.map(m=>m.key));for(const s of sides)for(const node of ui[s].scroll.querySelectorAll('[data-group]')){node.classList.toggle('has-search-match',s===side&&keys.has(node.dataset.group));node.classList.toggle('is-search-current',s===side&&matches.length>0&&node.dataset.group===active?.key);}}
  });
  const dispose = () => { if (disposed) return; disposed = true; wording?.dispose(); finder?.dispose(); blockDialog?.close(); documentPdfDialog?.close(); for (const side of sides) clearPdfPreview(side); selectionGeneration++; for (const timer of Object.values(typingTimers)) clearTimeout(timer); for (const viewer of Object.values(viewers)) void viewer.dispose().catch(() => {}); root.replaceChildren(); };
  signal?.addEventListener('abort', dispose, {once: true});
  if (alive()) {
    if (!single && Object.values(models).some(model => model.hasTables)) saveNote.textContent += sides.every(side => drafts[side].copyRowFrom) ? " New row: add → fill in → copy to the adjacent version. Undo with ↶." : " New row: add → fill in. Undo with ↶.";
    if (Object.values(models).some(model => model.blocks.some(block => block.list))) saveNote.textContent += " Numbering is shown for reference; comparison and editing apply to the item text.";
    if (restoredState !== undefined) {
      for (const side of sides) {
        if (viewers[side] && !drafts[side].changed && restoredState.pages[side] > viewers[side].pageCount) { dispose(); throw new Error("Couldn't restore saved work: page not found."); }
        pages[side] = restoredState.pages[side];
      }
      if (single && report.sources.left.format === 'pdf' && restoredState.pdfTextView !== undefined) textViews.left = restoredState.pdfTextView;
      selected = restoredState.selected; zoom.value = restoredState.zoom;
      root.style.setProperty('--sheet-min-width', zoom.value + 'px');
      inspector.hidden = !selected; root.classList.toggle('is-editing', !!selected);
      if (selected) for (const side of sides) input[side].value = value(side, selected) ?? '';
    }
    changed();
    await Promise.all(sides.map(side => renderSide(side)));
    if (alive() && restoredState !== undefined) for (const side of sides) {
      ui[side].scroll.scrollTop = restoredState.scroll[side].top;
      ui[side].scroll.scrollLeft = restoredState.scroll[side].left;
      scrollPositions[side] = readScroll(side);
    }
  }
  restoring = false;
  return {dispose, drafts, select, snapshot, getAssistantContext, get changed() { return drafts.left.changed || drafts.right.changed; }};
}
