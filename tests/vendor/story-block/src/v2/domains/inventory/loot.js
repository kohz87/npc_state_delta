// The inventory domain's loot offers (moved out of domains/inventory.js unchanged; inventory.js re-exports every public name): the
// offer's shape check, reading and capturing a `? loot` line, taking from an offer and the guard of the loot blocks.

import { isPlainObject, clone } from '../common.js';
import { cleanName, resolveDef, aliasKey, trimText } from '../names.js';
import { isCurrencyName, coinValue, formatAmount } from '../money.js';
import { nonBlank, MAX_NAME, isCount, featureOn, FEATURE, MAX_UNSTACKED } from './state.js';
import { itemText } from './validate.js';
import { currencyIn, defineByName, grantInto, receive, told } from './stacks.js';
import { joinNames } from './wear.js';
import { lineQty, storyCoin, storyItems, readerCarry } from './lines.js';

// `? loot Rusty Key, Lantern Oil x2, Torn Map — on the cellar shelf | qty: 1`: what lies there, offered
// on the reply's card as chips; the reader takes the ones they want (inventory.lootTake). The offer is
// read as a `+ item` line would be, so the chips show what can be taken; things the party already carries (tolerant
// names) are left out. One offer per reply, keyed by the reply's record ID (`loot[<sid>]`, scratch like
// perReply); a second loot line in the reply adds to it. A reply keeps the LOOT_KEEP newest offers.
export const LOOT_ITEMS = 8;
export const LOOT_KEEP = 5;
// The guards of the loot blocks (Story Block's own, asked through the core module's replayGuard): a take's (lootTakeGuard),
// and the offer's, reply-bound, so it holds while its reply is in the chat (asked, it only checks its own shape).
export const LOOT_GUARD = 'loot.take';
export const LOOT_OFFER = 'loot.offer';
export const LOOT_KINDS = Object.freeze([LOOT_OFFER, LOOT_GUARD]);
const LOOT_OWNER = 'story-block';
const MAX_WHERE = 120;

export function lootErrors(loot) {
    if (!isPlainObject(loot)) return ['The loot on offer is not a record.'];
    const errors = [];
    for (const [key, offer] of Object.entries(loot)) {
        if (!isPlainObject(offer)) {
            errors.push(`The loot of reply ${key} is not a record.`);
            continue;
        }
        if (offer.sid !== key) errors.push(`The loot of reply ${key} is filed under the wrong reply.`);
        if (typeof offer.where !== 'string' || typeof offer.claim !== 'string' || !Number.isSafeInteger(offer.n)) errors.push(`The loot of reply ${key} is missing where it lies, its claim or its order.`);
        const list = lootItems(offer);
        if (!list || !list.length || list.length > LOOT_ITEMS
            || list.some(item => !isPlainObject(item) || !nonBlank(item.name) || item.name.length > MAX_NAME || !isCount(item.qty, 1)
                || (item.coin !== undefined && !isCount(item.coin, 1)))) {
            errors.push(`The loot of reply ${key} needs 1 to ${LOOT_ITEMS} things, each with a name and a positive quantity.`);
        }
    }
    return errors;
}

// An offer's things in order, or null when they are not kept as they should be. They are a record keyed
// "0", "1", … (not a list): a later line of the same reply adds keys, which replay fits like any other
// per-reply bookkeeping (a list append inside a scratch field would not be).
export function lootItems(offer) {
    const items = offer?.items;
    if (!isPlainObject(items)) return null;
    const keys = Object.keys(items);
    if (keys.some((key, at) => key !== String(at))) return null;
    return keys.map(key => items[key]);
}

// "Lantern Oil x2", "Lantern Oil ×2" → { name, qty }: a count of any length is a count, never part of
// the name); without one, `fallback`. Money ("1000 gold", "Gold x500",
// "gold") → { money: amount }.
function lootPart(text, fallback, currency) {
    const counted = /^(.*?)\s*[x×]\s*(\d+)$/i.exec(text);
    const number = digits => Math.min(Number(digits), Number.MAX_SAFE_INTEGER);
    const { name, qty } = counted && counted[1].trim() ? { name: counted[1].trim(), qty: number(counted[2]) } : { name: text, qty: fallback };
    // A coin's name counts in the smallest unit: "3 silver" is 30 when silver is worth 10 (money.js coinValue).
    if (isCurrencyName(cleanName(name), currency)) return { name, money: number(qty * coinValue(cleanName(name), currency)) };
    const leading = /^(\d[\d,]*)\s+(.+)$/.exec(name);
    if (leading && isCurrencyName(cleanName(leading[2]), currency)) return { name: leading[2], money: number(Number(leading[1].replace(/,/g, '')) * coinValue(cleanName(leading[2]), currency)) };
    return { name, qty };
}

/** Whether the party (anyone in it) already carries the item a name means, by the tolerant lookup. */
function owned(inv, name) {
    const found = resolveDef(inv, name);
    return found.status === 'found' && Object.values(inv.stacks).some(stack => stack.def === found.id);
}

/** `? loot A, B x2, C — where | qty: n` (see above). */
export function captureLoot(ctx, line, env) {
    if (!featureOn(ctx, FEATURE.loot)) ctx.fail('FEATURE_OFF', 'Loot to pick from is turned off in the Features.');
    if (line?.op !== '?') ctx.fail('INVALID', `"${line?.op} loot" is not a change the inventory understands; write ? loot Thing, Other Thing — where it lies.`);
    const sid = ctx.carrier?.sid;
    if (ctx.cause !== 'story' || typeof sid !== 'string' || !sid) ctx.fail('REFUSED', 'Loot is laid out by a reply\'s change lines only.');
    const inv = ctx.draft('inventory');
    const fallback = lineQty(ctx, line, 1);
    if (fallback < 1) ctx.fail('INVALID', 'A quantity of loot must be at least 1.');
    const parts = String(line.name ?? '').split(/[,;]/).map(part => part.trim()).filter(Boolean);
    if (!parts.length) ctx.fail('INVALID', 'A loot line needs the things that lie there: ? loot Rusty Key, Lantern Oil — where.');
    const before = isPlainObject(inv.loot) && isPlainObject(inv.loot[sid]) ? inv.loot[sid] : null;
    const items = before ? clone(lootItems(before) ?? []) : [];
    const notes = [];
    const currency = currencyIn(ctx);
    // New definitions are worked out on a copy; the real ones are made only for what the reader takes.
    const scratch = { ...inv, defs: { ...inv.defs }, aliases: { ...inv.aliases } };
    for (const part of parts) {
        const { name: written, qty, money } = lootPart(part, fallback, currency);
        const name = cleanName(written);
        if (!name) continue;
        // Money in a loot line is a coin offer in that loot, counted for the reply now (as a
        // `+ coin` line would be) and paid into the wallet on Take: never an item, never left out unsaid.
        if (money !== undefined) {
            const purse = items.find(item => item.coin !== undefined);
            if (!purse && items.length >= LOOT_ITEMS) {
                notes.push(`One reply may lay out at most ${LOOT_ITEMS} things to pick from; ${formatAmount(money, currency)} was left out.`);
                continue;
            }
            if (money < 1) { notes.push(`${name}: an amount of money is more than nothing.`); continue; }
            const held = storyCoin(ctx, inv, money);
            if (purse) {
                purse.coin += held.amount;
                purse.name = formatAmount(purse.coin, currency);
            } else items.push({ name: formatAmount(held.amount, currency), qty: 1, coin: held.amount });
            continue;
        }
        if (items.length >= LOOT_ITEMS) {
            notes.push(`One reply may lay out at most ${LOOT_ITEMS} things to pick from; ${name} and the rest were left out.`);
            break;
        }
        if (name.length > MAX_NAME) { notes.push(`An item needs a name of 1 to ${MAX_NAME} characters; one was left out.`); continue; }
        if (owned(inv, name)) { notes.push(`${name} is already carried, so it is not offered.`); continue; }
        if (qty < 1) { notes.push(`${name}: a quantity of loot is at least 1.`); continue; }
        let held;
        let def;
        try {
            ({ def } = defineByName(ctx, scratch, name, env, { owner: 'party' }, false));
            if (items.some(item => aliasKey(item.name) === aliasKey(def.name) || resolveDef(scratch, item.name).id === def.id)) { notes.push(`${def.name} is offered once.`); continue; }
            held = storyItems(def, qty, false, 'offered');
        } catch (error) {
            if (typeof error?.code !== 'string') throw error;
            notes.push(error.message);
            continue;
        }
        items.push({ name: def.name, qty: held.qty });
        if (held.problem) notes.push(held.problem);
    }
    if (JSON.stringify(items) === JSON.stringify(lootItems(before) ?? [])) ctx.fail('REFUSED', notes.join(' ') || 'There is nothing in that loot to pick up.');
    if (!isPlainObject(inv.loot)) inv.loot = {};
    const others = Object.keys(inv.loot).filter(key => key !== sid)
        .sort((a, b) => (inv.loot[b]?.n ?? 0) - (inv.loot[a]?.n ?? 0) || (a < b ? -1 : 1));
    for (const key of others.slice(LOOT_KEEP - 1)) delete inv.loot[key];
    const here = trimText(line.text ?? '', MAX_WHERE);
    const where = before && before.where !== here ? trimText([before.where, here].filter(Boolean).join('; '), MAX_WHERE) : here;
    inv.loot[sid] = { sid, n: Number.isSafeInteger(ctx.rev) ? ctx.rev : 0, where, claim: `loot:${sid}`, items: { ...items } };
    // The offer is the reply's own (REPLAY.md "Reply-bound guards"): it goes with its reply, also when deleting the earliest
    // replies carries the rest of what they did forward, and a take of it (lootTakeGuard) goes with it.
    const offered = { kind: LOOT_OFFER, sid };
    ctx.replayGuard({ owner: LOOT_OWNER, version: 2, epoch: ctx.epoch, rulesHash: null, inputHash: ctx.hash(offered), predicate: offered, replyBound: true });
    const list = items.map(item => itemText(item.name, item.qty));
    return {
        summary: `Loot to pick from${where ? ` (${where})` : ''}: ${list.join(', ')}. The reader picks what to take (this reply's card, or To pick up in the Inventory).`,
        data: { sid, where, items: clone(items) },
        narrate: false,
        ...(notes.length ? { problem: notes.join(' ') } : {}),
    };
}

// `inventory.lootTake { sid, pick: [index…] }` (the reader's "Take selected" on the reply's card):
// once per reply's offer (claim `loot:<sid>`), the picked things the party does not carry yet go to the
// party's bag, as the offer held them. The reader's own take: past the carry limit it is refused.
// The take is a guarded block (REPLAY.md, predicate `loot.take`): what a reply laid out goes away with it, so
// the take applies, with its claim, only while that reply's offer still lays out what was taken (lootTakeGuard).
export function lootTake(ctx, payload, env) {
    if (!featureOn(ctx, FEATURE.loot)) ctx.fail('FEATURE_OFF', 'Loot to pick from is turned off in the Features.');
    const inv = ctx.draft('inventory');
    const sid = payload.sid;
    const offer = typeof sid === 'string' && isPlainObject(inv.loot) && Object.hasOwn(inv.loot, sid) && isPlainObject(inv.loot[sid]) ? inv.loot[sid] : null;
    if (!offer) ctx.fail('NOT_FOUND', 'That loot is no longer there to take.');
    const things = lootItems(offer) ?? [];
    const picks = Array.isArray(payload.pick) ? payload.pick.map(at => (typeof at === 'string' && /^\d+$/.test(at) ? Number(at) : at)) : [];
    if (!picks.length || picks.length > LOOT_ITEMS || picks.some(at => !Number.isSafeInteger(at) || at < 0 || at >= things.length)) {
        ctx.fail('INVALID', 'Pick at least one of the things on offer to take.');
    }
    if (!ctx.claim(offer.claim || `loot:${sid}`)) ctx.fail('REFUSED', 'That loot has already been taken: each reply\'s loot is taken once.');
    const skipped = [];
    const wanted = [];
    const over = [];
    let coin = 0;
    for (const at of [...new Set(picks)].sort((a, b) => a - b)) {
        const item = things[at];
        if (item.coin !== undefined) { coin += item.coin; continue; }
        if (owned(inv, item.name)) { skipped.push(item.name); continue; }
        const { def, created } = defineByName(ctx, inv, item.name, env, { owner: 'party' });
        // The offer was held to what one grant can give as it read the item then; a pack enabled since (or an
        // offer an older version saved) can make it a thing that does not stack: what fits is taken, the rest stays.
        const qty = def.stack ? item.qty : Math.min(item.qty, MAX_UNSTACKED);
        if (qty < item.qty) over.push({ name: def.name, qty: item.qty - qty });
        wanted.push({ def, qty, created, offered: item.name });
    }
    if (!wanted.length && !coin) ctx.fail('REFUSED', `${joinNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already carried.`);
    if (wanted.length) readerCarry(ctx, wanted.map(entry => ({ defId: entry.def.id, qty: entry.qty })), 'party');
    // What the take needs of the offer, decided now and kept on the block: the offer's names and how many of each were taken.
    const predicate = { kind: LOOT_GUARD, sid, claim: offer.claim || `loot:${sid}`, items: wanted.map(entry => ({ name: entry.offered, qty: entry.qty })), coin };
    ctx.replayGuard({ owner: LOOT_OWNER, version: 2, epoch: ctx.epoch, rulesHash: null, inputHash: ctx.hash(predicate), predicate });
    // FB-2: what the story offered is the story's own (`story: true`, as a `+ item` line's), whatever its
    // def (a pack's item named in the `? loot` line).
    const stacks = wanted.flatMap(entry => grantInto(ctx, inv, entry.def, entry.qty, 'party', '', false, true));
    // The money was counted for its reply when the loot was read: it is paid as offered.
    const currency = currencyIn(ctx);
    if (coin) receive(ctx, env, { owner: 'party', amount: coin, note: 'loot' });
    const where = offer.where ? ` (${offer.where})` : '';
    const left = skipped.length ? `; ${joinNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already carried` : '';
    const took = [...wanted.map(entry => itemText(entry.def.name, entry.qty)), ...(coin ? [formatAmount(coin, currency)] : [])];
    const behind = over.length ? ` ${joinNames(over.map(entry => itemText(entry.name, entry.qty)))} ${over.length === 1 && over[0].qty === 1 ? 'is' : 'are'} left where ${over.length === 1 ? 'it' : 'they'} lay: a thing that does not stack is given at most ${MAX_UNSTACKED} at once.` : '';
    return {
        summary: `The party takes ${joinNames(took)}${where}${left}.${behind}`,
        data: { sid, taken: wanted.map(entry => ({ def: entry.def.id, qty: entry.qty })), coin, skipped, stacks, ...(over.length ? { left: over } : {}),
            v2: { result: { taken: predicate.items, coin } } },
        narrate: told(ctx),
        ...(behind ? { problem: behind.trim() } : {}),
    };
}

// The taken things (`wanted`, [{ name, qty }]) the offer's things no longer lay out: for each, the one thing of the offer its
// name means by the inventory's own lookup (an offer as a slice of defs keyed by position, each named and aliased by its own
// name), with at least as many; a name that means none, or more than one, or a thing an earlier taken name took, is gone.
function offeredFor(things, wanted) {
    const defs = {};
    const aliases = {};
    things.forEach((item, at) => {
        if (!isPlainObject(item) || item.coin !== undefined || !nonBlank(item.name)) return;
        defs[String(at)] = { name: item.name };
        aliases[aliasKey(item.name)] ??= String(at);
    });
    const used = new Set();
    return wanted.filter(want => {
        const found = resolveDef({ defs, aliases }, want.name);
        if (found.status !== 'found' || used.has(found.id)) return true;
        used.add(found.id);
        const qty = things[Number(found.id)].qty;
        return !(Number.isSafeInteger(qty) && qty >= want.qty);
    });
}
export function lootTakeGuard({ state, hash }, { guard }) {
    const predicate = guard?.predicate;
    const damaged = { ok: false, reason: 'its loot guard is damaged' };
    if (predicate?.kind === LOOT_OFFER) {
        return guard.owner === LOOT_OWNER && guard.version === 2 && guard.replyBound === true && typeof predicate.sid === 'string'
            && Object.keys(predicate).length === 2 && hash(predicate) === guard.inputHash ? { ok: true } : damaged;
    }
    if (guard?.owner !== LOOT_OWNER || guard.version !== 2 || !isPlainObject(predicate) || predicate.kind !== LOOT_GUARD
        || typeof predicate.sid !== 'string' || typeof predicate.claim !== 'string' || !isCount(predicate.coin, 0)
        || !Array.isArray(predicate.items) || predicate.items.some(item => !isPlainObject(item) || !nonBlank(item.name) || !isCount(item.qty, 1))) return damaged;
    if (hash(predicate) !== guard.inputHash) return damaged;
    const loot = state?.domains?.inventory?.loot;
    const offer = isPlainObject(loot) && Object.hasOwn(loot, predicate.sid) && isPlainObject(loot[predicate.sid]) ? loot[predicate.sid] : null;
    if (!offer || (offer.claim || `loot:${predicate.sid}`) !== predicate.claim) return { ok: false, reason: 'the loot it took is no longer on offer' };
    const things = lootItems(offer) ?? [];
    const gone = offeredFor(things, predicate.items);
    const purse = things.find(item => isPlainObject(item) && item.coin !== undefined)?.coin;
    const short = predicate.coin > 0 && !(Number.isSafeInteger(purse) && purse >= predicate.coin);
    if (gone.length || short) {
        const names = [...gone.map(want => itemText(want.name, want.qty)), ...(short ? ['the money'] : [])];
        return { ok: false, reason: `the loot on offer no longer holds ${joinNames(names)} it took` };
    }
    return { ok: true };
}
