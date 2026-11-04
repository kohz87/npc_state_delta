// The inventory domain's read-only rules (moved out of domains/inventory.js unchanged; inventory.js re-exports every public name): an
// item's text, whether a legendary has been earned, and which party members can wear what in which slot. Pure functions of the
// state they are given.

import { isPlainObject, OWNER_RE, capitalize } from '../common.js';
import { trimText } from '../names.js';
import { nonBlank } from './state.js';

export const itemText = (name, qty) => (qty === 1 ? name : `${name} ×${qty}`);

// Legendary from the story's own words: only when the same reply also completes a quest or wins a fight against a group at least 10
// levels above the party. Whoever knows that (the quests, the fights) answers `story.legendaryEarned` for the reply; nothing answering is no.
export function legendaryEarned(ctx) {
    try { if (ctx.query('story.legendaryEarned', {}) === true) return true; } catch { /* nothing answers */ }
    // The reply's own roll (the RPG, lean-rpg/gear.js earnedLegend): a won fight against a group 10+ levels above the party carries `legend: 1`.
    try { if (ctx.query('rpg.rolls', {})?.result?.legend === 1) return true; } catch { /* no roll this reply */ }
    // Once earned it lasts: any earlier roll of the chat's record with `legend: 1`, or a quest completed (`inventory.legendEarned`, derived from the record).
    try { return ctx.query('inventory.legendEarned', {}) === true; } catch { return false; }
}

/** Whether legendary has been earned in this chat's record up to the reply asking: a roll with `legend: 1` at or before it, or a quest the Director's threads say ended `done`. */
export function legendEarned(tools) {
    const upTo = Number.isInteger(tools?.reply?.index) ? tools.reply.index : Infinity;
    let entries = [];
    try { entries = tools?.receipts?.() ?? []; } catch { entries = []; }
    if (entries.some(entry => entry?.receipt?.type === 'rpg.resolve' && entry.receipt.data?.v2?.result?.legend === 1 && (!Number.isInteger(entry.index) || entry.index <= upTo))) return true;
    try {
        const threads = tools?.query?.('director.threads', { kind: 'quest' });
        return Array.isArray(threads) && threads.some(thread => thread?.kind === 'quest' && thread.ended?.outcome === 'done');
    } catch { return false; }
}

// Slots that hold several pieces, each under its own key (`accessory-1`, `accessory-2`),
// with the count when no module says otherwise. Every other slot holds one piece.
// The counts come from the `items.slots` query ({ accessory, worn }, or
// `accessories`), held to 0…MAX_MANY.
export const MANY_SLOTS = Object.freeze({ accessory: 2, worn: 1 });
export const MAX_MANY = 3;

/** The slot a worn stack's key stands for: `accessory-2` → `accessory`. */
export const baseSlot = key => (typeof key === 'string' ? key.trim().replace(/-\d+$/, '') : null);
const keyNumber = key => Number(/-(\d+)$/.exec(String(key ?? ''))?.[1] ?? 0);

export function asking(query, name, args) {
    try {
        return query(name, args);
    } catch {
        return undefined;
    }
}

/** The slot counts in force: { accessory, worn } from `items.slots`, else MANY_SLOTS. */
export function slotLimits(query) {
    const given = asking(query, 'items.slots', {});
    const pick = name => {
        const n = isPlainObject(given) ? given[name] ?? given[`${name === 'accessory' ? 'accessories' : `${name}s`}`] : undefined;
        return Number.isSafeInteger(n) ? Math.max(0, Math.min(MAX_MANY, n)) : MANY_SLOTS[name];
    };
    return { accessory: pick('accessory'), worn: pick('worn') };
}

// The party's members, in the party module's order: `party.actors` when a module answers it, else the
// `party` domain's actors (its `order` first). → [{ id, name }]
export function membersOf(query, party) {
    const listed = asking(query, 'party.actors', {});
    const raw = Array.isArray(listed)
        ? listed
        : [...(Array.isArray(party?.order) ? party.order : []), ...Object.keys(isPlainObject(party?.actors) ? party.actors : {}).sort()]
            .filter((id, at, all) => all.indexOf(id) === at && isPlainObject(party.actors[id]))
            .map(id => ({ ...party.actors[id], id }));
    const seen = new Set();
    return raw.filter(actor => typeof actor?.id === 'string' && OWNER_RE.test(actor.id) && actor.id !== 'party' && !seen.has(actor.id) && seen.add(actor.id))
        .map(actor => ({ id: actor.id, name: trimText(typeof actor.name === 'string' && actor.name.trim() ? actor.name : actor.id, 60) }));
}

// The main character's id (`party.pc`, else the party domain's `pc`), or null: what the shared bag wears
// is theirs when a party module identifies them.
export function pcOf(query, party) {
    const pc = asking(query, 'party.pc', {});
    const id = typeof pc?.id === 'string' ? pc.id : typeof party?.pc === 'string' ? party.pc : null;
    return id && OWNER_RE.test(id) && id !== 'party' ? id : null;
}

const wearerOf = (stack, pc) => (stack.owner === 'party' ? pc ?? 'party' : stack.owner);

/**
 * Can `actor` wear `def`? Equipment with a slot, a slot this chat's rules count (an accessory when
 * accessories count), and what a module answering `items.canWear({ actor, defId })` says
 * ({ ok: false, message } refuses). → { ok, message }
 */
export function canWear(query, def, actor, limits, who = actor) {
    if (def?.kind !== 'equipment') return { ok: false, message: `${def?.name ?? 'That'} is not equipment; it cannot be worn or wielded.` };
    if (!nonBlank(def.slot)) return { ok: false, message: `${def.name} has no slot to be worn in.` };
    const base = baseSlot(def.slot);
    if (Object.hasOwn(MANY_SLOTS, base) && limits[base] === 0) {
        return { ok: false, message: `In this chat's rules no ${base === 'accessory' ? 'accessories' : 'worn pieces'} count, so ${def.name} cannot be worn.` };
    }
    const said = asking(query, 'items.canWear', { actor, defId: def.id });
    if (isPlainObject(said) && said.ok === false) {
        return { ok: false, message: typeof said.message === 'string' && said.message ? said.message : `${capitalize(who)} cannot wear ${def.name}.` };
    }
    return { ok: true, message: '' };
}
