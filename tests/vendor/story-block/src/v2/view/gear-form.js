// The hand-set gear form (Gear in fights on): the fields and the commands of "+ Add item" and of the Edit of a piece the reader added, as plain data
// so both are tested without a page (as hero-edit.js does for the hero). The fields are those of `ss.editable` kind `fields`; the plans are its
// `plan(changed, all)`.
//
// Two groups: "Item" (Name, Count, Kind, Note) and, only while Kind is Equipment, "Gear" (Slot, Rarity, Bonus up to 2 stats with the live "N of M points" line,
// Equip on / Equipped by). The starting kit (`kit`: the chat has no message from the reader yet) offers Rarity and Bonus; after it Rarity is Common (disabled) and
// Bonus is left out of Add, and read-only in Edit. The commands enforce the same rules (inventory.js `handEdit`, `inventory.add`): this form only asks.

import { STRINGS } from '../strings.js';
import { cutAt } from '../../text.js';
import { GEAR } from '../domains/gear.js';

const F = STRINGS.inventory.gear.form;
const G = STRINGS.inventory.gear;
const E = STRINGS.editMessages;
const N = STRINGS.inventory;

/** The kinds the form offers, in the inventory's own words. */
export const FORM_KINDS = Object.freeze(['equipment', 'consumable', 'goods', 'quest', 'material']);
export const NAME_MAX = 60;
const NOTE_MAX = 300;

const short = (value, max) => cutAt(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
const kindOptions = () => FORM_KINDS.map(value => ({ value, label: F.kinds[value] }));
const rarityOptions = () => Object.keys(GEAR.budget).map(value => ({ value, label: N.rarities[value] }));
const slotOptions = () => [{ value: '', label: G.none }, ...Object.entries(G.slots).map(([value, label]) => ({ value, label }))];
const statOptions = () => [{ value: '', label: F.noStat }, ...GEAR.stats.map(value => ({ value, label: value }))];
// (the first owner is the main character: "Astra (you)")
const wearerOptions = owners => [{ value: '', label: G.none }, ...(Array.isArray(owners) ? owners : []).map((entry, at) => ({ value: String(entry?.value ?? ''), label: `${String(entry?.label ?? '')}${at === 0 && entry?.label && !/\(you\)/.test(String(entry.label)) ? ` ${F.you}` : ''}` }))];
const SHOWN = Object.freeze({ key: 'kind', in: Object.freeze(['equipment']) });

// The Bonus lines (two), their stat and points boxes, and (when they can be changed) the live points line after them.
function bonusFields(stats, locked) {
    const listed = Object.entries(stats && typeof stats === 'object' ? stats : {}).slice(0, GEAR.maxStats);
    const out = [];
    for (const at of [1, 2]) {
        const one = listed[at - 1];
        const extra = locked ? { disabled: true, title: F.laterTitle } : {};
        out.push({ key: `stat${at}`, label: at === 1 ? F.bonus : F.stat, ...(at === 1 ? {} : { hideLabel: true }), type: 'choice', options: statOptions(), value: one?.[0] ?? '', group: F.groupGear, row: `bonus${at}`, showWhen: SHOWN, ...extra });
        out.push({ key: `points${at}`, label: F.amount, hideLabel: true, type: 'number', min: 1, max: 6, soft: true, value: one?.[1] ?? '', group: F.groupGear, row: `bonus${at}`, showWhen: SHOWN, ...extra });
    }
    if (!locked) {
        out.push({ key: 'budget', type: 'points', group: F.groupGear, showWhen: SHOWN, rarity: 'rarity', lines: [['stat1', 'points1'], ['stat2', 'points2']],
            budget: { ...GEAR.budget }, words: { ...N.rarities }, text: F.points, none: F.pointsNone });
    }
    return out;
}

/** The fields of "+ Add item". `kit`: the starting kit is open; `owners`: who can wear it, [{ value, label }]. */
export function addFields({ kit = false, owners = [] } = {}) {
    const fields = [
        { key: 'name', label: F.name, type: 'text', value: '', maxLength: NAME_MAX, group: F.groupItem },
        { key: 'count', label: F.count, type: 'number', min: 1, value: 1, group: F.groupItem, row: 'ck' },
        { key: 'kind', label: F.kind, type: 'choice', options: kindOptions(), value: 'goods', group: F.groupItem, row: 'ck' },
        { key: 'note', label: F.note, type: 'text', value: '', maxLength: NOTE_MAX, group: F.groupItem },
        { key: 'slot', label: F.slot, type: 'choice', options: slotOptions(), value: '', group: F.groupGear, row: 'sr', showWhen: SHOWN },
        { key: 'rarity', label: F.rarity, tone: true, type: 'choice', options: rarityOptions(), value: 'common', group: F.groupGear, row: 'sr', showWhen: SHOWN, ...(kit ? {} : { disabled: true, title: F.laterTitle }) },
        ...(kit ? bonusFields({}, false) : []),
        { key: 'equip', label: F.equipOn, type: 'choice', options: wearerOptions(owners), value: '', group: F.groupGear, showWhen: SHOWN },
        ...(kit ? [] : [{ key: 'later', type: 'note', text: F.laterHint, group: F.groupGear, showWhen: SHOWN }, { key: 'copy', type: 'note', text: F.copyHint, group: F.groupGear, showWhen: SHOWN }]),
    ];
    return fields;
}

// The stats the two Bonus lines name, { STR: 1 }: a line with a stat needs its points (a whole number of at least 1); a line with points only is no line.
function statsOf(all) {
    const stats = {};
    for (const [stat, points] of [['stat1', 'points1'], ['stat2', 'points2']]) {
        const name = String(all[stat] ?? '');
        if (!name) continue;
        const n = all[points];
        if (!Number.isSafeInteger(n) || n < 1) return { error: E.kitStats.replace('{max}', String(GEAR.maxStats)) };
        stats[name] = (stats[name] ?? 0) + n;
    }
    return { stats };
}

/** The `plan` of "+ Add item": one `inventory.add` (and, when asked, the putting on inside it, so a refusal leaves nothing half done). */
export function addPlan({ kit = false } = {}) {
    return (_changed, all) => {
        const name = short(all.name, NAME_MAX);
        if (!name) return { error: E.itemName };
        const qty = all.count;
        if (!Number.isSafeInteger(qty) || qty < 1) return { error: N.countError };
        const payload = { name, qty, kind: all.kind };
        const note = short(all.note, NOTE_MAX);
        if (note) payload.note = note;
        if (all.kind === 'equipment') {
            if (all.slot) payload.slot = all.slot;
            if (kit) {
                const read = statsOf(all);
                if (read.error) return { error: read.error };
                if (all.rarity && all.rarity !== 'common') payload.rarity = all.rarity;
                if (Object.keys(read.stats).length) payload.stats = read.stats;
            }
            if (all.equip) payload.equip = all.equip;
        }
        return { steps: [{ command: 'inventory.add', payload, keys: Object.keys(all) }] };
    };
}

/**
 * The fields of the Edit of a piece the reader added, from the item widget's props `p` (`value` the name, `itemCount`, `itemNote`, `gear`: `{ kind, rarity, stack,
 * owner, by, place, row: { defSlot, stats }, kit, owners }`).
 */
export function editFields(p) {
    const gear = p?.gear ?? {};
    const row = gear.row ?? {};
    const kit = gear.kit === true;
    const equipment = gear.kind === 'equipment';
    const fields = [
        { key: 'name', label: F.name, type: 'text', value: String(p?.value ?? ''), maxLength: 120, group: F.groupItem },
        { key: 'count', label: F.count, type: 'number', min: 1, value: Number(p?.itemCount ?? 1), group: F.groupItem, row: 'ck' },
        { key: 'kind', label: F.kind, type: 'choice', options: kindOptions(), value: gear.kind ?? 'goods', group: F.groupItem, row: 'ck' },
        { key: 'note', label: F.note, type: 'text', value: String(p?.itemNote ?? ''), maxLength: NOTE_MAX, group: F.groupItem },
        // (only the reader sets it; the story never does)
        { key: 'carry', label: F.carry, type: 'number', min: 0, max: 500, value: Number.isSafeInteger(row.carry) ? row.carry : 0, group: F.groupItem },
        { key: 'carryHelp', type: 'note', text: F.carryHelp, group: F.groupItem },
        { key: 'slot', label: F.slot, type: 'choice', options: slotOptions(), value: String(row.defSlot ?? ''), group: F.groupGear, row: 'sr', showWhen: SHOWN },
        { key: 'rarity', label: F.rarity, tone: true, type: 'choice', options: rarityOptions(), value: equipment || kit ? String(gear.rarity ?? 'common') : 'common', group: F.groupGear, row: 'sr', showWhen: SHOWN,
            ...(kit ? {} : { disabled: true, title: F.laterTitle }) },
        ...bonusFields(equipment ? row.stats : {}, !kit),
        { key: 'by', label: F.equippedBy, type: 'choice', options: wearerOptions(gear.owners), value: String(gear.by ?? ''), group: F.groupGear, showWhen: SHOWN },
        ...(kit ? [] : [{ key: 'later', type: 'note', text: F.laterHint, group: F.groupGear, showWhen: SHOWN }]),
    ];
    return fields;
}

/** The `plan` of that Edit: `inventory.edit` for what changed (name, count, note, kind, slot, rarity, bonus), then who wears it (`item.equip` / `inventory.unequip`). */
export function editPlan(p) {
    const gear = p?.gear ?? {};
    return (changed, all) => {
        const stack = gear.stack;
        const payload = { stack, group: true };
        const name = short(all.name, 120);
        if (changed.name !== undefined) { if (!name) return { error: E.itemName }; if (name !== p.value) payload.name = name; }
        if (changed.count !== undefined) {
            if (!Number.isSafeInteger(all.count) || all.count < 1) return { error: N.countError };
            if (all.count !== p.itemCount) payload.qty = all.count;
        }
        if (changed.note !== undefined) payload.note = short(all.note, NOTE_MAX);
        const touched = ['kind', 'slot', 'rarity', 'stat1', 'points1', 'stat2', 'points2'].some(key => changed[key] !== undefined);
        if (touched) {
            if (changed.kind !== undefined) payload.kind = all.kind;
            if (all.kind === 'equipment') {
                if (changed.slot !== undefined) payload.slot = all.slot;
                // (Goods made Equipment while the kit is open saves the Rarity the form shows, touched or not; later it is Common, which the form shows too)
                if (changed.rarity !== undefined || (changed.kind !== undefined && gear.kit === true)) payload.rarity = all.rarity;
                if (['stat1', 'points1', 'stat2', 'points2'].some(key => changed[key] !== undefined)) {
                    const read = statsOf(all);
                    if (read.error) return { error: read.error };
                    payload.stats = read.stats;
                }
            }
        }
        const steps = [];
        if (changed.carry !== undefined) {
            if (!Number.isSafeInteger(all.carry) || all.carry < 0 || all.carry > 500) return { error: E.carryRange.replace('{max}', '500') };
            steps.push({ command: 'inventory.carry', payload: { stack, carry: all.carry }, keys: ['carry'] });
        }
        if (Object.keys(payload).length > 2) steps.push({ command: 'inventory.edit', payload, keys: ['name', 'count', 'note', 'kind', 'slot', 'rarity', 'stat1', 'points1', 'stat2', 'points2'] });
        // Who wears it: only for equipment; leaving Equipment takes it off inside the edit itself.
        if (all.kind === 'equipment') {
            const placed = String(gear.place ?? ''), wearer = String(gear.by ?? '');
            const by = String(all.by ?? ''), slot = String(all.slot ?? '');
            if (!by || !slot) {
                if (by === '' && placed && changed.by !== undefined) steps.push({ command: 'inventory.unequip', payload: { stack }, keys: ['by'] });
            } else if (!(placed === slot && wearer === by) && (changed.by !== undefined || changed.slot !== undefined || changed.kind !== undefined)) {
                steps.push({ command: 'item.equip', payload: { stack, owner: by, slot, ...(by !== gear.owner ? { transfer: true } : {}) }, keys: ['by'] });
            }
        }
        return { steps };
    };
}
