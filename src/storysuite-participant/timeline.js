// NPC State Delta, what the timeline participant keeps **inside Delta's chat state** (`state.timeline`), so that it travels with the dossiers it
// names: a chat rename moves the state file, a branch inherits it (branch.js), an export carries it (native-transfer.js), and a restore puts a
// checkpoint's block back with the dossiers of the same checkpoint.
//
//   timeline = {
//     v: 1,
//     lineage,       'lg_xxxxxxxx': the id of this story's native line. Minted once, never from the chat's key or name; a rename keeps it, a branch
//                    inherits it. A checkpoint belongs to a lineage, not to a file name.
//     identity,      { map: { np_id: { nativeKey, archived, since } } }: the np_ of every dossier, archived (never reused) when its dossier goes
//     reserved,      [np_id]: every np_ ever issued in this lineage, including the ones a restore took back (inactive, never issued again)
//     applied,       { event id: { nativeKey, at } }: the confirmed deaths applied
//     former,        [lineage]: earlier story lines of this same chat whose checkpoints it still accepts (written only when there is one: a
//                    chat that never changed its line keeps the block it always had)
//   }
//
// Pure. The block is plain JSON and is part of every checkpoint (restoring puts the saved map and deaths back; `reserved` is merged with the
// live one so an id the dead timeline issued is not issued again).

import { unionMarks } from '../memory-fact-marks.js';
import { cleanApplied } from './checkpoint.js';
import { commonPrefixLength, firstLineageDivergence } from '../../branch-core.js';
import { cleanIdentity } from './identity.js';

export const TIMELINE_VERSION = 1;
export const LINEAGE_ID = /^lg_[0-9a-z]{8}$/;
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const NP_ID = /^np_[0-9a-z]{8}$/;
const FORMER_MAX = 16;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A new lineage id. `random()` is a number in [0, 1) (Math.random by default, crypto when there is one). */
export function mintLineage(random = defaultRandom) {
    let text = '';
    for (let i = 0; i < 8; i += 1) text += BASE36[Math.floor(random() * 36) % 36];
    return `lg_${text}`;
}

function defaultRandom() {
    const crypto = globalThis.crypto;
    if (crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    return Math.random();
}

/** The block of a state as stored, checked: a whole block for anything, with `lineage` null when there is none yet. */
export function cleanTimeline(raw) {
    const block = { v: TIMELINE_VERSION, lineage: null, identity: cleanIdentity(null), reserved: [], applied: {}, former: [] };
    if (!isRecord(raw)) return block;
    if (typeof raw.lineage === 'string' && LINEAGE_ID.test(raw.lineage)) block.lineage = raw.lineage;
    block.identity = cleanIdentity(raw.identity);
    block.reserved = [...new Set([...(Array.isArray(raw.reserved) ? raw.reserved.filter(id => typeof id === 'string' && NP_ID.test(id)) : []), ...Object.keys(block.identity.map)])].sort();
    block.applied = cleanApplied(raw.applied);
    block.former = formerOf(raw.former, block.lineage);
    return block;
}

/** Former lineages as kept: well formed, not the line itself, each once, sorted, at most FORMER_MAX. */
function formerOf(list, lineage) {
    return [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && LINEAGE_ID.test(id) && id !== lineage))].sort().slice(0, FORMER_MAX);
}

/** The block as it is written into the state: no derived index. */
export function storedTimeline(block) {
    return {
        v: TIMELINE_VERSION,
        lineage: block.lineage,
        identity: { map: Object.fromEntries(Object.entries(block.identity.map).map(([id, entry]) => [id, { nativeKey: entry.nativeKey, archived: entry.archived === true, since: entry.since }])) },
        reserved: [...block.reserved].sort(),
        applied: Object.fromEntries(Object.entries(block.applied).map(([event, entry]) => [event, { nativeKey: entry.nativeKey, at: entry.at }])),
        ...(formerOf(block.former, block.lineage).length ? { former: formerOf(block.former, block.lineage) } : {}),
    };
}

/** The block of `state` (a state object), checked. */
export const timelineOf = state => cleanTimeline(state?.timeline);

/**
 * The state a restore installs: the checkpoint's state with its block, but this lineage's id and every np_ id that either timeline issued
 * kept reserved.
 */
export function restoredState(saved, live) {
    const state = JSON.parse(JSON.stringify(saved ?? {}));
    // (ONEPASSCAPR2-1) Reply-owned capture inputs outlive a selected checkpoint; keys include the complete branch lineage.
    if (Array.isArray(live?.captureJournal)) {
        const entries = new Map((state.captureJournal || []).map(entry => [entry.key, entry]));
        for (const entry of live.captureJournal) if (entry?.key) entries.set(entry.key, structuredClone(entry));
        state.captureJournal = [...entries.values()];
    }
    // (memory facts) The live-eligibility marks survive any restore (exact keys only; src/memory-fact-marks.js unionMarks).
    const marks = unionMarks(state.memoryFactMarks, live?.memoryFactMarks);
    if (marks) state.memoryFactMarks = marks;
    const then = cleanTimeline(state.timeline);
    const now = cleanTimeline(live?.timeline);
    // A checkpoint of a former line of this chat, installed in the line it has now, leaves that line recorded as a former one.
    const lineage = now.lineage ?? then.lineage;
    then.former = formerOf([...then.former, ...now.former, ...(then.lineage && then.lineage !== lineage ? [then.lineage] : [])], lineage);
    then.lineage = lineage;
    then.reserved = [...new Set([...then.reserved, ...now.reserved, ...Object.keys(now.identity.map)])].sort();
    state.timeline = storedTimeline(then);
    return state;
}

/**
 * How many messages behind the point where the story and the dossiers part a selected state may be before it is worth a line in the Problems:
 * the swiped reply, the reader's turn before it and one more exchange (4), or, when Delta publishes only on a change and a stretch of replies
 * named nobody, the replies a scan skips (`scanEvery`) with their turns, and one more exchange. A heuristic on lineage length: it only says, it never refuses.
 */
export const selectionMaxBehind = scanEvery => Math.max(4, 2 * (Number.isInteger(scanEvery) && scanEvery > 0 ? scanEvery : 5) + 2);

/**
 * Whether a head selection (the host's own, `hs_`) installs a state further behind the change than expected: `saved` is the lineage of the
 * state to install, `live` the lineage of the dossiers now, `chat` the lineage of the chat now (each a list of message fingerprints). The
 * story and the dossiers part at the first message they do not share (a swiped reply, the end of a shortened chat). The state is installed
 * either way (it can be the right one after a quiet stretch); a long way back is told, so that a real recurrence of a wrong selection is seen.
 * → { behind, at } (messages, and where they part) or null (as expected, or too little known to say).
 */
export function selectionBehind({ saved, live, chat, max = selectionMaxBehind() }) {
    if (![saved, live, chat].every(Array.isArray) || !live.length || !chat.length) return null;
    const divergence = firstLineageDivergence(live, chat);
    const at = divergence === -1 ? chat.length : divergence;
    const behind = at - saved.length;
    return behind > max ? { behind, at } : null;
}

/**
 * Whether a head selection (the host's `hs_`) may replace the live dossiers with the selected state `saved` (its lineage: message fingerprints).
 * Two rules, and only these can refuse: (i) the state must have a lineage and it must be a prefix of the chat now (a state that holds a message the
 * chat lacks carries the effects of a removed reply; one with no lineage cannot be judged); (ii) the live state must equal what was last published
 * (`liveHash` = `baseHash`): anything else is unpublished work, and an older state is never installed over it. → { install, why }.
 */
export function installGuard({ saved, chat, liveHash, baseHash }) {
    if (!Array.isArray(saved) || !saved.length) return { install: false, why: 'no-lineage' };
    if (commonPrefixLength(saved, chat) !== saved.length) return { install: false, why: 'not-in-chat' };
    if (liveHash !== baseHash) return { install: false, why: 'unpublished' };
    return { install: true, why: '' };
}

/** The message the story and the dossiers first part at: the live state's lineage against the chat; with no live lineage, the end of the selected state's. */
export function changeAt({ saved, live, chat }) {
    if (!Array.isArray(live) || !live.length) return Array.isArray(saved) ? saved.length : 0;
    const divergence = firstLineageDivergence(live, chat);
    return divergence === -1 ? chat.length : divergence;
}

/** The one-line note the reader keeps until dismissed: { kind: 'rebuilt' | 'refused', replyN, unread }. */
export function restoreNoteText(note) {
    if (!isRecord(note)) return '';
    if (note.kind === 'refused') return `Dossiers were kept as they are. They may still hold what reply ${note.replyN} changed, because the earlier state could not be used safely. Use Refresh on anyone who looks wrong.`;
    const unread = note.unread > 0 ? ` ${note.unread} earlier ${note.unread === 1 ? 'reply was' : 'replies were'} not re-read.` : '';
    return `Dossiers were restored to before reply ${note.replyN} and rebuilt from the later replies; details may differ. People you added or edited yourself after that point are not restored. Use Refresh on anyone who looks wrong.${unread}`;
}

/** A note as stored, checked, or null. */
export function cleanRestoreNote(raw) {
    if (!isRecord(raw) || !['rebuilt', 'refused'].includes(raw.kind)) return null;
    const count = value => (Number.isInteger(value) && value > 0 ? value : 0);
    return { kind: raw.kind, replyN: Math.max(1, count(raw.replyN)), unread: count(raw.unread) };
}
