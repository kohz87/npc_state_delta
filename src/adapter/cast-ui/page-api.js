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
    const pageApi = Object.freeze({
        version: 1,
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
