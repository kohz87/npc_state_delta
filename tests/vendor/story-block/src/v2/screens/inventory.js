// `story-block/inventory` (SPEC §13.1): the party's things from the head state, grouped by kind, with
// rarity colours, quantities, the wallet in the chat's one currency (MODULES §F1), "Use on…" for a consumable
// (`item.use { stack, target }`, only the members `items.useOn` says a dose would help now: a module's rule,
// none without one), a "To pick up" section with the loot still waiting (the same chips and Take selected as
// the reply's card, so loot works with the cards off), and filters that fill the view's draft (§13.2, §13.6):
// a name box ("Filter…", `draft.find`), what kind, what rarity, equipped only.
//
// Equipment belongs to RPG Battle (its party screen shows who wears what). So the equipment controls are drawn
// only when RPG Battle answers (`q.gear.detail`, the same probe as its item detail): an "Equip on…" picker
// (`item.equip { stack, to }` for an unworn piece, MODULES §F99), the plain Equip, Unequip, the condition, and a "Worn by" tag on a worn
// piece. Without RPG Battle the inventory is the bag and the purse only. Drop is bag management and always there. Its texts are in src/v2/strings.js. Nothing here writes state; the buttons run the core commands
// with the payloads of MODULES §F5 (`inventory.equip { stack }`, `inventory.unequip { stack }`,
// `inventory.drop { stack, qty }`). Equip on…, Use on… and Drop open a fold row BELOW the action row (one open per card); Drop
// asks first there ("Drop …?" and the confirm). The party shares one bag, so there is no Give here (`inventory.transfer` stays
// a core command).

import { KIND_ORDER, RARITIES } from '../domains/inventory.js';
import { STRINGS, html } from '../strings.js';
import { BASE_CSS, RARITY_THEME } from './style.js';

export const INVENTORY_SCREEN_ID = 'story-block/inventory';

const S = STRINGS.inventory;

/** The kinds' group titles (src/v2/strings.js). */
export const KIND_TITLES = S.kinds;

/** The "Worn by" tag's texts (src/v2/strings.js). */
const WORN = Object.freeze({ by: S.wornBy, byParty: S.wornByParty });

// RPG Battle is installed when its item detail answers (`q.gear.detail`, screens/view.js itemDetail). Every
// equipment control is drawn only while this holds.
const RPG = 'q.gear.detail == true';

const KIND_ICONS = Object.freeze({
    quest: 'fa-scroll', equipment: 'fa-shield-halved', consumable: 'fa-flask',
    material: 'fa-cubes', goods: 'fa-box', money: 'fa-gem',
});

// The draft fields start unset, so every test also accepts "never chosen" (null) as "everything".
// `contains` holds for an empty filter text, so the name box filters only once something is typed.
// The equipped-only filter only narrows while RPG Battle is there (its checkbox is drawn only then).
const anyKind = kind => `(draft.kind == null || draft.kind == '' || draft.kind == '${kind}')`;
const ITEM_FILTER = "(draft.rarity == null || draft.rarity == '' || draft.rarity == it.rarity)"
    + ' && (draft.equippedOnly != true || q.gear.detail != true || it.equipped != null)'
    + ' && contains(it.name, draft.find)';
const rarityClasses = name => RARITIES.filter(rarity => rarity !== 'common').map(rarity => `r-${rarity}: ${name}.rarity == '${rarity}'`).join('; ');
const RARITY_CLASSES = rarityClasses('it');

// The actions that open a fold (Equip on…, Use on…, Drop). Each is a real button in the card's action row with aria-expanded and
// aria-controls (the fold row's id): a press sets the card's `fold[stack]` in the view's draft (`data-draft` on a button picks its
// value; a press on the open one closes it), and that one value is the one open fold of the card. The fold opens in a row BELOW the
// action row, so the row does not move. Escape inside the card closes the open fold and the focus goes back to its button
// (`data-draft-close` on the card); Cancel does the same (`data-draft-cancel`). Arrow keys do nothing here: they are not radios.
const foldAction = (kind, when, icon, label, title) => `
          <button type="button" class="ss-button act"${when ? ` data-if="${when}"` : ''} title="${title}" data-draft="fold[it.stack]" value="${kind}" aria-expanded="{{ draft.fold[it.stack] == '${kind}' }}" aria-controls="fold-{{ it.stack }}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</button>`;
const foldPanel = (kind, cls, when, question, body) => `
          <div class="fold ${cls}" id="fold-{{ it.stack }}" role="group" aria-label="${question}" data-if="draft.fold[it.stack] == '${kind}'${when ? ` && ${when}` : ''}">
            <span class="fold-q">${question}</span>${body}
            <button type="button" class="ss-button fold-cancel" data-draft-cancel>${html(S.cancel)}</button>
          </div>`;

function group(kind) {
    return `
  <section class="group" data-kind="${kind}" data-if="${anyKind(kind)}">
    <h4 class="ss-section-label"><i class="fa-solid ${KIND_ICONS[kind]}" aria-hidden="true"></i> ${html(KIND_TITLES[kind])}</h4>
    <ul>
      <li class="item ss-glass" data-each="q.items as it" data-draft-close="fold[it.stack]" data-if="it.kind == '${kind}' && ${ITEM_FILTER}"
          data-class="${RARITY_CLASSES}; equipped: ${RPG} && it.equipped != null">
        <span class="ss-tile-box" aria-hidden="true"><i class="fa-solid ${KIND_ICONS[kind]}"></i><span class="ss-tile-count" data-if="it.qty != 1">{{ it.qty }}</span></span>
        <div class="body">
        <div class="line">
          <span class="name">{{ it.name }}</span>
          <span class="chip eq worn-by" data-if="${RPG} && it.equipped != null && it.owner != 'party'" title="${html(S.equippedTitle)}"><i class="fa-solid fa-check" aria-hidden="true"></i> ${html(WORN.by, { name: '{{ state.party.actors[it.owner].name }}' })}</span>
          <span class="chip eq worn-by" data-if="${RPG} && it.equipped != null && it.owner == 'party' && state.party.pc != null" title="${html(S.equippedTitle)}"><i class="fa-solid fa-check" aria-hidden="true"></i> ${html(WORN.by, { name: '{{ state.party.actors[state.party.pc].name }}' })}</span>
          <span class="chip eq worn-by" data-if="${RPG} && it.equipped != null && it.owner == 'party' && state.party.pc == null" title="${html(S.equippedTitle)}"><i class="fa-solid fa-check" aria-hidden="true"></i> ${html(WORN.byParty)}</span>
          <span class="chip key" data-if="it.key" title="${html(S.keyTitle)}">${html(S.key)}</span>
          <span class="chip carry" data-if="it.carry" title="${html(S.carryTitle)}">+{{ it.carry }} ${html(S.carry)}</span>
          <span class="rarity">{{ it.rarity }}</span>
          <span class="cond muted" data-if="${RPG} && it.cond != null" title="${html(S.condTitle)}">{{ it.cond }}/100</span>
          <span class="owner muted" data-if="it.owner != 'party' && (q.gear.detail != true || it.equipped == null)">{{ state.party.actors[it.owner].name }}</span>
        </div>
        <p class="note muted" data-if="it.note">{{ it.note }}</p>
        <div class="detail" data-if="q.gear.detail == true"><ss-widget name="rpg-battle.item-detail" data-props='{"stack":"{{ it.stack }}"}'></ss-widget></div>
        <div class="actions">
          <button class="ss-button" data-if="${RPG} && it.kind == 'equipment' && it.equipped == null && len(q.gear.members) == 0" data-command="inventory.equip"
                  data-payload='{"stack":"{{ it.stack }}"}' title="${html(S.equipTitle, { name: '{{ it.name }}' })}"><i class="fa-solid fa-hand-fist" aria-hidden="true"></i> ${html(S.equip)}</button>
          ${foldAction('equipOn', `${RPG} && it.kind == 'equipment' && it.equipped == null && len(q.gear.wearers[it.stack]) > 0`, 'fa-hand-fist', html(S.equipOn), html(S.equipOnTitle, { name: '{{ it.name }}' }))}
          ${foldAction('use', "it.kind == 'consumable' && len(q.gear.users[it.stack]) > 0", 'fa-flask', html(S.useOn), html(S.useOnTitle, { name: '{{ it.name }}' }))}
          <button class="ss-button" data-if="${RPG} && it.equipped != null" data-command="inventory.unequip"
                  data-payload='{"stack":"{{ it.stack }}"}' title="${html(S.unequipTitle, { name: '{{ it.name }}' })}">${html(S.unequip)}</button>
          ${foldAction('drop', '', 'fa-trash-can', html(S.drop), html(S.dropTitle, { name: '{{ it.name }}' }))}
        </div>
          ${foldPanel('equipOn', 'equip-on', `${RPG} && it.kind == 'equipment' && it.equipped == null && len(q.gear.wearers[it.stack]) > 0`, html(S.equipOn), `
            <button class="ss-button pick-member" data-each="q.gear.wearers[it.stack] as who" data-command="item.equip"
                    data-payload='{"stack":"{{ it.stack }}","to":"{{ who.id }}"}' title="${html(S.equipOnWho, { name: '{{ it.name }}' })}">{{ who.name }}</button>`)}
          ${foldPanel('use', 'use-on', "it.kind == 'consumable' && len(q.gear.users[it.stack]) > 0", html(S.useOn), `
            <button class="ss-button" data-each="q.gear.users[it.stack] as who" data-command="item.use"
                    data-payload='{"stack":"{{ it.stack }}","target":"{{ who.id }}"}' title="${html(S.useOnWho, { name: '{{ it.name }}' })}">{{ who.name }}</button>`)}
          ${foldPanel('drop', 'drop', '', html(S.dropAsk, { name: '{{ it.name }}' }), `
            <button class="ss-button ss-button-danger" data-if="it.qty != 1" data-command="inventory.drop"
                    data-payload='{"stack":"{{ it.stack }}","qty":1}'>${html(S.dropOne)}</button>
            <button class="ss-button ss-button-danger" data-command="inventory.drop"
                    data-payload='{"stack":"{{ it.stack }}","qty":{{ it.qty }}}'><span data-if="it.qty != 1">${html(S.dropAll, { qty: '{{ it.qty }}' })}</span><span data-if="it.qty == 1">${html(S.drop)}</span></button>`)}
        </div>
      </li>
    </ul>
  </section>`;
}

const TEMPLATE = `
<div class="inv">
  <header class="top">
    <div class="wallet" title="${html(S.walletTitle)}">
      <i class="fa-solid fa-coins" aria-hidden="true"></i>
      <span data-if="len(q.currency.coins) == 0"><b data-if="q.wallet.coin">{{ q.wallet.coin }}</b><b data-if="!q.wallet.coin">0</b>
      <span><span data-if="q.wallet.coin == 1">{{ q.currency.name }}</span><span data-if="q.wallet.coin != 1">{{ q.currency.plural }}</span></span></span>
      <span data-if="len(q.currency.coins) > 0"><b data-if="q.wallet.coin">{{ fmt.money(q.wallet.coin) }}</b><b data-if="!q.wallet.coin">{{ fmt.money(0) }}</b></span>
    </div>
    <div class="filter" role="search" aria-label="${html(S.filterLabel)}" data-if="len(q.items) > 0">
      <input type="search" class="find" data-draft="find" placeholder="${html(S.find)}" title="${html(S.findTitle)}"
             aria-label="${html(S.findTitle)}" autocomplete="off">
      <label>${html(S.show)}
        <select data-draft="kind">
          <option value="">${html(S.everything)}</option>
${KIND_ORDER.map(kind => `          <option value="${kind}"${kind === 'equipment' ? ` data-if="${RPG}"` : ''}>${html(KIND_TITLES[kind])}</option>`).join('\n')}
        </select>
      </label>
      <label>${html(S.rarity)}
        <select data-draft="rarity">
          <option value="">${html(S.any)}</option>
${RARITIES.map(rarity => `          <option value="${rarity}">${html(S.rarities[rarity])}</option>`).join('\n')}
        </select>
      </label>
      <label class="check" data-if="${RPG}"><input type="checkbox" data-draft="equippedOnly"> ${html(S.equippedOnly)}</label>
    </div>
  </header>
  <section class="loot" data-if="len(q.loot) > 0">
    <h4 class="ss-section-label"><i class="fa-solid fa-sack-dollar" aria-hidden="true"></i> ${html(S.lootTitle)}</h4>
    <div class="offer" data-each="q.loot as o">
      <p class="loot-head"><b>${html(S.lootWhere)}</b><span class="where" data-if="o.where"> — {{ o.where }}</span></p>
      <div class="chips">
        <label class="chip pick" data-each="o.items as it, i"><input type="checkbox" data-draft="loot[o.sid]" value="{{ i }}"> <span>{{ it.name }}</span><span class="n" data-if="it.qty != 1"> ×{{ it.qty }}</span></label>
      </div>
      <p class="hint muted">${html(S.lootPick)}</p>
      <button class="ss-button ss-button-primary take" data-command="inventory.lootTake" data-payload='{"sid":"{{ o.sid }}","pick":{{ draft.loot[o.sid] }}}'
              title="${html(S.lootTakeTitle)}"><i class="fa-solid fa-hand" aria-hidden="true"></i> ${html(S.lootTake)}</button>
    </div>
  </section>
  <p class="empty muted" data-if="len(q.items) == 0">${html(S.empty)}</p>
  <div class="groups">${KIND_ORDER.map(group).join('')}
  </div>
  <p class="nomatch muted" data-if="len(q.items) > 0">${html(S.noMatch)}</p>
</div>`;

const CSS = `${BASE_CSS}
.inv { display: grid; gap: var(--sb-gap); }
.top { display: flex; flex-wrap: wrap; gap: var(--sb-gap); align-items: center; justify-content: space-between; }
.wallet { display: inline-flex; gap: 6px; align-items: baseline; font-size: 1.05em; }
.wallet i { color: var(--sb-accent); }
.filter { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: 0.85em; }
.filter label { display: inline-flex; gap: 4px; align-items: center; }
.filter select, .filter .find { font: inherit; color: var(--sb-fg); background: var(--sb-surface); border: 1px solid var(--sb-border);
                 border-radius: 6px; padding: 1px 4px; margin: 0; box-shadow: none; transition: border-color 0.15s ease; }
.filter .find { flex: 1 1 9em; min-width: 7em; max-width: 100%; width: auto; height: auto; padding: 2px 8px; box-sizing: border-box; }
.filter .find::placeholder { color: var(--sb-em); opacity: 1; }
.filter select:focus-visible, .filter .find:focus-visible { outline: none; border-color: var(--sb-accent); }
.filter .check input { flex: 0 0 auto; width: 1em; height: 1em; min-width: 0; margin: 0; accent-color: var(--sb-accent); }
.groups { display: grid; gap: var(--sb-gap); }
.group:not(:has(.item)) { display: none; }
.nomatch { display: none; }
.groups:not(:has(.item)) + .nomatch { display: block; }
.item { --rarity: var(--sb-common); padding: 12px; margin: 0 0 4px; border-radius: var(--ss-radius-l, 14px); transition: box-shadow 0.15s ease; }
/* UI 5b: an item is a glass card: its tile (the kind's icon, the count in the corner) with the rarity ring, the name and the actions beside it */
.item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; }
.item > .body { display: grid; gap: 6px; min-width: 0; }
.item .ss-tile-box { --rarity-ring: var(--rarity); width: 44px; height: 44px; border: 2px solid var(--rarity); border-radius: var(--ss-radius-m, 12px); }
.item .ss-tile-count { right: -6px; bottom: -6px; }
.item.r-uncommon { --rarity: var(--sb-uncommon); }
.item.r-rare { --rarity: var(--sb-rare); }
.item.r-epic { --rarity: var(--sb-epic); }
.item.r-legendary { --rarity: var(--sb-legendary); }
.item.equipped { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sb-accent) 45%, transparent); }
.line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.name { font-weight: 600; color: var(--rarity); }
.qty { font-variant-numeric: tabular-nums; }
.rarity { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--rarity); opacity: 0.85; }
.eq { color: var(--sb-accent); }
/* The "Worn by" tag is text: the foreground colour (the accent is too faint for small text on glass); its tick keeps the accent. */
.item .worn-by { color: var(--sb-fg); }
.worn-by > i { color: var(--sb-accent); }
.owner { font-size: 0.85em; }
.note { margin: 2px 0 0; font-size: 0.85em; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.act { cursor: pointer; }
.act[aria-expanded="true"] { border-color: var(--sb-accent); }
.act:focus-visible, .fold-cancel:focus-visible, .fold .ss-button:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: 2px; }
/* The fold row: a hairline above it, the question muted, the members as accent-soft buttons, Cancel plain (the design's Equip on… row). */
.fold { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 0 0; border-top: 1px solid var(--sb-border); }
.fold .fold-q { flex-basis: 100%; color: var(--sb-em); font-weight: 400; }
.fold .pick-member { background: color-mix(in srgb, var(--sb-accent) 24%, transparent); border-color: var(--sb-accent); }
.fold .ss-button { min-height: 44px; }
/* The danger tone is the confirm's text and ring, never a filled background (the Drop action itself is a plain button). The text is the
   theme's error text (4.5:1 on the glass); --sb-bad is a fixed #d9534f (3.3 to 4.0:1), so it stays the ring only. */
.fold .ss-button-danger { background: transparent; color: var(--ss-bad-text, var(--sb-bad)); border-color: var(--sb-bad); }
.loot { display: grid; gap: 6px; }
.loot .offer { display: grid; gap: 4px; padding: 6px 8px; border-radius: 6px; background: var(--sb-raised); }
.loot .loot-head, .loot .hint { margin: 0; }
.loot .hint { font-size: 0.85em; }
.loot .chips { display: flex; flex-wrap: wrap; gap: 4px; }
.loot .pick { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; padding: 1px 8px; border-radius: 999px;
              border: 1px solid var(--sb-border); background: var(--sb-surface); }
.loot .pick:has(input:checked) { border-color: var(--sb-accent); color: var(--sb-accent); }
.loot .pick input { width: 1em; height: 1em; min-width: 0; margin: 0; accent-color: var(--sb-accent); }
.loot .take { justify-self: start; }
.cond { font-size: 0.8em; font-variant-numeric: tabular-nums; }
@media (max-width: 480px) { .filter { width: 100%; } }
/* Every action is a 44px target (Equip on…, Use on…, Unequip, Drop, and the fold rows' buttons). */
.actions .ss-button { min-height: 44px; }
`;

export const inventoryScreen = Object.freeze({
    id: INVENTORY_SCREEN_ID,
    title: S.title,
    icon: 'fa-box-open',
    mounts: Object.freeze(['tab', 'screen']),
    data: Object.freeze({
        items: Object.freeze({ query: 'inventory.items' }),
        wallet: Object.freeze({ query: 'inventory.wallet', args: Object.freeze({ owner: 'party' }) }),
        currency: Object.freeze({ query: 'inventory.currency' }),
        // Who wears what, who may put each piece on, where Give may hand it (MODULES §F99).
        gear: Object.freeze({ query: 'inventory.equipment' }),
        // The loot laid out and not yet taken, so it can be taken with the cards off too.
        loot: Object.freeze({ query: 'inventory.loot' }),
    }),
    theme: RARITY_THEME,
    template: TEMPLATE,
    css: CSS,
});
