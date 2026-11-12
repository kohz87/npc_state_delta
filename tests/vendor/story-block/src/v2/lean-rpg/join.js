// Companions who join (mockup section 8): the narrator's one-line form for someone joining or leaving the party,
//   + party Mara | about: a hedge-witch from Kvildal | class: I | best: int
//   - party Mara
// and what code makes of it. Pure: no DOM, no commands. This file reads the line, checks it against the story's blocks, works out the
// character (stats 10, the named best stat 14, Soul Class as written but never above the party's highest, bars full) and the two
// definitions it is made of (the wizard's buildDefinitions, so a story-made companion is the same blocks a reader-made one is). The
// block engine (data-modules/part.js) makes them as one guarded action; the card under the reply (Ask) is read from the reply's own
// receipts, so a swipe, a delete or a Re-read takes it away with the reply and nothing is kept in the story's state for it.

import { activeDefinition, instanceOf } from '../data-modules/adapters.js';
import { DM_LIMITS, DM_OLD_ROOM } from '../data-modules/schema.js';
import { oneLine } from '../../text.js';
import { CLASS_NAMES, CREATION, JOINS, JOIN_SETTING, PARTY_ACTIVE, PARTY_MAX, STATS } from './names.js';
import { fold } from './read.js';
import { RPG_STRINGS, fill } from './strings.js';
import { buildDefinitions, creationOf, hasRoom, newSoul, readDraft } from './view/wizard-data.js';
import { classOfLevel, companionStats, levelOfClass } from './formula.js';
import { STANDARD_FORMULA, isStandard } from './rules.js';
import { soulReading } from './soul.js';

const J = RPG_STRINGS.join;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The setting's value: 'ask' (the default), 'auto' or 'off'. */
export const joinMode = values => (JOINS.includes(values?.[JOIN_SETTING]) ? values[JOIN_SETTING] : JOINS[0]);

/** The narrator's grammar line for party lines (one line, as every kind's is). */
export const joinGrammar = () => J.grammar;
/** The same line in the words of this story's own class field (`naming`, soulNaming): the classes it runs from and to; the template's gives joinGrammar's text. */
export const joinGrammarOwn = naming => { const own = soulWords(naming); return fill(J.grammarOwn, { first: oneLine(own.first), last: oneLine(own.last) }); };

/** The command a card's No runs, and the receipt `data` keys the card reads (receipt.data.join). */
export const JOIN_NO = 'rpg.joinNo';
export const JOIN_BENCH = 'dm.bench';
export const JOIN_ADD = 'dm.join';

/**
 * A Soul Class written as I to IX or 1 to 9 → 1..9, or 0 when it is not one. `soul` (soul.js soulReading): the field's own names are
 * understood too, when a pack renamed them ("Level" 1–9, or words).
 */
export function soulOf(text, soul = null) {
    const word = oneLine(text).toUpperCase();
    if (/^[1-9]$/.test(word)) return Number(word);
    const at = CLASS_NAMES.indexOf(word);
    if (at >= 0) return at + 1;
    const own = typeof soul?.word === 'function' ? CLASS_NAMES.findIndex((_, n) => oneLine(soul.word(n + 1)).toUpperCase() === word) : -1;
    return own >= 0 ? own + 1 : 0;
}

/**
 * A party line read: `{ op: '+' | '-', name, about, soul, best }` or `{ error }` (plain words). `about` is cut at 240 characters (whole
 * characters), `soul` is 1 when the line has no class, `best` is one of the seven stats or '' when the line names none.
 */
export function readJoin(line, naming = null) {
    const op = line?.op;
    if (op !== '+' && op !== '-') return { error: fill(J.wrongOp, { op: op ?? '' }) };
    const name = oneLine(line?.name);
    if (!name) return { error: J.noPerson };
    if ([...name].length > CREATION.name) return { error: fill(J.nameLong, { max: CREATION.name }) };
    if (op === '-') return { op, name };
    const labels = isRecord(line?.labels) ? line.labels : {};
    const about = [...oneLine(labels.about ?? line?.text)].slice(0, CREATION.about).join('');
    let soul = 1;
    if (oneLine(labels.class)) {
        soul = soulOf(labels.class, naming);
        if (!soul) return { error: fill(J.badClass, soulWords(naming)) };
    }
    let best = '';
    if (oneLine(labels.best)) {
        best = oneLine(labels.best).toLowerCase();
        if (!STATS.includes(best)) return { error: fill(J.badBest, { stats: STATS.join(', ') }) };
    }
    return { op, name, about, soul, best };
}

/** What the Soul Class is called, as the refusal and the card say it: { label, first, last, word } (soul.js). The default is the template's. */
const soulWords = naming => {
    const own = naming ?? newSoul();
    return { label: own.label, first: own.word(1), last: own.word(CLASS_NAMES.length), word: own.word };
};

/** What this story's party calls the Soul Class: the first Character block's own field (companions who left too), else the template's. */
export function soulNaming(state) {
    const domain = state?.domains?.dataModules;
    for (const module of Object.keys(isRecord(domain?.active) ? domain.active : {})) {
        const definition = activeDefinition(state, module);
        if (definition?.role === 'character' && definition.scope === 'chat' && isRecord(definition.state?.soul)) return soulReading(definition.state.soul);
    }
    return newSoul();
}

/** The characters of the story's party, from a state: `[{ module, name, soul, level, left, canLeave }]` in block order (the ones who left too). `soul` is the Soul Class of an earlier block, else the class the level stands for (formula.js classOfLevel). */
export function partyOf(state) {
    const domain = state?.domains?.dataModules;
    const out = [];
    for (const module of Object.keys(isRecord(domain?.active) ? domain.active : {})) {
        const definition = activeDefinition(state, module);
        if (definition?.role !== 'character' || definition.scope !== 'chat') continue;
        const fields = instanceOf(state, module)?.fields;
        if (!isRecord(fields)) continue;
        const name = oneLine(fields.who) || oneLine(definition.name);
        if (!name) continue;
        out.push({ module, name, soul: Number.isSafeInteger(fields.soul) ? fields.soul : Number.isSafeInteger(fields.level) ? classOfLevel(fields.level) : 1, level: Number.isSafeInteger(fields.level) ? fields.level : levelOfClass(Number.isSafeInteger(fields.soul) ? fields.soul : 1), left: fields.left === true, canLeave: Object.hasOwn(definition.state ?? {}, 'left') });
    }
    return out;
}

/** The highest Soul Class among the characters who are in the party (1 when there is none). */
export const partyCap = party => Math.max(1, ...party.filter(person => !person.left).map(person => person.soul));

/**
 * What a `+ party` line may do in this story: `{ ok: true, soul, returning }` (`returning`: the party entry of someone who left and is
 * back) or `{ ok: false, why }`. The refusals are the plain ones: the name is taken, the party is full (counting those who left, whose
 * sheets are kept), there is no room for the two blocks.
 */
export function checkJoin(state, request, room = DM_LIMITS, limit = PARTY_MAX) {
    const party = partyOf(state);
    const same = party.find(person => fold(person.name) === fold(request.name));
    // The party limit counts members who are in it; a reply captured before the `partyRoom` mark (room = DM_OLD_ROOM) counts those who left too, as it did.
    // `limit` is the one the reply was captured under (4 with the `partyFour` mark, else 8). A refusal for a full party says `full`, so a caller may offer a bench choice.
    const old = room === DM_OLD_ROOM;
    const crowd = old ? party.length : party.filter(person => !person.left).length;
    const fullWhy = fill(J.fullActive, { max: limit });
    if (same?.left) return !old && crowd >= limit ? { ok: false, full: true, back: true, why: fullWhy } : { ok: true, returning: same, soul: same.soul };
    if (same) return { ok: false, why: fill(J.taken, { name: same.name }) };
    if (crowd >= limit) return { ok: false, full: !old, why: old ? fill(J.full, { max: PARTY_MAX }) : fullWhy };
    if (!hasRoom(state, room)) return { ok: false, why: fill(J.noRoom, { max: room.definitions }) };
    return { ok: true, soul: Math.min(request.soul, partyCap(party)) };
}

/**
 * The members a full party's card offers to bench: active ones with a Left field, never the reader's own character (the one named like the
 * persona, `isMe(name)`; with none named so, the first block, as the rolls take it). → [{ module, name, level }] in block order.
 */
export function benchable(state, isMe = () => false) {
    const active = partyOf(state).filter(person => !person.left);
    const mine = active.some(person => isMe(person.name));
    return active.filter((person, at) => (mine ? !isMe(person.name) : at > 0) && person.canLeave).map(({ module, name, level }) => ({ module, name, level }));
}

/** The wizard's draft for a joining companion (the card's Edit first opens it): name, about, class, the best stat raised to 14 (under the Standard formula `rules`: formula.js companionStats). */
export function joinDraft({ name = '', about = '', soul = 1, best = '', skills = [] } = {}, rules = null) {
    // (a cast member's signature skills, as the pack wrote them: they fill the slots in order, at the rank written, marked `sig` so the story never renames or replaces them; a `utility` one keeps its type and counts against the three utility slots)
    const signed = (Array.isArray(skills) ? skills : []).map(skill => ({ name: skill.name, about: skill.about, stat: skill.stat, uses: skill.uses, start: 0, rank: skill.rank, sig: true, ...(skill.type === 'utility' ? { type: 'utility' } : {}) }));
    // Every stat 5 and the best 9, then a point for every third level the class stands for (formula.js companionStats); the draft's budget is
    // exactly what they cost, so "Edit first" can move points around but is not handed more. (Without rules: the Standard preset's.)
    const standard = isStandard(rules) ? rules : STANDARD_FORMULA;
    const stats = companionStats(best, levelOfClass(soul), standard), creation = creationOf(standard);
    const spent = STATS.reduce((sum, stat) => sum + stats[stat] - creation.start, 0);
    return readDraft({ name, about, soul, stats, kind: 'companion', skills: signed, set: '', creation: { ...creation, budget: spent, max: creation.statMax } });
}

/**
 * The two definitions a joining companion is made of (`used`: the ids of the story's blocks, so the slugs are free). The Character
 * starts with no unspent points: the named stat is raised and the rest left as it was, as the line said.
 */
export const joinDefinitions = (request, { used = [], soul = request.soul, rules = null, cap = null, legacy = false, scale = 2, typed = true } = {}) =>
    buildDefinitions(joinDraft({ ...request, soul }, rules), { used, points: 0, cap, legacy, scale, typed });

/**
 * A Re-read takes the joined character's scale from that reply's pin. Otherwise choose 1 when all existing character pins are old, else 2.
 * Inspect pins even when a character has left or has no readable name; those old pins still identify the story's existing scale.
 */
export const joinScale = (state, standing = null, module = null) => {
    const joined = module && standing ? activeDefinition(standing, module) : null;
    if (joined?.role === 'character') return joined.state?.health?.scale === 2 ? 2 : 1;
    const pins = Object.keys(state?.domains?.dataModules?.active ?? {}).map(id => activeDefinition(state, id)).filter(definition => definition?.role === 'character');
    return pins.length && !pins.some(definition => definition.state?.health?.scale === 2) ? 1 : 2;
};

/**
 * The offers on a reply: the `+ party` lines that asked (Ask) or met a full party, read from the reply's receipts (`entries`: store.receipts() as a
 * query's tools give them, `{ index, receipt }`), minus the ones the reader answered (a `rpg.joinNo` receipt for the name, a `dm.join` for it, a return)
 * and the ones whose name is in the party now. → [{ name, about, soul, best }] in the order written. An offer that met a full party (`full`, a bench
 * choice) is asked again only while 4 are active, and "Not now" (`declined`) keeps it; a bench choice already made ends the list with
 * `{ name, done: true, benched }` (who stepped out), for the card to say so.
 */
export function joinOffers(entries, index, party = []) {
    const list = (Array.isArray(entries) ? entries : []).filter(entry => entry?.index === index && isRecord(entry.receipt?.data?.join));
    const answered = new Set(), declined = new Set(), done = [];
    for (const entry of list) {
        const join = entry.receipt.data.join, key = fold(join.name);
        if (join.op === 'no') declined.add(key);
        else if (typeof join.benched === 'string' && join.benched) {
            // (a bench choice counts only while the newcomer is in the party: a replay that skipped it leaves the offer as it was)
            if (!party.some(person => fold(person.name) === key && !person.left)) continue;
            answered.add(key);
            done.push({ name: oneLine(join.name), done: true, benched: oneLine(join.benched) });
        } else if (join.op === 'added' || join.op === 'back') answered.add(key);
    }
    const crowded = party.filter(person => !person.left).length >= PARTY_ACTIVE;
    const seen = new Map();
    const out = [];
    for (const entry of list) {
        const join = entry.receipt.data.join;
        if (join.op !== 'offer') continue;
        const key = fold(join.name);
        if (!key || answered.has(key)) continue;
        const known = seen.get(key);
        if (known) { known.recorded ||= join.full === true; known.back ||= join.back === true; known.four ||= join.four === true; continue; }
        const offer = { name: oneLine(join.name), about: oneLine(join.about), soul: Number.isSafeInteger(join.soul) ? join.soul : 1, best: STATS.includes(join.best) ? join.best : '',
            ...(Array.isArray(join.skills) && join.skills.length ? { skills: join.skills.slice(0, 8).map(skill => ({ name: oneLine(skill?.name), about: oneLine(skill?.about), stat: skill?.stat, uses: skill?.uses, rank: skill?.rank, ...(skill?.type === 'utility' ? { type: 'utility' } : {}) })) } : {}) };
        const state = { offer, recorded: join.full === true, back: join.back === true, four: join.four === true };
        seen.set(key, state);
        out.push(state);
    }
    const shown = [];
    for (const { offer, recorded, back, four } of out) {
        const key = fold(offer.name), person = party.find(entry => fold(entry.name) === key);
        if (person && !(back && person.left)) continue;
        const full = recorded && crowded;
        if (declined.has(key) && !full) continue;
        shown.push({ ...offer, ...(four ? { four: true } : {}), ...(full ? { full: true, ...(back ? { back: true } : {}), ...(declined.has(key) ? { declined: true } : {}) } : {}) });
    }
    return [...shown, ...done];
}

/** A bench button's label: the name is cut with an ellipsis so " · Lv N" always stays inside the card's 32-character action label. */
function benchLabel({ name, level }) {
    const tail = fill(J.benchOne, { name: '', level });
    const room = Math.max(1, 32 - [...tail].length);
    const chars = [...oneLine(name, 1000)];
    return fill(J.benchOne, { name: chars.length > room ? `${chars.slice(0, room - 1).join('').trimEnd()}…` : chars.join(''), level });
}

/** The card under the reply for the first offer, in reply-cards.js's shape, or null. */
export function joinCard(offers, state = null, isMe = () => false) {
    const offer = offers.find(entry => !entry.done) ?? offers[0];
    if (!offer) return null;
    if (offer.done) return { tone: 'good', icon: 'fa-user-check', title: J.benchDoneTitle, text: fill(J.benchDone, { left: offer.benched, name: offer.name }), rows: [], actions: [] };
    // (a full party, 4 active: one button per member who may step out, and Not now; the offer's request stays in the reply's receipt)
    if (offer.full) {
        const payload = { name: offer.name, about: offer.about, soul: offer.soul, best: offer.best, ...(offer.skills ? { skills: offer.skills } : {}) };
        // (room for Not now: a card keeps 4 buttons, so a chat with more than 4 active shows 3 members until Not now is used)
        const actions = benchable(state, isMe).slice(0, offer.declined ? 4 : 3).map(member => ({ id: `bench-${member.module}`.slice(0, 40), label: benchLabel(member), icon: 'fa-person-walking-arrow-right', command: JOIN_BENCH, payload: { ...payload, bench: member.name } }));
        if (!offer.declined) actions.push({ id: 'no', label: J.benchNot, icon: 'fa-xmark', command: JOIN_NO, payload: { name: offer.name } });
        return { tone: 'accent', icon: 'fa-flag', title: fill(J.benchTitle, { max: PARTY_ACTIVE }), rows: [],
            text: fill(offer.declined ? J.benchDeclined : J.benchWho, { name: offer.name }), actions };
    }
    // (a cast member's signature skills, as the pack had them when the line came, go with Edit first: the wizard's draft keeps them marked)
    const payload = { name: offer.name, about: offer.about, soul: offer.soul, best: offer.best, ...(offer.skills ? { skills: offer.skills } : {}) };
    // (the class a line writes stands for a level, 10n - 5: the card says the level the companion will start at)
    const rows = [{ icon: 'fa-star', text: fill(J.rowLevel, { level: levelOfClass(CLASS_NAMES[offer.soul - 1] ? offer.soul : 1) }) }];
    if (offer.best) rows.push({ icon: 'fa-arrow-up', text: fill(J.rowBest, { stat: offer.best.toUpperCase() }) });
    return {
        tone: 'accent', icon: 'fa-user-plus', title: fill(J.title, { name: offer.name }), text: offer.about, rows,
        actions: [
            { id: 'add', label: J.add, icon: 'fa-check', primary: true, command: JOIN_ADD, payload: offer.four ? { ...payload, four: true } : payload },
            { id: 'edit', label: J.edit, icon: 'fa-pencil', open: 'story-block/new-character', payload },
            { id: 'no', label: J.no, icon: 'fa-xmark', command: JOIN_NO, payload: { name: offer.name } },
        ],
    };
}
