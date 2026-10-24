// NPC State Delta as a timeline participant (Story Block docs/v2/TIMELINE.md, contract §8; track B6): the module has native state beside
// the story (dossiers with their evidence, the relationship map, its own rollback history), so a save point and a restore must take its
// checkpoint with them, and a character's confirmed death must reach it.
//
//   checkpoint({ cursor, headHash })            -> { checkpoint, hash, schema }    the native state, the np_ map and the applied deaths
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
//   installState(state)  replaces the chat's native state absolutely and makes it durable (asynchronous)
// `vault` keeps the bytes (vault.js).

import { PARTICIPANT_SCHEMA, buildCheckpoint, checkpointProblem, cleanApplied } from './checkpoint.js';
import { cleanIdentity, hydrateIdentity, resolveIdentity } from './identity.js';
import { hashJson } from './hash.js';
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

/** The index as stored, checked. */
function cleanIndex(raw) {
    const index = { v: 1, identity: cleanIdentity(raw?.identity), applied: cleanApplied(raw?.applied), reserved: [], acks: {}, prepared: {}, returns: {}, selected: null };
    if (isRecord(raw)) {
        index.reserved = Array.isArray(raw.reserved) ? raw.reserved.filter(id => typeof id === 'string') : [];
        for (const [event, ack] of Object.entries(isRecord(raw.acks) ? raw.acks : {})) if (isRecord(ack) && typeof ack.checkpoint === 'string' && typeof ack.hash === 'string') index.acks[event] = { checkpoint: ack.checkpoint, hash: ack.hash };
        for (const [id, entry] of Object.entries(isRecord(raw.prepared) ? raw.prepared : {})) {
            if (isRecord(entry) && typeof entry.checkpoint === 'string' && typeof entry.hash === 'string') index.prepared[id] = { checkpoint: entry.checkpoint, hash: entry.hash, return: typeof entry.return === 'string' ? entry.return : null };
        }
        for (const [id, entry] of Object.entries(isRecord(raw.returns) ? raw.returns : {})) {
            if (isRecord(entry) && typeof entry.prepared === 'string' && typeof entry.checkpoint === 'string' && ['prepared', 'active', 'aborted'].includes(entry.status)) index.returns[id] = { prepared: entry.prepared, checkpoint: entry.checkpoint, hash: String(entry.hash ?? ''), status: entry.status };
        }
        index.selected = typeof raw.selected === 'string' ? raw.selected : null;
    }
    return index;
}

/** A dossier marked dead by a confirmed event: Delta's own explicit, terminal death record, with the event as its reason. */
export function confirmedDeath(npc, { event, now }) {
    const dead = manualLifeStateRecord(npc, 'deceased', now);
    dead.lifeStateReason = `Confirmed dead by the rules (event ${String(event).slice(0, 60)}).`;
    return dead;
}

export function createParticipant({ port, vault, module = MODULE_ID, now = () => Date.now() }) {
    let index = null;
    let indexKey = null;
    let handle = null;
    let queue = Promise.resolve();
    let hydrating = false;

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

    async function load() {
        const key = String(port.chatKey());
        if (index && indexKey === key) return index;
        index = cleanIndex(await vault.getIndex(key));
        indexKey = key;
        return index;
    }
    const save = () => vault.putIndex(indexKey, index);

    /** Every dossier has its np_ and an entry whose dossier is gone is archived; written down when it changed. */
    async function hydrate() {
        const idx = await load();
        const out = hydrateIdentity(idx.identity, port.readState()?.npcs, { chatKey: indexKey, reserved: idx.reserved });
        if (out.changed || out.reserved.length !== idx.reserved.length) {
            idx.identity = out.identity;
            idx.reserved = out.reserved;
            await save();
        }
        return idx;
    }

    async function made({ state = port.readState(), identity, applied, cursor = null, headHash = null }) {
        const idx = await load();
        const built = buildCheckpoint({ chatKey: indexKey, state, identity: identity ?? idx.identity, applied: applied ?? idx.applied, cursor, headHash });
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
        if (doc.chatKey !== indexKey) return fail('CONFLICT', `The native checkpoint ${id} belongs to another chat.`);
        return { ok: true, doc };
    }

    const participant = {
        schema: PARTICIPANT_SCHEMA,

        checkpoint: ({ cursor = null, headHash = null } = {}) => exclusive(async () => {
            await hydrate();
            const built = await made({ cursor, headHash });
            return { ok: true, checkpoint: built.id, hash: built.hash, schema: PARTICIPANT_SCHEMA };
        }),

        prepare: input => exclusive(async () => {
            const idx = await load();
            if (!isRecord(input) || typeof input.checkpoint !== 'string' || typeof input.return !== 'string' || typeof input.hash !== 'string') return fail('INVALID', 'prepare takes { return, checkpoint, hash }.');
            const held = idx.returns[input.return];
            if (held && held.status !== 'aborted' && (held.checkpoint !== input.checkpoint || held.hash !== input.hash)) return fail('CONFLICT', 'That return was prepared for another checkpoint.');
            if (held && held.status !== 'aborted') return { ok: true, prepared: held.prepared, hash: held.hash };
            const got = await verified(input.checkpoint, input.hash);
            if (!got.ok) return got;
            const prepared = preparedId({ return: input.return, checkpoint: input.checkpoint, hash: input.hash, chat: indexKey, again: held ? 1 : 0 });
            idx.prepared[prepared] = { checkpoint: input.checkpoint, hash: input.hash, return: input.return };
            idx.returns[input.return] = { prepared, checkpoint: input.checkpoint, hash: input.hash, status: 'prepared' };
            await save();
            return { ok: true, prepared, hash: input.hash };
        }),

        activate: input => exclusive(async () => {
            const idx = await load();
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
            await port.installState(plain(got.doc.state));
            idx.identity = cleanIdentity(got.doc.identity);
            idx.applied = cleanApplied(got.doc.applied);
            // Ids the dead timeline issued stay reserved: inactive, resolving through no query, never issued again.
            idx.reserved = [...new Set([...idx.reserved, ...Object.keys(idx.identity.map)])].sort();
            idx.selected = entry.checkpoint;
            entry.return = input.return;
            idx.returns[input.return] = { ...ret, status: 'active' };
            await save();
            return { ok: true, checkpoint: entry.checkpoint, hash: entry.hash };
        }),

        abort: input => exclusive(async () => {
            const idx = await load();
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
            const idx = await load();
            const ret = isRecord(input) ? idx.returns[input.return] : null;
            return ret ? { ok: true, checkpoint: ret.checkpoint, hash: ret.hash, status: ret.status } : fail('NOT_FOUND', 'No such return.');
        }),

        applyEvent: input => exclusive(async () => {
            if (!isRecord(input) || typeof input.event !== 'string' || !input.event || typeof input.nativeKey !== 'string' || !input.nativeKey) return fail('INVALID', 'applyEvent takes { event, nativeKey, kind }.');
            if (input.kind !== 'confirmed-death') return fail('INVALID', 'The only native event is a confirmed-death.');
            const idx = await hydrate();
            const prior = idx.applied[input.event];
            if (prior) {
                if (prior.nativeKey !== input.nativeKey) return fail('CONFLICT', 'That event was delivered already for another person.');
                const ack = idx.acks[input.event];
                if (!ack) return fail('FAILED', 'That event is applied but its checkpoint is not recorded.');
                // A delivery whose install was lost is finished from its checkpoint: the person ends up dead either way.
                const live = port.readState()?.npcs?.find(npc => npc?.id === input.nativeKey);
                if (!live || !isTerminalNpcDeath(live)) {
                    const got = await verified(ack.checkpoint, ack.hash);
                    if (got.ok) await port.installState(plain(got.doc.state));
                }
                return { ok: true, event: input.event, checkpoint: ack.checkpoint, hash: ack.hash, ack: true };
            }
            const state = plain(port.readState());
            const at = Array.isArray(state.npcs) ? state.npcs.findIndex(npc => npc?.id === input.nativeKey) : -1;
            if (at < 0) return fail('NOT_FOUND', 'No dossier answers to that native key, so the death is held rather than guessed.');
            if (!isTerminalNpcDeath(state.npcs[at])) state.npcs[at] = confirmedDeath(state.npcs[at], { event: input.event, now: now() });
            const applied = { ...idx.applied, [input.event]: { nativeKey: input.nativeKey, at: now() } };
            const built = await made({ state, applied });
            idx.applied = applied;
            idx.acks[input.event] = { checkpoint: built.id, hash: built.hash };
            idx.selected = built.id;
            await save();
            await port.installState(state);
            return { ok: true, event: input.event, checkpoint: built.id, hash: built.hash, ack: true };
        }),

        /** The host gives the module its own handle { head(), nativeMutation(input) } when it registers the participant. */
        attach: given => { handle = given; },
    };

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
                const idx = await hydrate();
                const before = await made({ cursor: head.cursor, headHash: head.headHash });
                const state = plain(port.readState());
                edit(state);
                const next = hydrateIdentity(idx.identity, state.npcs, { chatKey: indexKey, reserved: idx.reserved });
                const after = await made({ state, identity: next.identity, cursor: head.cursor, headHash: head.headHash });
                const prepared = preparedId({ native: true, before: before.id, after: after.id, chat: indexKey, n: Object.keys(idx.prepared).length });
                idx.prepared[prepared] = { checkpoint: after.id, hash: after.hash, return: null };
                idx.reserved = next.reserved;
                await save();
                return { before: { module, checkpoint: before.id, hash: before.hash, schema: PARTICIPANT_SCHEMA }, after: { module, checkpoint: after.id, hash: after.hash, schema: PARTICIPANT_SCHEMA }, prepared };
            }),
        });
    }

    return {
        module,
        participant,
        /** The query the host resolves a death's npc with and Story Director a check's target with. Null until the identity is hydrated. */
        queries: {
            'npc.identity': (_state, args) => {
                const key = String(port.chatKey());
                const npcs = port.readState()?.npcs;
                // Not yet hydrated for this chat, or a dossier with no np_ yet (a scan, an import): the answer is null now, the hydration
                // runs behind it (never inside a query), and the next ask finds the ids.
                const unsettled = !index || indexKey !== key || (Array.isArray(npcs) && npcs.some(npc => typeof npc?.id === 'string' && !Object.hasOwn(index.identity.byKey, npc.id)));
                if (unsettled) {
                    if (key && key !== 'no-chat' && !hydrating) {
                        hydrating = true;
                        void exclusive(async () => { try { await hydrate(); } finally { hydrating = false; } });
                    }
                    if (!index || indexKey !== key) return null;
                }
                return resolveIdentity(index.identity, npcs, args);
            },
        },
        hydrate: () => exclusive(async () => { const idx = await hydrate(); return { ok: true, npcs: Object.keys(idx.identity.byKey).length }; }),
        nativeChange,
        identity: () => (index ? plain(index.identity) : null),
        index: () => (index ? plain(index) : null),
    };
}
