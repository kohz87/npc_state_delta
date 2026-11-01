// Companions who join (mockup section 8): the narrator's one-line form for someone joining or leaving the party,
//   + party Mara | about: a hedge-witch from Kvildal | class: I | best: int
//   - party Mara
// and what code makes of it. Pure: no DOM, no commands. This file reads the line, checks it against the story's blocks, works out the
// character (stats 10, the named best stat 14, Soul Class as written but never above the party's highest, bars full) and the two
// definitions it is made of (the wizard's buildDefinitions, so a story-made companion is the same blocks a reader-made one is). The
// block engine (data-modules/part.js) makes them as one guarded action; the card under the reply (Ask) is read from the reply's own
// receipts, so a swipe, a delete or a Re-read takes it away with the reply and nothing is kept in the story's state for it.

import { activeDefinition, instanceOf } from '../data-modules/adapters.js';
import { DM_LIMITS } from '../data-modules/schema.js';
import { oneLine } from '../../text.js';
import { CLASS_NAMES, CREATION, JOINS, JOIN_SETTING, PARTY_MAX, STATS } from './names.js';
import { fold } from './read.js';
import { RPG_STRINGS, fill } from './strings.js';
import { buildDefinitions, creationOf, hasRoom, newDraft, newSoul, readDraft } from './view/wizard-data.js';
import { companionStats } from './formula.js';
import { isStandard } from './rules.js';
import { soulReading } from './soul.js';

const J = RPG_STRINGS.join;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The setting's value: 'ask' (the default), 'auto' or 'off'. */
export const joinMode = values => (JOINS.includes(values?.[JOIN_SETTING]) ? values[JOIN_SETTING] : JOINS[0]);

/** The narrator's grammar line for party lines (one line, as every kind's is). */
export const joinGrammar = () => J.grammar;

/** The command a card's No runs, and the receipt `data` keys the card reads (receipt.data.join). */
export const JOIN_NO = 'rpg.joinNo';
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

/** The characters of the story's party, from a state: `[{ module, name, soul, left, canLeave }]` in block order (the ones who left too). */
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
        out.push({ module, name, soul: Number.isSafeInteger(fields.soul) ? fields.soul : 1, left: fields.left === true, canLeave: Object.hasOwn(definition.state ?? {}, 'left') });
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
export function checkJoin(state, request) {
    const party = partyOf(state);
    const same = party.find(person => fold(person.name) === fold(request.name));
    if (same?.left) return { ok: true, returning: same, soul: same.soul };
    if (same) return { ok: false, why: fill(J.taken, { name: same.name }) };
    if (party.length >= PARTY_MAX) return { ok: false, why: fill(J.full, { max: PARTY_MAX }) };
    if (!hasRoom(state)) return { ok: false, why: fill(J.noRoom, { max: DM_LIMITS.definitions }) };
    return { ok: true, soul: Math.min(request.soul, partyCap(party)) };
}

/** The wizard's draft for a joining companion (the card's Edit first opens it): name, about, class, the best stat raised to 14 (under the Standard formula `rules`: formula.js companionStats). */
export function joinDraft({ name = '', about = '', soul = 1, best = '' } = {}, rules = null) {
    if (isStandard(rules)) {
        // Standard: every stat 5 and the best 9, then the points of each Soul Class above I (formula.js companionStats); the draft's budget is
        // exactly what they cost, so "Edit first" can move points around but is not handed more.
        const stats = companionStats(best, soul, rules), creation = creationOf(rules);
        const spent = STATS.reduce((sum, stat) => sum + stats[stat] - creation.start, 0);
        return readDraft({ name, about, soul, stats, kind: 'companion', skills: [], set: '', creation: { ...creation, budget: spent, max: creation.statMax } });
    }
    const draft = newDraft({ hasYou: true });
    const stats = { ...draft.stats };
    if (STATS.includes(best)) stats[best] = 14;
    return readDraft({ ...draft, name, about, soul, stats, kind: 'companion' });
}

/**
 * The two definitions a joining companion is made of (`used`: the ids of the story's blocks, so the slugs are free). The Character
 * starts with no unspent points: the named stat is raised and the rest left as it was, as the line said.
 */
export const joinDefinitions = (request, { used = [], soul = request.soul, rules = null } = {}) =>
    buildDefinitions(joinDraft({ ...request, soul }, rules), { used, points: 0 });

/**
 * The offers on a reply: the `+ party` lines that asked (Ask), read from the reply's receipts (`entries`: store.receipts() as a
 * query's tools give them, `{ index, receipt }`), minus the ones the reader answered (a `rpg.joinNo` receipt for the name, a
 * `dm.join` for it) and the ones whose name is in the party now. → [{ name, about, soul, best }] in the order written.
 */
export function joinOffers(entries, index, party = []) {
    const list = (Array.isArray(entries) ? entries : []).filter(entry => entry?.index === index && isRecord(entry.receipt?.data?.join));
    const answered = new Set();
    for (const entry of list) if (entry.receipt.data.join.op === 'no' || entry.receipt.data.join.op === 'added') answered.add(fold(entry.receipt.data.join.name));
    const seen = new Set();
    const out = [];
    for (const entry of list) {
        const join = entry.receipt.data.join;
        if (join.op !== 'offer') continue;
        const key = fold(join.name);
        if (!key || seen.has(key) || answered.has(key) || party.some(person => fold(person.name) === key)) continue;
        seen.add(key);
        out.push({ name: oneLine(join.name), about: oneLine(join.about), soul: Number.isSafeInteger(join.soul) ? join.soul : 1, best: STATS.includes(join.best) ? join.best : '' });
    }
    return out;
}

/** The card under the reply for the first offer, in reply-cards.js's shape, or null. */
export function joinCard(offers, state = null) {
    const offer = offers[0];
    if (!offer) return null;
    const naming = soulNaming(state);
    const payload = { name: offer.name, about: offer.about, soul: offer.soul, best: offer.best };
    const rows = [{ icon: 'fa-star', text: fill(J.rowSoul, { label: naming.label, name: CLASS_NAMES[offer.soul - 1] ? naming.word(offer.soul) : naming.word(1) }) }];
    if (offer.best) rows.push({ icon: 'fa-arrow-up', text: fill(J.rowBest, { stat: offer.best.toUpperCase() }) });
    return {
        tone: 'accent', icon: 'fa-user-plus', title: fill(J.title, { name: offer.name }), text: offer.about, rows,
        actions: [
            { id: 'add', label: J.add, icon: 'fa-check', primary: true, command: JOIN_ADD, payload },
            { id: 'edit', label: J.edit, icon: 'fa-pencil', open: 'story-block/new-character', payload },
            { id: 'no', label: J.no, icon: 'fa-xmark', command: JOIN_NO, payload: { name: offer.name } },
        ],
    };
}
