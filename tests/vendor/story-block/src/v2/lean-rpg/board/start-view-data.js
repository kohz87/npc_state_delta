// Turns a staged/opened board fight into plain text and numbers for the start views.
// It reads the sheet without changing it; the offer line and pause view never read game state themselves.
// Foe names stay text (never markup), and the helper is safe to call while a preview is still waiting.

import { foeLabel } from '../foes.js';
import { STAGES, stageWord } from '../names.js';
import { readSheet } from '../read.js';
import { text as sentence } from '../../view/widgets/dom.js';

export const OFFER_BOARD_LABEL = 'Fight on the board';
export const OFFER_AUTO_LABEL = 'Auto-fight';
export const PAUSE_BOARD_LABEL = 'Fight on the board';
export const PAUSE_SEND_LABEL = 'Send without a fight';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const whole = value => (Number.isSafeInteger(value) ? value : null);
const slotOf = value => {
    if (Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return Number(value);
    if (Number.isSafeInteger(value?.slot)) return value.slot;
    return null;
};

const sessionOf = fight => (isObject(fight?.session) ? fight.session : isObject(fight?.board) ? fight.board : fight);

function foeFrom(source) {
    const name = sentence(source?.name, 60);
    if (!name) return null;
    const count = whole(source?.count) ?? 1;
    const level = whole(source?.level);
    const size = whole(source?.size) ?? 5;
    const hurt = Number.isFinite(source?.hurt) ? Math.max(0, Math.min(size, source.hurt)) : null;
    const health = sentence(source?.word ?? source?.healthWord, 40) || (hurt === null ? 'Unhurt' : stageWord(STAGES.health, hurt, size));
    const countText = count > 1 ? ` ×${count}` : '';
    const levelText = level === null ? '' : ` · ${foeLabel(level)}`;
    return { name, count, level, hurt, size, health, label: `${name}${countText}${levelText}` };
}

/** "Auto-fight (up to 3 exchanges)" for a cap of 1..8 (9 = until the end). */
export const autoFightLabel = cap => `Auto-fight (${cap >= 9 ? 'until the end' : `up to ${cap} exchange${cap === 1 ? '' : 's'}`})`;
const countName = foe => `${foe.name}${foe.count > 1 ? ` (${foe.count})` : ''}`;

/** The standing groups of a staged/opened fight, with the sheet's names, levels and health when `state` is given. */
export function fightFoes(fight, state = null) {
    const session = sessionOf(fight);
    if (!isObject(session)) return [];
    const explicit = list(session.foes).map(foeFrom).filter(Boolean);
    const sheet = state ? readSheet(state) : null;
    const groups = new Set(list(session.groups).map(slotOf).filter(value => value !== null));
    if (sheet && groups.size) {
        const found = sheet.foes.filter(foe => foe.filled && groups.has(foe.slot)).map(foeFrom).filter(Boolean);
        if (found.length) return found;
    }
    if (explicit.length) return explicit;
    const order = list(session.setup?.order ?? session.order ?? resultOf(session.result)?.order);
    return order.filter(entry => entry && entry.party !== true).map(entry => foeFrom({ name: entry.name })).filter(Boolean);
}

/**
 * The inline offer under the narrator's reply: `{ visible, text, foes, label, boardLabel, autoLabel }`, or null with no fight.
 * `hidden` is the reader's choice to keep narrating this fight. `state` lets the names come from the current sheet.
 */
export function offerLineData(fight, { state = null, hidden = false } = {}) {
    const foes = fightFoes(fight, state);
    if (!foes.length) return null;
    const names = [...new Set(foes.map(foe => foe.name))];
    const joined = names.join(', ');
    // A fight that ended with foes still up says so (offers.js sets `standing`); the groups show their counts.
    const standing = fight?.standing === true;
    return {
        visible: hidden !== true, foes,
        text: standing ? `Foes are still standing: ${foes.map(countName).join(', ')}` : `A fight started: ${joined}.`,
        label: `Fight offer: ${joined}`,
        boardLabel: OFFER_BOARD_LABEL,
        autoLabel: OFFER_AUTO_LABEL,
    };
}

/**
 * The pause screen's data for a typed attack on standing foes: the board and Auto-fight (up to the cap's exchanges).
 * → { mode: 'known' | 'new', title, note, label, boardLabel, autoLabel, sendLabel?, hint? } or null when no foe stands. With `working`: the pre-check's wait line; with `opening` (a recorded opening result): the foes it found.
 */
export function pauseViewData({ fight = null, state = null, cap = 3, opening = null, working = false } = {}) {
    // The pre-check is reading the reader's message (nothing to choose yet).
    if (working) return { mode: 'working', title: 'Setting up the fight…', hint: 'Reading your message for the foes. If it takes more than 20 seconds, your message is sent as it is.', label: 'Setting up the fight' };
    // Foes the pre-check found are not on the sheet yet: they come from the recorded opening.
    const found = opening ? list(opening.opened).map(foeFrom).filter(Boolean) : [];
    const known = found.length ? found : fightFoes(fight, state);
    if (!known.length) return null;
    if (found.length) {
        return {
            mode: 'new', title: `This is an attack on ${known.map(foe => `${foe.name} (${foe.count})`).join(', ')}`,
            note: 'Your message waits while the fight is played on the board.',
            hint: 'Found by the pre-check from your message. Big groups fight as packs.',
            label: 'Fight paused', boardLabel: PAUSE_BOARD_LABEL, autoLabel: autoFightLabel(cap), sendLabel: PAUSE_SEND_LABEL,
        };
    }
    return {
        mode: 'known', title: `This is an attack on ${known.map(countName).join(', ')}`,
        note: 'Your message waits while the fight is played on the board.',
        label: 'Fight paused', boardLabel: PAUSE_BOARD_LABEL, autoLabel: autoFightLabel(cap),
    };
}
