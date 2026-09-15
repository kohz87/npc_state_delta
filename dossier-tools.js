/* NPC State Delta dossier supporting tools UI. Uses canonical runtime/state owners. */
import {
    activeChatKey, activeOverlay, activeSession, api, buildPortablePortraitSettings, closeOverlay, currentSessionIs,
    escapeHtml, flushDurably, makeSession, mountOverlay, npcById,
    recordToolEvent, relationshipDiagnosticRows, selectedNpcId,
    setBusy, stage1Refresh, summarizeDecodedBundle, toolEvents,
} from './dossier-tools-core.js';
import { augmentNativeBundle, buildHistoryArchive, prepareNativeImport } from './native-transfer.js';

const STYLE_ID = 'npc_state_delta_tools_style';
const IMPORT_ACCEPT = '.npcstatedelta,application/octet-stream';
let importSelectionSequence = 0;

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
    const selection = ++importSelectionSequence;
    const openingSession = activeSession;
    const selectionCurrent = () => selection === importSelectionSequence && activeSession === openingSession;
    const file = await chooseImportFile();
    if (!file || !selectionCurrent()) return;
    if (file.size > 32 * 1024 * 1024) return toast('error', 'NPC State Delta import exceeds the 32 MB safety limit.');
    if (activeChatKey() !== chatKey) return toast('warning', 'NPC State Delta: the target chat changed while the import picker was open. Reopen Data and choose the file again.');
    let raw;
    try { raw = new Uint8Array(await file.arrayBuffer()); }
    catch (error) { return toast('error', `NPC State Delta import: could not read file. ${error?.message || error}`); }
    if (!selectionCurrent()) return;
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

export function nativeImportResultSummary(result = {}) {
    const report = result.importReport || {};
    const added = Array.isArray(report.added) ? report.added.length : 0;
    const updated = Array.isArray(report.updated) ? report.updated.length : 0;
    const skipped = Array.isArray(report.skipped) ? report.skipped.length : 0;
    return `${added} added, ${updated} updated, ${skipped} skipped; existing active dossiers were preserved`;
}

async function applyImport(session) {
    if (session.busy || !currentSessionIs(session) || !session.importBytes) return;
    const restoreSettings = Boolean(activeOverlay?.querySelector('[data-import-settings]')?.checked);
    setBusy(session, true, 'Applying validated native Delta import through the canonical importer…');
    let dossierApplied = false;
    try {
        const result = await api()?.importBytes?.(session.importBytes);
        if (!result) throw new Error('Canonical importer rejected the validated bundle.');
        dossierApplied = true;
        const saved = await flushDurably(session.chatKey, 'native import');
        let settingsWarning = '';
        if (!currentSessionIs(session)) return;
        if (restoreSettings && session.importDecoded?.portableSettings) {
            try {
                if (typeof api()?.savePortraitSettings !== 'function') throw new Error('Portrait settings save API is unavailable.');
                const savedSettings = await api().savePortraitSettings(session.importDecoded.portableSettings);
                if (savedSettings === false) settingsWarning = ' Portable portrait settings were not restored.';
            } catch (error) {
                settingsWarning = ` Portable portrait settings were not restored: ${error?.message || error}`;
                recordToolEvent('native-import-settings', { chatKey: session.chatKey, action: 'restore-settings', outcome: 'failed', detail: error?.message || error });
            }
        }
        if (!currentSessionIs(session)) return;
        stage1Refresh();
        recordToolEvent('native-import', { chatKey: session.chatKey, action: 'apply', outcome: saved.persisted ? 'saved' : 'local-only', persisted: saved.persisted });
        const fullySuccessful = saved.persisted && !settingsWarning;
        toast(fullySuccessful ? 'success' : 'warning', saved.persisted
            ? `NPC State Delta: ${nativeImportResultSummary(result)}. Target chat saved.${settingsWarning}`
            : `NPC State Delta: import applied locally, but durable save failed. ${saved.error?.message || saved.error}${settingsWarning}`);
        closeOverlay({ reason: 'imported', session });
    } catch (error) {
        if (dossierApplied) {
            recordToolEvent('native-import', { chatKey: session.chatKey, action: 'apply', outcome: 'local-only', persisted: false, detail: error?.message || error });
            toast('warning', `NPC State Delta: the validated import was applied locally, but durable confirmation failed: ${error?.message || error}`);
            closeOverlay({ reason: 'import-local-only', session });
            return;
        }
        if (currentSessionIs(session)) setBusy(session, false, `Import failed before canonical mutation: ${error?.message || error}`);
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
    const branchHistory = status.branchHistory || { available: false };
    const branchReconciliations = Array.isArray(status.branchReconciliations) ? status.branchReconciliations : [];
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
        profileUpdates: Number(scan.profileUpdates || 0),
        profileApplied: Number(scan.profileApplied || 0),
        profileEvidenceAdded: Number(scan.profileEvidenceAdded || 0),
        profileDevelopment: Array.isArray(scan.profileDevelopment) ? scan.profileDevelopment.slice(-12) : [],
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
        <section><h3>Persistence</h3><pre>${escapeHtml(JSON.stringify({ currentChat: api()?.persistenceStatus?.() || { available: false }, recentStage8Failures: recentPersistenceFailures }, null, 2))}</pre><small>Stage 8 waits for canonical flush and distinguishes local mutation from durable save. Pending and in-flight write flags describe this chat only, not a global database counter.</small></section>
        <section><h3>Branch reconciliation</h3><pre>${escapeHtml(JSON.stringify({ history: branchHistory, recent: branchReconciliations }, null, 2))}</pre><small>Delete/edit recovery is exact-boundary only: journal or exact-parent checkpoint, never an older ancestor. Deep edits with a retained assistant suffix fail closed and keep canonical dossiers. Exact SillyTavern swipe siblings restore directly; unseen siblings rebuild from their exact parent/root. Reconciliation records contain no story text.</small></section>
        ${npc ? `<section><h3>Relationship fractions / gate audit · ${escapeHtml(npc.name)}</h3><pre>${escapeHtml(JSON.stringify(rel, null, 2))}</pre></section>` : ''}
        <section><h3>Recent Stage 8 events</h3><pre>${escapeHtml(JSON.stringify(toolEvents.slice(-12).reverse(), null, 2))}</pre><small>Bounded records exclude credentials, full prompts, and provider responses.</small></section>
      </div><footer><button type="button" data-delta-tools-close data-delta-tools-autofocus>Close</button></footer>
    </section>`;
}
export function openDiagnostics() {
    const npc = npcById(selectedNpcId());
    mountOverlay(diagnosticsHtml(npc), makeSession('diagnostics', { npcId: npc?.id || '' }));
}

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* Native modal dialogs enter the browser top layer, which is above every ordinary z-index
   stacking context used by SillyTavern and the dossier panel. */
dialog.npc-state-delta-tools-overlay { width:100vw; max-width:none; height:100dvh; max-height:none; margin:0; border:0; box-sizing:border-box; }
dialog.npc-state-delta-tools-overlay:not([open]) { display:none !important; }
dialog.npc-state-delta-tools-overlay[open] { display:grid !important; }
dialog.npc-state-delta-tools-overlay::backdrop { background:transparent; }
/* Delta's maintained portrait surface is prompt generation + explicit image management only. */
.npc-state-delta-generate-portrait, .npc-state-delta-portrait-run, .npc-state-delta-portrait-use { display:none !important; }

.npc-state-delta-tools-overlay{position:fixed;inset:0;z-index:2147483640;display:grid;place-items:center;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:rgba(0,0,0,.72);overflow:auto}.delta-tools-dialog{width:min(920px,100%);max-height:min(900px,calc(100dvh - 24px));display:flex;flex-direction:column;background:var(--SmartThemeBlurTintColor,#18191d);color:var(--SmartThemeBodyColor,#f1efe9);border:1px solid rgba(218,193,148,.4);border-radius:14px;box-shadow:0 20px 70px rgba(0,0,0,.55);overflow:hidden}.delta-tools-dialog>header,.delta-tools-dialog>footer{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 14px;background:rgba(255,255,255,.04)}.delta-tools-dialog>header{justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.1)}.delta-tools-dialog>footer{flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.1)}.delta-tools-dialog h2,.delta-tools-dialog h3{margin:.1em 0}.delta-tools-dialog small{opacity:.72}.delta-tools-kicker{display:block;font-size:10px;letter-spacing:.14em;opacity:.65}.delta-tools-close{min-width:44px;min-height:44px;font-size:25px}.delta-tools-body{overflow:auto;padding:14px;overscroll-behavior:contain}.delta-tools-dialog button,.delta-tools-file-button{min-height:44px;padding:9px 12px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:rgba(255,255,255,.08);color:inherit;cursor:pointer}.delta-tools-dialog button:disabled{opacity:.45;cursor:not-allowed}.delta-tools-file-button{display:inline-flex;align-items:center}.delta-tools-file-button input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}.delta-tools-portrait-grid{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(280px,1.2fr);gap:16px}.delta-tools-preview{display:grid;gap:12px}.delta-tools-current,.delta-tools-generated{min-height:240px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.12);border-radius:11px;overflow:hidden;background:rgba(0,0,0,.18)}.delta-tools-current img,.delta-tools-generated img{width:100%;max-height:360px;object-fit:contain}.delta-tools-placeholder,.delta-tools-generated-placeholder{padding:22px;text-align:center;opacity:.7}.delta-tools-prompts label{display:grid;gap:5px;margin-bottom:10px}.delta-tools-prompts textarea{width:100%;min-height:110px;resize:vertical;background:rgba(0,0,0,.2);color:inherit;border:1px solid rgba(255,255,255,.18);border-radius:9px;padding:9px}.delta-tools-copy-row{display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 12px}.delta-tools-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px}.delta-tools-summary>*{padding:9px;border:1px solid rgba(255,255,255,.1);border-radius:8px;overflow-wrap:anywhere}.delta-tools-warning{border-left:3px solid #e5b66f;padding-left:10px}.delta-tools-danger{border-color:#d88!important}.delta-tools-check{display:flex;gap:9px;align-items:center;padding:10px 0}.delta-tools-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.delta-tools-metrics div{padding:10px;border:1px solid rgba(255,255,255,.1);border-radius:9px}.delta-tools-metrics b,.delta-tools-metrics span{display:block}.delta-tools-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(0,0,0,.2);padding:10px;border-radius:8px;max-height:260px;overflow:auto}.delta-tools-small{width:min(620px,100%)}
@media(max-width:760px){.npc-state-delta-tools-overlay{place-items:start center;padding-top:max(8px,env(safe-area-inset-top));padding-bottom:max(8px,env(safe-area-inset-bottom))}.delta-tools-dialog{max-height:calc(100dvh - 16px);border-radius:10px}.delta-tools-portrait-grid{grid-template-columns:1fr}.delta-tools-current,.delta-tools-generated{min-height:170px}.delta-tools-summary,.delta-tools-metrics{grid-template-columns:1fr 1fr}.delta-tools-dialog>footer{position:sticky;bottom:0}.delta-tools-dialog button,.delta-tools-file-button{min-height:46px}}
@media(max-width:430px){.delta-tools-summary,.delta-tools-metrics{grid-template-columns:1fr}.delta-tools-dialog>footer>*{flex:1 1 auto}}
`;
    document.head.appendChild(style);
}

if (typeof document !== 'undefined') installStyles();
