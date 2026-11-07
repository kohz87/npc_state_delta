// Story Suite v2: the store's record reads and small writes: setNarrated, setPracticeRule, receipts, truncate (return in
// time), untold and work. Moved out of createWrite unchanged; createWrite puts them in api at the places they were.

import { carrierIndexes, lastCarrier, readRecord } from '../../persist.js';
import { deepFreeze, revOf } from '../constants.js';
import { isMetaSpan } from '../../replay.js';

export function createRecords(s, deps) {
    const { baseFor, carrierAt, current, frozenReceipts, lineOf, list, marked, ORPHAN, quarantined, replayRecord, retain, saver, spansFor, stateBefore, take, writable, write } = deps;

    return {
        // `reply`: the record is of a received message Story Block captured (never a greeting): it is marked `reply: true`.
        setNarrated(index, ids, { reply = false } = {}) {
            if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
                throw new TypeError('Narrated receipts must be a list of receipt IDs.');
            }
            writable();
            const arr = list();
            const head = current();
            const atHead = index === head.key.index;
            const { message, record, fresh } = take(arr, index, atHead ? head.state : undefined);
            const rev = fresh ? revOf(atHead ? head.state : stateBefore(arr, index)) : record.rev;
            write(message, { ...record, narrated: [...new Set(ids)], ...(rev === undefined ? {} : { rev }), ...(reply && marked() ? { mv: 1, reply: true } : {}) });
            saver.touch();
            if (atHead) retain(arr, head.state, head.problems);
        },

        /**
         * Marks the reply at `index` as captured under the rule that skill practice comes only from rolls: `practiceRule: 'rolls'` on its record, kept
         * with the reply (a Re-read, an edit, a rebuild and a reload keep it). Only replies with a story practice line get it (turn.js); an older reply
         * has none and keeps its practice lines. Not a replay input.
         */
        setPracticeRule(index) {
            writable();
            const arr = list();
            const head = current();
            const atHead = index === head.key.index;
            const { message, record, fresh } = take(arr, index, atHead ? head.state : undefined);
            if (record.practiceRule === 'rolls') return;
            const rev = fresh ? revOf(atHead ? head.state : stateBefore(arr, index)) : record.rev;
            write(message, { ...record, practiceRule: 'rolls', ...(rev === undefined ? {} : { rev }) });
            saver.touch();
            if (atHead) retain(arr, head.state, head.problems);
        },

        // Every stored receipt on the current line of history, in chat order: [{ index, receipt }]
        // (the carriers the head is built from; frozen copies).
        receipts() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.receipts) return memo.receipts;
            s.counts.lineScans++;
            const out = [];
            let started = false;
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint) started = true;
                if (!started || !record) continue;
                for (const receipt of frozenReceipts(record)) out.push(Object.freeze({ index: i, receipt }));
            }
            memo.receipts = Object.freeze(out);
            return memo.receipts;
        },

        // Return in time (MODULES §F17): drops the head carrier's receipts with rev >= beforeRev and
        // their ops, so the head is the state just before the first of them. Each receipt's ops end with
        // its `/meta/rev` op, which is where they are cut. Only the head carrier (nothing after it holds
        // state that depends on it). Returns { dropped: receipt ids, rev }.
        // `{ dryRun: true, chat? }` works it all out and writes nothing, on `chat` (messages, default the
        // chat) if given: rewind asks it on the messages its branch will hold before it branches.
        truncate(index, beforeRev, { dryRun = false, chat: messages = null } = {}) {
            if (!dryRun) writable();
            const arr = dryRun && Array.isArray(messages) ? messages : list();
            if (index !== lastCarrier(arr)) throw new RangeError(`Message ${index} is not the last reply that keeps the story, so its changes cannot be taken back alone.`);
            if (!Number.isInteger(beforeRev) || beforeRev < 1) throw new TypeError('beforeRev must be a whole number of 1 or more.');
            const message = carrierAt(arr, index);
            const record = readRecord(message);
            if (!record) return { dropped: [], rev: revOf(arr === list() ? current().state : stateBefore(arr, index + 1)) };
            if (quarantined(record)) throw new Error(`This reply's story record cannot be cut down: ${ORPHAN}.`);
            const chunks = [];
            let start = 0;
            record.ops.forEach((op, at) => {
                if (op?.path === '/meta/rev') {
                    chunks.push({ ops: record.ops.slice(start, at + 1), rev: op.value });
                    start = at + 1;
                }
            });
            if (start < record.ops.length) chunks.push({ ops: record.ops.slice(start), rev: null });
            const cut = chunks.findIndex(chunk => chunk.rev === null || chunk.rev >= beforeRev);
            const kept = cut < 0 ? chunks : chunks.slice(0, cut);
            const keptRevs = new Set(kept.map(chunk => chunk.rev));
            const receipts = record.receipts.filter(receipt => keptRevs.has(receipt?.rev));
            const dropped = record.receipts.filter(receipt => !keptRevs.has(receipt?.rev)).map(receipt => receipt?.id);
            const base = baseFor(arr, index);
            if (!base) throw new Error('This chat has no story state yet.');
            const ops = kept.flatMap(chunk => chunk.ops);
            const byRev = new Map(receipts.map(receipt => [receipt.rev, receipt]));
            // A kept block that was a guarded one keeps its span's record (id, guard, claims, …).
            const was = new Map();
            let from = 0;
            for (const span of spansFor(record)) {
                if (isMetaSpan(span)) was.set(`${from}:${span.n}`, span);
                from += span.n;
            }
            let offset = 0;
            const spans = kept.map(chunk => {
                const old = was.get(`${offset}:${chunk.ops.length}`);
                offset += chunk.ops.length;
                return { ...(old ?? {}), n: chunk.ops.length, story: byRev.get(chunk.rev)?.cause === 'story' };
            });
            // C1-3: the kept changes are replayed as a rebuild replays them (block by block, by the
            // replay rules: a remove of what a deleted reply added is passed over), so a chat that
            // replays fine is not refused. A kept block that still does not apply refuses the rewind.
            const problems = [];
            const earlier = (dryRun ? [] : current().problems).filter(problem => problem.index < index);     // (read before anything is written)
            const state = replayRecord(base, { ...record, ops, spans, receipts }, index, problems, null, message);
            // (a guarded block whose guard no longer holds stays stored and inactive; it does not refuse)
            const refusing = problems.filter(problem => problem.code !== 'REPLAY_PREREQUISITE');
            if (refusing.length) throw new Error(refusing[0].why);
            if (dryRun) return { dropped, rev: revOf(state) };
            write(message, {
                ...record,
                ops,
                receipts,
                spans,
                narrated: record.narrated.filter(id => !dropped.includes(id)),
                rev: revOf(state),
            });
            saver.touch();
            // Only this carrier was rewritten: earlier problems stay, and so do those of its kept blocks that are off.
            retain(arr, state, [...earlier, ...problems], null);
            return { dropped, rev: revOf(state) };
        },

        untold() {
            const arr = list();
            const memo = lineOf(arr);
            if (memo.untold) return memo.untold;
            s.counts.lineScans++;
            const records = [];
            for (const i of carrierIndexes(arr)) {
                const record = readRecord(arr[i]);
                if (record?.checkpoint || (records.length && record)) records.push(record);
            }
            const told = new Set();
            const out = [];
            for (let r = records.length - 1; r >= 0; r--) {
                for (const id of records[r].narrated) told.add(id);
                const receipts = records[r].receipts;
                for (let k = receipts.length - 1; k >= 0; k--) {
                    if (receipts[k]?.narrate === true && !told.has(receipts[k].id)) out.push(receipts[k]);
                }
            }
            memo.untold = deepFreeze(structuredClone(out.reverse()));
            return memo.untold;
        },

        /**
         * How much replay work the store has done (for tests that count work rather than time): `replays`
         * (state rebuilt from a checkpoint), `recordsRead` (carriers replayed), `lineScans` (whole-chat
         * passes for receipts or untold), `witnessMisses` (timeline witnesses worked out, not found in the memo),
         * `prefixHits` / `prefixSteps` / `prefixReplays` (prefix memo: state found, one record stepped, full replay). A copy.
         */
        work() {
            return { ...s.counts };
        },
    };
}
