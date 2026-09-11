/* NPC State Delta Stage 3 scanner request routing owner. */

const EXTENSION_NAME = 'npc_state_delta';
const PROFILE_KEY = 'scannerConnectionProfile';
const CONTROL_ID = 'npc_state_delta_scanner_connection_profile';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const inflight = new Map();
let requestSequence = 0;
let initialized = false;
let profileEventsBound = false;

const metrics = {
    total: 0,
    defaultRoute: 0,
    profileRoute: 0,
    succeeded: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
    last: null,
};

function hostContext() {
    try { return globalThis.SillyTavern?.getContext?.() || null; }
    catch { return null; }
}

function routeSettings(ctx = hostContext()) {
    const extensionSettings = ctx?.extensionSettings;
    if (!extensionSettings || typeof extensionSettings !== 'object') return null;
    const root = extensionSettings[EXTENSION_NAME] ||= {};
    if (root[PROFILE_KEY] === undefined) root[PROFILE_KEY] = '';
    return root;
}

export function selectedScannerProfileId(ctx = hostContext()) {
    return String(routeSettings(ctx)?.[PROFILE_KEY] || '').trim();
}

function scannerMessages(options = {}) {
    const messages = [];
    const systemPrompt = String(options.systemPrompt || '').trim();
    const prompt = String(options.prompt || '');
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    if (String(options.prefill || '')) messages.push({ role: 'assistant', content: String(options.prefill) });
    return messages;
}

function abortError(message, kind = 'cancelled') {
    const error = new Error(message);
    error.name = 'NPCStateDeltaScannerRouteError';
    error.code = kind === 'timeout' ? 'NPC_SCANNER_ROUTE_TIMEOUT' : 'NPC_SCANNER_ROUTE_CANCELLED';
    return error;
}

function profileError(message, cause = null) {
    const error = new Error(`NPC State Delta scanner connection profile: ${message}`);
    error.name = 'NPCStateDeltaScannerRouteError';
    error.code = 'NPC_SCANNER_PROFILE_UNAVAILABLE';
    if (cause) error.cause = cause;
    return error;
}

function finishMetric(record, outcome, error = null) {
    const durationMs = Math.max(0, Date.now() - record.startedAt);
    if (outcome === 'success') metrics.succeeded += 1;
    else if (outcome === 'timeout') metrics.timedOut += 1;
    else if (outcome === 'cancelled') metrics.cancelled += 1;
    else metrics.failed += 1;
    metrics.last = {
        id: record.id,
        label: record.label,
        route: record.route,
        profileId: record.profileId || '',
        outcome,
        durationMs,
        at: Date.now(),
        error: error ? String(error?.message || error).slice(0, 240) : '',
    };
}

export async function dispatchScannerRequest(ctx, options = {}, { label = 'scanner request', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!ctx || typeof ctx !== 'object') throw profileError('SillyTavern context is unavailable.');
    const profileId = selectedScannerProfileId(ctx);
    const route = profileId ? 'profile' : 'default';
    const record = {
        id: ++requestSequence,
        label: String(label || 'scanner request').slice(0, 120),
        route,
        profileId,
        startedAt: Date.now(),
    };
    metrics.total += 1;
    if (profileId) metrics.profileRoute += 1;
    else metrics.defaultRoute += 1;

    if (!profileId) {
        if (typeof ctx.generateRaw !== 'function') {
            const error = profileError('the default host generateRaw() route is unavailable.');
            finishMetric(record, 'failure', error);
            throw error;
        }
        try {
            const value = await ctx.generateRaw(options);
            finishMetric(record, 'success');
            return value;
        } catch (error) {
            finishMetric(record, 'failure', error);
            throw error;
        }
    }

    const service = ctx.ConnectionManagerRequestService;
    if (!service || typeof service.sendRequest !== 'function') {
        const error = profileError(`selected profile ${profileId} cannot be used because SillyTavern Connection Manager request services are unavailable.`);
        finishMetric(record, 'failure', error);
        throw error;
    }

    let profile;
    try {
        profile = typeof service.getProfile === 'function'
            ? service.getProfile(profileId)
            : (ctx.extensionSettings?.connectionManager?.profiles || []).find(item => String(item?.id || '') === profileId);
    } catch (cause) {
        const error = profileError(`selected profile ${profileId} is missing. Choose another scanner profile in NPC State Delta settings or restore that Connection Profile.`, cause);
        finishMetric(record, 'failure', error);
        throw error;
    }
    if (!profile) {
        const error = profileError(`selected profile ${profileId} is missing. Choose another scanner profile in NPC State Delta settings or restore that Connection Profile.`);
        finishMetric(record, 'failure', error);
        throw error;
    }
    if (typeof service.isProfileSupported === 'function' && !service.isProfileSupported(profile)) {
        const error = profileError(`selected profile "${profile.name || profileId}" is not supported for text generation by this SillyTavern build.`);
        finishMetric(record, 'failure', error);
        throw error;
    }

    const controller = new AbortController();
    const boundedTimeout = Math.max(1000, Math.min(30 * 60 * 1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('NPC State Delta scanner request timeout');
    }, boundedTimeout);
    inflight.set(record.id, { controller, record });

    try {
        const response = await service.sendRequest(
            profileId,
            scannerMessages(options),
            Math.max(1, Math.round(Number(options.responseLength) || 2048)),
            {
                stream: false,
                signal: controller.signal,
                extractData: true,
                includePreset: true,
                includeInstruct: true,
            },
        );
        if (controller.signal.aborted) throw abortError(
            timedOut
                ? `Scanner request timed out after ${boundedTimeout} ms while using profile "${profile.name || profileId}".`
                : `Scanner request was cancelled while using profile "${profile.name || profileId}".`,
            timedOut ? 'timeout' : 'cancelled',
        );
        if (typeof response === 'function') throw profileError(`selected profile "${profile.name || profileId}" unexpectedly returned a streaming response.`);
        const content = typeof response === 'string' ? response : response?.content;
        if (content === undefined || content === null) throw profileError(`selected profile "${profile.name || profileId}" returned no text content.`);
        finishMetric(record, 'success');
        return String(content);
    } catch (cause) {
        if (timedOut) {
            const error = cause?.code === 'NPC_SCANNER_ROUTE_TIMEOUT'
                ? cause
                : abortError(`Scanner request timed out after ${boundedTimeout} ms while using profile "${profile.name || profileId}".`, 'timeout');
            finishMetric(record, 'timeout', error);
            throw error;
        }
        if (controller.signal.aborted) {
            const error = cause?.code === 'NPC_SCANNER_ROUTE_CANCELLED'
                ? cause
                : abortError(`Scanner request was cancelled while using profile "${profile.name || profileId}".`, 'cancelled');
            finishMetric(record, 'cancelled', error);
            throw error;
        }
        const error = cause?.name === 'NPCStateDeltaScannerRouteError'
            ? cause
            : profileError(`request through profile "${profile.name || profileId}" failed. ${cause?.message || cause}`, cause);
        finishMetric(record, 'failure', error);
        throw error;
    } finally {
        clearTimeout(timer);
        inflight.delete(record.id);
    }
}

export function cancelScannerRequests(reason = 'context changed') {
    let cancelled = 0;
    for (const { controller } of inflight.values()) {
        if (controller.signal.aborted) continue;
        cancelled += 1;
        controller.abort(`NPC State Delta scanner request cancelled: ${reason}`);
    }
    return cancelled;
}

export function scannerRoutingMetrics() {
    return {
        ...metrics,
        inflight: inflight.size,
        last: metrics.last ? { ...metrics.last } : null,
    };
}

function supportedProfiles(ctx) {
    const service = ctx?.ConnectionManagerRequestService;
    if (service && typeof service.getSupportedProfiles === 'function') {
        try { return service.getSupportedProfiles(); }
        catch { return []; }
    }
    return Array.isArray(ctx?.extensionSettings?.connectionManager?.profiles)
        ? ctx.extensionSettings.connectionManager.profiles.filter(profile => profile?.id && profile?.name)
        : [];
}

function mountProfileControl() {
    const ctx = hostContext();
    const settings = routeSettings(ctx);
    const panel = globalThis.document?.querySelector?.('#npc_state_delta_settings');
    if (!ctx || !settings || !panel) return false;
    const anchor = panel.querySelector?.('#npc_state_delta_full_scan_every_turn')?.closest?.('.npc-state-delta-setting-row')
        || panel.querySelector?.('#npc_state_delta_auto')?.closest?.('.npc-state-delta-setting-row');
    if (!anchor) return false;

    let row = globalThis.document.getElementById?.(`${CONTROL_ID}_row`);
    if (!row) {
        row = globalThis.document.createElement('label');
        row.id = `${CONTROL_ID}_row`;
        row.className = 'npc-state-delta-setting-row';
        row.setAttribute?.('for', CONTROL_ID);
        row.innerHTML = `<span><b>NPC scanner connection profile</b><small>Default keeps the current host route. Selecting a SillyTavern Connection Profile routes only NPC State Delta text-model requests; ordinary roleplay and portrait generation stay untouched.</small></span><select id="${CONTROL_ID}" class="text_pole"></select>`;
        anchor.insertAdjacentElement?.('afterend', row);
    }

    const select = globalThis.document.getElementById?.(CONTROL_ID);
    if (!select) return false;
    const selected = String(settings[PROFILE_KEY] || '');
    const profiles = supportedProfiles(ctx);
    const options = [{ id: '', name: 'Use current roleplay connection' }, ...profiles.map(profile => ({ id: String(profile.id), name: String(profile.name || profile.id) }))];
    if (selected && !options.some(option => option.id === selected)) {
        options.push({ id: selected, name: `Unavailable profile (${selected})` });
    }
    select.innerHTML = '';
    for (const optionData of options) {
        const option = globalThis.document.createElement('option');
        option.value = optionData.id;
        option.textContent = optionData.name;
        select.appendChild(option);
    }
    select.value = selected;
    if (select.dataset.npcStateDeltaScannerRoutingBound !== '1') {
        select.dataset.npcStateDeltaScannerRoutingBound = '1';
        select.addEventListener('change', () => {
            const liveCtx = hostContext();
            const liveSettings = routeSettings(liveCtx);
            if (!liveSettings) return;
            liveSettings[PROFILE_KEY] = String(select.value || '');
            try { liveCtx?.saveSettingsDebounced?.(); } catch {}
        });
    }
    return true;
}

function bindProfileEvents() {
    if (profileEventsBound) return;
    const ctx = hostContext();
    const source = ctx?.eventSource;
    const events = ctx?.eventTypes || ctx?.event_types || {};
    if (!source?.on) return;
    profileEventsBound = true;
    for (const key of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        if (events[key]) source.on(events[key], () => setTimeout(mountProfileControl, 0));
    }
    if (events.CHAT_CHANGED) source.on(events.CHAT_CHANGED, () => cancelScannerRequests('chat changed'));
    for (const key of ['APP_READY', 'EXTENSION_SETTINGS_LOADED', 'CHAT_LOADED']) {
        if (events[key]) source.on(events[key], () => setTimeout(mountProfileControl, 50));
    }
}

function init() {
    if (initialized) return void mountProfileControl();
    initialized = true;
    routeSettings();
    bindProfileEvents();
    mountProfileControl();
    let attempts = 0;
    const timer = setInterval(() => {
        attempts += 1;
        bindProfileEvents();
        if (mountProfileControl() || attempts >= 40) clearInterval(timer);
    }, 250);
}

globalThis.NPCStateDeltaScannerRouting = Object.freeze({
    dispatch: dispatchScannerRequest,
    cancelAll: cancelScannerRequests,
    metrics: scannerRoutingMetrics,
    selectedProfileId: selectedScannerProfileId,
    mountProfileControl,
});

if (typeof globalThis.$ === 'function') globalThis.$(init);
else if (globalThis.document?.readyState === 'loading') globalThis.document.addEventListener('DOMContentLoaded', init, { once: true });
else if (globalThis.document) init();
