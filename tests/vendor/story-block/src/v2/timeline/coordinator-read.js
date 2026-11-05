// The timeline coordinator's reading half (contract §8; docs/v2/TIMELINE.md), moved out of createTimeline unchanged: the settle that drops
// what belongs to another chat, the barrier's release and its reconcile, the clock and the scene a descriptor shows, the committed head,
// the list, the status and the history, the one rule for which messages are on the active line, and the hiding of the faded messages.
// `createRead(s, deps)` is given the timeline's state holder `s` and the few coordinator functions it calls (they are all defined by the time
// it is called); it never imports coordinator.js.

import { deriveId, hashJson, isRecordId } from '../replay.js';
import { cutAt } from '../../text.js';
import { HOST_DOMAIN, epochOf } from './gate.js';
import { crashing, fail, isObject, isStaleChat, makeId } from './util.js';

// How many times a head is planned again, one pass after the other, before it is called moving (the barrier stays up then).
const SELECTION_PASSES = 32;
const ordered = (a, b) => (a.target.rev - b.target.rev) || (a.target.op - b.target.op) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function createRead(s, deps) {
    const {
        block, store, registry, chat, barrier, problem, redraw, archive, participants, durable, here, ask, pointsOf, pendingEntry, pendingNow, raise,
        nativeSelectionProblem, selectionNeeded, selectHead, withWholePrefixes,
    } = deps;

    // What belongs to a chat that is not the open one is dropped: announcements owed, and a barrier raised for it (its own journal
    // keeps what it was doing, and its `recover` raises the barrier again when that chat is opened). The open chat is asked every
    // time whether its participants stand on the checkpoints of its selected head, whether or not an operation is running: a head
    // change met meanwhile raises the barrier at once, and the operation ends by reconciling (`reconcile`).
    function settle() {
        // A read as other Features would have it (registry.withFeatures: the Features page counting a preset) is not the open chat as it
        // is: it settles nothing, and works out no witness under switches the chat was not made with.
        if (registry.hypothetical?.()) return;
        const holder = archive.holder();
        s.owed = s.owed.filter(each => each.holder === holder);
        if (s.barrierOwner !== null && s.barrierOwner !== holder) {
            s.barrierOwner = null;
            s.barrierEarly = false;
            lowerWhenSettled();   // (held on, without a moment of readiness, when the open chat has something of its own to finish)
        }
        // The faded messages follow the story as it is now (read whole: with the barrier up the story is not, and the operation that holds it
        // does this itself before it lowers it).
        if (holder && registry.restore?.().state !== 'pending') syncHidden();
        // A chat whose journal has work unfinished, or whose participants are off its selected head, is barred from the moment it is
        // open; its recovery follows when the queue gives it its turn (a make of another chat may be holding the line meanwhile).
        if (holder && s.barrierOwner === null) {
            const outstanding = pendingEntry() !== null || selectionNeeded();
            const dependency = outstanding ? null : nativeSelectionProblem();
            if (outstanding || dependency) {
                s.barrierOwner = holder;
                s.barrierEarly = true;
                barrier('pending', dependency ?? 'A restore is finishing; every part must agree before the story goes on.');
            }
        }
    }

    // The one place the barrier comes down and the host is announced ready: nothing is outstanding in the journal (besides the change
    // being settled) and the participants stand on the checkpoints the selected head names. Judged in the same synchronous step that
    // lowers it, so no listener is told ready on a story whose native state has not caught up. → whether it came down.
    function lowerWhenSettled(settling = null) {
        if (pendingEntry(settling) !== null || selectionNeeded() || nativeSelectionProblem()) return false;
        s.barrierOwner = null;
        s.barrierEarly = false;
        block.clear();
        barrier('idle', '');
        return true;
    }
    // Brings the participants to the selected head and lowers the barrier, in this order: the head's checkpoints are reconciled to a
    // fixed point (each pass plans again from the head as it stands; a pass that still reports a change is followed by another), what
    // was published is made durable, and the look that lowers the barrier is the last thing done, with nothing awaited after it.
    // Bounded: a head that keeps moving leaves the barrier up for the next recovery. → { ok: true } when it came down, else why not.
    async function release(settling = null) {
        for (let pass = 0; pass < SELECTION_PASSES; pass += 1) {
            here();
            if (pendingEntry(settling) !== null) return fail('RESTORE_PENDING', 'Another change is outstanding in this chat; the barrier holds until it has settled.');
            withWholePrefixes(syncHidden);
            if (selectionNeeded()) {
                const selected = await selectHead();
                if (!selected.ok) return selected;
                continue;
            }
            const dependency = nativeSelectionProblem();
            if (dependency) { raise(dependency); return fail('SNAPSHOT_UNAVAILABLE', dependency); }
            await durable();
            if (lowerWhenSettled(settling)) return { ok: true };
        }
        return fail('FAILED', 'The selected head kept moving; the barrier remains held.');
    }
    // An operation that ends with the barrier raised for a selection (a head change it met while it ran) brings the participants to
    // the selected head before the next one starts. A failure leaves the barrier up: a recovery finishes it. (A save that failed is not
    // tried again here: the operation told its caller, and the retry or the recovery is the next try.)
    async function reconcile() {
        if (s.barrierOwner === null || s.barrierOwner !== archive.holder() || pendingEntry() !== null || !selectionNeeded()) return;
        try { await release(); } catch (error) {
            if (crashing(error)) throw error;
            if (isStaleChat(error)) settle();
        }
    }

    function minuteOf(state) {
        const time = ask('director.time', {}, state);
        const minutes = isObject(time) ? time.minutes : time;
        if (Number.isInteger(minutes)) return minutes;
        const own = state?.domains?.director?.time;
        const value = isObject(own) ? own.minutes : own;
        return Number.isInteger(value) ? value : null;
    }
    function sceneOf(state) {
        const scene = state?.domains?.scene;
        const name = typeof scene?.place?.name === 'string' ? scene.place.name.trim() : '';
        const present = Array.isArray(scene?.present) ? scene.present.map(person => (isObject(person) ? person.name : person)).filter(item => typeof item === 'string' && item.trim()) : [];
        const text = [name ? `At ${name}.` : '', present.length ? `With ${present.join(', ')}.` : ''].filter(Boolean).join(' ');
        const canonical = ask('atlas.canonical', {}, state);
        const place = isObject(canonical) && typeof canonical.id === 'string' && canonical.id ? canonical.id : null;
        return { place, text: cutAt(text, 240) };
    }

    // ---- the head ------------------------------------------------------------------------------------------

    // The committed head: the state, where the story ends, and one hash that changes whenever any of it does (the story's
    // prefix, the rev, the epoch, the native mutations that were published). Native mutations and makes check against it.
    function headNow() {
        const state = store.head();
        if (!state) return null;
        const boundary = store.boundary();
        if (!boundary) return null;
        const epoch = epochOf(state);
        const headHash = hashJson({ v: 1, prefix: boundary.prefixHash, rev: boundary.cursor.rev, epoch, native: archive.nativeSeq() });
        return { state, boundary, cursor: boundary.cursor, prefixHash: boundary.prefixHash, epoch, headHash };
    }

    // Why the story is held, for the readers of the status and of a refused head: { reason, code, blockedBy: { module, code } | null }. A participant that
    // could not follow the selected head is named (coordinator-block.js); a restore that is only finishing says what the barrier says.
    function whyPending() {
        const blocked = block.current();
        if (blocked) return blocked;
        const reason = registry.restore?.().reason;
        return { reason: typeof reason === 'string' ? reason : '', code: null, blockedBy: null };
    }

    async function head() {
        if (pendingNow()) return { ...fail('RESTORE_PENDING', 'A restore is in progress; the head is not settled until every part agrees.'), ...(({ reason, blockedBy }) => ({ reason, blockedBy }))(whyPending()) };
        const now = headNow();
        if (!now) return fail('NOT_FOUND', 'This chat has no story state yet.');
        // `source`: the Source of the reply at the head ({ sid, swipeKey, evidence, ordinal }), what nativeMutation asks of a participant that reads the head
        // through its handle (a module has no other way to name the reply a change of its own stands on).
        return { ok: true, headHash: now.headHash, cursor: structuredClone(now.cursor), epoch: now.epoch, prefixHash: now.prefixHash, ...(isObject(now.boundary.source) ? { source: structuredClone(now.boundary.source) } : {}) };
    }

    // ---- list, status, history ---------------------------------------------------------------------------

    // The eligible points of the head state, in target order, with their bytes checked now.
    function listNow(state) {
        return Object.values(pointsOf(state)).filter(isObject).map(point => ({ ...structuredClone(point), available: archive.hasPayload(point.payloadHash) })).sort(ordered);
    }
    async function list() {
        const state = store.head();
        return { ok: true, points: state ? listNow(state) : [] };
    }

    async function status() {
        settle();
        const entries = archive.entries();
        const damaged = entries.some(entry => !['make', 'restore', 'native-mutation', 'native-event', 'selection'].includes(entry.kind));
        const pending = pendingEntry();
        const state = damaged ? 'failed' : pending || registry.restore?.().state === 'pending' ? 'pending' : 'idle';
        const out = [];
        for (const module of participants.modules()) {
            const selected = archive.selection()[module];
            if (selected) out.push({ module, checkpoint: selected.checkpoint, hash: selected.hash, schema: selected.schema });
        }
        return { ok: true, state, return: pending?.kind === 'restore' ? pending.return : null, participants: out, ...(state === 'pending' ? whyPending() : {}) };
    }

    // The one rule for which messages of the chat are on the active line: the faded interval of each return on the line of history,
    // (target, restore], excludes the whole target reply when the cursor is inside it (op > 0), through the restoring reply,
    // including intervening reader messages. A cursor at op 0 denotes the boundary at that carrier.
    // → { messages, sids (the canonical ids of each carrier), faded (the intervals as returned), at (the Set of faded indexes) }.
    function activeLine({ ids = false } = {}) {
        const state = store.head();
        const messages = typeof chat === 'function' ? chat() : [];
        const returns = Object.values(isObject(state?.domains?.[HOST_DOMAIN]?.returns) ? state.domains[HOST_DOMAIN].returns : {}).filter(isObject);
        const faded = returns.map(item => item.faded).filter(item => isObject(item?.after) && isObject(item?.through))
            .map(item => ({ after: structuredClone(item.after), through: structuredClone(item.through) }));
        const sids = faded.length || ids ? messages.map((message, at) => (message?.is_user ? null : store.sourceAt(at))) : [];
        const spans = faded.map(item => ({ from: sids.findIndex(source => source?.sid === item.after.sid && source?.swipeKey === item.after.swipeKey), to: sids.findIndex(source => source?.sid === item.through.sid && source?.swipeKey === item.through.swipeKey), inside: item.after.op > 0 }))
            .filter(span => span.from >= 0 && span.to >= span.from);
        const at = new Set();
        for (let index = 0; index < messages.length; index += 1) if (spans.some(span => index >= span.from + (span.inside ? 0 : 1) && index <= span.to)) at.add(index);
        return { messages, sids, faded, at };
    }

    // ---- hiding the faded messages ------------------------------------------------------------------------------
    //
    // SillyTavern leaves a hidden message (`is_system: true`, the ghost the reader sees) out of every prompt it builds: chat and text
    // completion, regexes, nested and quiet generations. A restore hides the messages it faded that are not hidden already, and
    // records which ones it hid in its journal entry (`hid`: [{ stamp, index, sid }]); when the restore is gone from the story (a swipe,
    // a delete, a Re-read) it shows exactly those again. Each message it hid carries the stamp (`story_suite_hid`, on the message, which
    // swipes and deletions of other messages do not move), so a record is found again whatever happened to the places. A message the
    // reader hid is never stamped, so it is never shown; one the reader showed again while it was faded is the reader's choice
    // (`released`): it is not hidden again and nothing is said. `syncHidden` is that rule, run in one synchronous step over the story
    // read whole; it changes nothing when nothing is faded and nothing was hid, so a chat that never restored is untouched.
    const STAMP = 'story_suite_hid';
    const restoreEntries = () => archive.entries().filter(entry => entry.kind === 'restore' && entry.phase !== 'aborted');
    function syncHidden() {
        if (!archive.exists() || !archive.holder()) return;
        const entries = restoreEntries();
        const line = activeLine({ ids: true });
        const noted = entries.some(entry => entry.hid?.length || entry.released?.length);
        if (!line.at.size && !noted) { s.hideFailed.delete(archive.holder()); return; }
        const { messages, sids } = line;
        const placeOf = new Map();
        messages.forEach((message, at) => { if (typeof message?.[STAMP] === 'string') placeOf.set(message[STAMP], at); });
        const returns = store.head()?.domains?.[HOST_DOMAIN]?.returns;
        const owner = entries.filter(entry => isObject(returns) && isObject(returns[entry.return])).at(-1) ?? null;
        let failed = '';
        let flipped = false;
        const flip = (at, hidden) => {
            const message = messages[at];
            try {
                message.is_system = hidden;
                if (message.is_system !== hidden) throw new Error('the message did not take the flag');
            } catch (error) { failed ||= `message ${at} could not be ${hidden ? 'hidden' : 'shown'} (${error?.message ?? error})`; return false; }
            flipped = true;
            try { redraw?.(at, message); } catch { /* not drawn yet: it is drawn from the saved chat */ }
            return true;
        };
        const stamped = (at, stamp) => {
            try { if (stamp === null) delete messages[at][STAMP]; else messages[at][STAMP] = stamp; } catch (error) { failed ||= `message ${at} could not be marked (${error?.message ?? error})`; return false; }
            flipped = true;
            return true;
        };
        const notes = new Map();   // entry id -> { hid, released }
        const noteOf = entry => {
            if (!notes.has(entry.id)) notes.set(entry.id, { hid: (entry.hid ?? []).map(item => ({ ...item })), released: [...(entry.released ?? [])] });
            return notes.get(entry.id);
        };
        const known = new Set();
        for (const entry of entries) {
            for (const item of entry.hid ?? []) {
                known.add(item.stamp);
                const at = placeOf.get(item.stamp);
                const note = noteOf(entry);
                const drop = () => { note.hid = note.hid.filter(each => each.stamp !== item.stamp); };
                if (at === undefined) { drop(); continue; }   // the message is gone
                if (!line.at.has(at)) {
                    // the restore is gone from the story: what it hid is shown again (unless the reader showed it already)
                    if (messages[at].is_system === true && !flip(at, false)) continue;
                    if (stamped(at, null)) drop();
                } else if (messages[at].is_system !== true) {
                    // the reader showed it again while it was faded: theirs to choose, and not hidden again
                    drop();
                    note.released.push(item.stamp);
                }
            }
            for (const stamp of entry.released ?? []) {
                known.add(stamp);
                const at = placeOf.get(stamp);
                if (at === undefined) { const note = noteOf(entry); note.released = note.released.filter(each => each !== stamp); continue; }
                if (!line.at.has(at)) { const note = noteOf(entry); if (stamped(at, null)) note.released = note.released.filter(each => each !== stamp); }
            }
        }
        // what is faded and still visible is hidden now, and noted on the newest restore the story holds
        for (const at of line.at) {
            const message = messages[at];
            if (message.is_system === true || known.has(message[STAMP])) continue;
            if (!owner) { failed ||= 'a return in the story has no restore in the journal to note the hidden messages on'; break; }
            const stamp = makeId('hd');
            if (stamped(at, stamp) && flip(at, true)) noteOf(owner).hid.push({ stamp, index: at, sid: sids[at]?.sid ?? null });
            else if (message[STAMP] === stamp) stamped(at, null);
        }
        for (const [id, note] of notes) {
            const entry = archive.get(id);
            if (hashJson({ hid: entry.hid ?? [], released: entry.released ?? [] }) !== hashJson(note)) archive.patch(id, { hid: note.hid, released: note.released });
        }
        const holder = archive.holder();
        if (failed) {
            if (!s.hideFailed.has(holder)) {
                s.hideFailed.add(holder);
                try { problem?.({ code: 'HIDE_FAILED', message: `Messages a restore faded could not all be hidden or shown again (${failed}), so they may reach a prompt.` }); } catch { /* a listener is not the timeline's business */ }
            }
        } else s.hideFailed.delete(holder);
        // (the flags are the chat's: it is saved with them, by the operation's own flush or the next save)
        if (flipped) { store.touch?.(); store.scheduleSave?.(); }
    }

    // A projection of the chat's messages for the readers of the story (prompt, extraction, native scans): the canonical
    // ids of each message and whether it is on the active line. A message with no carrier record of its own (the reader's
    // own) gets a projection-only msg_ id worked out from where it stands.
    async function history(input = {}) {
        if (!isObject(input) || Object.keys(input).some(key => key !== 'through')) return fail('INVALID', 'history takes { through? }.');
        const through = input.through;
        if (through !== undefined && (!isObject(through) || !isRecordId(through.sid))) return fail('INVALID', 'through is a cursor.');
        const line = activeLine({ ids: true });
        const { messages, sids, faded } = line;
        const cut = through === undefined ? messages.length - 1 : sids.findIndex(source => source?.sid === through.sid && source?.swipeKey === through.swipeKey);
        if (through !== undefined && cut < 0) return fail('NOT_FOUND', 'No message of this chat has that cursor.');
        const out = [];
        for (let at = 0; at <= cut && at < messages.length; at++) {
            const message = messages[at];
            const source = sids[at];
            const ids = source ?? (() => {
                const id = deriveId('msg', hashJson({ lineage: archive.lineage(), at, name: message?.name ?? '', date: message?.send_date ?? '', mes: message?.mes ?? '' }));
                return { sid: id, swipeKey: id };
            })();
            out.push({ sid: ids.sid, swipeKey: ids.swipeKey, text: String(message?.mes ?? ''), active: !line.at.has(at) });
        }
        return { ok: true, messages: out, faded };
    }

    return { settle, release, reconcile, minuteOf, sceneOf, headNow, head, listNow, list, status, activeLine, syncHidden, history };
}
