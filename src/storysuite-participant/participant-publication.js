// Participant publication: native changes, baseline checkpoints and the debounced retries that publish Delta's durable writes.
// The participant's queue, state reader and host handle remain owned by participant.js and are injected here.

export function createParticipantPublication({
    PARTICIPANT_SCHEMA, fail, isRecord, plain, hashJson, hydrate, verified, made, warn, getHandle, preparing, port, timelineOf, hydrateIdentity,
    storedTimeline, preparedId, save, module, started, keyNow, exclusive, getAnnounced, preparedAt, schedule, cancel, retryMs,
}) {
    const RETRY_CODES = new Set(['STALE', 'RESTORE_PENDING']);
    let timer = null;
    let publishing = null;
    let again = false;
    let retries = 0;
    let last = null;

    /**
     * Both checkpoints of a change, made durable: `before` is the one the story stands on, `after` the state in `state`. The baseline is
     * the checkpoint the story stands on: when its bytes are gone or are not the ones recorded, the change is refused (a Problem is told)
     * and never published on a baseline made up from the new state, which would tell the story it stood where it did not.
     */
    async function pairFor(state, head) {
        const s = await hydrate();
        if (!s) throw new Error('There is no open chat.');
        const base = s.index.base;
        const kept = await verified(base.checkpoint, base.hash);
        if (!kept.ok) {
            const text = `NPC State Delta cannot record a native change: the checkpoint the story stands on (${base.checkpoint}) is not usable (${kept.message}); the change was not published.`;
            warn(text);
            throw new Error(text);
        }
        const after = await made({ state, cursor: head.cursor, headHash: head.headHash });
        return { before: base, after };
    }
    const shaped = built => ({ module, checkpoint: built.checkpoint ?? built.id, hash: built.hash, schema: PARTICIPANT_SCHEMA });

    /**
     * A native change published through the timeline (contract §8: "scan, manual dossier edit, meter/native synchronization and confirmed
     * death" are native mutations): `edit(state)` changes a copy of the native state; the before and after checkpoints are made durable;
     * the host then activates the after (this module's own `activate`) once the head, the barrier and the journal agree.
     * → the host's answer { ok, checkpoint, hash } or its failure.
     */
    async function nativeChange({ source, edit }) {
        if (!getHandle()) return fail('UNSUPPORTED', 'The host has not given this participant its handle.');
        const head = await getHandle().head();
        if (!head?.ok) return head;
        return getHandle().nativeMutation({
            participant: module,
            source,
            expectedHead: head.headHash,
            prepare: () => preparing(async () => {
                const s = await hydrate();
                if (!s) throw new Error('There is no open chat.');
                const state = plain(port.readState());
                edit(state);
                const block = timelineOf(state);
                block.lineage = s.lineage;
                const next = hydrateIdentity(block.identity, state.npcs, { seed: s.lineage, reserved: block.reserved });
                block.identity = next.identity;
                block.reserved = next.reserved;
                state.timeline = storedTimeline(block);
                const { before, after } = await pairFor(state, head);
                const prepared = preparedId({ native: true, before: before.checkpoint, after: after.id, lineage: s.lineage, n: Object.keys(s.index.prepared).length });
                s.index.prepared[prepared] = { checkpoint: after.id, hash: after.hash, return: null, inPlace: false, stateHash: null };
                await save();
                return { before: shaped(before), after: shaped(after), prepared };
            }),
        });
    }

    /**
     * Publishes the change Delta already made (a scan, an edit, a meter step: every durable write of its state ends here, see `noteChange`):
     * the checkpoint the story stood on, and the checkpoint of the state now, as one native mutation at the head. Nothing to publish when the
     * state is the one the story stands on. The host's refusal to publish (the head moved, a restore is pending) is retried by `noteChange`.
     */
    async function publish() {
        if (!getHandle()) return fail('UNSUPPORTED', 'The host has not given this participant its handle.');
        if (!started()) return { ok: true, unchanged: true };
        // The change belongs to the chat it was made in: once another chat is open nothing is retried, and the new chat is not hydrated here (a
        // branch just opened must get its dossiers from Delta's branch inheritance first). The chat publishes what it holds when it is open again.
        const key = keyNow();
        const left = { ok: true, unchanged: true, left: true };
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (keyNow() !== key) return left;
            const settled = await exclusive(async () => (keyNow() !== key ? left : { ok: true, session: await hydrate(), stateHash: hashJson(port.readState()) }));
            if (settled.left) return left;
            if (!settled.ok || !settled.session) return settled.ok ? { ok: true, unchanged: true } : settled;
            if (settled.session.index.base?.stateHash === settled.stateHash) return { ok: true, unchanged: true };
            const head = await getHandle().head();
            if (!head?.ok) return head;
            const source = head.source ?? (typeof port.headSource === 'function' ? port.headSource() : null);
            if (!isRecord(source)) return fail('UNSUPPORTED', 'The host gives no Source for the reply at the head, so a native change cannot be published yet.');
            const out = await getHandle().nativeMutation({
                participant: module,
                source,
                expectedHead: head.headHash,
                prepare: () => preparing(async () => {
                    if (keyNow() !== key) throw new Error('Another chat was opened; the change is published when its chat is open again.');
                    const s = await hydrate();
                    if (!s) throw new Error('There is no open chat.');
                    // A change announced from here on (the state is read now; the upload of its checkpoint takes time) is newer than this publication.
                    const seen = getAnnounced();
                    const state = port.readState();
                    const { before, after } = await pairFor(state, head);
                    const prepared = preparedId({ inPlace: true, before: before.checkpoint, after: after.id, lineage: s.lineage, n: Object.keys(s.index.prepared).length });
                    s.index.prepared[prepared] = { checkpoint: after.id, hash: after.hash, return: null, inPlace: true, stateHash: hashJson(state), newer: getAnnounced() > seen };
                    preparedAt.set(prepared, seen);
                    await save();
                    return { before: shaped(before), after: shaped(after), prepared };
                }),
            });
            if (out?.ok) return out;
            if (keyNow() !== key) return left;   // (refused because the chat changed: not retried, not told)
            if (out?.code !== 'STALE') return out;
        }
        return fail('STALE', 'The head kept moving; the change is published with the next one.');
    }

    function runPublish() {
        if (publishing) {
            again = true;
            return publishing;
        }
        publishing = (async () => {
            try {
                do {
                    again = false;
                    last = await publish();
                    if (last && last.ok === false && RETRY_CODES.has(last.code) && retries < 5) {
                        retries += 1;
                        schedulePublish(retryMs);
                    } else {
                        retries = 0;
                        if (last && last.ok === false && last.code !== 'UNSUPPORTED') warn(`NPC State Delta could not publish a native change (${last.code}): ${last.message}`);
                    }
                } while (again);
            } catch (error) {
                last = fail('FAILED', String(error?.message ?? error));
                warn(`NPC State Delta could not publish a native change: ${last.message}`);
            } finally {
                publishing = null;
            }
            return last;
        })();
        return publishing;
    }
    function schedulePublish(ms) {
        if (timer) return;
        timer = schedule(() => { timer = null; void runPublish(); }, ms);
    }
    /** Cancels a pending debounce and publishes now (tests; and a chat closing). */
    const flush = async () => { if (timer) { cancel(timer); timer = null; } return runPublish(); };

    return { nativeChange, schedulePublish, flush, lastPublish: () => last };
}
