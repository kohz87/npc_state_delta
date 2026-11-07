// The timeline participant's rebuild callback: the way out when this branch's native checkpoints cannot be restored.
// It replaces the open chat's native state with an empty one on a fresh lineage, lets Delta's normal scanner read the
// chosen part of the chat, and publishes the result through the host's native-mutation route as the new baseline.
//
//   port.rebuildScan({ replies })  reads the normal scanner over the last `replies` replies; null means the whole chat
//   publish({ source })             the participant's existing native-change publication (nativeMutation)
//
// The callback takes { return, replies?, all? }. `replies` defaults to 40; `replies: null` or `all: true` reads all.
// A rebuild never deletes vault files. A scanner failure before publication puts the previous native state back.

import { mintLineage, storedTimeline, timelineOf } from '../timeline.js';
import { fail, isRecord, plain } from './support.js';

export const REBUILD_REPLY_LIMIT = 40;

function requestOf(input, defaultReplies) {
    if (!isRecord(input) || typeof input.return !== 'string' || !input.return.trim()) {
        return fail('INVALID', 'rebuild takes { return, replies? } and `return` names the request.');
    }
    if (input.all !== undefined && typeof input.all !== 'boolean') return fail('INVALID', 'rebuild\'s `all` is true or false.');
    if (input.replies !== undefined && input.replies !== null && (!Number.isSafeInteger(input.replies) || input.replies < 1)) {
        return fail('INVALID', 'rebuild\'s `replies` is a positive whole number, null for all, or left out for the default.');
    }
    const replies = input.all === true || input.replies === null ? null : (input.replies ?? defaultReplies);
    return { ok: true, returnId: input.return, replies };
}

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

export function createRebuild({
    port, random, keyNow, usable, hydrate, setSession, getHandle, publish,
    exclusive = fn => Promise.resolve().then(fn), warn = () => {},
    defaultReplies = REBUILD_REPLY_LIMIT,
} = {}) {
    const limit = Number.isSafeInteger(defaultReplies) && defaultReplies > 0 ? defaultReplies : REBUILD_REPLY_LIMIT;

    function emptyState(oldLineage) {
        if (typeof port?.normalize !== 'function') throw failure('UNSUPPORTED', 'NPC State Delta cannot make a fresh native state for a rebuild.');
        const state = port.normalize({});
        if (!isRecord(state)) throw failure('FAILED', 'NPC State Delta made no fresh native state for a rebuild.');
        let lineage = mintLineage(random);
        if (lineage === oldLineage) lineage = mintLineage(random);
        const block = timelineOf(state);
        block.lineage = lineage;
        block.former = [];
        state.timeline = storedTimeline(block);
        return { state, lineage };
    }

    async function putBack(previous, previousSession, key) {
        if (keyNow() !== key) return;
        try {
            await port.installState(previous);
            setSession(previousSession ?? null);
        } catch (error) {
            warn(`NPC State Delta could not put back the native state after a failed rebuild: ${error?.message ?? error}`);
        }
    }

    async function run(input) {
        const request = requestOf(input, limit);
        if (!request.ok) return request;
        const key = keyNow();
        if (!usable(key)) return fail('FAILED', 'There is no open chat to rebuild.');
        if (typeof port?.readState !== 'function' || typeof port?.installState !== 'function' || typeof port?.rebuildScan !== 'function') {
            return fail('UNSUPPORTED', 'NPC State Delta has no normal scanner available for a rebuild.');
        }
        if (typeof getHandle !== 'function' || typeof publish !== 'function' || typeof hydrate !== 'function' || typeof setSession !== 'function') {
            return fail('UNSUPPORTED', 'NPC State Delta\'s timeline participant is not ready for a rebuild.');
        }

        const settled = await hydrate();
        if (!settled) return fail('FAILED', 'There is no open chat to rebuild.');
        if (keyNow() !== key) return fail('STALE', 'Another chat was opened before the rebuild started.');
        if (typeof port.busy === 'function' && port.busy() === true) return fail('STALE', 'NPC State Delta is still reading the latest reply; start from the chat again in a moment.');

        const previous = plain(port.readState());
        const previousSession = settled;
        const fresh = emptyState(settled.lineage);
        let switched = false;
        let publishing = false;
        try {
            await port.installState(fresh.state);
            switched = true;
            setSession(null);
            const session = await hydrate();
            if (!session || session.lineage !== fresh.lineage) {
                throw failure('FAILED', 'NPC State Delta could not start a fresh native line for this branch.');
            }
            if (keyNow() !== key) {
                switched = false;
                throw failure('STALE', 'Another chat was opened while the rebuild started; this chat was not changed.');
            }

            const scanned = await port.rebuildScan({ replies: request.replies });
            if (scanned === false || scanned?.ok === false) {
                throw failure(scanned?.code || 'FAILED', scanned?.message || 'NPC State Delta could not read this branch from the chat.');
            }
            if (keyNow() !== key) {
                switched = false;
                throw failure('STALE', 'Another chat was opened while the rebuild read the chat; this chat was not published.');
            }
            if (timelineOf(port.readState()).lineage !== fresh.lineage) {
                throw failure('FAILED', 'The rebuild read left another native line in this branch, so its result was not published.');
            }

            const handle = getHandle();
            if (!handle || typeof handle.head !== 'function') throw failure('UNSUPPORTED', 'The host has not given this participant its handle.');
            const head = await handle.head();
            if (!head?.ok) throw Object.assign(failure(head?.code || 'FAILED', head?.message || 'The story head is not available.'), { answer: head });
            const source = head.source ?? (typeof port.headSource === 'function' ? port.headSource() : null);
            if (!isRecord(source)) throw failure('UNSUPPORTED', 'The host gives no Source for the reply at the head, so the rebuilt state cannot be published.');

            publishing = true;
            let out;
            try { out = await publish({ source }); }
            catch (error) { return fail('FAILED', `NPC State Delta could not publish the rebuilt state: ${error?.message ?? error}`); }
            if (!out?.ok) return out;
            return {
                ok: true, rebuilt: true, replies: request.replies, lineage: fresh.lineage,
                checkpoint: out.checkpoint, hash: out.hash,
            };
        } catch (error) {
            if (switched && !publishing) await putBack(previous, previousSession, key);
            return error?.answer ?? fail(error?.code || 'FAILED', String(error?.message ?? error));
        }
    }

    return { rebuild: input => exclusive(() => run(input)) };
}
