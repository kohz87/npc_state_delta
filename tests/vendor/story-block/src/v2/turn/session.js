// Story Suite v2: a turn's session housekeeping, moved out of createTurn unchanged: the busy flag and its timer, the two prompt slots,
// the Problems list, the save that never costs the turn, the chat state's first start, the reader's repairs (start over / keep the
// earliest saved point), the rebuild after a head change and the guarded steps planned again after a delete or swipe.
// `createSession(s, deps)` is given the turn's state holder `s` and the few turn parts it uses; it never imports turn.js.

export function createSession(s, deps) {
    const { ctx, store, bus, events, notify, initial, position, roles, hasCarrier, refusal, STATIC_KEY, TAIL_KEY, REPLY_BUSY_MAX_MS, MAX_PROBLEMS, ROLE_SYSTEM } = deps;

    function markBusy() {
        s.replyBusy = true;
        if (s.busyTimer !== null) clearTimeout(s.busyTimer);
        s.busyTimer = setTimeout(markIdle, REPLY_BUSY_MAX_MS);
        s.busyTimer?.unref?.();
    }
    function markIdle() {
        s.replyBusy = false;
        if (s.busyTimer !== null) clearTimeout(s.busyTimer);
        s.busyTimer = null;
        const waiters = s.idleWaiters;
        s.idleWaiters = [];
        for (const resolve of waiters) resolve();
    }

    function setPrompt(key, text, place) {
        if (typeof ctx?.setExtensionPrompt !== 'function') return;
        ctx.setExtensionPrompt(key, text, position(place), 0, false, roles().SYSTEM ?? ROLE_SYSTEM);
    }
    function setPrompts(staticText, tailText) {
        s.slots = { staticText, tailText };
        setPrompt(STATIC_KEY, staticText, 'static');
        setPrompt(TAIL_KEY, tailText, 'tail');
    }
    const clearPrompts = () => setPrompts('', '');

    function problem(entry) {
        const item = { module: null, code: 'PROBLEM', ...entry };
        s.problemLog.push(item);
        if (s.problemLog.length > MAX_PROBLEMS) s.problemLog.splice(0, s.problemLog.length - MAX_PROBLEMS);
        // A quiet one (a line of a feature the reader turned off) is listed, not warned about.
        if (item.quiet !== true) console.warn(`[Story Suite] ${item.module ? `${item.module}: ` : ''}${item.message}`);
        return item;
    }

    // A save that fails never costs the turn (SPEC §3.3): the reader is told, the state stays in
    // memory marked unsaved, and the save is tried again after the reply (or with the next change).
    async function trySave(when) {
        try {
            await store.flush();
            return true;
        } catch (error) {
            const why = String(error?.message ?? error).trim().replace(/[.\s]*$/, '.');
            const reason = `The story could not be saved ${when}: ${why} It is kept and will be saved again.`;
            problem({ code: 'SAVE_FAILED', message: reason });
            try { notify?.(reason, null); } catch { /* a missing toastr is not an error */ }
            return false;
        }
    }

    // The chat's state starts on its first carrier; a damaged record set up again goes to the Problems.
    function ensureInitial() {
        const notes = store.ensureInitial(initial());
        for (const note of Array.isArray(notes) ? notes : []) problem({ code: 'DAMAGED', message: note, ...(repairActions().length ? { actions: repairActions() } : {}) });
    }

    // What the reader may do about a story that Story Block keeps as it is (read-only), only on their say, each asked
    // twice (never automatic): the actions the Problem carries and Settings → Diagnostics shows. A record from a newer
    // version has none: update Story Block.
    const START_OVER = Object.freeze({ id: 'start-over', label: 'Start this chat\'s story state over', confirm: 'The saved story state of this chat cannot be used as it is, and it is kept aside. Starting over begins the story\'s numbers (items, money, places) from their start, and the replies after it add their changes again. Start over?' });
    const KEEP_EARLIEST = Object.freeze({ id: 'keep-earliest', label: 'Keep the story state from the earliest saved point', confirm: 'The replies before the earliest saved point of this story are gone, and this session could not check what they did. Keeping it trusts that saved point as the start of the story, with whatever the deleted replies left in it. Keep it?' });
    function repairActions() {
        const kept = store.readOnly?.();
        if (!kept || kept.kind === 'future') return [];
        return kept.kind === 'unresolved' ? [KEEP_EARLIEST, START_OVER] : [START_OVER];
    }
    /** The reader's confirmed repair (store.startOver / keepEarliest): → { ok: true } | { ok: false, code, message }. */
    async function repair(id, { confirmed = false } = {}) {
        try {
            if (id === 'keep-earliest') store.keepEarliest?.({ confirmed });
            else if (id === 'start-over') store.startOver?.({ confirmed });
            else return refusal('NOT_FOUND', `There is no repair called "${id}".`);
        } catch (error) {
            return refusal('REFUSED', error?.message ?? String(error));
        }
        rebuild({ reason: 'repair' });
        await trySave('after the repair');
        return { ok: true };
    }
    const startOver = options => repair('start-over', options);

    // `publish: false`: the caller finishes its own work first (reconciling after a delete) and tells the screens once.
    // `reason` (repair, ...) rides on the head event for the public API's `story:rebuilt` (public-api.js).
    function rebuild({ publish = true, reason = null } = {}) {
        store.rebuild();
        if (hasCarrier()) ensureInitial();
        if (publish) events?.emit('head', { index: store.headIndex(), ...(reason ? { reason } : {}) });
    }

    // A guarded system step with a `replan` planned again (store.replaceStory / store.reconcile's `rerun`): as its
    // span saved it (type, payload, seed: `info.replan`; the receipt is only what was shown), on `state`, on the
    // reply it is kept on (`own` for the one a Re-read is on), keeping its ordinal.
    function planAgain(state, receipt, info = null, own = null) {
        const plan = info?.replan ?? { type: receipt.type, payload: receipt.replan?.payload ?? {}, seed: receipt.seed };
        const at = Number.isInteger(info?.index) ? info.index : null;
        const reply = own ?? (at !== null && store.carrierSid?.(at) ? { index: at, sid: store.carrierSid(at) } : null);
        const ordinal = info?.span?.source?.ordinal;
        // The proof of the block being planned again may be given again: the step keeps its ids.
        const replacing = Array.isArray(info?.span?.evidence) ? info.span.evidence : [];
        return bus.run(plan.type, plan.payload ?? {}, { cause: 'system', state, seed: plan.seed, replacing, reusing: typeof info?.span?.id === 'string' ? info.span : null, ...(Number.isInteger(info?.occurrence) ? { occurrence: info.occurrence } : {}), ...(reply ? { reply: { ...reply, ...(Number.isInteger(ordinal) ? { ordinal } : {}), ...(Number.isInteger(info?.opsBefore) ? { opsBefore: info.opsBefore } : {}) } } : {}) });
    }

    // After a delete or swipe (REPLAY.md "Reconciling"): the guarded steps that carry a `replan` are planned again
    // from the first one on, in the same save window; steps that come out as they were change nothing and write
    // nothing. Not while the story record is read-only. What was planned again is a Problem, quietly.
    function reconcileNow() {
        const from = store.replansFrom?.();
        if (!Number.isInteger(from) || store.readOnly?.()) return;
        try {
            const done = store.reconcile(from, { rerun: planAgain });
            if (!done.changed) return;
            store.scheduleSave?.();
            const parts = [done.planned ? `${done.planned} planned again` : '', done.removed ? `${done.removed} taken back` : ''].filter(Boolean).join(', ');
            if (!parts) return;     // (revs numbered on, nothing the reader needs told)
            problem({ code: 'REPLANNED', quiet: true, message: `The story before some steps changed, so ${parts || 'steps'} (their changes follow what is there now).` });
        } catch (error) {
            problem({ code: 'FAILED', message: `Steps that follow the change could not be planned again: ${error?.message ?? error}` });
        }
    }

    return { markBusy, markIdle, setPrompt, setPrompts, clearPrompts, problem, trySave, ensureInitial, repairActions, repair, startOver, rebuild, planAgain, reconcileNow };
}
