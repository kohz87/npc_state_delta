// Story Suite v2 evidence, payloads part: checks that a proof payload is closed and well formed for its kind, its payload
// key, and whether a proof's intent matches what the reader said. Pure. evidence.js keeps the public path of each export.

import { isId } from '../check.js';
import { CONTROL, LIMITS, STATS, isObject, utf8, whole } from './constants.js';
import { canonicalJson, hashJson, isRecordId } from '../replay.js';

// ---------- payloads ----------

// Plain text: nothing at the ends, no control characters, 1..max code points.
const textProblem = (value, max) => {
    if (typeof value !== 'string' || !value) return 'is text';
    if (value.trim() !== value) return 'has no space at either end';
    if (CONTROL.test(value)) return 'has no control characters';
    if ([...value].length > max) return `is at most ${max} characters`;
    return '';
};

export const exactKeys = (payload, keys) => Object.keys(payload).length === keys.length && keys.every(key => Object.hasOwn(payload, key));

/** An acceptance (contract §6): `{ thread, selection }` (the reader's pick) or `{ thread, words }` (what they said). */
function acceptanceProblem(payload) {
    if (!isRecordId(payload.thread)) return 'its thread is a record id like th_k3f9a2qz';
    const keys = Object.keys(payload).filter(key => key !== 'thread');
    if (keys.length !== 1 || (keys[0] !== 'selection' && keys[0] !== 'words')) return 'it names its thread and either a selection or the reader\'s words, nothing else';
    const why = textProblem(payload[keys[0]], keys[0] === 'selection' ? LIMITS.selection : LIMITS.words);
    return why ? `its ${keys[0]} ${why}` : '';
}

/** The check Story Director asks evidence for (contract §6): `{ check, actor, stat, dc }`, an `event` proof. */
function checkProblem(payload) {
    if (!exactKeys(payload, ['check', 'actor', 'stat', 'dc'])) return 'a check is { check, actor, stat, dc } and nothing else';
    if (!isRecordId(payload.check)) return 'its check is a record id';
    if (!isId(payload.actor)) return 'its actor is an id';
    if (!STATS.includes(payload.stat)) return `its stat is one of ${STATS.join(', ')}`;
    if (!Number.isInteger(payload.dc) || payload.dc < 1 || payload.dc > 40) return 'its dc is a whole number from 1 to 40';
    return '';
}

// A payload the contract leaves to a later package (B3/B6, Story Director's own events and visits): any plain
// JSON object, not empty, within the byte cap. Whether it means anything is its owner's to check.
function opaqueProblem(json, payload) {
    if (!Object.keys(payload).length) return 'it has nothing in it';
    if (utf8.encode(json).length > LIMITS.opaqueBytes) return `it is more than ${LIMITS.opaqueBytes} bytes`;
    return '';
}

const MAX_DEPTH = 64;

// '' when `value` is a tree that JSON can hold as it is: no list with a hole ([1, , 3] would come back as null), no
// object that contains itself, nothing nested deeper than MAX_DEPTH; else why not.
function structureProblem(value, ancestors = new Set(), depth = 0) {
    if (!value || typeof value !== 'object') return '';
    if (depth > MAX_DEPTH) return `it is nested more than ${MAX_DEPTH} levels deep`;
    if (ancestors.has(value)) return 'it contains itself';
    ancestors.add(value);
    let found = '';
    if (Array.isArray(value)) {
        for (let at = 0; at < value.length && !found; at += 1) {
            found = !(at in value) ? 'it has a list with a gap in it' : structureProblem(value[at], ancestors, depth + 1);
        }
    } else {
        for (const item of Object.values(value)) {
            found = structureProblem(item, ancestors, depth + 1);
            if (found) break;
        }
    }
    ancestors.delete(value);
    return found;
}

/**
 * { problem, json }: '' when `payload` is a closed payload for `kind`, else why not (structure only: intent is
 * `intentProblem`), and its normalized JSON (what its hash is taken of) when it is plain JSON.
 */
export function payloadCheck(kind, payload) {
    if (!isObject(payload)) return { problem: 'its payload is a plain JSON record', json: '' };
    const shape = structureProblem(payload);
    if (shape) return { problem: `its payload is plain JSON, and ${shape}`, json: '' };
    let json = '';
    try { json = canonicalJson(payload); } catch { json = ''; }
    if (!json) return { problem: 'its payload is a plain JSON record', json: '' };
    if (kind === 'acceptance') return { problem: acceptanceProblem(payload), json };
    if (kind === 'event' && Object.hasOwn(payload, 'check')) return { problem: checkProblem(payload), json };
    return { problem: opaqueProblem(json, payload), json };
}

/** '' when `payload` is a closed payload for `kind`, else why not. */
export const payloadProblem = (kind, payload) => payloadCheck(kind, payload).problem;

/**
 * What names a proof inside one root (contract §6: the same key with a changed payload is a CONFLICT): an
 * acceptance is its thread, a check is its check id; a payload nobody shaped is its own key, so a different
 * payload is simply another proof.
 */
export function payloadKey(kind, payload) {
    if (kind === 'acceptance') return `thread:${payload.thread}`;
    if (kind === 'event' && Object.hasOwn(payload, 'check')) return `check:${payload.check}`;
    return `payload:${hashJson(payload)}`;
}

// Folded for comparing: Unicode compatibility form, one space between words, lower case.
const fold = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
// The end marks of a sentence, and what may stand at a sentence's ends without being part of it (quotes, commas, dashes).
const SENTENCE_END = /[.!?\u2026\u3002\uff01\uff1f;\n\r]+/u;
const EDGE = /^[\s"'\u201c\u201d\u2018\u2019\u00ab\u00bb.!?\u2026\u3002\uff01\uff1f,:;\-\u2013\u2014()[\]*_~]+|[\s"'\u201c\u201d\u2018\u2019\u00ab\u00bb.!?\u2026\u3002\uff01\uff1f,:;\-\u2013\u2014()[\]*_~]+$/gu;
const core = text => fold(text).replace(EDGE, '');

/**
 * The sentences of the reader's message, folded and without their edges: the text cut at . ! ? … ; and line breaks.
 * A comma does not end one ("Sure, I accept the job" is one sentence).
 */
export function sentences(text) {
    // Cut first (a line break is a sentence end), then fold each piece: folding first would turn the break into a space.
    return String(text ?? '').normalize('NFKC').split(SENTENCE_END).map(piece => fold(piece).replace(EDGE, '')).filter(Boolean);
}

/**
 * '' when the host saw the reader's intent the proof claims, else why not (REFUSED). An acceptance by
 * `selection` is the reader's own action in a screen (cause `ui`). One by `words` must be a whole sentence of the
 * reader's message the host gave this reply (`chat.lastUser`: the message right before the reply), after folding
 * case, spacing and the marks at its ends, and at least two words: a piece of a sentence ("take it" out of "I will
 * not take it"), one word ("No") or text only the narration (`chat.reply`) says is REFUSED. The host proves
 * quoting, not meaning: whether the quoted sentence accepts is the owner's to judge.
 */
export function intentProblem(kind, payload, { cause, chat }) {
    if (kind !== 'acceptance') return '';
    if (Object.hasOwn(payload, 'selection')) {
        return cause === 'ui' ? '' : 'a selection is the reader\'s own pick in a screen, and this did not come from one';
    }
    const spoken = sentences(chat?.lastUser);
    if (!chat || !spoken.length) return 'the host saw no message from the reader for this reply, and narration cannot accept for them';
    const quoted = core(payload.words);
    if (quoted.split(' ').length < 2) return 'the reader\'s words are at least two words';
    return spoken.includes(quoted) ? '' : 'the words are not a whole sentence of the reader\'s message the host saw (narration cannot accept for the reader, and a piece of a sentence is not what they said)';
}
