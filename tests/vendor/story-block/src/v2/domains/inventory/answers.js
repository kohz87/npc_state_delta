// The inventory domain's query table (moved out of domains/inventory.js unchanged; inventory.js re-exports it): the answers other modules ask
// for. It reads loot, the kit and the story tally, so it sits above queries.js, whose helpers it uses, and below nothing but the facade.

import { clone, isPlainObject } from '../common.js';
import { resolveDef } from '../names.js';
import { resolveCurrency } from '../money.js';
import { createGearQueries } from '../gear.js';
import { FEATURE, condOf, condEvents } from './state.js';
import { legendEarned } from './validate.js';
import {
    definitionsOf, listItems, carryBonuses, gearIsOn, boundNames, equipmentView, encumbrance, defCarry,
    ENCUMBERED_PENALTY, gearWearers,
} from './queries.js';
import { economyOf } from './stacks.js';
import { lootItems } from './loot.js';
import { kitOpen } from './edit.js';
import { storedTally, clicksOf, tallied } from './lines.js';

/**
 * The inventory queries; `env.settings()` gives the currency for `inventory.currency` and the reader's
 * money scale, `env.economy()` the enabled pack's ({ scale } or null) for `inventory.economy`.
 */
export const createInventoryQueries = env => ({
    // { scale, source: 'pack' | 'settings' | 'default' } (MODULES §F104): multiply built-in money defaults by scale.
    'inventory.economy': () => {
        let pack = null;
        try { pack = typeof env.economy === 'function' ? env.economy() : null; } catch { /* no packs: none */ }
        return economyOf(env.settings(), pack);
    },
    // { name, plural, short }: the chat's one currency (MODULES.md F1); name singular ("mark").
    // The reader's currency, the pack's, or gold.
    'inventory.currency': () => resolveCurrency(env.settings()),
    // Each row's `carry` (the capacity the thing adds, PACKS.md "Carry capacity") is the carry module's
    // (`items.carry` → bonuses by stack: a pack's `carry` or the reader's own) when one answers, else the def's.
    // [def copies], ID-sorted: every definition the inventory holds (default) or those of `ids` that it
    // has; unknown IDs are left out, malformed arguments give []. It reads the definitions as the asking
    // transaction has them (drafts included), makes nothing and does not depend on a pack being installed:
    // a pack's item registered by the rules module stays here after the pack is removed.
    'inventory.definitions': (state, args) => definitionsOf(state?.domains?.inventory, args),
    'inventory.items': (state, args = {}, tools) => listItems(state?.domains?.inventory, args?.owner ?? null, carryBonuses(tools), gearIsOn(env), boundNames(state, tools, env)),
    'inventory.counts': state => {
        const inventory = state?.domains?.inventory, stacks = Object.values(inventory?.stacks ?? {}), totals = new Map();
        for (const stack of stacks) {
            const key = JSON.stringify([stack.def, stack.owner]);
            totals.set(key, (totals.get(key) ?? 0) + stack.qty);
        }
        return Object.fromEntries(stacks.map(stack => [stack.id, inventory.defs?.[stack.def]?.stack === false
            ? totals.get(JSON.stringify([stack.def, stack.owner])) : stack.qty]));
    },
    // { budget, paid, left, vouched }: the story money (`+ coin` lines and modules' `wallet.receive { story:
    // true }`) the current reply has given (RX-E-2); `vouched` is the part of `paid` that modules' vouched
    // payouts gave (quest rewards), so a module can tell a reply whose money its own payouts gave from one
    // whose coin lines did. There is no per-reply limit (the story decides what it pays), so `budget` and
    // `left` are always null; they stay in the answer for modules written when a limit could be set. The
    // current reply is the one the asking command is stored on (tools.reply: a capture's carrier, else the
    // head carrier); with none known, nothing is counted as given yet.
    'inventory.storyBudget': (state, args, tools) => {
        const stored = storedTally(state?.domains?.inventory, tools?.reply?.sid);
        const clicks = tools?.reply?.sid ? clicksOf(state?.domains?.inventory, tools.reply.sid) : 0;
        const paid = tallied(stored?.coin) + clicks;
        return { budget: null, paid, left: null, vouched: Math.min(paid, tallied(stored?.vouched) + clicks) };
    },
    'inventory.wallet': (state, args = {}) => ({ ...(state?.domains?.inventory?.wallets?.[args?.owner ?? 'party'] ?? {}) }),
    // { status: 'found' | 'ambiguous' | 'none', defs: [def copies], stacks: [items of the found def] }
    'inventory.find': (state, args = {}, tools) => {
        const inventory = state?.domains?.inventory;
        const found = resolveDef(inventory, args?.name ?? '');
        return {
            status: found.status,
            defs: found.ids.map(id => clone(inventory.defs[id])),
            stacks: found.status === 'found' ? listItems(inventory, null, null, gearIsOn(env), boundNames(state, tools, env)).filter(item => item.def === found.id) : [],
        };
    },
    'inventory.equipment': (state, args, tools) => equipmentView(state, tools),
    // The loot laid out and not taken yet, newest first: [{ sid, where, n, items: [{ name, qty }] }].
    'inventory.loot': Object.assign((state) => {
        const inventory = state?.domains?.inventory;
        const claims = state?.meta?.claims ?? {};
        return Object.values(isPlainObject(inventory?.loot) ? inventory.loot : {})
            .filter(offer => isPlainObject(offer) && typeof offer.sid === 'string' && !Object.hasOwn(claims, offer.claim || `loot:${offer.sid}`) && lootItems(offer)?.length)
            .sort((a, b) => (b.n ?? 0) - (a.n ?? 0) || (a.sid < b.sid ? -1 : 1))
            .map(offer => ({ sid: offer.sid, where: offer.where, n: offer.n, items: clone(lootItems(offer)) }));
    }, { feature: FEATURE.loot }),
    // { stack } → { stack, cond, events: [{ key, d, n }] } (the events as they apply), or null.
    'inventory.condition': (state, args = {}) => {
        const inventory = state?.domains?.inventory;
        const stack = typeof args?.stack === 'string' && isPlainObject(inventory?.stacks?.[args.stack]) ? inventory.stacks[args.stack] : null;
        return stack ? { stack: stack.id, cond: condOf(stack, inventory), events: condEvents(inventory, stack.id) } : null;
    },
    'inventory.legendEarned': Object.assign((_state, _args, tools) => legendEarned(tools), { feature: FEATURE.gear }),
    'inventory.encumbrance': Object.assign((state, args, tools) => encumbrance(state, tools, gearIsOn(env)), { feature: FEATURE.encumbrance }),
    // `story-block.gear`: { owner } → { on, owner, weapon, armour, shield: { name, bonus, cond, broken } | null, carry: { load, capacity,
    // encumbered, penalty } } (part 2's rolls read it), and `gear.carry`, `items.carry`'s answer when no carry module gives one.
    ...createGearQueries({
        on: () => gearIsOn(env), kit: () => kitOpen(env), empty: () => { try { return env?.chatEmpty?.() === true; } catch { return false; } },
        condOf, carryOf: defCarry, penalty: ENCUMBERED_PENALTY, feature: FEATURE.gear,
        names: (state, tools, id) => gearWearers(state, tools, env).names.get(id) ?? (id === 'party' ? 'The party' : String(id)),
        owners: (state, tools) => gearWearers(state, tools, env).owners,
    }),
});
