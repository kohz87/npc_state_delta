/* NPC State Delta dossier supporting tools UI. Uses canonical runtime/state owners. */
import {
    activeChatKey, api, buildPortablePortraitSettings, closeOverlay, currentSessionIs, draftKey,
    escapeHtml, flushDurably, keepPromptDraft, makeSession, mountOverlay, npcById, plain,
    portraitSignature, promptDrafts, recordToolEvent, relationshipDiagnosticRows, selectedNpcId,
    setBusy, stage1Refresh, summarizeDecodedBundle, toolEvents, uiRoot, validatePortraitFile,
} from './dossier-tools-core.js';
import { augmentNativeBundle, buildHistoryArchive, prepareNativeImport } from './native-transfer.js';

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
    const key = draftKey(activeChatKey(), npc.id);
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
async function copyText(text, label) {
    try {
        if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard API is unavailable.');
        await navigator.clipboard.writeText(text);
        toast('success', `NPC State Delta: ${label} copied.`);
    } catch (error) {
        toast('error', `NPC State Delta: could not copy ${label.toLowerCase()}. ${error?.message || error}`);
    }
}

function portraitDialogHtml(npc, draft) {
    const portrait = npc?.portrait?.dataUrl || '';
    return `<section class="delta-tools-dialog delta-tools-portrait" role="dialog" aria-modal="true" aria-label="Portrait management for ${escapeHtml(npc.name)}">
      <header><div><span class="delta-tools-kicker">PORTRAIT MANAGEMENT</span><h2>${escapeHtml(npc.name)}</h2><small>Edits are preserved in this chat session until you explicitly rebuild from the dossier.</small></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body delta-tools-portrait-grid">
        <section class="delta-tools-preview">
          <div class="delta-tools-current">${portrait ? `<img src="${escapeHtml(portrait)}" alt="Current portrait of ${escapeHtml(npc.name)}">` : '<div class="delta-tools-placeholder">No current portrait</div>'}</div>
          <div class="delta-tools-generated"><img data-delta-tools-generated hidden alt="Generated preview"><div data-delta-tools-generated-placeholder>Generated preview appears here. Generation alone never replaces the current portrait.</div></div>
        </section>
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
        if (!currentSessionIs(session)) throw new Error('The portrait workflow is no longer current; late completion was rejected from this workflow.');
        const saved = await flushDurably(session.chatKey, label);
        stage1Refresh();
        if (saved.persisted) toast('success', `NPC State Delta: ${live.name} portrait updated and saved.`);
        else toast('warning', `NPC State Delta: portrait applied locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'portrait-applied' });
    } catch (error) {
        recordToolEvent('portrait-completion', {
            chatKey: session.chatKey,
            npcId: session.npcId,
            action: label,
            outcome: 'rejected-or-failed',
            stale: /stale|changed|no longer|current/i.test(String(error?.message || error)),
            detail: error?.message || error,
        });
        if (currentSessionIs(session)) setBusy(session, false, error?.message || String(error));
        toast('error', `NPC State Delta portrait: ${error?.message || error}`);
    }
}

function wirePortraitDialog(session) {
    const overlay = document.getElementById('npc_state_delta_tools_overlay');
    const input = overlay?.querySelector('.delta-tools-portrait-file');
    input?.addEventListener('change', event => {
        const file = input.files?.[0];
        const validation = validatePortraitFile(file);
        if (!validation.ok) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (file) toast('warning', `NPC State Delta: ${validation.reason}`);
            input.value = '';
            return;
        }
        if (!currentSessionIs(session)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            input.value = '';
            recordToolEvent('portrait-upload', { chatKey: session.chatKey, npcId: session.npcId, action: 'file-selected', outcome: 'stale-rejected', stale: true });
            toast('warning', 'NPC State Delta: the portrait target changed while the file picker was open. Reopen Portrait for the current dossier.');
            return;
        }
        const before = portraitSignature(npcById(session.npcId));
        setBusy(session, true, 'Processing image through the canonical portrait handler…');
        void finishUploadedPortrait(session, before, file?.name?.includes('-generated.') ? 'generated portrait' : 'device portrait');
    });
    overlay?.addEventListener('input', event => {
        if (event.target.matches?.('#npc_state_delta_tools_positive, #npc_state_delta_tools_negative')) saveDraftFromOverlay(session);
    });
    overlay?.addEventListener('click', event => {
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
            const positive = overlay.querySelector('#npc_state_delta_tools_positive');
            const negative = overlay.querySelector('#npc_state_delta_tools_negative');
            if (positive) positive.value = prompts.positive || '';
            if (negative) negative.value = prompts.negative || '';
            keepPromptDraft(draftKey(session.chatKey, session.npcId), { positive: prompts.positive || '', negative: prompts.negative || '' });
            toast('info', 'NPC State Delta: prompts explicitly rebuilt from the current accepted dossier.');
            return;
        }
        if (event.target.closest?.('[data-generate]')) void generatePreview(session);
        if (event.target.closest?.('[data-apply-preview]')) void applyPreview(session);
        if (event.target.closest?.('[data-remove-portrait]')) void removePortrait(session);
    });
}

export function openPortraitTools(npcId = selectedNpcId()) {
    const npc = npcById(npcId);
    if (!npc) { toast('warning', 'NPC State Delta: select an NPC dossier first.'); return null; }
    const session = makeSession('portrait', { npcId: npc.id });
    const overlay = mountOverlay(portraitDialogHtml(npc, currentDraft(npc)), session);
    wirePortraitDialog(session);
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
    setBusy(session, true, 'Loading generated preview for explicit portrait application…', { allowClose: true });
    try {
        const response = await fetch(new URL(session.previewUrl, globalThis.location?.href || 'http://localhost/').href, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Could not load generated image (${response.status}).`);
        const blob = await response.blob();
        if (!blob.type?.startsWith('image/')) throw new Error('Generated preview did not return an image.');
        if (!currentSessionIs(session) || session.actionSeq !== action) return;
        const validation = validatePortraitFile({ type: blob.type, size: blob.size });
        if (!validation.ok) throw new Error(validation.reason);
        const input = document.querySelector('.delta-tools-portrait-file');
        if (typeof DataTransfer !== 'function' || !input) throw new Error('This browser cannot hand the generated image to the canonical portrait upload path.');
        const extension = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const file = new File([blob], `${plain(npcById(session.npcId)?.name || 'npc')}-generated.${extension}`, { type: blob.type });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        setBusy(session, false, '');
        input.dispatchEvent(new Event('change', { bubbles: true }));
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
        await waitForPortraitChange(session.chatKey, session.npcId, before, 2500);
        const saved = await flushDurably(session.chatKey, 'portrait removal');
        stage1Refresh();
        toast(saved.persisted ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: portrait removed from ${npc.name} and saved.`
            : `NPC State Delta: portrait removed locally, but durable save failed. ${saved.error?.message || saved.error}`);
        closeOverlay({ reason: 'portrait-removed' });
    } catch (error) {
        if (currentSessionIs(session)) setBusy(session, false, error?.message || String(error));
        toast('error', `NPC State Delta portrait removal: ${error?.message || error}`);
    }
}

function importDialogHtml(summary, prepared) {
    return `<section class="delta-tools-dialog" role="dialog" aria-modal="true" aria-label="Import NPC State Delta data">
      <header><div><span class="delta-tools-kicker">NATIVE DELTA IMPORT</span><h2>Review before applying</h2></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body">
        <div class="delta-tools-summary"><b>${summary.dossiers} dossiers</b><b>${summary.portraits} portraits</b><b>${summary.checkpoints} source checkpoints</b><span>Source: ${escapeHtml(summary.sourceChatKey || 'not declared')}</span><span>${escapeHtml(prepared.ownershipPolicy)}</span><span>${escapeHtml(prepared.historyPolicy)}</span></div>
        <p>Matching dossiers are reconciled through Delta's canonical importer; unmatched imported dossiers are added subject to the active roster cap; unrelated target dossiers remain. Portrait assets travel with their dossiers.</p>
        <p>Source checkpoints, lineage and inline history are retained in the file for audit, but are not replayed into the target chat. The target keeps its own current history baseline, so no source message provenance is invented.</p>
        <label class="delta-tools-check"><input type="checkbox" data-import-settings ${summary.portableSettings ? '' : 'disabled'}> Restore declared portable portrait-generation settings</label>
        <p class="delta-tools-warning">The file has already passed complete native-format validation. Apply mutates the active chat; Cancel makes no changes.</p>
      </div>
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
        let settled = false;
        const finish = file => {
            if (settled) return;
            settled = true;
            input.remove();
            resolve(file || null);
        };
        input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
        input.addEventListener('cancel', () => finish(null), { once: true });
        input.click();
    });
}

export async function openImportTools() {
    const chatKey = activeChatKey();
    if (!chatKey || chatKey === 'no-chat') return toast('warning', 'NPC State Delta: open the target chat before importing.');
    const file = await chooseImportFile();
    if (!file) return;
    if (activeChatKey() !== chatKey) return toast('warning', 'NPC State Delta: the target chat changed while the import picker was open. Reopen Data and choose the file again.');
    let raw;
    try { raw = new Uint8Array(await file.arrayBuffer()); }
    catch (error) { return toast('error', `NPC State Delta import: could not read file. ${error?.message || error}`); }
    if (activeChatKey() !== chatKey) return toast('warning', 'NPC State Delta: the target chat changed while the import file was being read. No import was applied.');
    let prepared;
    try { prepared = prepareNativeImport(raw, chatKey); }
    catch (error) { return toast('error', `NPC State Delta import rejected before mutation: ${error?.message || error}`); }
    if (activeChatKey() !== chatKey) return toast('warning', 'NPC State Delta: the target chat changed during import validation. No import was applied.');
    const summary = summarizeDecodedBundle(prepared.decoded);
    const session = makeSession('import');
    session.importBytes = prepared.importBytes;
    session.importDecoded = prepared.decoded;
    session.importSummary = summary;
    const overlay = mountOverlay(importDialogHtml(summary, prepared), session);
    overlay.addEventListener('click', event => { if (event.target.closest?.('[data-apply-import]')) void applyImport(session); });
}

async function applyImport(session) {
    if (session.busy || activeChatKey() !== session.chatKey || !session.importBytes) return;
    setBusy(session, true, 'Applying validated native Delta import through the canonical importer…');
    let dossierApplied = false;
    try {
        const result = api()?.importBytes?.(session.importBytes);
        if (!result) throw new Error('Canonical importer rejected the validated bundle.');
        dossierApplied = true;
        const saved = await flushDurably(session.chatKey, 'native import');
        let settingsWarning = '';
        const restoreSettings = Boolean(document.querySelector('[data-import-settings]')?.checked);
        if (restoreSettings && session.importDecoded?.portableSettings) {
            try {
                const savedSettings = await api()?.savePortraitSettings?.(session.importDecoded.portableSettings);
                if (savedSettings === false) settingsWarning = ' Portable portrait settings were not restored.';
            } catch (error) {
                settingsWarning = ` Portable portrait settings were not restored: ${error?.message || error}`;
                recordToolEvent('native-import-settings', { chatKey: session.chatKey, action: 'restore-settings', outcome: 'failed', detail: error?.message || error });
            }
        }
        stage1Refresh();
        recordToolEvent('native-import', { chatKey: session.chatKey, action: 'apply', outcome: saved.persisted ? 'saved' : 'local-only', persisted: saved.persisted });
        const fullySuccessful = saved.persisted && !settingsWarning;
        toast(fullySuccessful ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: imported ${session.importSummary?.dossiers || 0} dossier record(s) and saved the target chat.${settingsWarning}`
            : `NPC State Delta: import applied locally, but durable save failed. ${saved.error?.message || saved.error}${settingsWarning}`);
        closeOverlay({ reason: 'imported' });
    } catch (error) {
        if (dossierApplied) {
            recordToolEvent('native-import', { chatKey: session.chatKey, action: 'apply', outcome: 'local-only', persisted: false, detail: error?.message || error });
            toast('warning', `NPC State Delta: the validated import was applied locally, but durable confirmation failed: ${error?.message || error}`);
            closeOverlay({ reason: 'import-local-only' });
            return;
        }
        if (document.getElementById('npc_state_delta_tools_overlay')) setBusy(session, false, `Import failed before canonical mutation: ${error?.message || error}`);
        recordToolEvent('native-import', { chatKey: session.chatKey, action: 'apply', outcome: 'failed-before-mutation', detail: error?.message || error });
        toast('error', `NPC State Delta import rejected before canonical mutation: ${error?.message || error}`);
    }
}

export function exportNativeTools() {
    const chatKey = activeChatKey();
    if (!chatKey || chatKey === 'no-chat') return toast('warning', 'NPC State Delta: open a chat before exporting.');
    try {
        const base = api()?.exportBytes?.();
        if (!base) throw new Error('Canonical export returned no data.');
        const output = augmentNativeBundle(base, {
            portableSettings: buildPortablePortraitSettings(api()?.portraitSettings?.() || {}),
            historyArchive: buildHistoryArchive(api()?.getState?.() || {}),
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
    const actual = {
        totalProviderRequests: Number(routing.total || 0),
        defaultRoute: Number(routing.defaultRoute || 0),
        selectedProfileRoute: Number(routing.profileRoute || 0),
        succeeded: Number(routing.succeeded || 0),
        failed: Number(routing.failed || 0),
        rejectedBeforeDispatch: Number(routing.rejected || 0),
        timedOut: Number(routing.timedOut || 0),
        cancelled: Number(routing.cancelled || 0),
        inflight: Number(routing.inflight || 0),
    };
    const latest = scan ? {
        label: scan.label || '',
        durationMs: Number(scan.durationMs || 0),
        retried: Boolean(scan.retried),
        focusedRelationshipPass: Boolean(scan.relationshipPass),
        promptEstimateTokens: Math.ceil(Number(scan.promptChars || 0) / 4),
        responseEstimateTokens: Math.ceil(Number(scan.responseChars || 0) / 4),
        estimateNote: 'Character-based local estimates only; not provider usage.',
    } : null;
    const recentPersistenceFailures = toolEvents.filter(event => event.type === 'persistence' && event.persisted === false).slice(-8);
    return `<section class="delta-tools-dialog delta-tools-diagnostics" role="dialog" aria-modal="true" aria-label="NPC State Delta diagnostics">
      <header><div><span class="delta-tools-kicker">COMPACT DIAGNOSTICS</span><h2>Current chat</h2><small>Opening diagnostics never starts a scan or database-wide process.</small></div><button type="button" class="delta-tools-close" data-delta-tools-close aria-label="Close">×</button></header>
      <div class="delta-tools-body">
        <div class="delta-tools-metrics"><div><b>${actual.totalProviderRequests}</b><span>Actual provider requests</span></div><div><b>${actual.failed}</b><span>Provider failures</span></div><div><b>${actual.rejectedBeforeDispatch}</b><span>Rejected preflights</span></div><div><b>${actual.timedOut + actual.cancelled}</b><span>Timed out / cancelled</span></div></div>
        <section><h3>Request routing</h3><pre>${escapeHtml(JSON.stringify({ actual, lastRequest: routing.last || null }, null, 2))}</pre></section>
        <section><h3>Latest scan accounting</h3><pre>${escapeHtml(JSON.stringify(latest || { available: false }, null, 2))}</pre><small>Retry/focused flags describe the latest scan. The dispatcher aggregate above is the authoritative actual request count; Delta does not fabricate a per-pass provider count it does not expose.</small></section>
        <section><h3>Persistence</h3><pre>${escapeHtml(JSON.stringify({ stage8PendingWrite: false, recentStage8Failures: recentPersistenceFailures }, null, 2))}</pre><small>Stage 8 waits for canonical flush and distinguishes local mutation from durable save. The legacy runtime does not expose a global pending-write counter, so diagnostics says so rather than inventing one.</small></section>
        ${npc ? `<section><h3>Relationship fractions / gate audit · ${escapeHtml(npc.name)}</h3><pre>${escapeHtml(JSON.stringify(rel, null, 2))}</pre></section>` : ''}
        <section><h3>Recent Stage 8 events</h3><pre>${escapeHtml(JSON.stringify(toolEvents.slice(-12).reverse(), null, 2))}</pre><small>Bounded records exclude credentials, full prompts, and provider responses.</small></section>
      </div><footer><button type="button" data-delta-tools-close data-delta-tools-autofocus>Close</button></footer>
    </section>`;
}
export function openDiagnostics() {
    const npc = npcById(selectedNpcId());
    mountOverlay(diagnosticsHtml(npc), makeSession('diagnostics', { npcId: npc?.id || '' }));
}

function openDataMenu(anchor) {
    const session = makeSession('data');
    const overlay = mountOverlay(`<section class="delta-tools-dialog delta-tools-small" role="dialog" aria-modal="true" aria-label="NPC State Delta data transfer"><header><div><span class="delta-tools-kicker">NATIVE DELTA DATA</span><h2>Import / export</h2></div><button type="button" class="delta-tools-close" data-delta-tools-close>×</button></header><div class="delta-tools-body"><p>The native bundle is versioned Delta data only. It contains dossiers and portrait assets, declared portable portrait settings, and source history for audit. No Alpha/Beta/legacy converter is used, and imports never replace target chat lineage.</p></div><footer><button type="button" data-export>Export native bundle</button><button type="button" data-import>Import into active chat</button></footer></section>`, session);
    overlay.addEventListener('click', event => {
        if (event.target.closest?.('[data-export]')) { exportNativeTools(); closeOverlay({ reason: 'exported' }); }
        if (event.target.closest?.('[data-import]')) { closeOverlay({ reason: 'select-import', restore: false }); void openImportTools(); }
    });
    anchor?.blur?.();
}

function injectButtons() {
    const root = uiRoot();
    if (!root) return false;
    const top = root.querySelector('.delta-top-actions');
    if (top && !top.querySelector('.delta-tools-data')) {
        const data = document.createElement('button');
        data.type = 'button'; data.className = 'delta-btn delta-tools-data'; data.textContent = 'Data';
        const diagnostics = document.createElement('button');
        diagnostics.type = 'button'; diagnostics.className = 'delta-btn delta-tools-diagnostics-button'; diagnostics.textContent = 'Diagnostics';
        top.prepend(diagnostics); top.prepend(data);
        data.addEventListener('click', () => openDataMenu(data));
        diagnostics.addEventListener('click', () => openDiagnostics());
    }
    const heroActions = root.querySelector('.delta-hero-actions');
    if (heroActions && !heroActions.querySelector('.delta-tools-portrait-button')) {
        const portrait = document.createElement('button');
        portrait.type = 'button'; portrait.className = 'delta-btn delta-tools-portrait-button'; portrait.textContent = 'Portrait';
        portrait.addEventListener('click', () => openPortraitTools());
        heroActions.appendChild(portrait);
    }
    return true;
}

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.npc-state-delta-tools-overlay{position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:rgba(0,0,0,.72);overflow:auto}.delta-tools-dialog{width:min(920px,100%);max-height:min(900px,calc(100dvh - 24px));display:flex;flex-direction:column;background:var(--SmartThemeBlurTintColor,#18191d);color:var(--SmartThemeBodyColor,#f1efe9);border:1px solid rgba(218,193,148,.4);border-radius:14px;box-shadow:0 20px 70px rgba(0,0,0,.55);overflow:hidden}.delta-tools-dialog>header,.delta-tools-dialog>footer{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(255,255,255,.04)}.delta-tools-dialog>header{justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.1)}.delta-tools-dialog>footer{flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.1)}.delta-tools-dialog h2,.delta-tools-dialog h3{margin:.1em 0}.delta-tools-dialog small{opacity:.72}.delta-tools-kicker{display:block;font-size:10px;letter-spacing:.14em;opacity:.65}.delta-tools-close{min-width:44px;min-height:44px;font-size:25px}.delta-tools-body{overflow:auto;padding:14px;overscroll-behavior:contain}.delta-tools-dialog button,.delta-tools-file-button{min-height:44px;padding:9px 12px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(255,255,255,.08);color:inherit;cursor:pointer}.delta-tools-dialog button:disabled{opacity:.45;cursor:not-allowed}.delta-tools-file-button{display:inline-flex;align-items:center}.delta-tools-file-button input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.delta-tools-portrait-grid{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(280px,1.2fr);gap:16px}.delta-tools-preview{display:grid;gap:12px}.delta-tools-current,.delta-tools-generated{min-height:240px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.12);border-radius:11px;overflow:hidden;background:rgba(0,0,0,.18)}.delta-tools-current img,.delta-tools-generated img{width:100%;max-height:360px;object-fit:contain}.delta-tools-placeholder,.delta-tools-generated-placeholder{padding:22px;text-align:center;opacity:.7}.delta-tools-prompts label{display:grid;gap:5px;margin-bottom:10px}.delta-tools-prompts textarea{width:100%;min-height:110px;resize:vertical;background:rgba(0,0,0,.2);color:inherit;border:1px solid rgba(255,255,255,.18);border-radius:9px;padding:9px}.delta-tools-copy-row{display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 12px}.delta-tools-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}.delta-tools-summary>*{padding:9px;border:1px solid rgba(255,255,255,.1);border-radius:8px;overflow-wrap:anywhere}.delta-tools-warning{border-left:3px solid #e5b66f;padding-left:10px}.delta-tools-danger{border-color:#d88!important}.delta-tools-check{display:flex;gap:9px;align-items:center;padding:10px 0}.delta-tools-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.delta-tools-metrics div{padding:10px;border:1px solid rgba(255,255,255,.1);border-radius:9px}.delta-tools-metrics b,.delta-tools-metrics span{display:block}.delta-tools-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(0,0,0,.2);padding:10px;border-radius:8px;max-height:260px;overflow:auto}.delta-tools-small{width:min(620px,100%)}
@media(max-width:760px){.npc-state-delta-tools-overlay{place-items:start center;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom))}.delta-tools-dialog{max-height:calc(100dvh - 16px);border-radius:10px}.delta-tools-portrait-grid{grid-template-columns:1fr}.delta-tools-current,.delta-tools-generated{min-height:170px}.delta-tools-summary,.delta-tools-metrics{grid-template-columns:1fr 1fr}.delta-tools-dialog>footer{position:sticky;bottom:0}.delta-tools-dialog button,.delta-tools-file-button{min-height:46px}}
@media(max-width:430px){.delta-tools-summary,.delta-tools-metrics{grid-template-columns:1fr}.delta-tools-dialog>footer>*{flex:1 1 auto}}
`;
    document.head.appendChild(style);
}

function start(attempt = 0) {
    if (typeof document === 'undefined') return;
    installStyles();
    if (injectButtons()) {
        const root = uiRoot();
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
