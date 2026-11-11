/* NPC State Delta send yield (role: send-yield). The user's Send always wins over a background scan. SillyTavern drops or delays a Send that
   lands while a scan's quiet generation is in flight (seen 3 times in 30 sends, each a few seconds after a reply). So the scanner never
   starts a request while the user is typing, or while a Send's own generation runs; and when Send is pressed under a request already
   sent, that request yields: scanner-routing.js discards its answer and sends the same request again once the user is quiet. Nothing a
   scan would have written is lost: the same prompt runs later. Nothing here holds chat data: it only watches the input box and Send. */

export const SEND_QUIET_MS = 6000;        // no scan request starts within this long of the last key typed in the box
export const SEND_SETTLE_MS = 4000;       // ... or of a Send press (the host has started its generation by then)
export const SEND_MAX_WAIT_MS = 45000;    // a wait is bounded: a stuck box never starves the scans for good
const POLL_MS = 250;

/** `doc`: the page's document (or none: the gate then never holds anything). `now`/`sleep` are for tests. */
export function createSendYield(doc, { now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    let lastInputAt = 0;
    let lastPressAt = 0;
    let epoch = 0;
    const waiters = new Set();
    const press = () => {
        lastPressAt = now();
        epoch += 1;
        for (const wake of [...waiters]) wake();
        waiters.clear();
    };
    const inBox = event => String(event?.target?.id || '') === 'send_textarea';
    const onSendButton = event => Boolean(event?.target?.closest?.('#send_but')) || String(event?.target?.id || '') === 'send_but';
    if (typeof doc?.addEventListener === 'function') {
        doc.addEventListener('input', event => { if (inBox(event)) lastInputAt = now(); }, true);
        doc.addEventListener('keydown', event => {
            if (!inBox(event)) return;
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) press();
            else lastInputAt = now();
        }, true);
        // pointerdown, not click: the yield must start before the host's own click handler reads the state.
        doc.addEventListener('pointerdown', event => { if (onSendButton(event)) press(); }, true);
        doc.addEventListener('click', event => { if (onSendButton(event)) press(); }, true);
    }
    const generating = () => doc?.body?.dataset?.generating === 'true';
    const quietNow = () => now() - lastInputAt >= SEND_QUIET_MS && now() - lastPressAt >= SEND_SETTLE_MS && !generating();
    return {
        /** The number of Send presses so far: a request notes it when it is sent. */
        epoch: () => epoch,
        /** Resolves when the user is quiet (not typing, no Send under way), or after SEND_MAX_WAIT_MS. */
        async quiet() {
            const until = now() + SEND_MAX_WAIT_MS;
            while (!quietNow() && now() < until) await sleep(POLL_MS);
        },
        /** Resolves at the next Send press after `since` (at once if there already was one). */
        pressed(since) {
            if (epoch !== since) return Promise.resolve();
            return new Promise(resolve => waiters.add(resolve));
        },
    };
}
