// Session operations for the timeline participant: loading the chat's story line, reading and checking checkpoints,
// recognizing an earlier line of the same chat, and the state comparisons used by the host's commit probe.
// Keeps the participant's session and handed-checkpoint state live through accessors supplied by the factory.

import { buildCheckpoint, checkpointProblem } from '../checkpoint.js';
import { hydrateIdentity } from '../identity.js';
import { hashJson } from '../hash.js';
import { LINEAGE_ID, mintLineage, restoredState, storedTimeline, timelineOf } from '../timeline.js';
import { cleanIndex, fail, plain } from './support.js';

export function createSessionOps({
    port, vault, now, random, idleMs, keyNow, usable, loaded, restoreIndex, writtenIndexes, getSession, setSession,
}) {
    const handed = new Map();   // checkpoint id -> { hash, stateHash }: what the participant handed the host, for `current`

    /**
     * Brings the open chat's state up to date: it has a lineage, every dossier has its np_ and a dossier that is gone has its np_ archived;
     * written into the state (durably) when it changed. The chat is looked at again after every await: a chat that changed meanwhile ends it.
     * Only a chat that uses the timeline gets here: a save point, a restore, a death, a published change of a chat that has its line already, or a
     * question to `npc.identity`. Opening a chat, a reply, or a scan writes nothing (`started`).
     * → the session { key, lineage, index } or null (no chat, or it changed).
     */
    async function hydrate(until = null, guard = null) {
        const key = keyNow();
        if (!usable(key)) return null;
        // Nothing is read, minted or written before the chat's state is loaded: a retryable failure (the host asks again later).
        guard?.enter('loading the dossiers');
        if (!await loaded(until)) {
            guard?.check();
            if (keyNow() !== key) return null;
            throw new Error('NPC State Delta has not loaded this chat\'s dossiers yet; it is tried again in a moment.');
        }
        guard?.check();
        if (keyNow() !== key) return null;
        let state = port.readState();
        let block = timelineOf(state);
        // A branch waiting for its parent's dossiers gets them (and the parent's line) from Delta's branch inheritance: a line minted here first
        // would be written into the branch's file and the inheritance would never come (the branch's dossiers empty, its parent's checkpoints refused).
        if (!block.lineage && port.branchPending?.() === true) {
            guard?.enter('inheriting the parent dossiers');
            try { await port.inheritBranch?.(); } catch { /* looked at below */ }
            guard?.check();
            if (keyNow() !== key) return null;
            if (port.branchPending?.() === true) throw new Error('NPC State Delta is still carrying the parent chat\'s dossiers into this branch; it is tried again in a moment.');
            state = port.readState();
            block = timelineOf(state);
        }
        let write = false;
        if (!block.lineage) {
            block.lineage = mintLineage(random);
            write = true;
        }
        // The open chat's line changed under the participant (another copy of the state was adopted): the line it knew stays this chat's.
        if (getSession()?.key === key && getSession().lineage !== block.lineage && !block.former.includes(getSession().lineage)) {
            block.former = [...block.former, getSession().lineage];
            write = true;
        }
        const out = hydrateIdentity(block.identity, state?.npcs, { seed: block.lineage, reserved: block.reserved });
        if (out.changed || out.reserved.length !== block.reserved.length) write = true;
        block.identity = out.identity;
        block.reserved = out.reserved;
        if (write) {
            const was = hashJson(state);
            guard?.enter('saving the story-line identity');
            await port.writeTimeline(storedTimeline(block));
            if (keyNow() !== key) return null;
            // The write already happened even if the call expired, so the existing baseline must still describe the new state.
            if (getSession()?.index.base?.stateHash === was) getSession().index.base.stateHash = hashJson(port.readState());
            guard?.check();
        }
        if (!getSession() || getSession().key !== key || getSession().lineage !== block.lineage) {
            guard?.enter('reading the participant index');
            const index = cleanIndex(await vault.getIndex(block.lineage));
            guard?.check();
            if (keyNow() !== key) return null;
            setSession({ key, lineage: block.lineage, index });
            writtenIndexes.set(block.lineage, plain(index));
        }
        if (!getSession().index.base) {
            guard?.enter('building the baseline checkpoint');
            const built = buildCheckpoint({ lineage: block.lineage, state: port.readState() });
            guard?.enter('saving the baseline checkpoint');
            await vault.put(built.id, built.doc);
            guard?.check();
            if (keyNow() !== key) return null;
            const base = { checkpoint: built.id, hash: built.hash, stateHash: hashJson(port.readState()) };
            guard?.enter('saving the participant index');
            const s = getSession();
            try {
                await vault.putIndex(s.lineage, { ...s.index, base });
                guard?.check();
                if (keyNow() !== key) { await restoreIndex(s); return null; }
            } catch (error) {
                await restoreIndex(s);
                throw error;
            }
            s.index.base = base;
        }
        return getSession();
    }

    async function made({ state = port.readState(), cursor = null, headHash = null }, guard = null) {
        const s = getSession() ?? await hydrate();
        if (!s) throw new Error('There is no open chat to take a checkpoint of.');
        guard?.enter('building the native checkpoint');
        const built = buildCheckpoint({ lineage: s.lineage, state, cursor, headHash });
        guard?.enter('saving the native checkpoint');
        await vault.put(built.id, built.doc);
        guard?.check();
        return built;
    }

    /** The checkpoint `id` from the vault, checked against `hash`: { doc } or a failure. */
    async function verified(id, hash) {
        const doc = await vault.get(id);
        if (!doc) return fail('SNAPSHOT_UNAVAILABLE', `The native checkpoint ${id} is gone, so its dossiers cannot be put back.`);
        const problem = checkpointProblem(doc, doc?.kind ? hashJson(doc) : '');
        if (problem && /newer|not a native|missing|plain/.test(problem)) return fail('SNAPSHOT_UNAVAILABLE', problem);
        if (hashJson(doc) !== hash) return fail('CONFLICT', `The native checkpoint ${id} is not the one that was saved (another hash).`);
        if (doc.lineage !== getSession()?.lineage && !await formerLine(doc)) return fail('CONFLICT', `The native checkpoint ${id} belongs to another story line.`);
        return { ok: true, doc };
    }

    /**
     * Whether `doc` is a checkpoint of an earlier story line of this same chat. Before NSD 1.7.1 a reload's recovery could read the chat's state
     * before Delta had loaded it and mint a new line over the chat's own (hydrate waits for the load now); the chat's journal still names
     * checkpoints of the line it had, and refusing them held the chat for good on a swipe, a delete or a branch back past that point. Such a line
     * is accepted, and only such a line: one the chat records as its former line (`timeline.former`), or a well-formed line this participant kept
     * an index for whose checkpoint belongs to the chat's own family (`branchFamilyId`, a random id per chat and its branches). A checkpoint of
     * another chat (another family), or a line nobody kept (forged), is still another story line. Installing it records the line (restoredState).
     */
    async function formerLine(doc) {
        const lineage = doc?.lineage;
        if (typeof lineage !== 'string' || !LINEAGE_ID.test(lineage)) return false;
        const live = port.readState();
        if (timelineOf(live).former.includes(lineage)) return true;
        const family = typeof live?.branchFamilyId === 'string' ? live.branchFamilyId.trim() : '';
        if (!family || doc.state?.branchFamilyId !== family) return false;
        try { return Boolean(await vault.getIndex(lineage)); } catch { return false; }
    }

    /**
     * Whether the open chat uses the timeline: it has its story line (the state carries a lineage, made by the first save point, restore, death
     * or `npc.identity` question) or this run has made it. A chat that never did is left exactly as Delta alone keeps it: nothing is hydrated,
     * written or published for it, so a populated chat that never asks for the timeline stays byte for byte what it was.
     */
    const started = () => {
        if (getSession() && getSession().key === keyNow()) return true;
        try { if (typeof port.started === 'function') return port.started() === true; } catch { return false; }
        return Boolean(timelineOf(port.readState()).lineage);
    };
    const busy = () => (typeof port.busy === 'function' ? port.busy() === true : false);
    /** Whether the native state is, now, the one this checkpoint was handed over (or installed) as: the part of the host's commit probe that reads the state. */
    const stands = (checkpoint, hash) => {
        const held = handed.get(checkpoint);
        return Boolean(held) && held.hash === hash && hashJson(port.readState()) === held.stateHash;
    };
    /** Whether the live state is what installing this checkpoint's document leaves (its state with the timeline block's reserved ids of both timelines). */
    const standsOnBytes = doc => {
        const live = port.readState();
        const wanted = restoredState(doc.state, live);
        if (hashJson(wanted) === hashJson(live)) return true;
        // Delta normalizes a state as it installs it (a milestone's missing turn becomes 0, ...), and a checkpoint made in the run that wrote a
        // record may hold it as written: compared raw, such a checkpoint never "stands" once installed, and its activation is refused for good.
        // The bytes are compared as Delta keeps them too.
        if (typeof port.normalize !== 'function') return false;
        try { return hashJson(port.normalize(wanted)) === hashJson(live); } catch { return false; }
    };
    const hand = (checkpoint, hash, stateHash) => {
        handed.set(checkpoint, { hash, stateHash });
        while (handed.size > 16) handed.delete(handed.keys().next().value);
    };
    // Ends inside the host's bound for the callback (`until`): longer than that, the host gives up on the call and calls the save a failure.
    const quiet = async until => (typeof port.idle === 'function' ? (await port.idle(Math.max(0, Math.min(idleMs, until - now())))) !== false : true);

    return { hydrate, made, verified, started, busy, stands, standsOnBytes, hand, quiet };
}
