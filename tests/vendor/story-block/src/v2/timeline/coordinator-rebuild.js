// The timeline coordinator's rebuild half (docs/v2/TIMELINE.md; the owner's decision for a permanently blocked
// branch): a branch whose dossiers cannot be brought to the selected head may start them again from the chat.
// The reader chooses the last 40 replies (the default) or the whole chat. The pending selection is closed as
// `rebuilt` with `slots[module] = { rebuilt: true }`, the module's selected checkpoint is dropped, and the
// participant is asked once to rebuild. The journal entry is the only record: an old chat never calls this, and a
// chat that was rebuilt replays with the selection its participant published afterwards.
//
// `createRebuild(s, deps)` is given the timeline's state holder `s` and the coordinator functions it calls; it
// never imports coordinator.js. The participant callback needs the head and its own native mutation, so the
// barrier is taken down after the journal is durable and before the callback; `release` puts it back on its
// settled state afterwards (and is the only caller of the participant's own publication).

import { crashing, fail, isObject, makeId } from './util.js';

/** The default number of replies a rebuild reads. */
export const REBUILD_DEFAULT_REPLIES = 40;
/** `rebuild(module, { read })` choices. */
export const REBUILD_READ_LAST = 'last-40';
export const REBUILD_READ_ALL = 'all';
/** The Problem code a successful rebuild records. */
export const REBUILD_PROBLEM_CODE = 'REBUILT';
/** The causes that may be cured by rebuilding (a permanent block only). */
export const REBUILD_CODES = Object.freeze(['SNAPSHOT_UNAVAILABLE', 'CONFLICT', 'DEPENDENCY_UNAVAILABLE']);

const OPEN_RESTORE = Object.freeze(['committed', 'participants-pending', 'acked']);
const OPEN_NATIVE = Object.freeze(['prepared']);
const SETTLED_SELECTION = Object.freeze(['complete', 'rebuilt']);

/** The read plan of `rebuild(module, input)`: `{ ok: true, read, replies }` or INVALID. */
export function readPlan(input = {}) {
    if (input === undefined) input = {};
    if (!isObject(input)) return fail('INVALID', 'rebuild takes { read? }.');
    for (const key of Object.keys(input)) if (key !== 'read') return fail('INVALID', `rebuild does not take "${key}".`);
    const read = input.read ?? REBUILD_READ_LAST;
    if (read === REBUILD_READ_LAST) return { ok: true, read, replies: REBUILD_DEFAULT_REPLIES };
    if (read === REBUILD_READ_ALL) return { ok: true, read, replies: null };
    return fail('INVALID', `The rebuild reads "${REBUILD_READ_LAST}" or "${REBUILD_READ_ALL}", not ${JSON.stringify(read)}.`);
}

/**
 * The reader-facing number of the head reply: the count of story replies through the boundary, or the message
 * position when the chat is not available. → a whole number, or null when the boundary has no position.
 */
export function replyNumberAt(boundary, messages = []) {
    const at = Number.isInteger(boundary?.index) ? boundary.index : -1;
    if (at < 0) return null;
    if (Array.isArray(messages) && messages.length > at) {
        let replies = 0;
        for (let index = 0; index <= at; index += 1) if (messages[index] && !messages[index].is_user) replies += 1;
        if (replies > 0) return replies;
    }
    return at + 1;
}

/** The exact Problem sentence a successful rebuild records. */
export const rebuildMessage = reply => `dossiers rebuilt from the chat at reply ${reply}`;

export function createRebuild(s, deps) {
    const {
        archive, block, callParticipant, durable, headNow, here = () => {}, point = async () => {}, release = null,
        barrier = null, raise = () => {}, problem = null, chat = () => [], fallbackEmpty = null, participants = null,
    } = deps;

    // The callback is the participant's own: it reads the head and publishes its fresh state by `nativeMutation`.
    // Both are refused while this timeline is barred, so the journal is closed first and the barrier comes down for
    // that call. A failure puts a permanent block (with the original cause) back before the caller sees it.
    function lowerForParticipant() {
        if (s) { s.barrierOwner = null; s.barrierEarly = false; }
        block.clear();
        if (typeof barrier === 'function') barrier('idle', '');
    }

    const permanentFor = module => {
        const now = block.current();
        const blockedBy = now?.blockedBy;
        if (!blockedBy || blockedBy.module !== module || !REBUILD_CODES.includes(blockedBy.code)) return null;
        return now;
    };

    const outstanding = (ignore = null) => archive.entries().find(entry => entry.id !== ignore
        && ((entry.kind === 'restore' && OPEN_RESTORE.includes(entry.phase))
            || (entry.kind === 'selection' && !SETTLED_SELECTION.includes(entry.phase))
            || (['native-mutation', 'native-event'].includes(entry.kind) && OPEN_NATIVE.includes(entry.phase)))) ?? null;

    async function rebuild(module, input = {}) {
        if (typeof module !== 'string' || !module) return fail('INVALID', 'rebuild names the module whose dossiers are built again.');
        here();
        const plan = readPlan(input);
        if (!plan.ok) return plan;
        const blockedNow = permanentFor(module);
        if (!blockedNow) return fail('REFUSED', 'This branch is not blocked by a permanent dossier failure, so there is nothing to rebuild.');
        if (participants && typeof participants.get === 'function') {
            const participant = participants.get(module);
            if (!participant) return fail('SNAPSHOT_UNAVAILABLE', `The participant ${module} is not registered.`);
            // Do not discard a selection before learning whether this participant can rebuild it.
            if (typeof participant.rebuild !== 'function') return fail('UNSUPPORTED', `The participant ${module} cannot rebuild its dossiers.`);
        }
        // Until the fallback coordinator confirms its candidates are exhausted, keep the old selection intact.
        let empty = false;
        try { if (typeof fallbackEmpty === 'function') empty = await fallbackEmpty(module); } catch { /* fail closed */ }
        if (empty !== true) return fail('REFUSED', 'Earlier saved points have not all been checked for this branch, so it is not rebuilt yet.');
        const now = headNow();
        if (!now) return fail('NOT_FOUND', 'This chat has no story state yet.');
        const reply = replyNumberAt(now.boundary, chat());
        if (!Number.isInteger(reply) || reply < 1) return fail('NOT_FOUND', 'The rebuild could not find the reply it would start from.');

        const entries = archive.entries();
        const pending = [...entries].reverse().find(entry => entry.kind === 'selection' && !SETTLED_SELECTION.includes(entry.phase)) ?? null;
        const busy = outstanding(pending?.id ?? null);
        if (busy) return fail('RESTORE_PENDING', 'Another change is outstanding in this chat; the dossiers cannot be rebuilt until it has settled.');

        // Close the selection (or keep the closed one from an earlier failed attempt) and drop this module's selected
        // checkpoint. The participant publishes a fresh one from its rebuild callback.
        let entry = pending;
        if (entry) {
            entry = archive.patch(entry.id, { phase: 'rebuilt', slots: { ...(entry.slots ?? {}), [module]: { rebuilt: true } } });
        } else {
            const earlier = [...entries].reverse().find(item => item.kind === 'selection' && item.phase === 'rebuilt');
            entry = earlier
                ? archive.patch(earlier.id, { slots: { ...(earlier.slots ?? {}), [module]: { rebuilt: true } } })
                : archive.add({ id: makeId('hs'), kind: 'selection', phase: 'rebuilt', desired: {}, slots: { [module]: { rebuilt: true } } });
        }
        const selection = { ...archive.selection() };
        delete selection[module];
        archive.select(selection);
        await durable();
        await point('rebuild.journaled');

        lowerForParticipant();
        let answer;
        try {
            answer = await callParticipant(module, 'rebuild', { return: entry.id, read: plan.read, replies: plan.replies });
        } catch (error) {
            if (crashing(error)) throw error;
            answer = fail('FAILED', `The participant ${module} could not rebuild its dossiers: ${error?.message ?? error}`);
        }
        here();
        if (!isObject(answer) || answer.ok !== true) {
            const why = isObject(answer) && typeof answer.message === 'string' && answer.message
                ? answer
                : fail('FAILED', `The participant ${module} could not rebuild its dossiers.`);
            block.note(module, { ...why, code: blockedNow.blockedBy.code });
            return why;
        }
        await point('rebuild.participant');
        await durable();
        if (typeof release === 'function') {
            const released = await release(entry.id);
            if (released && released.ok === false) {
                block.note(module, { ...released, code: blockedNow.blockedBy.code });
                return released;
            }
        }
        // A participant that reads on after answering (`started: true`, with its `progress()`) records nothing yet: the banner's note tells when it is done.
        const started = answer.started === true;
        if (!started) try { problem?.({ module, code: REBUILD_PROBLEM_CODE, message: rebuildMessage(reply) }); } catch { /* the reader's list is optional */ }
        await point('rebuild.completed');
        return { ok: true, module, reply, read: plan.read, replies: plan.replies, rebuilt: entry.id, started };
    }

    return { rebuild };
}
