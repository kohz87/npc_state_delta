// The timeline coordinator's blocked-selection half (docs/v2/TIMELINE.md): what the coordinator does when a participant cannot bring its
// native state to the checkpoint the selected head names. The answer is classified: a PERMANENT one (SNAPSHOT_UNAVAILABLE: the file is
// missing; CONFLICT: the checkpoint belongs to another story line; anything else the participant cannot cure by waiting) is a Problem at
// once; a TRANSIENT one (FAILED: "tried again in a moment"; STALE: still busy; a timeout, which is reported as STALE) is asked again on a
// fixed schedule, and only when the schedule is used up is it a Problem. Nothing here is stored or replayed: the block and its timer live in
// the session (`s.block`, `s.retryTimer`), the schedule is a constant, and no clock or random source decides anything.
// `createBlock(s, deps)` is given the timeline's state holder `s` and the few coordinator functions it calls.

/** The waits before each new try of a transient failure, in milliseconds (a try after the last one gives up). */
export const RETRY_SCHEDULE_MS = Object.freeze([2000, 5000, 15000]);
const TRANSIENT = Object.freeze(['FAILED', 'STALE']);
export const transientCode = code => TRANSIENT.includes(code);

const trim = text => String(text ?? '').trim().replace(/[.\s]+$/, '');

export function createBlock(s, deps) {
    const { archive, registry, problem, raise, again } = deps;

    const nameOf = module => (module ? (registry.module?.(module)?.name ?? module) : 'A part of the story');

    // The plain sentence the reader sees (the barrier's reason, the toast of a send, the Problem).
    function reasonOf(block) {
        const name = nameOf(block.module);
        const cause = trim(block.message);
        if (!block.permanent) return `${name} could not load its saved records for this point yet (${cause}). It is being tried again; wait a moment, or reload the page.`;
        if (block.gaveUp) return `${name} still could not load its saved records for this point after trying again (${cause}). Reload the page to try once more, or delete the changed reply so the story ends where its records exist.`;
        return `${name} cannot restore its saved records for this point (${cause}). Reloading will not bring them back; delete the changed reply so the story ends where its records exist.`;
    }

    function announce(block) {
        if (block.reported) return;
        block.reported = true;
        try { problem?.({ module: block.module ?? undefined, code: block.code, toast: true, message: reasonOf(block) }); } catch { /* a listener is not the timeline's business */ }
    }

    function arm() {
        const block = s.block;
        if (!block || block.permanent || s.retryTimer !== null) return;
        if (block.tries >= RETRY_SCHEDULE_MS.length) {
            block.permanent = true;
            block.gaveUp = true;
            try { raise(reasonOf(block)); } catch { /* the chat was left: nothing to say there */ }
            announce(block);
            return;
        }
        const holder = block.holder;
        s.retryTimer = setTimeout(async () => {
            s.retryTimer = null;
            if (s.block !== block) return;
            if (archive.holder() !== holder) { s.block = null; return; }
            block.tries += 1;
            try { await again(); } catch { /* the next look at the block decides */ }
            if (s.block === block) arm();
        }, RETRY_SCHEDULE_MS[block.tries]);
        s.retryTimer?.unref?.();
    }

    return {
        /** A participant (or the plan itself: `module` null) could not bring the story to the selected head. → the failure, with `blockedBy`, `reason`. */
        note(module, failure) {
            const holder = archive.holder();
            const same = s.block && s.block.holder === holder && s.block.module === module && s.block.code === failure.code ? s.block : null;
            if (!same && s.block) this.clear();
            const block = same ?? (s.block = { holder, module, code: failure.code, message: failure.message, permanent: !transientCode(failure.code), gaveUp: false, tries: 0, reported: false });
            block.message = failure.message;
            const reason = reasonOf(block);
            raise(reason);
            if (block.permanent) announce(block); else arm();
            return { ...failure, reason, blockedBy: { module, code: failure.code } };
        },
        /** The selection went through, or the barrier came down: nothing blocks, and no try is waiting. */
        clear() {
            s.block = null;
            if (s.retryTimer !== null) { clearTimeout(s.retryTimer); s.retryTimer = null; }
        },
        /** What blocks the open chat now: { reason, code, blockedBy: { module, code } } or null. */
        current() {
            const block = s.block;
            if (!block || block.holder !== archive.holder()) return null;
            return { reason: reasonOf(block), code: block.code, blockedBy: { module: block.module, code: block.code } };
        },
    };
}
