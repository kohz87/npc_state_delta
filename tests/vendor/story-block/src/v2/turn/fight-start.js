// A fight-start choice belongs to the reader's message and the reply it follows.
// Chat metadata keeps the choice and the typed attack's hold across reloads; it never changes the sheet.

import { hashText } from '../assist/common.js';
import { readRecord } from '../persist.js';
import { fold } from '../lean-rpg/read.js';

const KEY = 'rpgFightStart';
const anchorOf = chat => readRecord(chat?.at(-2))?.sid;
const keyOf = message => hashText(String(message?.mes ?? '').trim());

export function pendingStart(meta, chat) {
    const pending = meta?.[KEY], last = chat?.at(-1);
    if (!pending || !last?.is_user || !pending.anchor || pending.anchor !== anchorOf(chat) || pending.message !== keyOf(last)) return null;
    return pending;
}

export function holdStart(meta, chat, value = {}) {
    const last = chat?.at(-1), anchor = anchorOf(chat);
    if (!meta || typeof meta !== 'object' || !last?.is_user || !anchor || !String(last.mes ?? '').trim()) return null;
    const pending = { anchor, message: keyOf(last), mode: 'known', choice: null, ...value };
    meta[KEY] = pending;
    return pending;
}

export function clearStart(meta) {
    if (meta && typeof meta === 'object') delete meta[KEY];
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
