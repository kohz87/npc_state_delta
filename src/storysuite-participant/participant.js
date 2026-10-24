// NPC State Delta as a timeline participant (Story Block docs/v2/TIMELINE.md, contract §8; track B6): the module has native state beside
// the story (dossiers with their evidence, the relationship map, its own rollback history), so a save point and a restore must take its
// checkpoint with them, and a character's confirmed death must reach it.
//
//   checkpoint({ cursor, headHash })            -> { checkpoint, hash, schema }    the native state (with its np_ map and applied deaths), once Delta is quiet
//   prepare({ return, checkpoint, hash })       -> { prepared, hash }              verifies the bytes; shows nothing
//   activate({ return, prepared })              -> { checkpoint, hash }            installs state, map and deaths together; idempotent
//   abort({ return, prepared })                 -> { aborted: true }               before the commit only
//   status({ return })                          -> { checkpoint, hash, status }
//   applyEvent({ event, nativeKey, kind })      -> { event, checkpoint, hash, ack }  a confirmed death, once per event
//   attach(handle)                              the host's handle { head(), nativeMutation(input) }
// and the query `npc.identity({ id } | { name })`. Every answer is `{ ok: true, ... }` or `{ ok: false, code, message }`; the callbacks run
// one at a time. Nothing here reads the chat or prompts: Delta's prompt text is not touched.
//
// `port` is what the participant needs of Delta's runtime (index.js, the lead's wiring):
//   chatKey()            the open chat's key (a string)
//   readState()          the chat's native state now, synchronously (a copy; window.NPCStateDelta.getState())
//   installState(state)  replaces the chat's native state absolutely and makes it durable (asynchronous); not a native change
//   writeTimeline(block) writes the participant's block (`state.timeline`) into the chat's state and makes it durable; not a native change
//   busy()               whether a scan or dossier pass is in flight for the open chat (optional)
//   idle(ms)             resolves true when none is, false after `ms` (optional)
//   headSource()         the Source of the reply at the head, when the host's head() does not carry one (optional; see the dev note)
//   restored()           told after a restore installed a state (optional)
//   warn(text)           where problems are told (optional)
// `vault` keeps the bytes (vault.js). The np_ map, the reserved ids and the applied deaths live in the chat's state (timeline.js), the restores
// in flight and the acknowledged deaths in the vault's index of the state's lineage.

import { PARTICIPANT_SCHEMA, buildCheckpoint, checkpointProblem } from './checkpoint.js';
import { hydrateIdentity, resolveIdentity } from './identity.js';
import { hashJson } from './hash.js';
import { mintLineage, restoredState, storedTimeline, timelineOf } from './timeline.js';
import { isTerminalNpcDeath, manualLifeStateRecord } from '../../terminal-lifecycle.js';

export const MODULE_ID = 'npc-state-delta';
const fail = (code, message) => ({ ok: false, code, message });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = value => JSON.parse(JSON.stringify(value ?? null));
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function preparedId(seed) {
    let value = BigInt(`0x${hashJson(seed).slice(0, 12)}`);
    let text = '';
    for (let i = 0; i < 8; i += 1) {
        text = BASE36[Number(value % 36n)] + text;
        value /= 36n;
    }
    return `pn_${text}`;
}

const HASH = /^[0-9a-f]{64}$/;

/** The lineage's index as stored, checked. */
function cleanIndex(raw) {
    const index = { v: 2, acks: {}, prepared: {}, returns: {}, selected: null, base: null };
    if (!isRecord(raw)) return index;
    for (const [event, ack] of Object.entries(isRecord(raw.acks) ? raw.acks : {})) if (isRecord(ack) && typeof ack.checkpoint === 'string' && typeof ack.hash === 'string') index.acks[event] = { checkpoint: ack.checkpoint, hash: ack.hash };
    for (const [id, entry] of Object.entries(isRecord(raw.prepared) ? raw.prepared : {})) {
        if (isRecord(entry) && typeof entry.checkpoint === 'string' && typeof entry.hash === 'string') index.prepared[id] = { checkpoint: entry.checkpoint, hash: entry.hash, return: typeof entry.return === 'string' ? entry.return : null, inPlace: entry.inPlace === true, stateHash: typeof entry.stateHash === 'string' ? entry.stateHash : null };
    }
    for (const [id, entry] of Object.entries(isRecord(raw.returns) ? raw.returns : {})) {
        if (isRecord(entry) && typeof entry.prepared === 'string' && typeof entry.checkpoint === 'string' && ['prepared', 'active', 'aborted'].includes(entry.status)) index.returns[id] = { prepared: entry.prepared, checkpoint: entry.checkpoint, hash: String(entry.hash ?? ''), status: entry.status };
    }
    index.selected = typeof raw.selected === 'string' ? raw.selected : null;
    if (isRecord(raw.base) && typeof raw.base.checkpoint === 'string' && HASH.test(String(raw.base.hash)) && typeof raw.base.stateHash === 'string') index.base = { checkpoint: raw.base.checkpoint, hash: raw.base.hash, stateHash: raw.base.stateHash };
    return index;
}

/** A dossier marked dead by a confirmed event: Delta's own explicit, terminal death record, with the event as its reason. */
export function confirmedDeath(npc, { event, now }) {
    const dead = manualLifeStateRecord(npc, 'deceased', now);
    dead.lifeStateReason = `Confirmed dead by the rules (event ${String(event).slice(0, 60)}).`;
    return dead;
}

const RETRY_CODES = new Set(['STALE', 'RESTORE_PENDING']);

export function createParticipant({ port, vault, module = MODULE_ID, now = () => Date.now(), random, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), debounceMs = 300, retryMs = 1500, idleMs = 20000 }) {
    let session = null;      // { key, lineage, index }
    let handle = null;
    let queue = Promise.resolve();
    let hydrating = false;
    let timer = null;
    let publishing = null;
    let again = false;
    let retries = 0;
    let last = null;
    const handed = new Map();   // checkpoint id -> { hash, stateHash }: what the participant handed the host, for `current`
    const warn = text => { try { port.warn?.(text); } catch { /* telling is best effort */ } };
    const keyNow = () => String(port.chatKey() ?? '');
    const usable = key => Boolean(key) && key !== 'no-chat';

    /** Runs `fn` after every earlier callback is done; a thrown error is a FAILED answer, never a crash of the queue. */
    const exclusive = fn => {
        const run = queue.then(async () => {
            try {
                return await fn();
            } catch (error) {
                return fail('FAILED', `${module} failed: ${error?.message ?? error}`);
            }
        });
        queue = run;
        return run;
    };

    const save = () => vault.putIndex(session.lineage, session.index);

    /**
     * Brings the open chat's state up to date: it has a lineage, every dossier has its np_ and a dossier that is gone has its np_ archived;
     * written into the state (durably) when it changed. The chat is looked at again after every await: a chat that changed meanwhile ends it.
     * → the session { key, lineage, index } or null (no chat, or it changed).
     */
    async function hydrate({ create = true } = {}) {
        const key = keyNow();
        if (!usable(key)) return null;
        const state = port.readState();
        const block = timelineOf(state);
        // A chat with no dossiers and no line yet has nothing to name: opening it writes nothing (a new chat has no file until it is saved), and
        // the line is made by the first thing that needs one (a save point, a death, a dossier).
        if (!create && !block.lineage && !(Array.isArray(state?.npcs) && state.npcs.length)) return null;
        let write = false;
        if (!block.lineage) {
            block.lineage = mintLineage(random);
            write = true;
        }
        const out = hydrateIdentity(block.identity, state?.npcs, { seed: block.lineage, reserved: block.reserved });
        if (out.changed || out.reserved.length !== block.reserved.length) write = true;
        block.identity = out.identity;
        block.reserved = out.reserved;
        if (write) {
            const was = hashJson(state);
            await port.writeTimeline(storedTimeline(block));
            if (keyNow() !== key) return null;
            // The participant's own write is not a change of the story's: a baseline that was the state before it is the state after it.
            if (session?.index.base?.stateHash === was) session.index.base.stateHash = hashJson(port.readState());
        }
        if (!session || session.key !== key || session.lineage !== block.lineage) {
            const index = cleanIndex(await vault.getIndex(block.lineage));
            if (keyNow() !== key) return null;
            session = { key, lineage: block.lineage, index };
        }
        if (!session.index.base) {
            const built = buildCheckpoint({ lineage: block.lineage, state: port.readState() });
            await vault.put(built.id, built.doc);
            if (keyNow() !== key) return null;
            session.index.base = { checkpoint: built.id, hash: built.hash, stateHash: hashJson(port.readState()) };
            await save();
        }
        return session;
    }

    async function made({ state = port.readState(), cursor = null, headHash = null }) {
        const s = session ?? await hydrate();
        if (!s) throw new Error('There is no open chat to take a checkpoint of.');
        const built = buildCheckpoint({ lineage: s.lineage, state, cursor, headHash });
        await vault.put(built.id, built.doc);
        return built;
    }

    /** The checkpoint `id` from the vault, checked against `hash`: { doc } or a failure. */
    async function verified(id, hash) {
        const doc = await vault.get(id);
        if (!doc) return fail('SNAPSHOT_UNAVAILABLE', `The native checkpoint ${id} is gone, so its dossiers cannot be put back.`);
        const problem = checkpointProblem(doc, doc?.kind ? hashJson(doc) : '');
        if (problem && /newer|not a native|missing|plain/.test(problem)) return fail('SNAPSHOT_UNAVAILABLE', problem);
        if (hashJson(doc) !== hash) return fail('CONFLICT', `The native checkpoint ${id} is not the one that was saved (another hash).`);
        if (doc.lineage !== session?.lineage) return fail('CONFLICT', `The native checkpoint ${id} belongs to another story line.`);
        return { ok: true, doc };
    }

    const busy = () => (typeof port.busy === 'function' ? port.busy() === true : false);
    const quiet = async () => (typeof port.idle === 'function' ? (await port.idle(idleMs)) !== false : true);

    const participant = {
        schema: PARTICIPANT_SCHEMA,

        // A save point is a moment: Delta must be at rest in it. A scan or dossier pass still reading the latest reply would land after the
        // checkpoint and be missing from it (a restore would then drop a person the story still has), so the checkpoint waits for it, and when
        // it does not finish or the state moves while the checkpoint is made, answers a retryable STALE rather than a save that is not true.
        checkpoint: ({ cursor = null, headHash = null } = {}) => exclusive(async () => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                if (!await quiet()) return fail('STALE', 'NPC State Delta is still reading the latest reply; save again in a moment.');
                const s = await hydrate();
                if (!s) return fail('FAILED', 'There is no open chat to save.');
                const at = hashJson(port.readState());
                // A change Delta saved that the timeline has not recorded yet is recorded first: the save point would carry it, but the host would
                // commit the point at a head that does not know it. The publish is asked for and the save is refused, retryably. When the host gives no
                // way to publish (no Source for the head: UNSUPPORTED) there is nothing to wait for.
                if (handle && s.index.base && s.index.base.stateHash !== at && last?.code !== 'UNSUPPORTED') {
                    schedulePublish(0);
                    return fail('STALE', 'NPC State Delta has a change the story has not recorded yet; save again in a moment.');
                }
                const built = await made({ cursor, headHash });
                if (busy() || hashJson(port.readState()) !== at) continue;
                s.index.base = { checkpoint: built.id, hash: built.hash, stateHash: at };
                handed.set(built.id, { hash: built.hash, stateHash: at });
                while (handed.size > 16) handed.delete(handed.keys().next().value);
                await save();
                return { ok: true, checkpoint: built.id, hash: built.hash, schema: PARTICIPANT_SCHEMA };
            }
            return fail('STALE', 'NPC State Delta kept changing while the save point was made; save again in a moment.');
        }),

        /**
         * Asked by the host inside its synchronous commit section, after it holds the checkpoint it will store and before it commits: is the
         * checkpoint still the native state? It answers at once (no waiting): the state is the one handed over, and nothing is running, due or
         * queued that would change it. { ok: true, current: boolean }; false makes the host cancel the save and ask again.
         */
        current: input => {
            const held = isRecord(input) ? handed.get(input.checkpoint) : null;
            if (!held || held.hash !== input.hash) return { ok: true, current: false };
            return { ok: true, current: !busy() && hashJson(port.readState()) === held.stateHash };
        },

        prepare: input => exclusive(async () => {
            const s = await hydrate();
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

        activate: input => exclusive(async () => {
            const s = await hydrate();
            if (!s) return fail('FAILED', 'There is no open chat.');
            const idx = s.index;
            if (!isRecord(input) || typeof input.prepared !== 'string' || typeof input.return !== 'string') return fail('INVALID', 'activate takes { return, prepared }.');
            const entry = idx.prepared[input.prepared];
            if (!entry) return fail('NOT_FOUND', 'Nothing was prepared under that id.');
            if (entry.return !== null && entry.return !== input.return) return fail('CONFLICT', 'That preparation belongs to another return.');
            const ret = idx.returns[input.return] ?? { prepared: input.prepared, checkpoint: entry.checkpoint, hash: entry.hash, status: 'prepared' };
            if (ret.prepared !== input.prepared) return fail('CONFLICT', 'That return was prepared under another id.');
            if (ret.status === 'active') return { ok: true, checkpoint: ret.checkpoint, hash: ret.hash };
            if (ret.status === 'aborted') return fail('REFUSED', 'That preparation was aborted.');
            const got = await verified(entry.checkpoint, entry.hash);
            if (!got.ok) return got;
            if (entry.inPlace) {
                // A change Delta already made and published after the fact: the state is live, nothing is installed over a newer one.
                idx.base = { checkpoint: entry.checkpoint, hash: entry.hash, stateHash: entry.stateHash ?? idx.base?.stateHash ?? '' };
            } else {
                // The saved state, its np_ map and its deaths together; the ids either timeline issued stay reserved (inactive, never issued again).
                const installed = restoredState(got.doc.state, port.readState());
                await port.installState(installed);
                try { port.restored?.(); } catch { /* the restore is done; telling is best effort */ }
                idx.base = { checkpoint: entry.checkpoint, hash: entry.hash, stateHash: hashJson(port.readState()) };
            }
            idx.selected = entry.checkpoint;
            entry.return = input.return;
            idx.returns[input.return] = { ...ret, status: 'active' };
            await save();
            return { ok: true, checkpoint: entry.checkpoint, hash: entry.hash };
        }),

        abort: input => exclusive(async () => {
            const s = await hydrate();
            if (!s) return { ok: true, aborted: true };
            const idx = s.index;
            const entry = isRecord(input) ? idx.prepared[input.prepared] : null;
            if (!entry) return { ok: true, aborted: true };
            const ret = idx.returns[input.return];
            if (ret?.status === 'active') return fail('REFUSED', 'That return was committed; it finishes, it is not aborted.');
            if (ret) idx.returns[input.return] = { ...ret, status: 'aborted' };
            delete idx.prepared[input.prepared];
            await save();
            return { ok: true, aborted: true };
        }),

        status: input => exclusive(async () => {
            const s = await hydrate();
            const ret = s && isRecord(input) ? s.index.returns[input.return] : null;
            return ret ? { ok: true, checkpoint: ret.checkpoint, hash: ret.hash, status: ret.status } : fail('NOT_FOUND', 'No such return.');
        }),

        applyEvent: input => exclusive(async () => {
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
        attach: given => { handle = given; },
    };

    /** Both checkpoints of a change, made durable: `before` is the one the story stands on, `after` the state in `state`. */
    async function pairFor(state, head) {
        const s = await hydrate();
        if (!s) throw new Error('There is no open chat.');
        const base = s.index.base;
        const kept = base ? await vault.get(base.checkpoint) : null;
        const before = kept && hashJson(kept) === base.hash ? base : null;
        const after = await made({ state, cursor: head.cursor, headHash: head.headHash });
        return { before: before ?? { checkpoint: after.id, hash: after.hash }, after };
    }
    const shaped = built => ({ module, checkpoint: built.checkpoint ?? built.id, hash: built.hash, schema: PARTICIPANT_SCHEMA });

    /**
     * A native change published through the timeline (contract §8: "scan, manual dossier edit, meter/native synchronization and confirmed
     * death" are native mutations): `edit(state)` changes a copy of the native state; the before and after checkpoints are made durable;
     * the host then activates the after (this module's own `activate`) once the head, the barrier and the journal agree.
     * → the host's answer { ok, checkpoint, hash } or its failure.
     */
    async function nativeChange({ source, edit }) {
        if (!handle) return fail('UNSUPPORTED', 'The host has not given this participant its handle.');
        const head = await handle.head();
        if (!head?.ok) return head;
        return handle.nativeMutation({
            participant: module,
            source,
            expectedHead: head.headHash,
            prepare: () => exclusive(async () => {
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
        if (!handle) return fail('UNSUPPORTED', 'The host has not given this participant its handle.');
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const settled = await exclusive(async () => ({ ok: true, session: await hydrate(), stateHash: hashJson(port.readState()) }));
            if (!settled.ok || !settled.session) return settled.ok ? { ok: true, unchanged: true } : settled;
            if (settled.session.index.base?.stateHash === settled.stateHash) return { ok: true, unchanged: true };
            const head = await handle.head();
            if (!head?.ok) return head;
            const source = head.source ?? (typeof port.headSource === 'function' ? port.headSource() : null);
            if (!isRecord(source)) return fail('UNSUPPORTED', 'The host gives no Source for the reply at the head, so a native change cannot be published yet.');
            const out = await handle.nativeMutation({
                participant: module,
                source,
                expectedHead: head.headHash,
                prepare: () => exclusive(async () => {
                    const s = await hydrate();
                    if (!s) throw new Error('There is no open chat.');
                    const state = port.readState();
                    const { before, after } = await pairFor(state, head);
                    const prepared = preparedId({ inPlace: true, before: before.checkpoint, after: after.id, lineage: s.lineage, n: Object.keys(s.index.prepared).length });
                    s.index.prepared[prepared] = { checkpoint: after.id, hash: after.hash, return: null, inPlace: true, stateHash: hashJson(state) };
                    await save();
                    return { before: shaped(before), after: shaped(after), prepared };
                }),
            });
            if (out?.ok || out?.code !== 'STALE') return out;
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

    return {
        module,
        participant,
        /**
         * The query the host resolves a death's npc with and Story Director a check's target with. It reads the chat's state, where the ids
         * are, so it answers at once after a reload; a dossier with no np_ yet (a scan, an import) is hydrated behind it, never inside it.
         */
        queries: {
            'npc.identity': (_state, args) => {
                const key = keyNow();
                if (!usable(key)) return null;
                const state = port.readState();
                const block = timelineOf(state);
                const npcs = state?.npcs;
                const unsettled = Array.isArray(npcs) && npcs.some(npc => typeof npc?.id === 'string' && !Object.hasOwn(block.identity.byKey, npc.id));
                if (unsettled && !hydrating) {
                    hydrating = true;
                    void exclusive(async () => { try { await hydrate(); } finally { hydrating = false; } });
                }
                return resolveIdentity(block.identity, npcs, args);
            },
        },
        /** Opens the chat's line: the ids exist before the first ask. A chat with nothing to name is left alone (nothing is written). */
        prime: () => exclusive(async () => { const s = await hydrate({ create: false }); return s ? { ok: true, lineage: s.lineage } : { ok: true, lineage: null }; }),
        /** Hydrates the open chat now, making its line if it has none. */
        hydrate: () => exclusive(async () => { const s = await hydrate(); return s ? { ok: true, npcs: Object.keys(timelineOf(port.readState()).identity.byKey).length, lineage: s.lineage } : fail('FAILED', 'There is no open chat.'); }),
        nativeChange,
        /** Delta's state was written durably by something other than the participant: publish it as a native change (debounced). */
        noteChange: () => { if (handle) schedulePublish(debounceMs); },
        /** Publishes now what is pending and resolves with the answer (tests; and a chat closing). */
        flush: async () => { if (timer) { cancel(timer); timer = null; } return runPublish(); },
        lastPublish: () => last,
        identity: () => timelineOf(port.readState()).identity,
        timeline: () => timelineOf(port.readState()),
        index: () => (session ? plain(session.index) : null),
    };
}
