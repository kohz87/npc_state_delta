// The participant callback object: save-point checkpointing, commit probing, prepare/activate/abort/status, confirmed-death
// events and the host handle attachment. Callbacks run in the order the host invokes them; each returns the same answer
// envelope as the original participant factory and uses the factory's live session, handle and publication accessors.

import { PARTICIPANT_SCHEMA } from '../checkpoint.js';
import { isTerminalNpcDeath } from '../../../terminal-lifecycle.js';
import { hashJson } from '../hash.js';
import { restoredState, storedTimeline, timelineOf } from '../timeline.js';
import { fail, isRecord, plain, preparedId } from './support.js';

export function createParticipantHandlers({
    abort, bounded, boundedCheckpoint, busy, confirmedDeath, getAnnounced, getHandle, getLast, hand, hostExclusive,
    hydrate, made, now, port, preparedAt, quiet, restoreIndex, save, schedulePublish, setHandle, stands, standsOnBytes, verified, verifyOnly, vault,
}) {
    return {
        participant: {
            schema: PARTICIPANT_SCHEMA,

            // A save point is a moment: Delta must be at rest in it. A scan or dossier pass still reading the latest reply would land after the
            // checkpoint and be missing from it (a restore would then drop a person the story still has), so the checkpoint waits for it, and when
            // it does not finish or the state moves while the checkpoint is made, answers a retryable STALE rather than a save that is not true.
            checkpoint: boundedCheckpoint(async ({ cursor = null, headHash = null } = {}, guard) => {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    guard.enter('waiting for dossier work');
                    const idle = await guard.wait(quiet(guard.until));
                    guard.check();
                    if (!idle) return fail('STALE', 'NPC State Delta is still reading the latest reply; save again in a moment.');
                    const s = await hydrate(guard.until, guard);
                    if (!s) return fail('FAILED', 'There is no open chat to save.');
                    guard.enter('reading the dossiers');
                    const at = hashJson(port.readState());
                    guard.check();
                    // A change Delta saved that the timeline has not recorded yet is recorded first: the save point would carry it, but the host would
                    // commit the point at a head that does not know it. The publish is asked for and the save is refused, retryably. When the host gives no
                    // way to publish (no Source for the head: UNSUPPORTED) there is nothing to wait for.
                    if (getHandle() && s.index.base && s.index.base.stateHash !== at && getLast()?.code !== 'UNSUPPORTED') {
                        schedulePublish(0);
                        return fail('STALE', 'NPC State Delta has a change the story has not recorded yet; save again in a moment.');
                    }
                    const built = await made({ cursor, headHash }, guard);
                    if (busy() || hashJson(port.readState()) !== at) continue;
                    guard.enter('saving the participant index');
                    const base = { checkpoint: built.id, hash: built.hash, stateHash: at };
                    try {
                        await vault.putIndex(s.lineage, { ...s.index, base });
                        guard.check();
                    } catch (error) {
                        // A failed or late write may have reached the server. Put back the previous baseline before the queue moves on, so an
                        // unaccepted checkpoint never becomes the basis of a native publication. If restoration fails, later work must retry it first.
                        await restoreIndex(s);
                        throw error;
                    }
                    s.index.base = base;
                    hand(built.id, built.hash, at);
                    return { ok: true, checkpoint: built.id, hash: built.hash, schema: PARTICIPANT_SCHEMA };
                }
                return fail('STALE', 'NPC State Delta kept changing while the save point was made; save again in a moment.');
            }),

            /**
             * Asked by the host inside its synchronous commit section, after it holds the checkpoint it will store and before it commits: is the
             * checkpoint still the native state? It answers at once (no waiting): the state is the one handed over, and nothing is running, due or
             * queued that would change it. { ok: true, current: boolean }; false makes the host cancel the save and ask again.
             */
            current: input => ({ ok: true, current: isRecord(input) && stands(input.checkpoint, input.hash) && !busy() }),

            /** Whether `prepare` would accept this checkpoint (file, hash, line), changing nothing: the host's fallback asks it of each candidate. */
            verify: bounded((input, until) => verifyOnly(input, until)),

            prepare: bounded(async (input, until) => {
                const named = isRecord(input) && typeof input.checkpoint === 'string' && typeof input.hash === 'string';
                const s = await hydrate(until, null, named ? { checkpoint: input.checkpoint, hash: input.hash } : null);
                if (s?.ok === false) return s;
                if (!s) return fail('FAILED', 'There is no open chat.');
                const idx = s.index;
                if (!isRecord(input) || typeof input.checkpoint !== 'string' || typeof input.return !== 'string' || typeof input.hash !== 'string') return fail('INVALID', 'prepare takes { return, checkpoint, hash }.');
                const held = idx.returns[input.return];
                if (held && held.status !== 'aborted' && (held.checkpoint !== input.checkpoint || held.hash !== input.hash)) return fail('CONFLICT', 'That return was prepared for another checkpoint.');
                if (held && held.status !== 'aborted') return { ok: true, prepared: held.prepared, hash: held.hash };
                const got = await verified(input.checkpoint, input.hash);
                if (!got.ok) return got;
                const prepared = preparedId({ return: input.return, checkpoint: input.checkpoint, hash: input.hash, lineage: s.lineage, again: held ? 1 : 0 });
                idx.prepared[prepared] = { checkpoint: input.checkpoint, hash: input.hash, return: input.return, inPlace: false, stateHash: null };
                idx.returns[input.return] = { prepared, checkpoint: input.checkpoint, hash: input.hash, status: 'prepared' };
                await save();
                return { ok: true, prepared, hash: input.hash };
            }),

            activate: input => hostExclusive(async () => {
                const s = await hydrate();
                if (!s) return fail('FAILED', 'There is no open chat.');
                const idx = s.index;
                if (!isRecord(input) || typeof input.prepared !== 'string' || typeof input.return !== 'string') return fail('INVALID', 'activate takes { return, prepared }.');
                const entry = idx.prepared[input.prepared];
                if (!entry) return fail('NOT_FOUND', 'Nothing was prepared under that id.');
                if (entry.return !== null && entry.return !== input.return) return fail('CONFLICT', 'That preparation belongs to another return.');
                const ret = idx.returns[input.return] ?? { prepared: input.prepared, checkpoint: entry.checkpoint, hash: entry.hash, status: 'prepared' };
                if (ret.prepared !== input.prepared) return fail('CONFLICT', 'That return was prepared under another id.');
                if (ret.status === 'aborted') return fail('REFUSED', 'That preparation was aborted.');
                const got = await verified(entry.checkpoint, entry.hash);
                if (!got.ok) return got;
                // A return already active is not skipped: it is acknowledged again only while the live state still is its bytes (a state that never
                // reached the file after it was activated, found by a recovery, is installed again).
                if (ret.status === 'active' && standsOnBytes(got.doc)) return { ok: true, checkpoint: ret.checkpoint, hash: ret.hash };
                // The journal decides what the story stands on: the selected bytes. A change Delta made and published after the fact is live already
                // when the state is those bytes; only then (or when a newer change of its own is in flight, below) is nothing installed. Anything else
                // (a restore, a selected head, a recovery that finds the live state is not what the journal selected) is installed, durably, and the
                // state is looked at again like the host's commit probe does before the activation is acknowledged.
                const live = port.readState();
                let install = !entry.inPlace || hashJson(live) !== hashJson(got.doc.state);
                const newer = entry.newer === true || getAnnounced() > (preparedAt.get(input.prepared) ?? Infinity);
                if (install && entry.inPlace && newer) {
                    // A newer change of Delta's own, announced after this one was read (even while its checkpoint was being uploaded, and noted in the
                    // index so a restart knows it too), is live: the older bytes do not overwrite it. It is published next, on this baseline, by the normal
                    // route, which is asked for now (the host cannot take a change while it is finishing this one, so it follows the acknowledgement).
                    install = false;
                    schedulePublish(0);
                }
                if (install) {
                    // The saved state, its np_ map and its deaths together; the ids either timeline issued stay reserved (inactive, never issued again).
                    await port.installState(restoredState(got.doc.state, live));
                    try { port.restored?.(); } catch { /* the restore is done; telling is best effort */ }
                    // The state now is the selected bytes (the timeline block aside, which keeps both timelines' reserved ids): read back and compared,
                    // then recorded as handed over so the probe `current` answers for it like for any checkpoint. Not acknowledged otherwise.
                    const now = port.readState();
                    hand(entry.checkpoint, entry.hash, hashJson(now));
                    if (!standsOnBytes(got.doc) || !stands(entry.checkpoint, entry.hash)) {
                        return fail('STALE', 'NPC State Delta could not confirm that the selected native state is installed; it is tried again.');
                    }
                    idx.base = { checkpoint: entry.checkpoint, hash: entry.hash, stateHash: hashJson(now) };
                } else {
                    idx.base = { checkpoint: entry.checkpoint, hash: entry.hash, stateHash: entry.stateHash ?? idx.base?.stateHash ?? '' };
                }
                preparedAt.delete(input.prepared);
                idx.selected = entry.checkpoint;
                entry.return = input.return;
                idx.returns[input.return] = { ...ret, status: 'active' };
                await save();
                return { ok: true, checkpoint: entry.checkpoint, hash: entry.hash };
            }),

            abort,

            status: input => hostExclusive(async () => {
                const s = await hydrate();
                const ret = s && isRecord(input) ? s.index.returns[input.return] : null;
                if (!ret) return fail('NOT_FOUND', 'No such return.');
                // The host's recovery asks this to learn whether the participant switched already, and skips the activation when it says active. It
                // says so only while the live state is the bytes of that checkpoint; otherwise (a write that never reached the file, bytes that are
                // gone) it says prepared, and the activation is asked for again, which installs them or refuses.
                if (ret.status === 'active') {
                    const got = await verified(ret.checkpoint, ret.hash);
                    if (!got.ok || !standsOnBytes(got.doc)) return { ok: true, checkpoint: ret.checkpoint, hash: ret.hash, status: 'prepared' };
                }
                return { ok: true, checkpoint: ret.checkpoint, hash: ret.hash, status: ret.status };
            }, true),

            applyEvent: input => hostExclusive(async () => {
                if (!isRecord(input) || typeof input.event !== 'string' || !input.event || typeof input.nativeKey !== 'string' || !input.nativeKey) return fail('INVALID', 'applyEvent takes { event, nativeKey, kind }.');
                if (input.kind !== 'confirmed-death') return fail('INVALID', 'The only native event is a confirmed-death.');
                const s = await hydrate();
                if (!s) return fail('FAILED', 'There is no open chat.');
                const idx = s.index;
                const prior = timelineOf(port.readState()).applied[input.event];
                if (prior) {
                    if (prior.nativeKey !== input.nativeKey) return fail('CONFLICT', 'That event was delivered already for another person.');
                    const ack = idx.acks[input.event];
                    if (!ack) return fail('FAILED', 'That event is applied but its checkpoint is not recorded.');
                    // A delivery whose install was lost is finished from its checkpoint: the person ends up dead either way.
                    const live = port.readState()?.npcs?.find(npc => npc?.id === input.nativeKey);
                    if (!live || !isTerminalNpcDeath(live)) {
                        const got = await verified(ack.checkpoint, ack.hash);
                        if (got.ok) await port.installState(restoredState(got.doc.state, port.readState()));
                    }
                    return { ok: true, event: input.event, checkpoint: ack.checkpoint, hash: ack.hash, ack: true };
                }
                const state = plain(port.readState());
                const at = Array.isArray(state.npcs) ? state.npcs.findIndex(npc => npc?.id === input.nativeKey) : -1;
                if (at < 0) return fail('NOT_FOUND', 'No dossier answers to that native key, so the death is held rather than guessed.');
                if (!isTerminalNpcDeath(state.npcs[at])) state.npcs[at] = confirmedDeath(state.npcs[at], { event: input.event, now: now() });
                const block = timelineOf(state);
                block.applied[input.event] = { nativeKey: input.nativeKey, at: now() };
                state.timeline = storedTimeline(block);
                const built = await made({ state });
                idx.acks[input.event] = { checkpoint: built.id, hash: built.hash };
                idx.selected = built.id;
                await save();
                await port.installState(state);
                idx.base = { checkpoint: built.id, hash: built.hash, stateHash: hashJson(port.readState()) };
                await save();
                return { ok: true, event: input.event, checkpoint: built.id, hash: built.hash, ack: true };
            }),

            /** The host gives the module its own handle { head(), nativeMutation(input) } when it registers the participant. */
            attach: given => { setHandle(given); },
        },
    };
}
