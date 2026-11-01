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
//
// Modules add their own lines (MODULES §F125): a module's `hooks.replyCard({ index, state, before, changes })`
// answers [{ text, summary?, flag?, note?, icon? }] for that reply (an example module: the checks it rolled, the die,
// the modifiers and the total against the difficulty). `replyCardLines` cleans them (one line each, cut by
// code points, at most REPLY_LINES_MAX per module, a Font Awesome icon name or a default); the host puts them in
// the card's scope as `moduleLines` (ui-host.js) and their `summary` (else their `text`) in the header line.
// Plain text only: the template prints them escaped.
// Pure: no DOM.

import { STRINGS, fill, html } from '../strings.js';
import { formatAmount } from '../domains/money.js';
import { BASE_CSS } from './style.js';
import { oneLine } from '../../text.js';

export const CHANGES_CARD_SCREEN_ID = 'story-block/changes-card';

const C = STRINGS.card;
const T = STRINGS.summary;

// `assisted` (MODULES §F123): the lines the Assist safety net applied on this reply ([{ line, late }],
// from its receipts), each shown with "(assist)" or "(assist, from the previous reply)".
// `refused` is not a state path: the host puts the reply's refused change lines in the card's scope
// (ui-host.js, from the turn's problems for that reply: [{ line, reason }]). A screen drawn without it
// (another host, a test) simply has none.
const TEMPLATE = `
<div class="chg">
  <ul class="tiles">
    <li class="tile line tone-good" data-each="state.inventory.stacks as s" data-if="changed(s)"
        data-class="eq: s.equipped != null">
      <span class="ico"><i class="fa-solid fa-box-open" aria-hidden="true"></i></span>
      <span class="tx"><span class="main" title="{{ state.inventory.defs[s.def].name }}">{{ state.inventory.defs[s.def].name }}</span>
        <span class="sub">${html(C.itemNow, { qty: '{{ s.qty }}' })}</span>
        <span class="sub" data-if="s.equipped" title="${html(C.equipped, { slot: '{{ s.equipped }}' })}">${html(C.equipped, { slot: '{{ s.equipped }}' })}</span></span>
    </li>
    <li class="tile line coin tone-warn" data-if="changed('state.inventory.wallets.party')">
      <span class="ico"><i class="fa-solid fa-coins" aria-hidden="true"></i></span>
      <span class="tx">
      <span class="main" data-if="len(q.currency.coins) == 0">${html(C.wallet, { coin: '<b>{{ state.inventory.wallets.party.coin }}</b>', money: '<span data-if="state.inventory.wallets.party.coin == 1">{{ q.currency.name }}</span><span data-if="state.inventory.wallets.party.coin != 1">{{ q.currency.plural }}</span>' })}</span>
      <span class="main" data-if="len(q.currency.coins) > 0" title="{{ fmt.money(state.inventory.wallets.party.coin) }}">${html(C.wallet, { coin: '<b>{{ fmt.money(state.inventory.wallets.party.coin) }}</b>', money: '' })}</span></span>
    </li>
    <li class="tile line place tone-info" data-if="changed('state.scene.place')">
      <span class="ico"><i class="fa-solid fa-location-dot" aria-hidden="true"></i></span>
      <span class="tx" data-if="state.scene.place.name"><span class="main">${html(C.movedTo)}</span> <span class="sub" title="{{ state.scene.place.name }}">{{ state.scene.place.name }}</span></span>
      <span class="tx" data-if="!state.scene.place.name"><span class="main">${html(C.placeCleared)}</span></span>
    </li>
    <li class="tile line present tone-accent" data-if="changed('state.scene.present')">
      <span class="ico"><i class="fa-solid fa-users" aria-hidden="true"></i></span>
      <span class="tx" data-if="len(state.scene.present) > 0"><span class="main" title="{{ state.scene.present }}">{{ state.scene.present }}</span> <span class="sub">${html(C.hereLabel)}</span></span>
      <span class="tx" data-if="len(state.scene.present) == 0"><span class="main">${html(C.nobodyNow)}</span></span>
    </li>
    <li class="tile line extra" data-each="moduleLines as x" data-if="x.kind != 'check'" data-class="tone-good: x.tone == 'good'; tone-bad: x.tone == 'bad'; tone-warn: x.tone == 'warn'; tone-info: x.tone == 'info'; tone-accent: x.tone == 'accent'">
      <span class="ico"><i class="fa-solid {{ x.icon }}" aria-hidden="true"></i></span>
      <span class="tx"><span class="main" title="{{ x.text }}">{{ x.text }}</span> <span class="sub flag" data-if="x.flag != ''" title="{{ x.flag }}">{{ x.flag }}</span> <span class="sub note" data-if="x.note != ''" title="{{ x.note }}">{{ x.note }}</span></span>
    </li>
  </ul>
  <ul class="edits" data-if="len(edits) > 0">
    <li class="edit line" data-each="edits as e"><i class="fa-solid fa-pencil" aria-hidden="true"></i> <span>{{ e.text }}</span></li>
  </ul>
  <p class="edit-hint muted" data-if="editableHead == true && len(edits) > 0">${html(C.editHint)}</p>
  <ul class="checks">
    <li class="check" data-each="moduleLines as x" data-if="x.kind == 'check'" data-class="good: x.check.result == 'success'; bad: x.check.result == 'fail'">
      <span class="dice">{{ x.check.d20 }}</span>
      <span class="what"><b data-if="x.check.label != ''">{{ x.check.label }}</b><span data-if="x.check.label != ''">${html(C.labelJoin)}</span>${html(C.checkLine, { d20: '{{ x.check.d20 }}', roll: '{{ x.check.rollText }}', mod: '{{ x.check.modText }}', total: '{{ x.check.total }}', dc: '{{ x.check.dc }}', word: '<b class="res">{{ x.check.word }}</b>' })}</span>
      <span class="story" data-if="x.check.disagree != ''">{{ x.check.disagree }}</span>
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
  <p class="none muted" data-if="!changed('state.inventory') && !changed('state.scene') && len(moduleLines) == 0 && len(edits) == 0">${html(C.nothing)}</p>
  <ul class="refused" data-if="len(refused) > 0">
    <li class="line" data-each="refused as r">
      <i class="fa-solid fa-ban" aria-hidden="true"></i>
      <span><span class="label">${html(C.notApplied)}</span> <span class="raw">{{ r.line }}</span><span class="why" data-if="r.reason"> — {{ r.reason }}</span></span>
    </li>
  </ul>
  <ul class="assisted" data-if="len(assisted) > 0" title="${html(C.assistTitle)}">
    <li class="line" data-each="assisted as a">
      <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
      <span><span class="raw">{{ a.line }}</span> <span class="muted" data-if="!a.late">${html(C.assist)}</span><span class="muted" data-if="a.late">${html(C.assistLate)}</span></span>
    </li>
  </ul>
</div>`;

const CSS = `${BASE_CSS}
/* Reply.dc.html's card: the changes as a grid of tiles (34px icon tile, a bold line, a muted line, a 1.5px ring by kind), the
   checks as full-width rows under it, and the assist and other lines last, small and muted. The grid's columns follow the card's
   own width (a container query): 2 below 560px (a phone, 360 to 412), 3 between, 4 from 900px. Colours are the theme's tokens. */
.chg { display: grid; gap: 10px; font-size: 0.95em; container-type: inline-size; min-width: 0; }
.tiles { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
@container (min-width: 560px) { .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (min-width: 900px) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.tile { --ring: var(--ss-border); display: flex; align-items: center; gap: 8px; min-width: 0; padding: 10px; border-radius: var(--ss-radius-m, 14px);
        background: var(--ss-glass, var(--ss-tile)); border: 1.5px solid var(--ring); }
.tile .ico { flex: none; width: 34px; height: 34px; border-radius: var(--ss-radius-s, 10px); background: var(--ss-tile); color: var(--ring);
             display: flex; align-items: center; justify-content: center; }
.tile .tx { min-width: 0; display: grid; gap: 1px; }
/* A long line wraps to two lines and is cut after that; the full text is the span's title. */
.tile .main, .tile .sub { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.tile .main { font-weight: 700; }
.tile .sub { font-size: 0.9em; color: var(--ss-muted); }
.tile.tone-good { --ring: var(--ss-good); }
.tile.tone-bad { --ring: var(--ss-bad); }
.tile.tone-warn { --ring: var(--ss-warn); }
.tile.tone-info { --ring: var(--ss-info); }
.tile.tone-accent { --ring: var(--ss-accent); }
.edits { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.edit { display: flex; gap: 8px; align-items: center; padding: 10px; border: 1px solid var(--ss-accent); border-radius: var(--ss-radius-m); overflow-wrap: anywhere; }
.edit i { color: var(--ss-accent-text); }
.edit-hint { margin: 0; font-size: 0.85em; }
/* The checks: a 34px tile with the d20, the line beside it (wraps under the tile's edge, never over it). The ring is the row's border and
   tint; the words are the theme's text colour (the tone colours are under 4.5:1 on the light glass). */
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.check { --ring: var(--ss-border); display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 4px 10px; align-items: center; padding: 8px 12px;
         border-radius: 12px; border: 1px solid var(--ring); background: color-mix(in srgb, var(--ring) 10%, transparent); color: var(--ss-text, var(--sb-fg)); }
.check.good { --ring: var(--ss-good); }
.check.bad { --ring: var(--ss-bad); }
.check .dice { width: 34px; height: 34px; border-radius: 9px; background: var(--ss-tile); display: flex; align-items: center; justify-content: center;
               font-weight: 800; font-size: 1.15em; color: var(--ss-text); }
.check .what { min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
.check .res { font-weight: 800; }
.check .story { grid-column: 2; justify-self: end; font-size: 0.85em; text-align: right; }
.none { margin: 0; }
.loot { margin-top: 2px; padding-top: 10px; border-top: 1px solid var(--ss-border, var(--sb-border)); display: grid; gap: 6px; }
.loot-head { margin: 0; }
.loot .chips { display: flex; flex-wrap: wrap; gap: 4px; }
.loot .pick { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; padding: 1px 8px; border-radius: 999px;
              border: 1px solid var(--sb-border); background: var(--sb-surface); }
.loot .pick:has(input:checked) { border-color: var(--sb-accent); color: var(--sb-accent); }
.loot .pick input { width: 1em; height: 1em; min-width: 0; margin: 0; accent-color: var(--sb-accent); }
.loot .hint, .loot .taken { margin: 0; font-size: 0.9em; }
.loot .take { justify-self: start; }
/* The lines last: muted and small (the refused and the assist lines). */
.refused, .assisted { display: grid; gap: 4px; margin: 0; padding: 8px 0 0; border-top: 1px solid var(--ss-border, var(--sb-border)); list-style: none;
                      color: var(--ss-muted, var(--sb-em)); font-size: 0.85em; }
.refused .line, .assisted .line { display: flex; gap: 8px; align-items: flex-start; }
.refused .line > i, .assisted .line > i { flex: none; width: 16px; text-align: center; padding-top: 2px; }
.refused .line > span, .assisted .line > span { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; }
.refused .line > i { color: var(--ss-bad-text, var(--ss-bad, var(--sb-em))); }
.assisted .raw, .refused .raw { font-family: var(--monoFontFamily, monospace); font-size: 0.95em; overflow-wrap: anywhere; }
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
/** The most lines one module adds to a reply's card (MODULES §F125). */
export const REPLY_LINES_MAX = 6;
const ICON = /^fa-[a-z0-9-]{1,40}$/;

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

/**
 * The modules' own lines for one reply's card (MODULES §F125). `entries`: [{ moduleId, fn }] (the registry's
 * `hookEntries('replyCard')`); `info`: { index, state, before, changes } of that reply. Each hook is called
 * with a copy of `info`; one that throws or answers anything but a list (a promise too) adds nothing.
 * → [{ module, icon, text, summary, flag, note }], each field one line: text ≤ 200, summary ≤ 80, flag and
 * note ≤ 160 characters; a line without text is left out.
 */
export function replyCardLines(entries, info = {}) {
    const out = [];
    for (const { moduleId, fn } of Array.isArray(entries) ? entries : []) {
        if (typeof fn !== 'function') continue;
        let answer;
        try {
            answer = fn({ index: info.index ?? null, state: info.state ?? null, before: info.before ?? null, changes: [...(info.changes ?? [])] });
        } catch {
            continue;
        }
        if (!Array.isArray(answer)) continue;
        for (const item of answer.slice(0, REPLY_LINES_MAX)) {
            const line = typeof item === 'string' ? { text: item } : item;
            if (!isRecord(line)) continue;
            const text = oneLine(line.text, 200);
            if (!text) continue;
            const check = checkOf(line.check);
            out.push({
                module: String(moduleId ?? ''),
                icon: typeof line.icon === 'string' && ICON.test(line.icon) ? line.icon : 'fa-circle-info',
                text,
                summary: oneLine(line.summary ?? '', 80),
                flag: oneLine(line.flag ?? '', 160),
                note: oneLine(line.note ?? '', 160),
                // A check (`check`) is drawn as a row with its die; any other line is a tile. `tone` (good, bad, warn, info, accent)
                // rings the tile; a check's ring is its result.
                kind: check ? 'check' : 'line',
                tone: check ? check.result === 'success' ? 'good' : 'bad' : toneOf(line.tone),
                check,
            });
        }
    }
    return out;
}

// The RPG's lines (src/v2/lean-rpg/view/changes-lines.js) beside the others: "Rolled for you: 3 exchanges", "Wessel: Soul Class
// II → III". A rise is told by its own line, so the plain "Rule: class-up" line the same rule leaves is left out then.
const RISE_RULE = /\b(class|rank|soul|xp|practice)\b/i;
export function mergeRpgLines(lines, rpg) {
    const own = Array.isArray(rpg) ? rpg : [];
    if (!own.length) return lines;
    const rises = own.some(item => item.icon === 'fa-arrow-up');
    return [...own, ...(rises ? lines.filter(item => !(item.icon === 'fa-bolt' && RISE_RULE.test(item.text))) : lines)];
}

const TONES = ['good', 'bad', 'warn', 'info', 'accent'];
const toneOf = value => (TONES.includes(value) ? value : 'info');
const whole = (value, low, high) => (Number.isInteger(value) && value >= low && value <= high ? value : null);

/**
 * A module's check (`check: { stat, what, d20, roll?, mod?, total?, dc, result?, story? }`) made ready for the card: the label
 * ("AGI — pursuing the wolf"), the modifier ("+ 1 DEX"), the result word, and the note when the story and the dice disagree.
 * Null when the die or the difficulty is not a whole number. `result`, when absent, is worked out from the total against the DC.
 */
function checkOf(raw) {
    if (!isRecord(raw)) return null;
    const d20 = whole(raw.d20, 1, 20);
    const dc = whole(raw.dc, -1000, 1000);
    if (d20 === null || dc === null) return null;
    const mod = whole(raw.mod ?? 0, -100, 100) ?? 0;
    const total = whole(raw.total ?? d20 + mod, -1000, 1000) ?? d20 + mod;
    const result = raw.result === 'success' || raw.result === 'fail' ? raw.result : total >= dc ? 'success' : 'fail';
    const story = raw.story === 'success' || raw.story === 'fail' ? raw.story : '';
    const stat = oneLine(raw.stat ?? '', 12).toUpperCase();
    const what = oneLine(raw.what ?? '', 120);
    const word = value => (value === 'success' ? C.success : C.fail);
    const roll = oneLine(raw.roll ?? '', 12);
    return {
        d20, dc, total, result, story,
        label: stat && what ? `${stat} — ${what}` : stat || what,
        modText: `${mod < 0 ? '−' : '+'} ${Math.abs(mod)}${stat ? ` ${stat}` : ''}`,
        rollText: roll ? fill(C.roll, { roll }) : '',
        word: word(result),
        disagree: story && story !== result ? fill(C.storyDice, { story: word(story), dice: word(result) }) : '',
    };
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
 * (MODULES §F41): "… · 1 line not applied". `assisted` is how many lines the Assist safety net applied on the reply
 * (MODULES §F123): "… · 1 line from the safety net (assist)", so a folded card says so too (the lines are in its body). `lines`: the modules' own lines (replyCardLines), each told by its
 * `summary` (else its `text`) after the rest: "+1 Rope · AGI check 14 vs 10: success". Takes the same fields
 * as changesDigest, or a digest as `digest`. The reader's own edits are not in the line (they are in the opened card).
 */
export function changesSummary({ state = null, before = null, changes = [], currency = null, digest = null, refused = 0, assisted = 0, lines = [] } = {}) {
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
    for (const line of Array.isArray(lines) ? lines : []) {
        const told = oneLine(line?.summary || line?.text || '', 80);
        if (told) parts.push(told);
    }
    const helped = Number.isSafeInteger(assisted) && assisted > 0 ? assisted : 0;
    if (helped) parts.push(helped === 1 ? T.assistedOne : fill(T.assistedMany, { n: helped }));
    const count = Number.isSafeInteger(refused) && refused > 0 ? refused : 0;
    const notApplied = count === 0 ? null : count === 1 ? T.refusedOne : fill(T.refusedMany, { n: count });
    if (parts.length) return [...parts, ...(notApplied ? [notApplied] : [])].join(' · ');
    const nothing = d.other ? T.otherOnly : T.none;
    return notApplied ? `${nothing} · ${notApplied}` : nothing;
}
