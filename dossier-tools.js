/* NPC State Delta dossier supporting tools UI. Uses the canonical runtime API rather than adding another state owner. */
import { encodeNpcStateBundle } from './bundle.js';
import {
    activeChatKey, api, buildPortablePortraitSettings, closeOverlay, currentSessionIs, draftKey,
    escapeHtml, flushDurably, keepPromptDraft, makeSession, mountOverlay, npcById, plain,
    portraitSignature, promptDrafts, recordToolEvent, relationshipDiagnosticRows, selectedNpcId,
    setBusy, stage1Refresh, summarizeDecodedBundle, toolEvents, validatePortraitFile,
} from './dossier-tools-core.js';
import { augmentNativeBundle, buildHistoryArchive, decodeDeltaNativeBundle, prepareNativeImport } from './native-transfer.js';

const STYLE_ID = 'npc_state_delta_tools_style';
const IMPORT_ACCEPT = '.npcstatedelta,application/octet-stream';

function toast(kind, message) { globalThis.toastr?.[kind]?.(message); }
function downloadBytes(data, name) {
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
function dataUrlFromBlob(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error('Could not read image.'));
        reader.onload = () => resolve(String(reader.result || ''));
        reader.readAsDataURL(blob);
    });
}
function waitForPortraitChange(chatKey, npcId, before, timeoutMs = 12000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (activeChatKey() !== chatKey) return reject(new Error('The active chat changed; stale portrait completion was discarded.'));
            const npc = npcById(npcId);
            if (!npc) return reject(new Error('The target NPC no longer exists; stale portrait completion was discarded.'));
            if (portraitSignature(npc) !== before) return resolve(npc);
            if (Date.now() - started >= timeoutMs) return reject(new Error('Portrait processing did not complete. The prior portrait was left unchanged.'));
            setTimeout(tick, 60);
        };
        tick();
    });
}
function hiddenUploadInput(npcId) {
    return `<input type="file" class="npc-state-delta-inline-portrait-file delta-tools-portrait-file" data-npc-id="${escapeHtml(npcId)}" accept="image/*">`;
}
function currentDraft(npc) {
    const chatKey = activeChatKey();
    const key = draftKey(chatKey, npc.id);
    const saved = promptDrafts.get(key);
    if (saved) return { key, positive: saved.positive || '', negative: saved.negative || '' };
    const prompts = api()?.portraitPrompts?.(npc.id) || { positive: '', negative: '' };
    return { key, positive: String(prompts.positive || ''), negative: String(prompts.negative || '') };
}
function saveDraftFromOverlay(session) {
    const positive = String(document.querySelector('#npc_state_delta_tools_positive')?.value || '');
    const negative = String(document.querySelector('#npc_state_delta_tools_negative')?.value || '');
    keepPromptDraft(draftKey(session.chatKey, session.npcId), { positive, negative });
    return { positive: positive.trim(), negative: negative.trim() };
}
function copyText(text, label) {
    return navigator.clipboard?.writeText?.(text).then(() => toast('success', `NPC State Delta: ${label} copied.`)).catch(error => {
        toast('error', `NPC State Delta: could not copy ${label.toLowerCase()}. ${error?.message || error}`);
    });
}

function portraitDialogHtml(npc, draft) {
    const portrait = npc?.portrait?.dataUrl || '';
    return `<section class="delta-tools-dialog delta-tools-portrait" role="dialog" aria-modal="true" aria-label="Portrait management for ${escapeHtml(npc.name)}">
      <header><div><span class="delta-tools-kicker">PORTRAIT MANAGEMENT</span><h2>${escapeHtml(npc.name)}</h2><small>Current accepted appearance · manual prompt edits stay local until explicitly rebuilt</small></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body delta-tools-portrait-grid">
        <section class="delta-tools-preview"><div class="delta-tools-current">${portrait ? `<img src="${escapeHtml(portrait)}" alt="Current portrait of ${escapeHtml(npc.name)}">` : '<div class="delta-tools-placeholder">No portrait</div>'}</div><div class="delta-tools-generated"><img data-delta-tools-generated hidden alt="Generated preview"><div data-delta-tools-generated-placeholder>Generated preview appears here and is never applied automatically.</div></div></section>
        <section class="delta-tools-prompts">
          <label>Positive prompt<textarea id="npc_state_delta_tools_positive" rows="8" data-delta-tools-autofocus>${escapeHtml(draft.positive)}</textarea></label>
          <div class="delta-tools-copy-row"><button type="button" data-copy="positive">Copy positive</button><button type="button" data-rebuild>Rebuild from dossier</button></div>
          <label>Negative prompt<textarea id="npc_state_delta_tools_negative" rows="6">${escapeHtml(draft.negative)}</textarea></label>
          <div class="delta-tools-copy-row"><button type="button" data-copy="negative">Copy negative</button><button type="button" data-copy="both">Copy both</button></div>
        </section>
      </div>
      <footer>
        <label class="delta-tools-file-button">${portrait ? 'Replace from device' : 'Upload from device'}${hiddenUploadInput(npc.id)}</label>
        <button type="button" data-generate>Generate preview</button>
        <button type="button" data-apply-preview disabled>Apply preview</button>
        <button type="button" data-remove-portrait ${portrait ? '' : 'disabled'}>Remove portrait</button>
        <span data-delta-tools-status hidden></span>
      </footer>
    </section>`;
}

async function finishUploadedPortrait(session, before, label) {
    try {
        const live = await waitForPortraitChange(session.chatKey, session.npcId, before);
        if (!currentSessionIs(session)) throw new Error('Portrait workflow was closed or superseded; late completion was not presented as current.');
        const saved = await flushDurably(session.chatKey, label);
        stage1Refresh();
        if (saved.persisted) toast('success', `NPC State Delta: ${live.name} portrait updated and saved.`);
        else toast('warning', `NPC State Delta: portrait applied locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'applied' });
    } catch (error) {
        recordToolEvent('portrait-stale-or-failed', { chatKey: session.chatKey, npcId: session.npcId, action: label, outcome: 'rejected', stale: /stale|changed|superseded|no longer exists/i.test(String(error?.message || error)), detail: error?.message || error });
        if (currentSessionIs(session)) setBusy(session, false, error?.message || String(error));
        toast('error', `NPC State Delta portrait: ${error?.message || error}`);
    }
}

function wirePortraitDialog(session, npc) {
    const overlay = document.getElementById('npc_state_delta_tools_overlay');
    const fileInput = overlay.querySelector('.delta-tools-portrait-file');
    fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        const validation = validatePortraitFile(file);
        if (!validation.ok) {
            if (file) toast('warning', `NPC State Delta: ${validation.reason}`);
            fileInput.value = '';
            return;
        }
        if (!currentSessionIs(session)) return;
        const before = portraitSignature(npcById(session.npcId));
        setBusy(session, true, 'Processing image through the canonical portrait handler…', { allowClose: true });
        void finishUploadedPortrait(session, before, 'device portrait');
    });
    overlay.addEventListener('input', event => {
        if (event.target.matches?.('#npc_state_delta_tools_positive, #npc_state_delta_tools_negative')) saveDraftFromOverlay(session);
    });
    overlay.addEventListener('click', event => {
        const copy = event.target.closest?.('[data-copy]')?.dataset?.copy;
        if (copy) {
            const draft = saveDraftFromOverlay(session);
            if (copy === 'positive') void copyText(draft.positive, 'Positive prompt');
            else if (copy === 'negative') void copyText(draft.negative, 'Negative prompt');
            else void copyText(`Positive:\n${draft.positive}\n\nNegative:\n${draft.negative}`, 'Portrait prompts');
            return;
        }
        if (event.target.closest?.('[data-rebuild]')) {
            const prompts = api()?.portraitPrompts?.(session.npcId);
            if (!prompts) return;
            overlay.querySelector('#npc_state_delta_tools_positive').value = prompts.positive || '';
            overlay.querySelector('#npc_state_delta_tools_negative').value = prompts.negative || '';
            keepPromptDraft(draftKey(session.chatKey, session.npcId), { positive: prompts.positive || '', negative: prompts.negative || '' });
            toast('info', 'NPC State Delta: portrait prompts rebuilt from the current accepted dossier.');
            return;
        }
        if (event.target.closest?.('[data-generate]')) void generatePreview(session);
        if (event.target.closest?.('[data-apply-preview]')) void applyPreview(session);
        if (event.target.closest?.('[data-remove-portrait]')) void removePortrait(session);
    });
}

export function openPortraitTools(npcId = selectedNpcId()) {
    const npc = npcById(npcId);
    if (!npc) return toast('warning', 'NPC State Delta: select an NPC dossier first.');
    const session = makeSession('portrait', { npcId: npc.id });
    const draft = currentDraft(npc);
    const overlay = mountOverlay(portraitDialogHtml(npc, draft), session);
    wirePortraitDialog(session, npc);
    return overlay;
}

async function generatePreview(session) {
    if (!currentSessionIs(session) || session.busy) return;
    const draft = saveDraftFromOverlay(session);
    if (!draft.positive) return toast('warning', 'NPC State Delta: positive portrait prompt is empty.');
    const action = ++session.actionSeq;
    session.previewUrl = '';
    const apply = document.querySelector('[data-apply-preview]');
    if (apply) apply.disabled = true;
    setBusy(session, true, 'Generating preview through SillyTavern Image Generation…', { allowClose: true });
    try {
        const url = await api()?.generatePortraitUrl?.(session.npcId, draft);
        if (!currentSessionIs(session) || session.actionSeq !== action || !npcById(session.npcId)) {
            recordToolEvent('portrait-generation', { chatKey: session.chatKey, npcId: session.npcId, action: 'generate', outcome: 'stale-rejected', stale: true });
            return;
        }
        if (!plain(url)) throw new Error('Image Generation returned no preview URL.');
        session.previewUrl = String(url);
        const image = document.querySelector('[data-delta-tools-generated]');
        const placeholder = document.querySelector('[data-delta-tools-generated-placeholder]');
        if (image) { image.src = session.previewUrl; image.hidden = false; }
        if (placeholder) placeholder.hidden = true;
        setBusy(session, false, 'Preview ready. It has not replaced the current portrait.');
        if (apply) apply.disabled = false;
        recordToolEvent('portrait-generation', { chatKey: session.chatKey, npcId: session.npcId, action: 'generate', outcome: 'preview-ready' });
    } catch (error) {
        if (currentSessionIs(session) && session.actionSeq === action) setBusy(session, false, `Generation failed: ${error?.message || error}`);
        recordToolEvent('portrait-generation', { chatKey: session.chatKey, npcId: session.npcId, action: 'generate', outcome: 'failed', detail: error?.message || error });
        toast('error', `NPC State Delta portrait generation: ${error?.message || error}`);
    }
}

async function applyPreview(session) {
    if (!currentSessionIs(session) || session.busy || !session.previewUrl) return;
    const action = ++session.actionSeq;
    const before = portraitSignature(npcById(session.npcId));
    setBusy(session, true, 'Loading generated preview for explicit portrait application…', { allowClose: true });
    try {
        const response = await fetch(new URL(session.previewUrl, globalThis.location?.href || 'http://localhost/').href, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Could not load generated image (${response.status}).`);
        const blob = await response.blob();
        if (!blob.type?.startsWith('image/')) throw new Error('Generated preview did not return an image.');
        if (!currentSessionIs(session) || session.actionSeq !== action) return;
        const validation = validatePortraitFile({ type: blob.type, size: blob.size });
        if (!validation.ok) throw new Error(validation.reason);
        const extension = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const file = new File([blob], `${plain(npcById(session.npcId)?.name || 'npc')}-generated.${extension}`, { type: blob.type });
        const input = document.querySelector('.delta-tools-portrait-file');
        if (typeof DataTransfer !== 'function' || !input) throw new Error('This browser cannot hand the generated image to the canonical portrait upload path.');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await finishUploadedPortrait(session, before, 'generated portrait');
    } catch (error) {
        if (currentSessionIs(session)) setBusy(session, false, `Could not apply preview: ${error?.message || error}`);
        toast('error', `NPC State Delta portrait: ${error?.message || error}`);
    }
}

async function removePortrait(session) {
    if (!currentSessionIs(session) || session.busy) return;
    const npc = npcById(session.npcId);
    if (!npc?.portrait?.dataUrl) return;
    const before = portraitSignature(npc);
    setBusy(session, true, 'Removing portrait without changing the dossier…');
    const button = document.createElement('button');
    button.type = 'button';
    button.hidden = true;
    button.className = 'npc-state-delta-inline-remove-portrait';
    button.dataset.npcId = session.npcId;
    document.body.appendChild(button);
    button.click();
    button.remove();
    try {
        await waitForPortraitChange(session.chatKey, session.npcId, before, 2000);
        const saved = await flushDurably(session.chatKey, 'portrait removal');
        stage1Refresh();
        toast(saved.persisted ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: portrait removed from ${npc.name} and saved.`
            : `NPC State Delta: portrait removed locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'removed' });
    } catch (error) {
        setBusy(session, false, error?.message || String(error));
        toast('error', `NPC State Delta portrait removal: ${error?.message || error}`);
    }
}

function importDialogHtml(summary, prepared) {
    const source = summary.sourceChatKey ? escapeHtml(summary.sourceChatKey) : 'not declared';
    return `<section class="delta-tools-dialog" role="dialog" aria-modal="true" aria-label="Import NPC State Delta data">
      <header><div><span class="delta-tools-kicker">NATIVE DELTA IMPORT</span><h2>Review before applying</h2></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body"><div class="delta-tools-summary"><b>${summary.dossiers} dossiers</b><b>${summary.portraits} portraits</b><b>${summary.checkpoints} source checkpoints</b><span>Source chat: ${source}</span><span>${escapeHtml(prepared.ownershipPolicy)}</span><span>${escapeHtml(prepared.historyPolicy)}</span></div>
      <p>Matching dossiers are reconciled through Delta's canonical importer; unmatched imported dossiers are added subject to the active roster cap; unrelated target dossiers remain. Portraits travel with their dossiers. Source history is retained in the file for audit only and never overwrites target lineage/checkpoints.</p>
      <label class="delta-tools-check"><input type="checkbox" data-import-settings ${summary.portableSettings ? '' : 'disabled'}> Restore declared portable portrait-generation settings</label>
      <p class="delta-tools-warning">Import mutates the active chat after full bundle validation. Closing now makes no changes.</p></div>
      <footer><button type="button" data-delta-tools-close>Cancel</button><button type="button" class="delta-tools-danger" data-apply-import data-delta-tools-autofocus>Apply import to active chat</button><span data-delta-tools-status hidden></span></footer>
    </section>`;
}

async function chooseImportFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMPORT_ACCEPT;
    input.hidden = true;
    document.body.appendChild(input);
    return new Promise(resolve => {
        input.addEventListener('change', () => { const file = input.files?.[0] || null; input.remove(); resolve(file); }, { once: true });
        input.click();
    });
}

export async function openImportTools() {
    const chatKey = activeChatKey();
    if (!chatKey || chatKey === 'no-chat') return toast('warning', 'NPC State Delta: open the target chat before importing.');
    const file = await chooseImportFile();
    if (!file) return;
    let raw;
    try { raw = new Uint8Array(await file.arrayBuffer()); }
    catch (error) { return toast('error', `NPC State Delta import: could not read file. ${error?.message || error}`); }
    let prepared;
    try { prepared = prepareNativeImport(raw, chatKey); }
    catch (error) { return toast('error', `NPC State Delta import rejected before mutation: ${error?.message || error}`); }
    const summary = summarizeDecodedBundle(prepared.decoded);
    const session = makeSession('import');
    session.importBytes = prepared.importBytes;
    session.importDecoded = prepared.decoded;
    session.importSummary = summary;
    const overlay = mountOverlay(importDialogHtml(summary, prepared), session);
    overlay.addEventListener('click', event => {
        if (event.target.closest?.('[data-apply-import]')) void applyImport(session);
    });
}

async function applyImport(session) {
    if (session.busy || activeChatKey() !== session.chatKey || !session.importBytes) return;
    setBusy(session, true, 'Applying validated native Delta import through the canonical importer…');
    try {
        api()?.importBytes?.(session.importBytes);
        const restoreSettings = Boolean(document.querySelector('[data-import-settings]')?.checked);
        if (restoreSettings && session.importDecoded?.portableSettings) await api()?.savePortraitSettings?.(session.importDecoded.portableSettings);
        const saved = await flushDurably(session.chatKey, 'native import');
        stage1Refresh();
        recordToolEvent('native-import', { chatKey: session.chatKey, action: 'apply', outcome: saved.persisted ? 'saved' : 'local-only', persisted: saved.persisted });
        toast(saved.persisted ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: imported ${session.importSummary?.dossiers || 0} dossier record(s) and saved the target chat.`
            : `NPC State Delta: import applied locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'imported' });
    } catch (error) {
        setBusy(session, false, `Import failed: ${error?.message || error}`);
        recordToolEvent('native-import', { chatKey: session.chatKey, action: 'apply', outcome: 'failed', detail: error?.message || error });
        toast('error', `NPC State Delta import failed without partial Stage 8 mutation: ${error?.message || error}`);
    }
}

export function exportNativeTools() {
    const chatKey = activeChatKey();
    if (!chatKey || chatKey === 'no-chat') return toast('warning', 'NPC State Delta: open a chat before exporting.');
    try {
        const state = api()?.getState?.();
        const base = api()?.exportBytes?.();
        if (!base) throw new Error('Canonical export returned no data.');
        const output = augmentNativeBundle(base, {
            portableSettings: buildPortablePortraitSettings(api()?.portraitSettings?.() || {}),
            historyArchive: buildHistoryArchive(state || {}),
        });
        downloadBytes(output, `npc-state-delta-${Date.now()}.npcstatedelta`);
        recordToolEvent('native-export', { chatKey, action: 'export', outcome: 'downloaded' });
        toast('success', 'NPC State Delta: native bundle exported with portraits, portable portrait settings, and source-history audit data.');
    } catch (error) {
        toast('error', `NPC State Delta export failed: ${error?.message || error}`);
    }
}

function diagnosticsHtml(npc) {
    const status = api()?.uiStatus?.() || {};
    const routing = status.scannerRouting || api()?.scannerRouting?.() || {};
    const scan = status.lastScan || api()?.scanMetrics?.() || null;
    const rel = npc ? relationshipDiagnosticRows(npc) : [];
    const pendingWrites = status?.persistencePending ?? status?.pendingWrites ?? 'not exposed by runtime';
    const events = toolEvents.slice(-12).reverse();
    return `<section class="delta-tools-dialog delta-tools-diagnostics" role="dialog" aria-modal="true" aria-label="NPC State Delta diagnostics">
      <header><div><span class="delta-tools-kicker">COMPACT DIAGNOSTICS</span><h2>Current chat</h2><small>Opening this view does not initiate a scan.</small></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body">
        <div class="delta-tools-metrics"><div><b>${Number(routing.total || 0)}</b><span>Actual provider requests</span></div><div><b>${Number(routing.failed || 0)}</b><span>Provider failures</span></div><div><b>${Number(routing.rejected || 0)}</b><span>Rejected preflights</span></div><div><b>${Number(routing.cancelled || 0) + Number(routing.timedOut || 0)}</b><span>Cancelled / timed out</span></div></div>
        <section><h3>Routing / latest scan</h3><pre>${escapeHtml(JSON.stringify({ inflight: routing.inflight || 0, lastRequest: routing.last || null, lastScan: scan ? { label: scan.label, durationMs: scan.durationMs, retried: Boolean(scan.retried), relationshipPass: Boolean(scan.relationshipPass), promptEstimateTokens: Math.ceil(Number(scan.promptChars || 0) / 4), responseEstimateTokens: Math.ceil(Number(scan.responseChars || 0) / 4) } : null, note: 'Prompt token values are local character estimates, not provider usage.' }, null, 2))}</pre></section>
        <section><h3>Persistence</h3><p>Pending writes: ${escapeHtml(String(pendingWrites))}. Stage 8 actions separately report local application versus durable flush success.</p></section>
        ${npc ? `<section><h3>Relationship fractions / gate audit · ${escapeHtml(npc.name)}</h3><pre>${escapeHtml(JSON.stringify(rel, null, 2))}</pre></section>` : ''}
        <section><h3>Recent Stage 8 events</h3><pre>${escapeHtml(JSON.stringify(events, null, 2))}</pre><small>No credentials, full prompts, or provider responses are recorded here.</small></section>
      </div><footer><button type="button" data-delta-tools-close data-delta-tools-autofocus>Close</button></footer>
    </section>`;
}

export function openDiagnostics() {
    const npc = npcById(selectedNpcId());
    const session = makeSession('diagnostics', { npcId: npc?.id || '' });
    mountOverlay(diagnosticsHtml(npc), session);
}

function injectButtons() {
    const root = document.getElementById('npc_state_delta_stage1_ui');
    if (!root) return false;
    const top = root.querySelector('.delta-top-actions');
    if (top && !top.querySelector('.delta-tools-data')) {
        const data = document.createElement('button');
        data.type = 'button'; data.className = 'delta-btn delta-tools-data'; data.textContent = 'Data';
        const diag = document.createElement('button');
        diag.type = 'button'; diag.className = 'delta-btn delta-tools-diagnostics-button'; diag.textContent = 'Diagnostics';
        top.prepend(diag); top.prepend(data);
        data.addEventListener('click', () => openDataMenu(data));
        diag.addEventListener('click', () => openDiagnostics());
    }
    const heroActions = root.querySelector('.delta-hero-actions');
    if (heroActions && !heroActions.querySelector('.delta-tools-portrait-button')) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'delta-btn delta-tools-portrait-button'; button.textContent = 'Portrait';
        button.addEventListener('click', () => openPortraitTools());
        heroActions.appendChild(button);
    }
    return true;
}

function openDataMenu(anchor) {
    const session = makeSession('data');
    const overlay = mountOverlay(`<section class="delta-tools-dialog delta-tools-small" role="dialog" aria-modal="true" aria-label="NPC State Delta data transfer"><header><div><span class="delta-tools-kicker">NATIVE DELTA DATA</span><h2>Import / export</h2></div><button type="button" class="delta-tools-close" data-delta-tools-close>×</button></header><div class="delta-tools-body"><p>The native bundle is versioned Delta data only. It contains dossiers and portrait assets, plus declared portable portrait settings and source history for audit. Imports never install Alpha/Beta/legacy converters and never replace target chat lineage.</p></div><footer><button type="button" data-export>Export native bundle</button><button type="button" data-import>Import into active chat</button></footer></section>`, session);
    overlay.addEventListener('click', event => {
        if (event.target.closest?.('[data-export]')) { exportNativeTools(); closeOverlay({ reason: 'exported' }); }
        if (event.target.closest?.('[data-import]')) { closeOverlay({ reason: 'select-import', restore: false }); void openImportTools(); }
    });
    anchor?.blur?.();
}

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.npc-state-delta-tools-overlay{position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:rgba(0,0,0,.72);overflow:auto}
.delta-tools-dialog{width:min(920px,100%);max-height:min(900px,calc(100dvh - 24px));display:flex;flex-direction:column;background:var(--SmartThemeBlurTintColor,#18191d);color:var(--SmartThemeBodyColor,#f1efe9);border:1px solid rgba(218,193,148,.4);border-radius:14px;box-shadow:0 20px 70px rgba(0,0,0,.55);overflow:hidden}.delta-tools-dialog>header,.delta-tools-dialog>footer{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(255,255,255,.04)}.delta-tools-dialog>header{justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.1)}.delta-tools-dialog>footer{flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.1)}.delta-tools-dialog h2,.delta-tools-dialog h3{margin:.1em 0}.delta-tools-dialog small{opacity:.7}.delta-tools-kicker{display:block;font-size:10px;letter-spacing:.14em;opacity:.65}.delta-tools-close{min-width:44px;min-height:44px;font-size:25px}.delta-tools-body{overflow:auto;padding:14px;overscroll-behavior:contain}.delta-tools-dialog button,.delta-tools-file-button{min-height:44px;padding:9px 12px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(255,255,255,.08);color:inherit;cursor:pointer}.delta-tools-dialog button:disabled{opacity:.45;cursor:not-allowed}.delta-tools-file-button{display:inline-flex;align-items:center}.delta-tools-file-button input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.delta-tools-portrait-grid{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(280px,1.2fr);gap:16px}.delta-tools-preview{display:grid;gap:12px}.delta-tools-current,.delta-tools-generated{min-height:240px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.12);border-radius:11px;overflow:hidden;background:rgba(0,0,0,.18)}.delta-tools-current img,.delta-tools-generated img{width:100%;max-height:360px;object-fit:contain}.delta-tools-placeholder,.delta-tools-generated-placeholder{padding:22px;text-align:center;opacity:.7}.delta-tools-prompts label{display:grid;gap:5px;margin-bottom:10px}.delta-tools-prompts textarea{width:100%;min-height:110px;resize:vertical;background:rgba(0,0,0,.2);color:inherit;border:1px solid rgba(255,255,255,.18);border-radius:9px;padding:9px}.delta-tools-copy-row{display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 12px}.delta-tools-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}.delta-tools-summary>*{padding:9px;border:1px solid rgba(255,255,255,.1);border-radius:8px}.delta-tools-warning{border-left:3px solid #e5b66f;padding-left:10px}.delta-tools-danger{border-color:#d88!important}.delta-tools-check{display:flex;gap:9px;align-items:center;padding:10px 0}.delta-tools-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.delta-tools-metrics div{padding:10px;border:1px solid rgba(255,255,255,.1);border-radius:9px}.delta-tools-metrics b,.delta-tools-metrics span{display:block}.delta-tools-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(0,0,0,.2);padding:10px;border-radius:8px;max-height:260px;overflow:auto}.delta-tools-small{width:min(620px,100%)}
@media(max-width:760px){.npc-state-delta-tools-overlay{place-items:start center;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom))}.delta-tools-dialog{max-height:calc(100dvh - 16px);border-radius:10px}.delta-tools-portrait-grid{grid-template-columns:1fr}.delta-tools-current,.delta-tools-generated{min-height:170px}.delta-tools-summary,.delta-tools-metrics{grid-template-columns:1fr 1fr}.delta-tools-dialog>footer{position:sticky;bottom:0}.delta-tools-dialog button,.delta-tools-file-button{min-height:46px}}
@media(max-width:430px){.delta-tools-summary,.delta-tools-metrics{grid-template-columns:1fr}.delta-tools-dialog>footer>*{flex:1 1 auto}}
`;
    document.head.appendChild(style);
}

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    installStyles();
    if (injectButtons()) {
        const root = document.getElementById('npc_state_delta_stage1_ui');
        if (!root?.__npcStateDeltaToolsObserver) {
            const observer = new MutationObserver(() => injectButtons());
            observer.observe(root, { childList: true, subtree: true });
            root.__npcStateDeltaToolsObserver = observer;
        }
        return;
    }
    if (attempt < 60) setTimeout(() => start(attempt + 1), 100);
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    else queueMicrotask(() => start());
}

export const __test = Object.freeze({ buildHistoryArchive, decodeDeltaNativeBundle, prepareNativeImport, relationshipDiagnosticRows, validatePortraitFile });
