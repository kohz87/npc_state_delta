// The host archive (contract §8; docs/v2/TIMELINE.md): everything the timeline keeps outside the replayed domains, in
// the chat's own metadata (`chatMetadata.storySuite.timeline`, saved with the chat file by the store's save):
//
// * `payloads`: the immutable bytes of every snapshot, by their hash: `{ payload, proofs }`, the payload and the proof pins the
//   story held then. The hash (the descriptor's `payloadHash`) covers both, so bytes that lost or changed their pins are not the
//   bytes. They are never embedded in a replayed domain, so a snapshot does not hold the snapshots before it twice.
// * `snapshots`: each descriptor as it was made (a restore overlays the target's from here: the payload was captured
//   before its own descriptor existed).
// * `journal`: the durable record of every make, restore and native mutation, one entry per attempt, with its phase.
// * `pins`: the batch results a restore was prepared for: the sealed result's own bytes (resolved and verified against their
//   hash), the prepared manifest and the story as it was just before the restore, so what a restore replaced stays retrievable.
// * `prefix`: the participants' prefix map (chat lineage, canonical sid, swipe key, block, op, prefix hash) -> the
//   checkpoints before and after and which one is selected.
// * `events`: the native events (confirmed deaths) delivered, by id.
//
// A chat that never used the timeline has none of it: nothing is created by reading. Writing marks the chat changed
// (`touch`), so the store's next save carries it, and is refused when the chat the running operation began in is no longer open.

import { hashJson } from '../replay.js';
import { isObject, makeId, staleChat } from './util.js';

const verified = new WeakMap();   // payload entry -> the hash it was verified for

export function createArchive({ metadata, touch = () => {}, bound = () => null }) {
    const meta = () => {
        let value = null;
        try { value = metadata(); } catch { value = null; }
        return isObject(value) ? value : null;
    };
    const find = () => {
        const root = meta()?.storySuite?.timeline;
        return isObject(root) ? root : null;
    };
    function make() {
        const holder = meta();
        if (!holder) throw new Error('This chat has no metadata to keep the timeline in.');
        if (!isObject(holder.storySuite)) holder.storySuite = {};
        if (!isObject(holder.storySuite.timeline)) {
            holder.storySuite.timeline = { v: 1, lineage: makeId('ln'), payloads: {}, snapshots: {}, journal: {}, seq: 0, pins: { batchResults: {} }, prefix: {}, native: 0, events: {} };
        }
        const root = holder.storySuite.timeline;
        for (const key of ['payloads', 'snapshots', 'journal', 'prefix', 'events']) if (!isObject(root[key])) root[key] = {};
        if (!isObject(root.pins)) root.pins = { batchResults: {} };
        if (!isObject(root.pins.batchResults)) root.pins.batchResults = {};
        return root;
    }
    // An operation is bound to the chat it began in (`bound()` → that chat's metadata): a write while another chat is open
    // is refused before it creates or changes anything there.
    const write = fn => {
        const chat = bound();
        if (chat && meta() !== chat) throw staleChat();
        const root = make();
        const out = fn(root);
        touch();
        return out;
    };

    const api = {
        /** The chat holds a timeline archive (something made one). */
        exists: () => find() !== null,
        /** The metadata object the archive lives in (a different one means another chat is open). */
        holder: () => meta(),
        lineage: () => find()?.lineage ?? null,
        ensure: () => write(root => root.lineage),

        // ---- payloads (immutable, by hash) ----
        putPayload(hash, entry) {
            write(root => {
                if (!Object.hasOwn(root.payloads, hash)) root.payloads[hash] = structuredClone(entry);
            });
        },
        /**
         * The archived `{ payload, proofs }` for `hash`, or null when it is not there or its bytes do not hash to it. Looked at
         * once per stored entry, then remembered (a list of save points is cheap); `fresh` hashes the bytes again, as a restore
         * does before it relies on them.
         */
        payload(hash, { fresh = false } = {}) {
            const root = find();
            if (!root || typeof hash !== 'string' || !Object.hasOwn(root.payloads, hash)) return null;
            const entry = root.payloads[hash];
            if (!isObject(entry) || !isObject(entry.payload) || !isObject(entry.proofs)) return null;
            if (fresh || verified.get(entry) !== hash) {
                let actual = null;
                try { actual = hashJson({ payload: entry.payload, proofs: entry.proofs }); } catch { actual = null; }
                if (actual !== hash) return null;
                verified.set(entry, hash);
            }
            return entry;
        },
        hasPayload: hash => api.payload(hash) !== null,

        marker: id => find()?.markers?.[id] ?? null,
        putMarker(id, value) { write(root => { if (!isObject(root.markers)) root.markers = {}; root.markers[id] = structuredClone(value); }); },

        // ---- descriptors ----
        putSnapshot(id, value) {
            write(root => { root.snapshots[id] = structuredClone(value); });
        },
        snapshot(id) {
            const root = find();
            return root && Object.hasOwn(root.snapshots, id) && isObject(root.snapshots[id]) ? root.snapshots[id] : null;
        },

        // ---- the journal ----
        get(id) {
            const root = find();
            return root && Object.hasOwn(root.journal, id) && isObject(root.journal[id]) ? root.journal[id] : null;
        },
        /** Adds a journal entry (its `id` is the key); `seq` orders the entries. */
        add(entry) {
            return write(root => {
                root.seq = (Number.isInteger(root.seq) ? root.seq : 0) + 1;
                root.journal[entry.id] = { ...structuredClone(entry), seq: root.seq };
                return root.journal[entry.id];
            });
        },
        /** Changes fields of an entry in place (one step of its phase), → the entry. */
        patch(id, fields) {
            return write(root => {
                if (!Object.hasOwn(root.journal, id)) throw new Error(`There is no journal entry ${id}.`);
                Object.assign(root.journal[id], structuredClone(fields));
                return root.journal[id];
            });
        },
        /** Every entry, oldest first. */
        entries() {
            const root = find();
            return root ? Object.values(root.journal).filter(isObject).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) : [];
        },

        // ---- pins ----
        pin(id) {
            const root = find();
            return root && Object.hasOwn(root.pins.batchResults, id) && isObject(root.pins.batchResults[id]) ? root.pins.batchResults[id] : null;
        },
        putPin(id, pin) {
            write(root => { root.pins.batchResults[id] = structuredClone(pin); });
        },

        // ---- the participants' prefix map ----
        putPrefix(participant, key, mapping) {
            write(root => {
                if (!isObject(root.prefix[participant])) root.prefix[participant] = {};
                root.prefix[participant][key] = structuredClone(mapping);
            });
        },
        prefix(participant, key) {
            const root = find();
            const table = root?.prefix?.[participant];
            return isObject(table) && Object.hasOwn(table, key) && isObject(table[key]) ? table[key] : null;
        },
        /** The participant's mappings, [{ key, ...mapping }] in the order they were made. */
        prefixes(participant) {
            const table = find()?.prefix?.[participant];
            return isObject(table) ? Object.entries(table).filter(([, value]) => isObject(value)).map(([key, value]) => ({ key, ...value })).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) : [];
        },

        // The checkpoints actually selected, and the first known native state before any change.
        selection: () => find()?.selection ?? {},
        baseline: () => find()?.baseline ?? {},
        select(value) { write(root => { root.selection = structuredClone(value); }); },
        remember(items) {
            write(root => {
                if (!isObject(root.baseline)) root.baseline = {};
                if (!isObject(root.selection)) root.selection = {};
                for (const item of items) {
                    if (!Object.hasOwn(root.baseline, item.module)) root.baseline[item.module] = structuredClone(item);
                    if (!Object.hasOwn(root.selection, item.module)) root.selection[item.module] = structuredClone(item);
                }
            });
        },

        // ---- native events (confirmed deaths) ----
        event: id => {
            const root = find();
            return root && Object.hasOwn(root.events, id) && isObject(root.events[id]) ? root.events[id] : null;
        },
        putEvent(id, event) {
            write(root => { root.events[id] = structuredClone(event); });
        },

        /** How many native mutations and events have completed: part of the head's hash. */
        nativeSeq: () => (Number.isInteger(find()?.native) ? find().native : 0),
        bumpNative() {
            return write(root => {
                root.native = (Number.isInteger(root.native) ? root.native : 0) + 1;
                return root.native;
            });
        },
    };
    return api;
}
