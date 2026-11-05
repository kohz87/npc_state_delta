// Story Suite v2: the store's records that are kept as they are, and the archive of ids (moved out of createStore unchanged):
// what a stored `storySuite` value is (absent, ours, or one that must never be written over), the read-only state a chat is in while its
// first record is one Story Block does not own, the archive of the ids of deleted replies and swipes, and the index of the ids the chat
// already holds. `createTombs(s, deps)` is given the store's state holder `s` and the few store functions it calls; it never imports store.js.

import { isObject } from './constants.js';
import { KEY, carrierIndexes, readRecord, recordFault } from '../persist.js';
import { isMetaSpan } from '../replay.js';

export function createTombs(s, deps) {
    const { chatId, metadata, current, list } = deps;

    // ---- records that are kept as they are -------------------------------------------------------------

    // What a stored `storySuite` value is: 'absent', 'ours' (a whole v2 record), or one Story Block must never write over:
    // 'future' (a newer version's), 'legacy' (v1 or no version) and 'damaged' (a v2 record that is not whole, or not a record).
    function rawKind(raw) {
        if (raw === undefined || raw === null) return 'absent';
        if (!isObject(raw)) return 'damaged';
        if (Number.isFinite(raw.v) && raw.v > 2) return 'future';
        if (raw.v === 2) return recordFault({ extra: { [KEY]: raw } }) ? 'damaged' : 'ours';
        return 'legacy';
    }
    const KEPT_ASIDE = new Set(['future', 'legacy', 'damaged']);
    const WHY = {
        future: raw => `is from a newer version (v${raw.v})`,
        legacy: () => 'is from an older version of Story Suite',
        damaged: raw => `is damaged (${isObject(raw) ? recordFault({ extra: { [KEY]: raw } }) || 'it is not a record' : 'it is not a record'})`,
    };

    // The chat's first record when it is one Story Block does not own (a future version's, an older one's, a damaged
    // one): it is neither read nor repaired nor written over. With `stateless` (the chat has no state at all) also an
    // unresolved start: the replies before the earliest checkpoint that is left are gone and this session never saw
    // them, so that checkpoint cannot be checked; it is kept as it is and nothing is adopted or reset by itself.
    // → { index, kind, why, raw? } or null.
    function preservedAt(arr, stateless = false) {
        const first = carrierIndexes(arr)[0];
        if (first === undefined) return null;
        const raw = arr[first].extra?.[KEY];
        const kind = rawKind(raw);
        if (KEPT_ASIDE.has(kind)) return { index: first, kind, why: WHY[kind](raw), raw };
        if (stateless) {
            const at = carrierIndexes(arr).find(i => readRecord(arr[i])?.checkpoint);
            if (at !== undefined) return { index: at, kind: 'unresolved', why: `has the earliest saved point of a story whose first replies are gone (this session had not seen them)`, raw: null };
        }
        return null;
    }

    const readOnlyMessage = kept => (kept.kind === 'unresolved'
        ? `The story on message ${kept.index} ${kept.why}; Story Block keeps the saved history as it is and works read-only on an empty story until you choose what to do.`
        : `The story record on message ${kept.index} ${kept.why}; Story Block keeps it as it is and works read-only on an empty story until it can be read.${kept.kind === 'future' ? ' Update Story Block to read it.' : ''}`);

    // Every writer starts here: while the head is the read-only fallback, nothing is written.
    // Derived from the head each time (not only from the cache entry), so no cache path can lose it.
    function keptNow() {
        const head = current();
        if (head.readOnly) return head.readOnly;
        return s.fallback && head.state === s.fallback ? preservedAt(list(), true) : null;
    }
    function writable() {
        const kept = keptNow();
        if (kept) throw new Error(readOnlyMessage(kept));
    }

    // ---- the carrier source map (contract §4) ------------------------------------------------------

    // The ids the chat's records already hold, found once per chat array (and again after rebuild()) and kept up
    // to date by write(): an id that left with a deleted reply only stays "taken", which costs nothing but a salt.
    // The archive (contract §4): ids of the canonical sids, swipe keys and evidence ids of replies and swipes that were
    // deleted. They stay in the chat's metadata, are never handed out again, and confer no eligibility (archived(id)).
    function archive() {
        let meta = null;
        try { meta = metadata(); } catch { meta = null; }
        if (!isObject(meta)) meta = null;
        if (meta !== s.tombMeta) {
            s.tombMeta = meta;
            const stored = meta?.storySuite?.sourceArchive?.deleted;
            s.tombs = new Set(Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []);
        }
        return s.tombs;
    }
    function bury(ids) {
        const set = archive();
        const before = set.size;
        for (const id of ids) if (typeof id === 'string' && id) set.add(id);
        if (set.size === before) return;
        if (s.tombMeta) {
            if (!isObject(s.tombMeta.storySuite)) s.tombMeta.storySuite = {};
            // (Not a change to save on its own: SillyTavern saves the chat after a delete, and every later save carries it.)
            s.tombMeta.storySuite.sourceArchive = { v: 1, deleted: [...set].sort() };
        }
    }
    // What a rebuild finds gone since the index was last built: the ids of replies and swipes that left the chat.
    function bury2(previous, now) {
        const gone = [];
        for (const key of ['swipeKeys', 'evidences', 'logicals']) for (const id of previous[key].keys()) if (!now[key].has(id)) gone.push(id);
        bury(gone);
    }

    function idsOf(arr) {
        // (the chat array SillyTavern holds is the same object whichever chat is open: the index is for one chat's ids)
        if (s.idIndex?.arr === arr && s.idIndex.chat === chatId()) return s.idIndex;
        s.idIndex = { arr, chat: chatId(), swipeKeys: new Map(), evidences: new Map(), logicals: new Map(), blocks: new Set() };
        for (const other of arr) {
            for (const record of [other?.extra?.[KEY], ...(Array.isArray(other?.swipe_info) ? other.swipe_info.map(info => info?.extra?.[KEY]) : [])]) {
                if (isObject(record?.source)) noteIds(s.idIndex, other, record.source, record.sid);
                for (const span of Array.isArray(record?.spans) ? record.spans : []) if (isMetaSpan(span)) s.idIndex.blocks.add(span.id);
            }
        }
        return s.idIndex;
    }
    function noteIds(index, message, entry, sid) {
        if (entry.swipeKey) index.swipeKeys.set(entry.swipeKey, sid);
        if (entry.evidence) index.evidences.set(entry.evidence, sid);
        if (entry.logical) {
            if (!index.logicals.has(entry.logical)) index.logicals.set(entry.logical, new Set());
            index.logicals.get(entry.logical).add(message);
        }
    }

    return { rawKind, KEPT_ASIDE, WHY, preservedAt, readOnlyMessage, keptNow, writable, archive, bury2, idsOf, noteIds };
}
