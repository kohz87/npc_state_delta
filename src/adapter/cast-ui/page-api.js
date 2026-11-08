// The page API Story Director's World screen uses: render present cards with optional slots, report availability, and
// subscribe to cast/state changes. The API object and its props remain frozen as before.

export function createPageApi(session, deps, renderCast, watchers) {
    const { doc, enabled, npcList, page, PAGE_API, PAGE_SLOT_CLASS, runtime, warn } = deps;

    // Each `slot(name, aliases)` node inside its present person's card (the card's text, under the now lines).
    function fillSlots(el, slot) {
        for (const old of [...(el.querySelectorAll?.(`.${PAGE_SLOT_CLASS}`) ?? [])]) old.remove?.();
        const cells = [...(el.querySelectorAll?.('.npc-state-delta-present-cell[data-npc-id]') ?? [])];
        if (typeof slot !== 'function' || !cells.length) return cells.length;
        const list = npcList();
        for (const cell of cells) {
            const npc = list.find(item => String(item.id ?? '') === String(cell.dataset?.npcId ?? ''));
            if (!npc) continue;
            let node = null;
            try { node = slot(String(npc.name ?? '').trim(), Array.isArray(npc.aliases) ? [...npc.aliases] : []); } catch { node = null; }
            if (!node || typeof node !== 'object' || typeof node.nodeType !== 'number') continue;
            node.classList?.add?.(PAGE_SLOT_CLASS);
            (cell.querySelector?.('.npc-state-delta-present-card-text') ?? cell).append?.(node);
        }
        return cells.length;
    }
    // busy(): Delta still has work for the open chat's newest reply (a scan running, due, queued or deferred, or the reply held while the chat
    // loads; the runtime's pageBusy, no state copied). There is no gap in Delta after MESSAGE_RECEIVED: the listener takes its scan intent
    // synchronously; only the host's time before that event is invisible to it. While it reads true, one cheap check every BUSY_POLL_MS tells the
    // onChange listeners once when it turns false: a scan that changed no card dispatches no cast event, and the listeners must still redraw.
    const BUSY_POLL_MS = 250;
    let busyPoll = null;
    function busyNow() {
        if (!session.hosted || !enabled()) return false;
        try { return runtime()?.pageBusy?.() === true; } catch { return false; }
    }
    function watchBusy() {
        if (busyPoll !== null) return;
        busyPoll = setTimeout(() => {
            busyPoll = null;
            if (busyNow()) return watchBusy();
            for (const fn of [...watchers]) {
                try { fn(); } catch (error) { warn('Story Suite v2 cast listener failed', error); }
            }
        }, BUSY_POLL_MS);
        busyPoll?.unref?.();
    }
    const pageApi = Object.freeze({
        version: 2,
        /** True while Delta has not finished reading the newest reply of the open chat; false when hydrated and idle, off or not hosted. */
        busy() {
            const on = busyNow();
            if (on) watchBusy();
            return on;
        },
        /** True while Delta is hosted, loaded and on: its cards can be drawn. */
        available: () => session.hosted && Boolean(runtime()) && enabled(),
        /** Draws the present cast's cards and meters into `el`; → how many present cards it drew (0: none, or not available). */
        render(el, { slot = null } = {}) {
            if (!el || !pageApi.available()) return 0;
            try {
                renderCast(el, { track: false, people: true });
                return fillSlots(el, slot);
            } catch (error) {
                warn('Story Suite v2 World cast failed', error);
                return 0;
            }
        },
        /** `fn()` after Delta's cast or state may have changed; → unsubscribe. */
        onChange(fn) {
            if (typeof fn !== 'function') return () => {};
            watchers.add(fn);
            return () => { watchers.delete(fn); };
        },
    });
    function offerPage(on) {
        if (!page || (typeof page !== 'object' && typeof page !== 'function')) return;
        try {
            if (on) page[PAGE_API] = pageApi;
            else if (page[PAGE_API] === pageApi) delete page[PAGE_API];
        } catch (error) { warn('Story Suite v2 page API failed', error); }
    }

    return { pageApi, offerPage, fillSlots };
}
