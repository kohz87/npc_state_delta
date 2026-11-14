// Page-API change listeners: the subscriber set and the one notification loop used by the rendered cast and key-person pin.
//
// (perf) Only the cast-rendered notification of a render caused by the streaming message's growth (one per streamed token) is coalesced: notifyChange(true) runs the first at
// once, further ones inside COALESCE_MS become one trailing call, and none runs while a reply is being made (a generation: checked again every
// RECHECK_MS, at most MAX_HOLD_MS, then it runs anyway). Every other change (Delta turned on or off, the host going away, a timeline change)
// is notifyChange() and goes out at once, with whatever trailing call was waiting folded into it.

const COALESCE_MS = 250;
const RECHECK_MS = 700;
const MAX_HOLD_MS = 200000;

export function createWatchers({ warn, delta = null }) {
    const watchers = new Set();  // the page API's onChange subscribers
    let last = 0;                // when the listeners last ran
    let timer = null;            // the trailing call waiting
    let heldSince = 0;           // when a generation first held a call back
    const generating = () => {
        try { return delta?.()?.generationActive?.() === true; } catch { return false; }
    };
    function run() {
        last = Date.now();
        heldSince = 0;
        for (const fn of [...watchers]) {
            try { fn(); } catch (error) { warn('Story Suite v2 cast listener failed', error); }
        }
    }
    function later(wait) {
        timer = setTimeout(() => { timer = null; notifyChange(true); }, wait);
        timer?.unref?.();
    }
    function notifyChange(coalesce = false) {
        if (!coalesce) {
            if (timer !== null) { clearTimeout(timer); timer = null; }
            run();
            return;
        }
        if (timer !== null) return;   // one is already waiting: it tells the listeners about the newest state
        if (generating()) {
            if (!heldSince) heldSince = Date.now();
            if (Date.now() - heldSince < MAX_HOLD_MS) { later(RECHECK_MS); return; }
        }
        const wait = last + COALESCE_MS - Date.now();
        if (wait > 0) { later(wait); return; }
        run();
    }
    return { watchers, notifyChange };
}
