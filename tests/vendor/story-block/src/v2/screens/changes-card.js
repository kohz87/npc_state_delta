// `story-block/changes-card` (SPEC §13.1, §13.4): the inline card under a reply, "Changed this reply".
// The card mount gives it **that reply's** state and the JSON Pointers that reply's ops touched, so the
// template lists only what `changed()` says moved: the stacks touched (with what is held now), the
// wallet, the place and who is present, and the loot the reply laid out (`? loot`) as chips to tick
// with a "Take selected" button (`inventory.lootTake`; once taken, "Taken.").
//
// The card's collapsed header is one line from the mount's `summary` hook. `changesSummary` (below)
// writes it from the reply's state and the state before it, so it can say what was gained and lost:
// "+1 Moonveil Trout, −1 Rope · +30 gold · to Bluewatch Village · Fenna arrived". A stack used up
// completely is gone from the reply's state, so only the header (which sees the state before) names it.
// Pure: no DOM.

import { STRINGS, fill, html } from '../strings.js';
import { formatAmount } from '../domains/money.js';
import { BASE_CSS } from './style.js';

export const CHANGES_CARD_SCREEN_ID = 'story-block/changes-card';

const C = STRINGS.card;
const T = STRINGS.summary;

// `refused` is not a state path: the host puts the reply's refused change lines in the card's scope
// (ui-host.js, from the turn's problems for that reply: [{ line, reason }]). A screen drawn without it
// (another host, a test) simply has none.
const TEMPLATE = `
<div class="chg">
  <ul class="lines">
    <li class="line item" data-each="state.inventory.stacks as s" data-if="changed(s)"
        data-class="eq: s.equipped != null">
      <i class="fa-solid fa-box-open" aria-hidden="true"></i>
      <span class="name">{{ state.inventory.defs[s.def].name }}</span>
      <span class="now muted">${html(C.itemNow, { qty: '{{ s.qty }}' })}</span>
      <span class="chip" data-if="s.equipped">${html(C.equipped, { slot: '{{ s.equipped }}' })}</span>
    </li>
    <li class="line coin" data-if="changed('state.inventory.wallets.party')">
      <i class="fa-solid fa-coins" aria-hidden="true"></i>
      <span data-if="len(q.currency.coins) == 0">${html(C.wallet, { coin: '<b>{{ state.inventory.wallets.party.coin }}</b>', money: '<span data-if="state.inventory.wallets.party.coin == 1">{{ q.currency.name }}</span><span data-if="state.inventory.wallets.party.coin != 1">{{ q.currency.plural }}</span>' })}</span>
      <span data-if="len(q.currency.coins) > 0">${html(C.wallet, { coin: '<b>{{ fmt.money(state.inventory.wallets.party.coin) }}</b>', money: '' })}</span>
    </li>
    <li class="line place" data-if="changed('state.scene.place')">
      <i class="fa-solid fa-location-dot" aria-hidden="true"></i>
      <span data-if="state.scene.place.name">${html(C.nowAt, { place: '<b>{{ state.scene.place.name }}</b>' })}</span>
      <span data-if="!state.scene.place.name">${html(C.placeCleared)}</span>
    </li>
    <li class="line present" data-if="changed('state.scene.present')">
      <i class="fa-solid fa-users" aria-hidden="true"></i>
      <span data-if="len(state.scene.present) > 0">${html(C.hereNow, { names: '{{ state.scene.present }}' })}</span>
      <span data-if="len(state.scene.present) == 0">${html(C.nobodyNow)}</span>
    </li>
  </ul>
  <div class="loot" data-each="state.inventory.loot as o, sid" data-if="changed(o)">
    <p class="loot-head"><i class="fa-solid fa-sack-dollar" aria-hidden="true"></i> <b>${html(C.loot)}</b><span class="where" data-if="o.where"> — {{ o.where }}</span></p>
    <div class="offer" data-if="state.meta.claims[o.claim] != true">
      <div class="chips">
        <label class="chip pick" data-each="o.items as it, i"><input type="checkbox" data-draft="pick" value="{{ i }}"> <span>{{ it.name }}</span><span class="n" data-if="it.qty != 1"> ×{{ it.qty }}</span></label>
      </div>
      <p class="hint muted">${html(C.lootPick)}</p>
      <button class="btn take" data-command="inventory.lootTake" data-payload='{"sid":"{{ sid }}","pick":{{ draft.pick }}}'
              title="${html(C.lootTakeTitle)}"><i class="fa-solid fa-hand" aria-hidden="true"></i> ${html(C.lootTake)}</button>
    </div>
    <p class="taken muted" data-if="state.meta.claims[o.claim] == true">${html(C.lootTaken)}</p>
  </div>
  <p class="none muted" data-if="!changed('state.inventory') && !changed('state.scene')">${html(C.nothing)}</p>
  <ul class="refused" data-if="len(refused) > 0">
    <li class="line" data-each="refused as r">
      <i class="fa-solid fa-ban" aria-hidden="true"></i>
      <span><span class="label">${html(C.notApplied)}</span> <span class="raw">{{ r.line }}</span><span class="why" data-if="r.reason"> — {{ r.reason }}</span></span>
    </li>
  </ul>
</div>`;

const CSS = `${BASE_CSS}
.chg { font-size: 0.9em; padding: 4px 8px; border-left: 3px solid var(--sb-accent); border-radius: 6px; background: var(--sb-raised); }
.lines { display: grid; gap: 2px; }
.line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.line > i { width: 1.1em; text-align: center; color: var(--sb-accent); }
/* One text after the icon (the wallet, the place, who is here): it wraps beside the icon, never under it. */
.coin, .place, .present { flex-wrap: nowrap; }
.coin > span, .place > span, .present > span { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; }
.name { font-weight: 600; }
.none { margin: 0; }
.loot { margin-top: 4px; padding-top: 4px; border-top: 1px dashed var(--sb-border); display: grid; gap: 4px; }
.loot-head { margin: 0; }
.loot .chips { display: flex; flex-wrap: wrap; gap: 4px; }
.loot .pick { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; padding: 1px 8px; border-radius: 999px;
              border: 1px solid var(--sb-border); background: var(--sb-surface); }
.loot .pick:has(input:checked) { border-color: var(--sb-accent); color: var(--sb-accent); }
.loot .pick input { width: 1em; height: 1em; min-width: 0; margin: 0; accent-color: var(--sb-accent); }
.loot .hint, .loot .taken { margin: 0; font-size: 0.9em; }
.loot .take { justify-self: start; }
.refused { display: grid; gap: 2px; margin-top: 4px; padding-top: 4px; border-top: 1px dashed var(--sb-border);
           color: var(--sb-em); opacity: 0.75; font-size: 0.95em; }
.refused .line { flex-wrap: nowrap; }
.refused .line > i { color: var(--sb-em); }
.refused .line > span { flex: 1 1 0; min-width: 0; }
.refused .raw { font-family: var(--monoFontFamily, monospace); font-size: 0.95em; overflow-wrap: anywhere; }
`;

export const changesCardScreen = Object.freeze({
    id: CHANGES_CARD_SCREEN_ID,
    title: C.title,
    icon: 'fa-list-check',
    mounts: Object.freeze(['card']),
    // Shown under every reply until the reader turns it off (MODULES §F24).
    defaultOn: true,
    data: Object.freeze({ currency: Object.freeze({ query: 'inventory.currency' }) }),
    template: TEMPLATE,
    css: CSS,
});

// ---------------------------------------------------------------------------------------------------
// The one-line summary

const INVENTORY = /^\/domains\/inventory(\/|$)/;
const STACK = /^\/domains\/inventory\/stacks\/([^/]+)/;
const WALLETS = /^\/domains\/inventory\/wallets(\/|$)/;
const PLACE = /^\/domains\/scene\/place(\/|$)|^\/domains\/scene$/;
const PRESENT = /^\/domains\/scene\/present(\/|$)|^\/domains\/scene$/;
const LOOT = /^\/domains\/inventory\/loot(?:\/([^/]+))?$/;
const MAX_ITEMS = 3;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inventoryOf = state => (isRecord(state?.domains?.inventory) ? state.domains.inventory : {});
const sceneOf = state => (isRecord(state?.domains?.scene) ? state.domains.scene : {});
const coinOf = state => {
    const coin = inventoryOf(state).wallets?.party?.coin;
    return Number.isSafeInteger(coin) ? coin : 0;
};
const placeName = state => (typeof sceneOf(state).place?.name === 'string' ? sceneOf(state).place.name : '');
const presentOf = state => (Array.isArray(sceneOf(state).present) ? sceneOf(state).present.filter(name => typeof name === 'string') : []);
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }) || (a.def < b.def ? -1 : a.def > b.def ? 1 : 0);

// Quantity held per item definition, every owner together (a hand-over between members is no change).
function heldByDef(state) {
    const held = new Map();
    for (const stack of Object.values(inventoryOf(state).stacks ?? {})) {
        if (!isRecord(stack) || typeof stack.def !== 'string' || !Number.isSafeInteger(stack.qty)) continue;
        held.set(stack.def, (held.get(stack.def) ?? 0) + stack.qty);
    }
    return held;
}

function defName(def, ...states) {
    for (const state of states) {
        const name = inventoryOf(state).defs?.[def]?.name;
        if (typeof name === 'string' && name) return name;
    }
    return def;
}

/**
 * What a reply changed, from its state, the state before it (the previous carrier's; null for the
 * greeting or when unknown) and the JSON Pointers its ops touched (the card mount's `changes`).
 * → { gained: [{ def, name, qty }], lost: [{ def, name, qty }], held: [{ def, name, qty }],
 *     coin: number | null, coinNow: number | null, place: string | null, arrived: [], left: [],
 *     presentNow: string[] | null, other: bool }
 * With `before`, gained / lost / coin / arrived / left are differences. Without it, `held` lists the
 * touched items with what is held now, `coinNow` the wallet and `presentNow` who is here, since nothing
 * says what they were before. `other` is true when the reply changed something else (another module's).
 */
export function changesDigest({ state = null, before = null, changes = [] } = {}) {
    const paths = (Array.isArray(changes) ? changes : [...(changes ?? [])]).filter(path => typeof path === 'string');
    const digest = { gained: [], lost: [], held: [], coin: null, coinNow: null, place: null, arrived: [], left: [], presentNow: null, other: false, loot: 0 };
    const touched = test => paths.some(path => test.test(path));
    const known = isRecord(before);

    if (touched(INVENTORY)) {
        if (known) {
            const now = heldByDef(state);
            const then = heldByDef(before);
            for (const def of new Set([...then.keys(), ...now.keys()])) {
                const delta = (now.get(def) ?? 0) - (then.get(def) ?? 0);
                if (delta > 0) digest.gained.push({ def, name: defName(def, state, before), qty: delta });
                else if (delta < 0) digest.lost.push({ def, name: defName(def, state, before), qty: -delta });
            }
            digest.gained.sort(byName);
            digest.lost.sort(byName);
            const coin = coinOf(state) - coinOf(before);
            if (coin !== 0) digest.coin = coin;
        } else {
            const stacks = inventoryOf(state).stacks ?? {};
            const ids = new Set(paths.map(path => STACK.exec(path)?.[1]).filter(id => id && isRecord(stacks[id])));
            const held = new Map();
            for (const id of ids) held.set(stacks[id].def, (held.get(stacks[id].def) ?? 0) + stacks[id].qty);
            digest.held = [...held].map(([def, qty]) => ({ def, name: defName(def, state), qty })).sort(byName);
            if (touched(WALLETS)) digest.coinNow = coinOf(state);
        }
    }
    // Loot laid out by this reply (`? loot`): how many things its offer holds.
    const offers = isRecord(inventoryOf(state).loot) ? inventoryOf(state).loot : {};
    const laid = new Set();
    for (const path of paths) {
        const m = LOOT.exec(path);
        if (!m) continue;
        if (m[1]) laid.add(m[1].replace(/~1/g, '/').replace(/~0/g, '~'));
        else Object.keys(offers).forEach(key => laid.add(key));
    }
    for (const key of laid) if (isRecord(offers[key]?.items)) digest.loot += Object.keys(offers[key].items).length;
    if (touched(PLACE)) {
        const name = placeName(state);
        if (!known || name !== placeName(before)) digest.place = name;
    }
    if (touched(PRESENT)) {
        const now = presentOf(state);
        const then = known ? presentOf(before) : [];
        const lower = list => new Set(list.map(name => name.toLowerCase()));
        const nowKeys = lower(now);
        const thenKeys = lower(then);
        digest.arrived = known ? now.filter(name => !thenKeys.has(name.toLowerCase())) : [];
        digest.left = then.filter(name => !nowKeys.has(name.toLowerCase()));
        if (!known) digest.presentNow = now;
    }
    digest.other = paths.some(path => !INVENTORY.test(path) && !/^\/domains\/scene(\/|$)/.test(path) && !/^\/meta(\/|$)/.test(path));
    return digest;
}

function itemList(entries, sign) {
    const shown = entries.slice(0, MAX_ITEMS).map(entry => `${sign}${entry.qty} ${entry.name}`);
    return entries.length > MAX_ITEMS ? [...shown, fill(T.more, { n: entries.length - MAX_ITEMS })] : shown;
}

function people(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return fill(T.two, { a: names[0], b: names[1] });
    return fill(T.many, { first: names.slice(0, 2).join(', '), n: names.length - 2 });
}

/**
 * The card's collapsed one-line summary, in plain words: "+1 Moonveil Trout, −1 Rope · +30 gold ·
 * to Bluewatch Village · Fenna arrived", or "No changes" ("No item, coin or place changes" when only
 * another module's state moved). `currency` is `inventory.currency`'s
 * `{ name }` (default gold). `refused` is how many of the reply's change lines were not applied
 * (MODULES §F41): "… · 1 line not applied". Takes the same fields as changesDigest, or a digest as `digest`.
 */
export function changesSummary({ state = null, before = null, changes = [], currency = null, digest = null, refused = 0 } = {}) {
    const d = digest ?? changesDigest({ state, before, changes });
    // The currency word for an amount: its name for exactly 1, else its plural (MODULES §F1).
    const name = typeof currency?.name === 'string' && currency.name ? currency.name : T.defaultMoney;
    const plural = typeof currency?.plural === 'string' && currency.plural ? currency.plural : name;
    const money = n => (Math.abs(n) === 1 ? name : plural);
    // With coins (MODULES §F108) an amount is its mixed coins ("+3 silver 5 copper").
    const coined = Array.isArray(currency?.coins) && currency.coins.length > 0;
    const amount = n => (coined ? formatAmount(Math.abs(n), currency) : `${Math.abs(n)} ${money(n)}`);
    const parts = [];
    const items = [...itemList(d.gained, '+'), ...itemList(d.lost, '−')];
    if (items.length) parts.push(items.join(', '));
    if (d.held.length) parts.push(d.held.slice(0, MAX_ITEMS).map(entry => fill(T.held, { name: entry.name, qty: entry.qty })).join(', ')
        + (d.held.length > MAX_ITEMS ? fill(T.moreTail, { n: d.held.length - MAX_ITEMS }) : ''));
    if (d.coin !== null) parts.push(`${d.coin > 0 ? '+' : '−'}${amount(d.coin)}`);
    else if (d.coinNow !== null) parts.push(coined ? fill(T.coinNow, { n: formatAmount(d.coinNow, currency), money: '' }).replace(/\s{2,}/g, ' ').trim() : fill(T.coinNow, { n: d.coinNow, money: money(d.coinNow) }));
    if (d.place !== null) parts.push(d.place ? fill(T.to, { place: d.place }) : T.placeCleared);
    if (d.arrived.length) parts.push(fill(T.arrived, { names: people(d.arrived) }));
    if (d.left.length) parts.push(fill(T.left, { names: people(d.left) }));
    if (d.presentNow) parts.push(d.presentNow.length ? fill(T.here, { names: people(d.presentNow) }) : T.nobody);
    if (d.loot > 0) parts.push(d.loot === 1 ? T.lootOne : fill(T.lootMany, { n: d.loot }));
    const count = Number.isSafeInteger(refused) && refused > 0 ? refused : 0;
    const notApplied = count === 0 ? null : count === 1 ? T.refusedOne : fill(T.refusedMany, { n: count });
    if (parts.length) return [...parts, ...(notApplied ? [notApplied] : [])].join(' · ');
    const nothing = d.other ? T.otherOnly : T.none;
    return notApplied ? `${nothing} · ${notApplied}` : nothing;
}
