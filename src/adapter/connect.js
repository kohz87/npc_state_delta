// Finding the host and registering with it (src/storysuite-v2.js): look for a Story Block v2 on the page a bounded number of times,
// register Delta's module, watch that the host is still the one registered with, and give everything back when it goes.
//
// A part of the adapter closure: createConnectPart(session, deps) gets the adapter's shared state (session) and the adapter's options,
// constants and the parts built before it (deps), and returns what the other parts and the adapter use. No SillyTavern import.

/** True when `host` looks like Story Block v2's global: a `ready` promise or an `sdk` object. */
export function isV2Host(host) {
    if (!host || (typeof host !== 'object' && typeof host !== 'function')) return false;
    return typeof host.ready?.then === 'function' || typeof host.sdk?.registerModule === 'function';
}

export function createConnectPart(session, deps) {
    const {
        aliveMs, announceHosted, attempts, cardSettings, chatKeyOf, definition, dossiersReady, host, listen, loadDossierList,
        doc, loadEmptyCast, onTurn: runTurn, portraitFill: fillPortraits, registerCardSettings, registerPublicPaths, retryMs, startTimeline, stopTimeline,
        syncDrawer, timers, unmountSection, warn, flushNotify,
    } = deps;

    // A host capture or Re-read that settles after Delta's last render: an open dossier panel asks to draw again (it draws only
    // when its view token moved).
    function refreshPanel() {
        try { doc?.getElementById?.('npc_state_delta_dossier_root')?.__npcStateDeltaStage1Ui?.scheduleRefresh?.(); } catch { /* no panel open */ }
    }
    // The host's 'turn' and 'head' events run Delta's own steps, then the panel's refresh.
    // Each also moves session.hostRev, which the dossier view token caches the host's views by (hostRevision).
    const onTurn = turn => { session.hostRev += 1; try { return runTurn(turn); } finally { refreshPanel(); } };
    const portraitFill = (...args) => { session.hostRev += 1; try { return fillPortraits(...args); } finally { refreshPanel(); } };

    let aliveTimer = null;
    let hostRef = null;          // the Story Block global we connected to
    let offTurn = null;          // unsubscribes from the host's 'turn' event
    let offHead = null;          // unsubscribes from the host's 'head' event
    let offsRev = [];            // unsubscribe from the host's 'committed' / 'feature' / 'modules' events (they move hostRev too)
    let offCardSettings = null;  // unregisters Delta's card settings

    async function register(sdk, from, attempt) {
        if (hostRef !== from) return false;
        if (host() !== from) {
            // Replaced while it was getting ready: look again (still within the bound).
            hostRef = null;
            if (session.started) schedulePoll(attempt + 1);
            return false;
        }
        if (typeof sdk?.registerModule !== 'function' || session.sdkRef === sdk) return false;
        session.sdkRef = sdk;
        // The host's registerModule is async: Delta is hosted (drawer copy, launcher and in-chat cast
        // step aside) only once the host has accepted the module, never on a refusal.
        try {
            await sdk.registerModule(definition);
        } catch (error) {
            if (session.sdkRef === sdk) session.sdkRef = null;
            warn('Story Suite v2 registration failed; Delta keeps working on its own', error);
            return false;
        }
        if (!session.started || hostRef !== from || session.sdkRef !== sdk) return false;
        session.hosted = true;
        try {
            const off = typeof sdk.on === 'function' ? sdk.on('turn', onTurn) : null;
            offTurn = typeof off === 'function' ? off : null;
        } catch (error) { warn('Story Suite v2 turn events are not available', error); }
        try {
            const off = typeof sdk.on === 'function' ? sdk.on('head', portraitFill) : null;
            offHead = typeof off === 'function' ? off : null;
        } catch (error) { warn('Story Suite v2 head events are not available', error); }
        for (const name of ['committed', 'feature', 'modules']) {   // (a command's write, a Feature switched, a module's state moved: each can move what the host answers)
            try {
                const off = typeof sdk.on === 'function' ? sdk.on(name, () => { session.hostRev += 1; }) : null;
                if (typeof off === 'function') offsRev.push(off);
            } catch (error) { warn(`Story Suite v2 ${name} events are not available`, error); }
        }
        offCardSettings = registerCardSettings(sdk, cardSettings);
        session.offPublicPaths = registerPublicPaths(sdk);
        session.baselineKey = dossiersReady() ? chatKeyOf() : null;
        listen();
        syncDrawer();
        announceHosted(true);
        portraitFill();
        startTimeline();
        aliveTimer = timers.setInterval?.(check, aliveMs) ?? null;
        aliveTimer?.unref?.();
        return true;
    }

    function connect(sb, attempt) {
        hostRef = sb;
        const ready = typeof sb.ready?.then === 'function' ? sb.ready : Promise.resolve(sb.sdk);
        const cast = Promise.resolve().then(() => loadEmptyCast()).then(fn => {
            if (typeof fn === 'function') session.emptyCast = fn;
        }, () => { /* keep the fallback line */ });
        // The dossier list's markup; until it loads (or if it cannot), plain rows of names.
        Promise.resolve().then(() => loadDossierList?.()).then(parts => {
            if (parts && typeof parts.rowNodes === 'function') session.listParts = parts;
        }, () => { /* plain rows */ });
        return Promise.all([ready, cast])
            .then(([sdk]) => register(sdk, sb, attempt))
            .catch(error => {
                warn('Story Block v2 did not become ready; Delta keeps working on its own', error);
                return false;
            });
    }

    function poll(attempt) {
        session.pollTimer = null;
        if (!session.started || hostRef) return;
        const sb = host();
        if (isV2Host(sb)) {
            session.pending = connect(sb, attempt);
            return;
        }
        schedulePoll(attempt + 1);
    }

    function schedulePoll(attempt) {
        if (attempt > attempts || session.pollTimer !== null) return;
        session.pollTimer = timers.setTimeout?.(() => poll(attempt), retryMs) ?? null;
        session.pollTimer?.unref?.();
    }

    // The host went away (or was replaced): everything goes back as it was before hosting.
    function unhost() {
        if (aliveTimer !== null) timers.clearInterval?.(aliveTimer);
        aliveTimer = null;
        const was = session.hosted;
        session.hosted = false;
        stopTimeline();
        try { offTurn?.(); } catch { /* the host is gone */ }
        offTurn = null;
        try { offHead?.(); } catch { /* the host is gone */ }
        offHead = null;
        for (const off of offsRev) { try { off(); } catch { /* the host is gone */ } }
        offsRev = [];
        try { offCardSettings?.(); } catch { /* the host is gone */ }
        offCardSettings = null;
        try { session.offPublicPaths?.(); } catch { /* the host is gone */ }
        session.offPublicPaths = null;
        session.baselineKey = null;
        hostRef = null;
        session.sdkRef = null;
        session.pendingSection = null;
        session.castEl = null;
        unmountSection();
        syncDrawer();
        if (was) announceHosted(false);
        try { flushNotify?.(); } catch { /* nothing waiting */ }
    }

    /** Checks that the host is still there; restores the drawer and looks again when it is not. */
    function check() {
        if (!hostRef || host() === hostRef) return session.hosted;
        unhost();
        if (session.started) poll(0);
        return false;
    }

    return {
        poll, unhost, check,
    };
}
