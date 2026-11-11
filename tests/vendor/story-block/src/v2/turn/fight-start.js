// A fight-start choice belongs to the reader's message and the reply it follows.
// Chat metadata keeps the choice and the typed attack's hold across reloads; it never changes the sheet.

import { hashText } from '../assist/common.js';
import { readRecord } from '../persist.js';
import { fold } from '../lean-rpg/read.js';
import { extractBlock, parseChanges, stripBlock } from '../capture.js';

const KEY = 'rpgFightStart';
// A running check is page-local. A copied or reloaded metadata object cannot still have a call in flight.
const working = new WeakMap();
const anchorOf = chat => readRecord(chat?.at(-2))?.sid;
const keyOf = message => hashText(String(message?.mes ?? '').trim());

export function pendingStart(meta, chat) {
    const pending = meta?.[KEY], last = chat?.at(-1);
    if (!pending || !last?.is_user || !pending.anchor || pending.anchor !== anchorOf(chat) || pending.message !== keyOf(last)
        || (pending.mode === 'working' && working.get(meta) !== pending)) return null;
    return pending;
}

export function holdStart(meta, chat, value = {}) {
    const last = chat?.at(-1), anchor = anchorOf(chat);
    if (!meta || typeof meta !== 'object' || !last?.is_user || !anchor || !String(last.mes ?? '').trim()) return null;
    const pending = { anchor, message: keyOf(last), mode: 'known', choice: null, ...value };
    meta[KEY] = pending;
    if (pending.mode === 'working') working.set(meta, pending); else working.delete(meta);
    return pending;
}

export function clearStart(meta, expected = null) {
    if (meta && typeof meta === 'object' && (!expected || meta[KEY] === expected)) {
        working.delete(meta);
        delete meta[KEY];
    }
}

// The gate for a known fight must not turn a conversation or a quiet observation into a fight.
const ACTION = /\b(?:attack\w*|strik\w*|struck|stab\w*|slash\w*|hit(?:s|ting)?|punch\w*|kick\w*|swing\w*|swung|smash\w*|bash\w*|fight\w*|fought|battl\w*|duel\w*|kill\w*|slay\w*|slew|smite\w*|shoot\w*|shot|hurl\w*|throw\w*|threw|cast\w*|charge\w*|ambush\w*|grappl\w*|tackl\w*|shov\w*|disarm\w*|block\w*|brac\w*|parr\w*|dodg\w*|evad\w*|defend\w*|guard\w*|lunge\w*|thrust\w*|engag\w*|assault\w*|pounc\w*|jump\w*|leap\w*|leapt|fall(?:s|ing)?\s+upon|fell\s+upon|flee\w*|fled|run\w*|ran|escap\w*|retreat\w*|cut\w*|slic\w*|cleav\w*|hack\w*|brawl\w*)\b/iu;
const WEAPON_ACTION = /\b(?:fire|fires|fired|firing|draw|draws|drew|drawing|loose|loosed|aim|aims|aimed)\b[^.!?]{0,35}\b(?:at|arrow|bow|bolt|blade|sword|dagger|weapon|gun|spear)\b/iu;
export function fightsInMessage(text, sheet) {
    if (ACTION.test(String(text ?? '')) || WEAPON_ACTION.test(String(text ?? ''))) return true;
    const message = fold(String(text ?? ''));
    return (sheet?.characters ?? []).some(actor => (actor.skills ?? []).some(skill => {
        const name = fold(skill.name);
        return name.length >= 4 && message.includes(name);
    }));
}

// The next-reply cue for a fight narrated with no Foes line (it would never be fought on the board): the reply before reads as a fight (at least
// FIGHT_WORDS_MIN different fight words in its story, and a `? roll` line) and wrote no foes line, and no foe is set now. Gated by the caller on the
// RPG being on; a tail line only, the static prompt is unchanged. Re-derived from the stored reply each time, so replay == live.
export const FIGHT_CUE = 'A fight seems under way in the last reply but no foes line was written: write + dm foes so it is fought on the board.';
export const FIGHT_WORDS_MIN = 3;
// Action words only (something done to someone): a noun or scene word (blood, dead, sword, bolt, axe) never counts, so a dead tree or a sword on the wall is no fight.
const FIGHT_WORD = /(?<![\p{L}\p{N}])(kill(?:ed|s)?|slain|slay(?:s)?|slew|stab(?:bed|s)?|slash(?:ed|es)?|wound(?:ed|s)?|bleed(?:ing|s)?|struck\s+down|strikes?\s+down|swung\s+at|swings?\s+at|cleaves?|cleft|parried|lunged|fell\s+dead)(?![\p{L}\p{N}])/giu;
export function fightCue(reply, { foesNow = false, heads = null } = {}) {
    const mes = String(reply?.mes ?? '');
    if (foesNow || !mes) return null;
    const lines = parseChanges(extractBlock(mes, 'Changes', null, { heads }) ?? '').lines;
    if (!lines.some(line => line.kind === 'roll') || lines.some(line => line.kind === 'dm' && line.op === '+' && (/^foes?(?![\p{L}])/iu.test(line.name) || /^set-slot/u.test(String(line.labels?.kind ?? ''))))) return null;
    const words = new Set([...stripBlock(mes, 'Changes', { heads }).matchAll(FIGHT_WORD)].map(found => found[1].toLowerCase().replace(/\s+/gu, ' ')));
    return words.size >= FIGHT_WORDS_MIN ? FIGHT_CUE : null;
}
