// The data modules' prompt tail and reply cards (moved out of data-modules/part.js unchanged):
// compact field words, one summary line per block, their tail room, and the cards under the head reply.
import { DM_LIMITS as L, dmHidden, dmNameOf, dmDefaultTone } from '../schema.js';
import { createEvaluation, titlePart } from '../interpreter.js';
import { activeDefinition, inputsOf, instanceOf } from '../adapters.js';
import { cutAt, oneLine } from '../../../text.js';
import { roleTail } from '../../lean-rpg/tail.js';
import { barOf, sizeOf as barSizeOf, spreadWord, wordsOf } from '../../lean-rpg/blocks.js';
import { SKILL_SLOTS_BASE, skillFieldSlots } from '../../skill-slots.js';
import { kept, subjectsOf } from './shared.js';
import { moduleView } from './views.js';

const valueText = value => (typeof value === 'string' ? JSON.stringify(oneLine(value)) : Array.isArray(value) ? `${value.length} ${value.length === 1 ? 'entry' : 'entries'}` : String(value));
// A List of entries in the tail, short: each entry by its number and title and then its choices and numbers ("1 \"Find the key\" active; 2 \"Meet Wren\" done"),
// never its longer texts. The story needs the numbers and titles to name an entry, and what is still open. When the list does not fit `room` (characters), the
// open entries (by the status role's tone: not done or failed) come first, then the finished ones, each newest first; an entry is never cut in the middle, and
// the line ends "+N more". The entries shown keep their numbers and their order.
const entriesText = (definition, key, list, room = L.listTailTokens * 4) => {
    const schema = definition.state[key], parts = Object.entries(schema.of), title = titlePart(definition, key);
    const status = definition.roles?.field === key ? definition.roles.status : null;
    const pieces = list.map((entry, at) => [`${at + 1}`, title ? valueText(entry[title]) : null, ...parts.filter(([part, sub]) => part !== title && sub.type !== 'text').map(([part]) => String(entry[part]))].filter(Boolean).join(' '));
    const open = at => !status || ['active', 'neutral'].includes(definition.tones?.[list[at][status]] ?? dmDefaultTone(list[at][status]));
    // (newest first within each: when entries must go behind "+N more" the oldest are the ones hidden)
    const order = [...list.keys()].filter(open).reverse().concat([...list.keys()].filter(at => !open(at)).reverse());
    const budget = room - `${key}: `.length;
    const shown = [];
    let used = 0;
    for (const at of order) {
        const more = order.length - shown.length - 1 > 0 ? `; +${order.length - shown.length - 1} more`.length : 0;
        if (shown.length && used + pieces[at].length + 2 + more > budget) break;
        shown.push(at);
        used += pieces[at].length + 2;
    }
    const hidden = list.length - shown.length;
    return `${key}: ${shown.length ? `${shown.sort((a, b) => a - b).map(at => pieces[at]).join('; ')}${hidden ? `; +${hidden} more` : ''}` : 'none'}`;
};
// A number whose field has display names is shown (to a person and to the story) by its name; stored, it stays the number.
// The Standard formula's bars (a field with `blocks`) have no fixed names: their stage word depends on the bar's size, which `at` ({ fields, key }, the
// block's fields as they were then) gives; without it the number shows, as for any number.
const barText = (schema, value, at) => {
    const size = barSizeOf(schema, at.fields, at.key);
    return Number.isSafeInteger(value) ? spreadWord(wordsOf(barOf(schema)), Math.min(size, Math.max(0, value)), size) : valueText(value);
};
const shownText = (schema, value, at = null) => dmNameOf(schema, value) ?? (at && barOf(schema) ? barText(schema, value, at) : valueText(value));
// A hidden field (`prompt: false`) is left out: the story is never told it.
const fieldText = (definition, key, value, room) => (Array.isArray(value) ? entriesText(definition, key, value, room) : value !== null && typeof value === 'object'
    ? `${key}: ${Object.entries(value).map(([name, item]) => `${name} ${valueText(item)}`).join(', ')}` : `${key} ${shownText(definition.state[key], value)}`);
// (`room`: the characters the line may take; a List of entries takes what the other fields leave)
const fieldsText = (definition, fields, room = Infinity) => {
    const shown = Object.entries(fields).filter(([key]) => !dmHidden(definition.state[key]));
    const lists = shown.filter(([, value]) => Array.isArray(value)).length;
    const left = lists ? (room - shown.filter(([, value]) => !Array.isArray(value)).reduce((sum, [key, value]) => sum + fieldText(definition, key, value).length + 2, 0)) / lists : 0;
    return shown.map(([key, value]) => fieldText(definition, key, value, lists ? Math.max(0, Math.floor(left)) : undefined)).join('; ');
};
// The named fields a root changed, for its summary: "Soul Class II → III". Empty for a block with no display names.
const namedChanges = (definition, before, after) => Object.entries(definition.state).filter(([key, schema]) => (schema.names || barOf(schema)) && before[key] !== after[key])
    .map(([key, schema]) => `${schema.label ?? key} ${shownText(schema, before[key], { fields: before, key })} → ${shownText(schema, after[key], { fields: after, key })}`);

// What a module may take of the prompt's tail: 100 tokens, 300 for a block with a `role` (the RPG's sheets carry text the story reads).
// `rpg` is whether the RPG feature is on: a block with a role is the RPG's to write only then; with it off the block is told like any other.
// A Skills block may say 47 tokens more for each skill it holds past five (the longest line one skill makes: a 40-character name and 120 of text, measured at 188
// characters); a slot that holds no skill reserves nothing. `fields` is the block's fields (none: nothing is held).
export const tailRoom = (definition, rpg = true, fields = null) => {
    if (!(rpg && definition?.role)) return Object.values(definition?.state ?? {}).some(schema => schema?.type === 'entries') ? L.listTailTokens : L.tailTokens;
    const held = definition.role === 'skills' && fields ? Array.from({ length: skillFieldSlots(fields) }, (_, i) => fields[`skill${i + 1}`]).filter(name => typeof name === 'string' && name.trim()).length : 0;
    return L.roleTailTokens + L.skillTailTokens * Math.max(0, held - SKILL_SLOTS_BASE);
};

/**
 * One module's state in plain words for the prompt's tail, at most 100 tokens (300 for a block with a role, written compact): "Survival — Wessel: hunger 12; fatigue 6."
 * `rpg` (default on) is the RPG feature: with it off a block with a role gets the ordinary line, which leaves out its hidden fields as well.
 */
export function summaryOf(state, module, { rpg = true } = {}) {
    const definition = activeDefinition(state, module);
    if (!definition) return `${module} — unavailable (damaged or unknown pin).`;
    const view = moduleView(state, { module });
    let waiting = '';
    try { const inputs = inputsOf(state, definition); if (definition.timers.some(timer => inputs[timer.clock]?.minutes == null)) waiting = ' Waiting for story time.'; } catch { waiting = ' Waiting.'; }
    // A block with a role is written compact (lean-rpg/tail.js): defaults and empty slots left out, one line per skill; nothing to say, no line.
    if (rpg && definition.role) {
        const people = definition.scope === 'chat' ? [{ name: definition.name, fields: view.chat }] : view.characters.map(({ id, name, ...fields }) => ({ name, fields }));
        const line = roleTail(definition, people, { hidden: key => dmHidden(definition.state[key]), text: (key, value) => fieldText(definition, key, value),
            named: (key, value) => shownText(definition.state[key], value) });
        return line && cutAt(`${line}${waiting}`, tailRoom(definition, rpg, view.chat) * 4);
    }
    const limit = tailRoom(definition, rpg) * 4;
    const room = limit - definition.name.length - 4 - waiting.length;
    const body = definition.scope === 'chat' ? fieldsText(definition, view.chat, room)
        : view.characters.map(({ id, name, ...fields }) => `${name}: ${fieldsText(definition, fields, Math.floor(room / view.characters.length) - name.length - 2)}`).join(' | ') || 'no one attached';
    // The host estimates tokens from UTF-16 length; cut on a character boundary within that budget.
    return cutAt(`${definition.name} — ${body}.${waiting}`, limit);
};
const tailLines = (state, rpg) => Object.keys(state?.domains?.dataModules?.active ?? {}).map(module => summaryOf(state, module, { rpg }));

// --- Cards under the head reply -------------------------------------------------------------------------------------------------
// A block's `cards` are derived from the head reply's state each time the cards are asked for, never stored. They reach the reply-cards
// socket (src/v2/reply-cards.js) through a few fixed slots, because that socket takes one named card per entry: slot n answers with the
// nth card of the active blocks, in pin order and, within a block, in the order written. A card with a button runs that Button of the
// same block as a reader command on the latest reply.
export const CARD_SLOTS = 8;
const CARD_LOOK = Object.freeze({ info: { tone: 'info', icon: 'ph-info' }, warn: { tone: 'accent', icon: 'ph-warning' }, end: { tone: 'bad', icon: 'ph-skull' } });
const cardLists = new WeakMap();

const CARD_RANK = Object.freeze({ end: 1, warn: 2, info: 3 });

/**
 * The cards the head state shows: [{ module, card }] with card in reply-cards.js's shape. A card whose condition cannot be asked is left out.
 * They are ordered the end cards of a role `character` block first (the death notice), then any other end card, then warn, then info (pin
 * order, then written order, within each) before the slots are filled, so a death notice always has a slot, however many other cards show.
 */
export function blockCards(state) {
    const active = state?.domains?.dataModules?.active;
    if (!active || !Object.keys(active).length) return [];
    return kept(cardLists, state, () => Object.keys(active).flatMap(module => {
        const definition = activeDefinition(state, module), instance = instanceOf(state, module);
        if (!definition?.cards?.length || !instance) return [];
        return definition.cards.flatMap((entry, at) => {
            try {
                if (!createEvaluation(definition, instance).condition(['card', at], entry.when, {})) return [];
            } catch { return []; }
            const look = CARD_LOOK[entry.tone] ?? CARD_LOOK.info, kind = entry.button ? definition.kinds[entry.button] : null;
            return [{ module, rank: entry.tone === 'end' && definition.role === 'character' ? 0 : CARD_RANK[entry.tone] ?? CARD_RANK.info, card: { ...look, title: entry.title, text: entry.text,
                actions: kind ? [{ id: entry.button, label: oneLine(kind.title ?? entry.button.replace(/^button-/, '')), primary: true,
                    command: 'dm.act', payload: { module, kind: entry.button } }] : [] } }];
        });
    }).sort((a, b) => a.rank - b.rank).map(({ module, card }) => ({ module, card })));
};
const blockCardSlots = Object.fromEntries(Array.from({ length: CARD_SLOTS }, (_, at) => [`block-card-${at + 1}`, { for: state => blockCards(state)[at]?.card ?? null }]));

export { valueText, entriesText, barText, shownText, fieldText, fieldsText, namedChanges, tailLines, blockCardSlots };
