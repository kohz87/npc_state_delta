// The inventory domain's story capture (moved out of domains/inventory.js unchanged; inventory.js re-exports every public name): the
// `- item` / `+ item` / `~ item` lines, the `+ coin` / `- coin` lines, a used consumable, and the money a line pays or receives.

import { labelOf, isPlainObject, clone } from '../common.js';
import { cleanName, trimText, aliasKey } from '../names.js';
import { isCurrencyName, countedMoney, coinValue, parseAmount } from '../money.js';
import { GEAR, slotWordOf, placeOf } from '../gear.js';
import { featureOn, FEATURE, MAX_NOTE, gearOn, MAX_NAME } from './state.js';
import { itemText, baseSlot } from './validate.js';
import {
    currencyIn, defineByName, grantInto, knownDef, unbound, stacksOf, shortOf, takeAcross, refuseBound, boundId,
    receive, pay,
} from './stacks.js';
import { storyWear, storyRepair } from './wear.js';
import { carryFits, lineQty, storyItems, storyCoin } from './lines.js';

// What the story gives past the carry limit (`story-block.encumbrance`): kept, and the party is
// encumbered (derived from the load: inventory.encumbrance), so `true` comes back; with the feature
// off the line is refused with the module's reason, as F39 has it. No module answering: no limit.
function storyCarry(ctx, def, qty, owner) {
    const fits = carryFits(ctx, [{ defId: def.id, qty }], owner);
    if (!fits || fits.ok) return false;
    if (!featureOn(ctx, FEATURE.encumbrance)) ctx.fail('REFUSED', fits.message);
    return true;
}

const ENCUMBERED_NOTE = ' The party now carries more than it can and is encumbered until something is put down.';

// A consumable the story says was used (MODULES §F96): `- item Potion | used: yes`, or a used-word in
// the line or the reply, and no word that says it went another way.
export const USED_WORDS = /\b(?:used|uses|drank|drinks|drunk|ate|eats|eaten|applied|applies|quaffed|swallowed|consumed)\b/i;
export const GONE_WORDS = /\b(?:lost|loses|sold|sells|gave|given|gives|dropped|stolen|traded|handed|broke|broken|spilled|spilt)\b/i;

/** Whether a `- item` line says the thing was used (not lost, sold, given…): see USED_WORDS. */
export function usedByLine(line, replyText = '') {
    const labels = Object.entries(line?.labels ?? {}).map(([name, value]) => `${name} ${value}`).join(' ');
    const own = `${line?.text ?? ''} ${labels}`;
    if (GONE_WORDS.test(own)) return false;
    if (/^(?:yes|true|1)$/i.test(String(line?.labels?.used ?? '').trim())) return true;
    return USED_WORDS.test(own) || USED_WORDS.test(String(replyText ?? ''));
}

// A used consumable goes to the module that answers `item.use` (its effect is that module's rules):
// `item.use { name, on, qty, story: true }`. Null when no module answers it (the line then takes the
// thing away, as before); a refusal there refuses the line, so the thing stays.
function useInStory(ctx, line, def, qty) {
    const on = labelOf(line, 'on', 'who', 'by');
    let out;
    try {
        out = ctx.call('item.use', { name: def.name, ...(on ? { on } : {}), qty, story: true });
    } catch (error) {
        if (error?.code === 'UNKNOWN_COMMAND' && String(error.message).includes('"item.use"')) return null;
        throw error;
    }
    const data = isPlainObject(out?.data) ? out.data : {};
    return {
        summary: typeof out?.summary === 'string' && out.summary ? out.summary : `${itemText(def.name, qty)} used.`,
        data: { ...clone(data), def: def.id, qty, used: true },
        narrate: typeof out?.narrate === 'boolean' ? out.narrate : false,
    };
}

// The stats a line names (`| DEX: +2 | STR: 1`): { DEX: 2, STR: 1 } for the whole numbers above 0; gearDefine holds them to the rarity's budget.
function statWords(line) {
    const out = {};
    for (const stat of GEAR.stats) {
        const written = labelOf(line, stat.toLowerCase());
        const n = written === null ? NaN : Number(/^\s*\+?(\d{1,3})\s*$/.exec(written)?.[1]);
        if (Number.isSafeInteger(n) && n > 0) out[stat] = n;
    }
    return out;
}

// With gear on, a gained item's `equipped: <slot>` puts it on: the slot is the word's (weapon, body, off-hand, head, cloak, feet, accessory),
// one item per slot per owner, so what was in it is put away. Equipment only; a word that is no slot, or one the item does not fit, is passed over.
// (the story's gains go to the party's bag, where nothing is bound: a bound piece is a member's, so it is never the one put away here)
function equipFromLine(inv, def, stackIds, word) {
    if (word === null || def.kind !== 'equipment' || !stackIds?.length) return null;
    const named = slotWordOf(word);
    const own = slotWordOf(def.slot);
    if (!named || (own && baseSlot(named) !== baseSlot(own))) return null;
    const id = [...stackIds].reverse().find(sid => inv.stacks[sid] && inv.stacks[sid].equipped === null);
    if (!id) return null;
    const stack = inv.stacks[id];
    let where = placeOf(named);
    if (named === 'accessory') {
        const taken = key => Object.values(inv.stacks).some(other => other.owner === stack.owner && other.id !== stack.id && other.equipped === key);
        where = ['accessory-1', 'accessory-2'].find(key => !taken(key)) ?? 'accessory-1';
    }
    const occupant = Object.values(inv.stacks).find(other => other.id !== stack.id && other.owner === stack.owner && other.equipped === where);
    if (occupant) occupant.equipped = null;
    stack.equipped = where;
    return `${def.name} is equipped (${where}).`;
}

/** `+ item Name | qty | note`, `- item Name | qty`, `~ item Name | note | qty | name` (a rename). */
export function captureItem(ctx, line, env) {
    const inv = ctx.draft('inventory');
    const name = cleanName(line?.name);
    if (!name) ctx.fail('INVALID', 'An item line needs the item\'s name.');
    const text = String(line.text ?? '').trim();
    // An "item" named as money (the currency, a coin, "Silver Coins", "3 silver coins") goes to the
    // wallet, as the coin and loot lines read the same words (B-a1-7).
    const currency = currencyIn(ctx);
    if (isCurrencyName(name, currency) || countedMoney(name, currency)) return itemAsCoin(ctx, line, env, currency);
    if (line.op === '+') {
        const qty = lineQty(ctx, line, 1);
        if (qty < 1) ctx.fail('INVALID', 'A gained item needs a quantity of at least 1.');
        const note = trimText(labelOf(line, 'note') ?? text, MAX_NOTE);
        const { def, created } = defineByName(ctx, inv, name, env, { note, owner: 'party', words: { kind: labelOf(line, 'kind'), slot: labelOf(line, 'slot') ?? labelOf(line, 'equipped', 'equip', 'worn'), rarity: labelOf(line, 'rarity', 'quality'), stats: statWords(line) } });
        const held = storyItems(def, qty);
        // Asked before the stacks change: `add` is weight on top of what is carried now.
        const heavy = storyCarry(ctx, def, held.qty, 'party');
        // Given by a story line: the story's own whatever its def (B-a2-2), for what it sells for.
        const stacks = grantInto(ctx, inv, def, held.qty, 'party', note, false, true);
        const worn = gearOn(ctx) ? equipFromLine(inv, def, stacks, labelOf(line, 'equipped', 'equip', 'worn')) : null;
        return {
            summary: `The party gains ${itemText(def.name, held.qty)}.${worn ? ` ${worn}` : ''}${heavy ? ENCUMBERED_NOTE : ''}`,
            data: { def: def.id, qty: held.qty, owner: 'party', stacks, created, from: labelOf(line, 'from') ?? '', ...(heavy ? { encumbered: true } : {}) },
            narrate: false,
            ...(held.problem ? { problem: held.problem } : {}),
        };
    }
    if (line.op === '-') {
        const def = knownDef(ctx, inv, name);
        const qty = lineQty(ctx, line, 1);
        if (qty < 1) ctx.fail('INVALID', 'A lost item needs a quantity of at least 1.');
        if (def.kind === 'consumable' && usedByLine(line, ctx.chat?.reply)) {
            const used = useInStory(ctx, line, def, qty);
            if (used) return used;
        }
        const held = unbound(ctx, inv, stacksOf(inv, def.id));
        const have = held.reduce((sum, stack) => sum + stack.qty, 0);
        if (!have) ctx.fail('NOT_FOUND', `There is no ${def.name} in the inventory.`);
        if (have < qty) ctx.fail('NOT_ENOUGH', shortOf(def.name, have));
        takeAcross(inv, held, qty);
        return {
            summary: `Lost ${itemText(def.name, qty)} (${have - qty} left).`,
            data: { def: def.id, qty, left: have - qty },
            narrate: false,
        };
    }
    if (line.op === '~') {
        const def = knownDef(ctx, inv, name);
        const changes = [];
        const worn = labelOf(line, 'wear');
        if (worn !== null) changes.push(storyWear(ctx, inv, def, worn, trimText(text, MAX_NOTE)).replace(/\.$/, ''));
        // With gear on, the story's repair word mends a piece (one condition word up) or restores it (back to Good).
        const mended = gearOn(ctx) ? labelOf(line, 'repair', 'repaired', 'mend') : null;
        if (mended !== null) changes.push(storyRepair(ctx, inv, def, mended).replace(/\.$/, ''));
        const rename = labelOf(line, 'name', 'rename');
        if (rename !== null && cleanName(rename) && cleanName(rename) !== def.name) {
            const lots = stacksOf(inv, def.id);
            if (lots.length) refuseBound(ctx, inv, lots.find(lot => boundId(ctx, lot)) ?? lots[0]);
            const next = cleanName(rename);
            const key = aliasKey(next);
            const taken = (inv.aliases[key] && inv.aliases[key] !== def.id)
                || Object.values(inv.defs).some(other => other.id !== def.id && aliasKey(other.name) === key);
            if (taken) ctx.fail('REFUSED', `"${next}" is already the name of another item.`);
            if (next.length > MAX_NAME) ctx.fail('INVALID', `An item needs a name of 1 to ${MAX_NAME} characters.`);
            const old = def.name;
            inv.aliases[aliasKey(old)] ??= def.id;
            inv.aliases[key] = def.id;
            def.name = next;
            changes.push(`${old} is now called ${next}`);
        }
        // With a wear label the text says how it happened, not a new note.
        const note = labelOf(line, 'note') ?? (worn === null && mended === null ? text || null : null);
        const qty = labelOf(line, 'qty', 'quantity', 'count') === null ? null : lineQty(ctx, line, null);
        let problem = null;
        let heavy = false;
        if (note !== null || qty !== null) {
            const held = stacksOf(inv, def.id);
            if (!held.length) ctx.fail('NOT_FOUND', `There is no ${def.name} in the inventory.`);
            if (held.length > 1) ctx.fail('INVALID', `There are several lots of ${def.name}; the line cannot say which one changed.`);
            const stack = held[0];
            if (qty !== null) refuseBound(ctx, inv, stack);
            if (note !== null) {
                stack.note = trimText(note, MAX_NOTE);
                changes.push(`${def.name}: ${stack.note || 'note cleared'}`);
            }
            if (qty !== null) {
                if (qty > 1 && !def.stack) ctx.fail('REFUSED', `${def.name} does not stack.`);
                if (qty === 0) delete inv.stacks[stack.id];
                else if (qty > stack.qty) {
                    // A raised count is a gain (r2-1): held to the carry limit.
                    const held = storyItems(def, qty - stack.qty, true);
                    // Asked before the count moves: `add` is weight on top of what is carried now.
                    if (storyCarry(ctx, def, held.qty, stack.owner)) heavy = true;
                    stack.qty += held.qty;
                    problem = held.problem;
                } else stack.qty = qty;
                changes.push(`${def.name} now ${qty === 0 ? 0 : stack.qty}`);
            }
        }
        if (!changes.length) ctx.fail('INVALID', `The line changes nothing about ${def.name}.`);
        return {
            summary: `${changes.join('; ')}.${heavy ? ENCUMBERED_NOTE : ''}`,
            data: { def: def.id, ...(heavy ? { encumbered: true } : {}) },
            narrate: false,
            ...(problem ? { problem } : {}),
        };
    }
    return ctx.fail('INVALID', `"${line.op} item" is not a change the inventory understands; use +, - or ~.`);
}

// `+ item Marks | qty: 44`, `- item mark`: the party's wallet, as `+ coin 44` / `- coin 1` would.
function itemAsCoin(ctx, line, env, currency) {
    if (line.op !== '+' && line.op !== '-') {
        ctx.fail('INVALID', `${currency.plural} are money, not an item; write + coin or - coin with the amount.`);
    }
    const count = lineQty(ctx, line, 1);
    if (count < 1) ctx.fail('INVALID', 'An amount of money must be more than nothing.');
    // `+ item Silver | qty: 3` is 3 silver: counted in the smallest unit (money.js coinValue); `+ item 3
    // silver coins` too (the number in the name times the quantity).
    const counted = countedMoney(cleanName(line?.name), currency);
    const amount = counted ? count * counted.count * counted.value : count * Math.max(1, coinValue(cleanName(line?.name), currency));
    if (!Number.isSafeInteger(amount)) ctx.fail('INVALID', 'That amount is too large.');
    const who = labelOf(line, line.op === '+' ? 'from' : 'to');
    const note = who ? `${line.op === '+' ? 'from' : 'to'} ${trimText(who, 80)}` : '';
    return line.op === '+'
        ? receiveStory(ctx, env, { owner: 'party', amount, note })
        : payStory(ctx, env, { owner: 'party', amount, note });
}

// A story line's money, counted for the reply (storyCoin); `vouched` for a module's payout
// that the story alone vouched for (wallet.receive { story: true }).
export function receiveStory(ctx, env, { owner, amount, note }, vouched = false) {
    storyCoin(ctx, ctx.draft('inventory'), amount, vouched);
    return receive(ctx, env, { owner, amount, note });
}

// A story payment can spend up to what the wallet holds.
function payStory(ctx, env, { owner, amount, note }) {
    return pay(ctx, env, { owner, amount, note });
}

/** `+ coin 30 | from: who`, `- coin 5 | to: who`: the party's wallet; only the number counts. */
export function captureCoin(ctx, line, env) {
    const written = labelOf(line, 'amount') ?? String(line?.name ?? '');
    if (line?.op !== '+' && line?.op !== '-') {
        ctx.fail('INVALID', `"${line?.op} coin" is not a change the wallet understands; use + coin or - coin.`);
    }
    // With coins, "3 silver" is read in the smallest unit here, before it is counted for the reply.
    const parsed = parseAmount(written, currencyIn(ctx));
    if (parsed.error) ctx.fail('INVALID', parsed.error);
    const who = labelOf(line, line.op === '+' ? 'from' : 'to');
    const note = who ? `${line.op === '+' ? 'from' : 'to'} ${trimText(who, 80)}` : '';
    return line.op === '+'
        ? receiveStory(ctx, env, { owner: 'party', amount: parsed.amount, note })
        : payStory(ctx, env, { owner: 'party', amount: parsed.amount, note });
}
