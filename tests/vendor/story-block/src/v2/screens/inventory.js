// Inventory shows the wallet, items, loot and bag actions.

import { KIND_ORDER, RARITIES } from '../domains/inventory.js';
import { STRINGS, html, jsonText } from '../strings.js';
import { INVENTORY_ADD_WIDGET } from './inventory-add.js';
import { BASE_CSS, RARITY_THEME } from './style.js';

export const INVENTORY_SCREEN_ID = 'story-block/inventory';

const S = STRINGS.inventory;
const G = S.gear;

/** The kinds' group titles (src/v2/strings.js). */
export const KIND_TITLES = S.kinds;

const KIND_ICONS = Object.freeze({
    quest: 'fa-scroll', equipment: 'fa-shield-halved', consumable: 'fa-flask',
    material: 'fa-cubes', goods: 'fa-box', money: 'fa-gem',
});

// The draft fields start unset, so every test also accepts "never chosen" (null) as "everything".
// `contains` holds for an empty filter text, so the name box filters only once something is typed.
// The equipped-only filter narrows the visible items.
const anyKind = kind => `(draft.kind == null || draft.kind == '' || draft.kind == '${kind}')`;
const ITEM_FILTER = "(draft.rarity == null || draft.rarity == '' || draft.rarity == it.rarity)"
    + ' && (draft.equippedOnly != true || it.equipped != null)'
    + ' && contains(it.name, draft.find)';
const rarityClasses = name => RARITIES.filter(rarity => rarity !== 'common').map(rarity => `r-${rarity}: ${name}.rarity == '${rarity}'`).join('; ');
const RARITY_CLASSES = rarityClasses('it');

// The actions that open a fold (Use on… and Drop). Each is a real button in the card's action row with aria-expanded and
// aria-controls (the fold row's id): a press sets the card's `fold[stack]` in the view's draft (`data-draft` on a button picks its
// value; a press on the open one closes it), and that one value is the one open fold of the card. The fold opens in a row BELOW the
// name and the actions, so the row does not move. Escape inside the card closes the open fold and the focus goes back to its button
// (`data-draft-close` on the card); Cancel does the same (`data-draft-cancel`). Arrow keys do nothing here: they are not radios.
const foldAction = (kind, when, icon, label, title) => `
          <button type="button" class="ss-button act"${when ? ` data-if="${when}"` : ''} title="${title}" data-draft="fold[it.stack]" value="${kind}" aria-expanded="{{ draft.fold[it.stack] == '${kind}' }}" aria-controls="fold-{{ it.stack }}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</button>`;
const foldPanel = (kind, cls, when, question, body) => `
          <div class="fold ${cls}" id="fold-{{ it.stack }}" role="group" aria-label="${question}" data-if="draft.fold[it.stack] == '${kind}'${when ? ` && ${when}` : ''}">
            <span class="fold-q">${question}</span>${body}
            <button type="button" class="ss-button fold-cancel" data-draft-cancel>${html(S.cancel)}</button>
          </div>`;

// A cast member's signature piece (gear on) is bound: it has no Drop (and its Edit is locked, see the Edit form).
const BOUND_FREE = "q.gx.rows[it.stack].bound == null";
// The lock of a bound chip: the app's own ph-lock-simple (solid), drawn by the badge widget (a template cannot carry an svg's path).
const LOCK = `<ss-widget class="bound-lock" name="ss.badge" data-props='{"icon":"ph-lock-simple:fill","label":"${jsonText(G.bound)}"}'></ss-widget>`;

// With Gear in fights on (`q.gx` answers; it is null while off) the same card gains the gear parts; `group(kind)` without `gear` is the template as it
// always was, so the gear-off render is exactly that.
function group(kind, gear = false) {
    const row = 'q.gx.rows[it.stack]';
    const edit = `{"value":"{{ it.name }}","itemCount":{{ q.counts[it.stack] }},"itemNote":"{{ it.note }}","displayValue":false,"kind":"item","label":"${jsonText(S.editItem)}","command":"inventory.edit","payload":{"stack":"{{ it.stack }}","group":true}${gear
        ? `,"gear":{"kind":"{{ it.kind }}","stack":"{{ it.stack }}","owner":"{{ it.owner }}","by":"{{ ${row}.byId }}","place":"{{ ${row}.place }}","slot":"{{ ${row}.slotKey }}","bound":"{{ ${row}.bound.who }}","def":"{{ it.def }}","rarity":"{{ it.rarity }}","row":{{ ${row} }},"kit":{{ q.gx.kit.open }},"owners":{{ q.gx.owners }}}` : ''}}`;
    // The chips and the condition of a row: today's, or (gear on) the slot, who wears it and the condition bar with its word.
    const chips = gear ? `
          <span class="rarity">{{ it.rarity }}</span>
          <span class="chip slot" data-if="it.kind == 'equipment' && it.slot != null" title="${html(G.slotTitle)}">{{ it.slot }}</span>` : `
          <span class="chip eq worn-by" data-if="it.equipped != null && it.owner == 'party'" title="${html(S.equippedTitle)}">${html(S.wornByParty)}</span>
          <span class="chip key" data-if="it.key" title="${html(S.keyTitle)}">${html(S.key)}</span>
          <span class="chip carry" data-if="it.carry" title="${html(S.carryTitle)}">+{{ it.carry }} ${html(S.carry)}</span>
          <span class="rarity">{{ it.rarity }}</span>
          <span class="cond muted" data-if="it.cond != null" title="${html(S.condTitle)}">{{ it.cond }}/100</span>
          <span class="owner muted" data-if="it.owner != 'party'">{{ state.party.actors[it.owner].name }}</span>`;
    // Gear on, line 2: who has it (Equipped · name, or the lock and Bound · name for a cast member's signature piece), the key, who carries it.
    // The line is always there, so every row is as tall as the next.
    const line2 = `
        <div class="g-l2">
          <span class="chip eq worn-by" data-if="${row}.by != '' && ${row}.bound == null" title="${html(G.equippedByTitle, { name: '{{ ' + row + '.by }}' })}">${html(G.equippedBy, { name: '{{ ' + row + '.by }}' })}</span>
          <span class="chip eq worn-by bound" data-if="${row}.bound != null" title="${html(G.boundTitle, { name: '{{ ' + row + '.bound.who }}' })}">${LOCK}${html(G.boundBy, { name: '{{ ' + row + '.bound.who }}' })}</span>
          <span class="chip key" data-if="it.key" title="${html(S.keyTitle)}">${html(S.key)}</span>
          <span class="owner muted" data-if="it.owner != 'party'">{{ state.party.actors[it.owner].name }}</span>
        </div>`;
    // Line 3: the stat bonus, the condition bar and word, then the note (muted), one line.
    const detail = gear ? `
        <div class="detail gear-line g-l3">
          <span class="bonus" data-if="${row}.bonus != ''">{{ ${row}.bonus }}</span>
          <span class="carry-note" data-if="it.carry">+{{ it.carry }} ${html(S.carry)}</span>
          <span class="cbar" data-if="it.kind == 'equipment'" title="${html(G.condTitle)}" data-bind-var="--ss-fill: ${row}.fill" data-class="w-worn: ${row}.word == 'worn'; w-torn: ${row}.word == 'torn'; w-broken: ${row}.word == 'broken'"><i></i></span>
          <span class="cword" data-if="it.kind == 'equipment'" data-class="w-worn: ${row}.word == 'worn'; w-torn: ${row}.word == 'torn'; w-broken: ${row}.word == 'broken'">${['good', 'worn', 'torn', 'broken'].map(word => `<span data-if="${row}.word == '${word}'">${html(G.words[word])}</span>`).join('')}<span data-if="${row}.broken"> ${html(G.brokenNoBonus)}</span></span>
          <p class="note muted" data-if="it.note">{{ it.note }}</p>
        </div>` : '';
    const buttons = gear ? '' : `
          <button class="ss-button" data-if="it.kind == 'equipment' && it.equipped == null" data-command="inventory.equip"
                  data-payload='{"stack":"{{ it.stack }}"}' title="${html(S.equipTitle, { name: '{{ it.name }}' })}"><i class="fa-solid fa-hand-fist" aria-hidden="true"></i> ${html(S.equip)}</button>`;
    const unequip = gear ? '' : `
          <button class="ss-button" data-if="it.equipped != null" data-command="inventory.unequip"
                  data-payload='{"stack":"{{ it.stack }}"}' title="${html(S.unequipTitle, { name: '{{ it.name }}' })}">${html(S.unequip)}</button>`;
    return `
  <section class="group" data-kind="${kind}" data-if="${gear ? `q.gx != null && ${anyKind(kind)}` : `q.gx == null && ${anyKind(kind)}`}">
    <h4 class="ss-section-label"><i class="fa-solid ${KIND_ICONS[kind]}" aria-hidden="true"></i> ${html(KIND_TITLES[kind])}</h4>
    <ul>
      <li class="item ss-glass${gear ? ' grow' : ''}" data-each="q.items as it" data-draft-close="fold[it.stack]" data-if="it.kind == '${kind}' && ${ITEM_FILTER}"
          data-class="${RARITY_CLASSES}; equipped: it.equipped != null${gear ? `; broken: ${row}.broken` : ''}">
        <span class="ss-tile-box" aria-hidden="true"><i class="fa-solid ${KIND_ICONS[kind]}"></i><span class="ss-tile-count" data-if="it.qty != 1">{{ it.qty }}</span></span>
        <div class="body">
        <div class="line${gear ? ' g-l1' : ''}">
          <span class="name">{{ it.name }}</span>
          <span class="item-edit" data-inline-control="ss.editable" data-props='${edit}'></span>${chips}
        </div>${gear ? line2 : `
        <p class="note muted" data-if="it.note">{{ it.note }}</p>`}${detail}
        <div class="actions">${buttons}
          ${foldAction('use', "it.kind == 'consumable' && len(q.gear.users[it.stack]) > 0", 'fa-flask', html(S.useOn), html(S.useOnTitle, { name: '{{ it.name }}' }))}${unequip}
          ${foldAction('drop', gear ? BOUND_FREE : '', 'fa-trash-can', html(S.drop), html(S.dropTitle, { name: '{{ it.name }}' }))}
        </div>
          ${foldPanel('use', 'use-on', "it.kind == 'consumable' && len(q.gear.users[it.stack]) > 0", html(S.useOn), `
            <button class="ss-button" data-each="q.gear.users[it.stack] as who" data-command="item.use"
                    data-payload='{"stack":"{{ it.stack }}","target":"{{ who.id }}"}' title="${html(S.useOnWho, { name: '{{ it.name }}' })}">{{ who.name }}</button>`)}
          ${foldPanel('drop', 'drop', gear ? BOUND_FREE : '', html(S.dropAsk, { name: '{{ it.name }}' }), `
            <button class="ss-button ss-button-danger" data-if="it.qty != 1" data-command="inventory.drop"
                    data-payload='{"stack":"{{ it.stack }}","qty":1}'>${html(S.dropOne)}</button>
            <button class="ss-button ss-button-danger" data-command="inventory.drop"
                    data-payload='{"stack":"{{ it.stack }}","qty":{{ it.qty }}}'><span data-if="it.qty != 1">${html(S.dropAll, { qty: '{{ it.qty }}' })}</span><span data-if="it.qty == 1">${html(S.drop)}</span></button>`)}
        </div>
      </li>
    </ul>
  </section>`;
}

// With Gear in fights on, the sections come in this order (equipment first); the kinds it does not name follow, so nothing is hidden.
const GEAR_ORDER = Object.freeze(['equipment', 'consumable', 'goods', 'quest', 'material', 'money']);

const CARRY = `<section class="carry-sec" data-if="q.gx != null">
    <h4 class="ss-section-label"><i class="fa-solid fa-weight-hanging" aria-hidden="true"></i> ${html(G.carry)}</h4>
    <ul>
      <li class="item ss-glass carry-card" aria-label="${html(G.carryLabel)}" data-class="heavy: q.gx.carry.level == 'heavy'; over: q.gx.carry.level == 'over'">
        <div class="carry-line"><b class="carry-num">{{ q.gx.carry.load }} / {{ q.gx.carry.capacity }}</b>
          <span class="carry-state" data-if="q.gx.carry.level == 'heavy'">${html(G.heavy)}</span>
          <span class="carry-state" data-if="q.gx.carry.level == 'over'">${html(G.over, { n: '{{ q.gx.carry.lose }}' })}</span></div>
        <div class="ss-bar-track carry-bar" data-bind-var="--ss-fill: ratio(q.gx.carry.load, q.gx.carry.capacity)"><div class="ss-bar-fill"></div></div>
        <p class="carry-break muted" data-if="q.gx.carry.breakdown != ''">{{ q.gx.carry.breakdown }}</p>
        <p class="carry-break carry-away muted" data-each="q.gx.carry.away as line">{{ line }}</p>
      </li>
    </ul>
  </section>`;

const TEMPLATE = `
<div class="inv" data-class="gear: q.gx != null">
  <header class="top">
    <div class="wallet-and-add">
    <div class="wallet" title="${html(S.walletTitle)}">
      <i class="fa-solid fa-coins" aria-hidden="true"></i>
      <span data-if="len(q.currency.coins) == 0"><b data-if="q.wallet.coin">{{ q.wallet.coin }}</b><b data-if="!q.wallet.coin">0</b>
      <span><span data-if="q.wallet.coin == 1">{{ q.currency.name }}</span><span data-if="q.wallet.coin != 1">{{ q.currency.plural }}</span></span></span>
      <span data-if="len(q.currency.coins) > 0"><b data-if="q.wallet.coin">{{ fmt.money(q.wallet.coin) }}</b><b data-if="!q.wallet.coin">{{ fmt.money(0) }}</b></span>
    <span data-inline-control="ss.editable" data-props='{"value":{{ q.wallet.coin }},"displayValue":false,"money":true,"currency":{{ q.currency }},"label":"${jsonText(S.editPurse)}","command":"wallet.set","valueKey":"amount"}'></span>
    </div>
    <span data-inline-control="${INVENTORY_ADD_WIDGET}"></span>
    </div>
    <div class="filter" role="search" aria-label="${html(S.filterLabel)}" data-if="len(q.items) > 0">
      <input type="search" class="find" data-draft="find" placeholder="${html(S.find)}" title="${html(S.findTitle)}"
             aria-label="${html(S.findTitle)}" autocomplete="off">
      <label>${html(S.show)}
        <select data-draft="kind">
          <option value="">${html(S.everything)}</option>
${KIND_ORDER.map(kind => `          <option value="${kind}">${html(KIND_TITLES[kind])}</option>`).join('\n')}
        </select>
      </label>
      <label>${html(S.rarity)}
        <select data-draft="rarity">
          <option value="">${html(S.any)}</option>
${RARITIES.map(rarity => `          <option value="${rarity}">${html(S.rarities[rarity])}</option>`).join('\n')}
        </select>
      </label>
      <label class="check"><input type="checkbox" data-draft="equippedOnly"> ${html(S.equippedOnly)}</label>
    </div>
  </header>${CARRY}
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

  <div class="groups">${GEAR_ORDER.map(kind => group(kind, true).trim()).join('')}${KIND_ORDER.map(kind => group(kind)).join('')}
  </div>
  <p class="nomatch muted" data-if="len(q.items) > 0">${html(S.noMatch)}</p>
</div>`;

const CSS = `${BASE_CSS}
.inv { display: grid; gap: var(--sb-gap); }
.top { display: flex; flex-wrap: wrap; gap: var(--sb-gap); align-items: center; }
.wallet-and-add { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.wallet { display: inline-flex; gap: 6px; align-items: center; font-size: 1.05em; }
.wallet i { color: var(--sb-accent); }
.inv-add-form { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.inv-add-form input { width: 10em; max-width: 100%; }
.inv-add-error { flex-basis: 100%; color: var(--ss-bad-text); }
/* Gear in fights: "+ Add item" opens the grouped form full width under the button; while a row is being edited on a phone it takes the whole row. */
.wallet-and-add:has(.inv-add-gear) { display: flex; width: 100%; }
.wallet-and-add:has(.inv-add-gear) > :has(.inv-add-gear) { flex: 1 1 100%; min-width: 0; }
/* the slim 32px boxes only where there is room and a fine pointer; a phone keeps size.css's 44px controls */
@media (min-width: 760px) and (pointer: fine) {
  .ss-w-editable-group input, .ss-w-editable-group select { box-sizing: border-box !important; min-height: 32px !important; height: 32px !important; }
}
.ss-w-inventory-add:has(.inv-add-gear), .inv-add-gear, .inv-add-gear > .ss-w-editable { display: block; width: 100%; min-width: 0; }
.inv.gear .item:has(.ss-w-editable-gear) > .body > .actions { display: none; }
@media (max-width: 600px) {
  .inv.gear .item:has(.ss-w-editable-gear) > .ss-tile-box { display: none; }
  .inv.gear .item.grow:has(.ss-w-editable-gear) { grid-template-columns: minmax(0, 1fr); }
}
.filter { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin-left: auto; font-size: 0.85em; }
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
.item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: center; }
.item:has(> .body > .fold) { align-items: start; }
/* The body: the name line, the note and the item detail in the left column; the actions on the right, at most half the row (more
   buttons than fit wrap as a group on the right); an open fold below both. The text and the actions are centred on each other: the
   actions span the text's rows and a 1fr row above and below them, which take the room when the actions are the taller. */
.item > .body { display: grid; grid-template-columns: minmax(0, 1fr) fit-content(50%); grid-template-rows: 1fr auto auto auto 1fr auto; column-gap: 12px; row-gap: 0; align-items: center; min-width: 0; }
.item > .body > .line { grid-column: 1; grid-row: 2; }
.item > .body > .note { grid-column: 1; grid-row: 3; margin-top: 6px; }
.item > .body > .detail { grid-column: 1; grid-row: 4; margin-top: 6px; }
/* The text column never reaches under the actions: it may shrink below its longest word, a long name breaks anywhere and the chips
   (Worn by, the condition, key, carry) wrap to the next line, each cut to the column. */
.item > .body > :is(.line, .note, .detail) { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.item > .body > .line > * { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.item > .body > .actions { grid-column: 2; grid-row: 1 / 6; justify-content: flex-end; margin: 0; }
.item > .body > .fold { grid-column: 1 / -1; grid-row: 6; margin-top: 8px; }
.item .ss-tile-box { --rarity-ring: var(--rarity); width: 44px; height: 44px; border: 2px solid var(--rarity); border-radius: var(--ss-radius-m, 12px); }
.item .ss-tile-count { right: -6px; bottom: -6px; }
.item.r-uncommon { --rarity: var(--sb-uncommon); }
.item.r-rare { --rarity: var(--sb-rare); }
.item.r-epic { --rarity: var(--sb-epic); }
.item.r-legendary { --rarity: var(--sb-legendary); }
.item.equipped { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sb-accent) 45%, transparent); }
.line { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.line:has(.ss-w-editable-item-form) > :not(.item-edit) { display: none; }
.line:has(.ss-w-editable-item-form) > .item-edit, .line .ss-w-editable:has(.ss-w-editable-item-form) { width: 100%; }
.item > .body:has(.ss-w-editable-item-form) > .note { display: none; }
.name { font-weight: 600; color: var(--rarity); }
.qty { font-variant-numeric: tabular-nums; }
.rarity { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--rarity); opacity: 0.85; }
.eq { color: var(--sb-accent); }
/* The "Worn by" tag is text: the foreground colour (the accent is too faint for small text on glass); its tick keeps the accent. */
.item .worn-by { color: var(--sb-fg); }
.worn-by > i { color: var(--sb-accent); }
.owner { font-size: 0.85em; }
.note { margin: 2px 0 0; font-size: 0.85em; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
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
/* ---- Gear in fights (the .gear class is on only while it is on) ---- */
.inv.gear, .inv.gear .groups { gap: 22px; }
.inv.gear .top { gap: 8px 12px; }
/* "+ Add item" is the slim pill of the filter row's height, on one line, wherever it sits. */
.inv.gear .wallet-and-add { flex-wrap: wrap; }
.inv.gear .ss-w-inventory-add > button.ss-button { min-height: 0; padding: 4px 12px; font-size: 12px; line-height: 1.3; white-space: nowrap; flex: 0 0 auto; width: auto; }
.carry-sec { display: grid; gap: 8px; }
.carry-sec > ul { margin: 0; }
/* The Carry card is an item row's card: its content is one column (the load and its state, the bar, the breakdown). */
.item.carry-card { grid-template-columns: minmax(0, 1fr); gap: 8px; align-items: stretch; margin-bottom: 0; }
.carry-line { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; }
.carry-num { font-variant-numeric: tabular-nums; color: var(--ss-good, var(--sb-good)); }
.carry-bar { height: 8px; }
.carry-card .ss-bar-fill { --ss-bar-color: var(--ss-good, var(--sb-good)); }
.carry-card.heavy .carry-line, .carry-card.heavy .carry-line .carry-num { color: var(--ss-warn-text, #e0b04a); }
.carry-card.heavy .ss-bar-fill { --ss-bar-color: var(--ss-warn, #e0b04a); }
.carry-card.over .carry-line, .carry-card.over .carry-line .carry-num { color: var(--ss-bad-text, var(--sb-bad)); }
.carry-card.over .ss-bar-fill { --ss-bar-color: var(--ss-bad, var(--sb-bad)); }
.carry-break { margin: 0; font-size: 0.8em; }
.carry-away { opacity: 0.75; }
.chip.slot { text-transform: uppercase; letter-spacing: 0.04em; font-size: 0.7em; }
.gear-line { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-size: 0.8em; }
.gear-line .bonus { color: var(--rarity); font-weight: 600; font-variant-numeric: tabular-nums; }
.gear-line .carry-note { color: var(--sb-em); }
.cbar { --ss-fill: 1; position: relative; display: inline-block; width: 38px; height: 4px; border-radius: 2px; background: var(--ss-track, rgba(127, 127, 127, 0.3)); overflow: hidden; }
.cbar > i { position: absolute; inset: 0 auto 0 0; width: calc(var(--ss-fill, 1) * 100%); border-radius: inherit; background: var(--ss-good, var(--sb-good)); }
.cbar.w-worn > i { background: var(--ss-warn, #e0b04a); }
.cbar.w-torn > i { background: color-mix(in srgb, var(--ss-warn, #e0b04a) 55%, var(--ss-bad, var(--sb-bad))); }
.cbar.w-broken > i { background: var(--ss-bad, var(--sb-bad)); }
.cword { color: var(--ss-good, var(--sb-good)); }
.cword.w-worn { color: var(--ss-warn-text, #e0b04a); }
.cword.w-torn { color: color-mix(in srgb, var(--ss-warn-text, #e0b04a) 55%, var(--ss-bad-text, var(--sb-bad))); }
.cword.w-broken { color: var(--ss-bad-text, var(--sb-bad)); }
.item.broken .name { text-decoration: none; }
/* ---- Gear on: every row is three lines (name, pencil, rarity word, slot chip / who has it / bonus, condition, note), the same height, the same text
   edge; the compact Drop sits in the middle of the row. The row being edited keeps the form above (no fixed lines then). ---- */
.inv.gear .item.grow:not(:has(.ss-w-editable-item-form)) { min-height: 84px; box-sizing: border-box; padding-top: 12px; padding-bottom: 12px; }
.inv.gear .item.grow:not(:has(.ss-w-editable-item-form)) > .body { grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: 20px 16px 16px; row-gap: 4px; column-gap: 10px; align-items: center; }
.inv.gear .item.grow:not(:has(.ss-w-editable-item-form)) > .body > :is(.g-l1, .g-l2, .g-l3) { grid-column: 1; grid-row: auto; display: flex; flex-wrap: nowrap; align-items: center; gap: 6px; min-width: 0; margin: 0; overflow: hidden; white-space: nowrap; }
.inv.gear .item.grow:not(:has(.ss-w-editable-item-form)) > .body > .g-l1 { height: 20px; }
.inv.gear .item.grow:not(:has(.ss-w-editable-item-form)) > .body > :is(.g-l2, .g-l3) { height: 16px; }
.inv.gear .item.grow:not(:has(.ss-w-editable-item-form)) > .body > .actions { grid-column: 2; grid-row: 1 / 4; align-self: center; justify-self: end; margin: 0; }
.inv.gear .item.grow:not(:has(.ss-w-editable-item-form)) > .body > .fold { grid-column: 1 / -1; grid-row: 4; }
.inv.gear .item.grow .actions .ss-button { min-height: 32px; height: 32px; padding: 0 10px; font-size: 12px; }
.inv.gear .g-l1 > .name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.inv.gear .g-l1 > :not(.name) { flex: none; }
.inv.gear .g-l1 .item-edit .ss-w-editable-pencil { height: 18px; min-height: 0; min-width: 0; padding: 0 2px; margin: 0; }
.inv.gear .g-l1 .rarity { font-size: 9px; }
.inv.gear .g-l2 .chip.eq { display: inline-flex; align-items: center; }
.inv.gear .item.grow .g-l3 { font-size: 1em; }
.inv.gear .g-l3 .note { flex: 1 1 0; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.inv.gear .item.grow:has(.ss-w-editable-item-form) > .body > :is(.g-l2, .g-l3) { display: none; }
.chip.bound { display: inline-flex; align-items: center; }
.bound > .bound-lock { display: inline-flex; flex: none; margin: 0 3px 0 0; }
.bound > .bound-lock .ss-w-badge { padding: 0; border: 0; background: none; min-height: 0; gap: 0; }
.bound > .bound-lock .ss-w-badge-icon { color: inherit; display: inline-flex; }
.bound > .bound-lock .ss-icon-svg { width: 9px; height: 9px; }
/* The rarity word is for desktop widths: on a phone the name's colour already says it. */
@media (max-width: 500px) { .inv.gear .g-l1 { gap: 4px; } .inv.gear .g-l1 .rarity { display: none; } .inv.gear .g-l1 .chip.slot { padding: 0 4px; } }
`;

export const inventoryScreen = Object.freeze({
    id: INVENTORY_SCREEN_ID,
    title: S.title,
    icon: 'fa-box-open',
    bar: true,
    mounts: Object.freeze(['tab', 'screen']),
    data: Object.freeze({
        items: Object.freeze({ query: 'inventory.items' }),
        counts: Object.freeze({ query: 'inventory.counts' }),
        wallet: Object.freeze({ query: 'inventory.wallet', args: Object.freeze({ owner: 'party' }) }),
        currency: Object.freeze({ query: 'inventory.currency' }),
        // Who wears what, who may put each piece on, where Give may hand it (MODULES §F99).
        gear: Object.freeze({ query: 'inventory.equipment' }),
        // The loot laid out and not yet taken, so it can be taken with the cards off too.
        loot: Object.freeze({ query: 'inventory.loot' }),
        // Gear in fights (Settings -> RPG): the Carry card, each row's bonus and condition, who can wear. Null while it is off.
        gx: Object.freeze({ query: 'gear.view' }),
    }),
    theme: RARITY_THEME,
    template: TEMPLATE,
    css: CSS,
});
