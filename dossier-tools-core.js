/* NPC State Delta supporting tools: portrait manager, native data transfer, and diagnostics. */

const OVERLAY_ID = 'npc_state_delta_tools_overlay';
const DOSSIER_ROOT_ID = 'npc_state_delta_dossier_root';
const TOOL_EVENT_LIMIT = 60;
const PROMPT_DRAFT_LIMIT = 20;
const PORTRAIT_FILE_LIMIT = 16 * 1024 * 1024;
const RELATIONSHIP_AXES = Object.freeze(['trust', 'affection', 'desire', 'tension']);
const RELATIONSHIP_GATE_THRESHOLDS = Object.freeze([25, 50, 75, 90]);

export const toolEvents = [];
export const promptDrafts = new Map();
export let activeOverlay = null;
export let activeSession = null;
let sessionSequence = 0;

export function plain(value) { return String(value ?? '').trim(); }
export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}
export function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}
export function clampText(value, limit = 240) { return String(value ?? '').slice(0, limit); }

export function boundedAppend(list, value, limit = TOOL_EVENT_LIMIT) {
    if (!Array.isArray(list)) return [];
    list.push(value);
    if (list.length > limit) list.splice(0, list.length - limit);
    return list;
}

export function estimateLocalTokens(chars) {
    const count = Math.max(0, Math.round(safeNumber(chars, 0)));
    return count ? Math.max(1, Math.ceil(count / 4)) : 0;
}

export function validatePortraitFile(file) {
    if (!file) return { ok: false, reason: 'No image was selected.' };
    if (!plain(file.type).toLowerCase().startsWith('image/')) return { ok: false, reason: 'Choose a supported image file.' };
    if (safeNumber(file.size, 0) > PORTRAIT_FILE_LIMIT) return { ok: false, reason: 'Image exceeds the 16 MB input safety limit.' };
    return { ok: true, reason: '' };
}

export function relationshipDiagnosticRows(npc = {}) {
    const relationship = npc?.relationship && typeof npc.relationship === 'object' ? npc.relationship : {};
    const progress = npc?.relationshipProgress && typeof npc.relationshipProgress === 'object' ? npc.relationshipProgress : {};
    const milestones = Array.isArray(npc?.relationshipMilestones) ? npc.relationshipMilestones : [];
    return RELATIONSHIP_AXES.map(axis => {
        const score = Math.max(-100, Math.min(100, safeNumber(relationship[axis], 0)));
        const fraction = Math.max(-0.999999, Math.min(0.999999, safeNumber(progress[axis], 0)));
        const direction = score < 0 ? -1 : 1;
        const reached = RELATIONSHIP_GATE_THRESHOLDS.filter(threshold => Math.abs(score) >= threshold);
        const missingReached = reached.filter(threshold => !milestones.some(item => plain(item?.axis) === axis
            && safeNumber(item?.polarity, 0) === direction
            && safeNumber(item?.threshold, 0) === threshold));
        return {
            axis,
            score,
            fractionalProgress: fraction,
            recordedMilestones: milestones.filter(item => plain(item?.axis) === axis).length,
            derivedGateAudit: missingReached.length ? `Missing reached gate record(s): ${missingReached.join(', ')}` : 'Recorded gates consistent with reached thresholds',
        };
    });
}

export function summarizeDecodedBundle(decoded = {}) {
    const npcs = Array.isArray(decoded?.state?.npcs) ? decoded.state.npcs : [];
    const portraits = npcs.filter(npc => plain(npc?.portrait?.dataUrl)).length;
    const history = decoded?.historyArchive && typeof decoded.historyArchive === 'object' ? decoded.historyArchive : null;
    return {
        dossiers: npcs.length,
        portraits,
        portableSettings: Boolean(decoded?.portableSettings && typeof decoded.portableSettings === 'object'),
        historyIncluded: Boolean(history),
        checkpoints: Array.isArray(history?.checkpoints) ? history.checkpoints.length : 0,
        inlineHistory: Array.isArray(history?.inlineCards) ? history.inlineCards.length : 0,
        sourceChatKey: clampText(decoded?.metadata?.sourceChatKey || '', 180),
        formatVersion: safeNumber(decoded?.metadata?.formatVersion, 0),
        appVersion: clampText(decoded?.metadata?.appVersion || '', 60),
    };
}

export function buildPortablePortraitSettings(raw = {}) {
    return {
        portraitGenerationEnabled: raw?.portraitGenerationEnabled !== false,
        portraitThemePreset: clampText(raw?.portraitThemePreset || 'custom', 80),
        portraitStylePositive: clampText(raw?.portraitStylePositive || '', 2400),
        portraitStyleNegative: clampText(raw?.portraitStyleNegative || '', 2400),
        portraitComposition: clampText(raw?.portraitComposition || '', 1200),
        portraitPromptFormat: clampText(raw?.portraitPromptFormat || 'hybrid', 40),
        portraitUseMood: raw?.portraitUseMood !== false,
        portraitUseLocation: raw?.portraitUseLocation === true,
        portraitSaveToGallery: raw?.portraitSaveToGallery === true,
    };
}

function safeToolEvent(type, values = {}) {
    const allowed = {};
    for (const key of ['chatKey', 'npcId', 'action', 'outcome', 'detail', 'persisted', 'stale']) {
        if (!(key in values)) continue;
        const value = values[key];
        allowed[key] = typeof value === 'boolean' ? value : clampText(value, key === 'detail' ? 240 : 120);
    }
    return { type: clampText(type, 80), at: Date.now(), ...allowed };
}

export function recordToolEvent(type, values = {}) {
    boundedAppend(toolEvents, safeToolEvent(type, values), TOOL_EVENT_LIMIT);
}

export function api() { return globalThis.NPCStateDelta || null; }
export function uiRoot() { return document.getElementById(DOSSIER_ROOT_ID); }
export function activeChatKey() {
    try { return plain(api()?.uiStatus?.()?.chatKey); } catch { return ''; }
}
export function npcById(id) {
    try { return api()?.getState?.()?.npcs?.find?.(npc => String(npc?.id || '') === String(id || '')) || null; }
    catch { return null; }
}
export function selectedNpcId() {
    const root = uiRoot();
    const selected = root?.querySelector?.('.delta-cast-card.selected')?.dataset?.npcId
        || root?.querySelector?.('.delta-hero .delta-edit[data-npc-id]')?.dataset?.npcId
        || '';
    return plain(selected);
}
export function portraitSignature(npc) {
    const portrait = npc?.portrait || null;
    return portrait ? `${plain(portrait.dataUrl).length}:${safeNumber(portrait.updatedAt, 0)}:${plain(portrait.sourceName)}` : 'none';
}
export function draftKey(chatKey, npcId) { return `${chatKey}::${npcId}`; }
export function keepPromptDraft(key, draft) {
    promptDrafts.delete(key);
    promptDrafts.set(key, { ...draft, touchedAt: Date.now() });
    while (promptDrafts.size > PROMPT_DRAFT_LIMIT) promptDrafts.delete(promptDrafts.keys().next().value);
}
export function portraitTargetCurrent({
    expectedChatKey = '', actualChatKey = '', npcId = '', npcExists = false,
    sessionId = null, activeSessionId = null, actionSeq = null, expectedActionSeq = null, cancelled = false,
} = {}) {
    if (cancelled || !expectedChatKey || expectedChatKey !== actualChatKey || !npcId || !npcExists) return false;
    if (sessionId !== null && activeSessionId !== null && sessionId !== activeSessionId) return false;
    if (expectedActionSeq !== null && actionSeq !== null && actionSeq !== expectedActionSeq) return false;
    return true;
}

export function currentSessionIs(session) {
    return Boolean(session && activeSession === session && activeOverlay?.isConnected && portraitTargetCurrent({
        expectedChatKey: session.chatKey,
        actualChatKey: activeChatKey(),
        npcId: session.npcId,
        npcExists: Boolean(npcById(session.npcId)),
        sessionId: session.id,
        activeSessionId: activeSession?.id ?? null,
        cancelled: session.cancelled,
    }));
}
function invalidateSession(reason = 'closed') {
    if (activeSession) {
        activeSession.cancelled = true;
        activeSession.actionSeq += 1;
        recordToolEvent('workflow-closed', { chatKey: activeSession.chatKey, npcId: activeSession.npcId, action: activeSession.kind, detail: reason });
    }
}

function restoreFocus(session) {
    try { session?.returnFocus?.focus?.({ preventScroll: true }); } catch {}
}

export function closeOverlay({ reason = 'closed', restore = true } = {}) {
    const session = activeSession;
    invalidateSession(reason);
    activeOverlay?.remove?.();
    activeOverlay = null;
    activeSession = null;
    document.documentElement?.classList?.remove?.('npc-state-delta-tools-open');
    document.body?.classList?.remove?.('npc-state-delta-tools-open');
    if (restore) restoreFocus(session);
}

export function makeSession(kind, values = {}) {
    return {
        id: ++sessionSequence,
        kind,
        chatKey: activeChatKey(),
        npcId: plain(values.npcId),
        returnFocus: document.activeElement,
        actionSeq: 0,
        busy: false,
        cancelableBusy: false,
        cancelled: false,
        previewUrl: '',
        importBytes: null,
        importDecoded: null,
        importSummary: null,
    };
}

export function mountOverlay(html, session) {
    closeOverlay({ reason: 'replaced', restore: false });
    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'npc-state-delta-tools-overlay';
    overlay.innerHTML = html;
    overlay.addEventListener('click', event => {
        if (event.target === overlay && (!session.busy || session.cancelableBusy)) closeOverlay({ reason: 'backdrop' });
        const close = event.target.closest?.('[data-delta-tools-close]');
        if (close && (!session.busy || session.cancelableBusy)) {
            event.preventDefault();
            closeOverlay({ reason: 'cancelled' });
        }
    });
    document.body.appendChild(overlay);
    document.documentElement?.classList?.add?.('npc-state-delta-tools-open');
    document.body?.classList?.add?.('npc-state-delta-tools-open');
    activeOverlay = overlay;
    activeSession = session;
    requestAnimationFrame(() => overlay.querySelector('[data-delta-tools-autofocus], [data-delta-tools-close]')?.focus?.());
    recordToolEvent('workflow-opened', { chatKey: session.chatKey, npcId: session.npcId, action: session.kind });
    return overlay;
}

export function setBusy(session, busy, status = '', { allowClose = false } = {}) {
    if (!currentSessionIs(session) && session.kind === 'portrait') return;
    const nextBusy = Boolean(busy);
    const wasBusy = Boolean(session.busy);
    const controls = activeOverlay?.querySelectorAll?.('[data-delta-tools-close], button, input[type="file"]') || [];
    if (nextBusy && !wasBusy) {
        controls.forEach?.(control => {
            if (control.dataset?.deltaToolsAllowBusy === '1' || (allowClose && control.matches?.('[data-delta-tools-close]'))) return;
            control.dataset.deltaToolsBusyPrevDisabled = control.disabled ? '1' : '0';
            control.disabled = true;
        });
    } else if (!nextBusy && wasBusy) {
        controls.forEach?.(control => {
            if (control.dataset?.deltaToolsAllowBusy === '1') return;
            control.disabled = control.dataset.deltaToolsBusyPrevDisabled === '1';
            delete control.dataset.deltaToolsBusyPrevDisabled;
        });
    }
    session.busy = nextBusy;
    session.cancelableBusy = nextBusy && allowClose;
    const statusNode = activeOverlay?.querySelector?.('[data-delta-tools-status]');
    if (statusNode) {
        statusNode.textContent = status;
        statusNode.hidden = !status;
    }
}

export function stage1Refresh() {
    try { uiRoot()?.__npcStateDeltaStage1Ui?.scheduleRefresh?.(); } catch {}
}

export async function flushDurably(chatKey, context) {
    if (activeChatKey() !== chatKey) throw new Error('The active chat changed before persistence completed.');
    try {
        const runtime = api();
        if (typeof runtime?.flush !== 'function') throw new Error('Canonical durable flush API is unavailable.');
        await runtime.flush();
        recordToolEvent('persistence', { chatKey, action: context, outcome: 'saved', persisted: true });
        return { persisted: true, error: null };
    } catch (error) {
        recordToolEvent('persistence', { chatKey, action: context, outcome: 'failed', persisted: false, detail: error?.message || error });
        return { persisted: false, error };
    }
}
