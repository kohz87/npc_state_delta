// `story-block/home` (SPEC §13.1, §13.4): the landing page of the full-screen game view. A summary of
// the purse and what is worn, and the open quests. The place, the time, the weather and the people here are the game view's
// header (view/game-header.js), so the Where card is drawn only where there is no header above Home (`settings._heroShown`, which
// the game view sets while its header is up: no chat yet, or a host with no header).
// A query whose module is absent answers null; its panel stays hidden. Story Block alone shows
// the place and the purse. The time is written on the story's calendar (view/clock.js).
//
// The quests come from the `quest.board` query (a module that keeps quests answers it): its open quests, then its offers, each with the
// status line that module words itself (`status.text`: "Ready to turn in", "Not yet: 2/3 wolves",
// "Offered — say you take it", from `quest.details` where it has one), so Home never works out a
// quest's state on its own. The first open quest's progress bar is drawn when the board says it has a
// target (`meter`).
//
// First, while a module holds the story back (its canGenerate, MODULES §F12: a module needs a setup step), "Before you start" (the host's `story-block.ready-hint` widget): its reason and a
// button that runs its onBlocked hook. Without such a module
// it draws nothing.
//
// The Mounts card (`mounts.list`, `mounts.pace`: src/v2/domains/mounts.js) shows only while the party has a mount. Last, the save points
// (MODULES §F93): the host's `story-block.savepoints` widget, which draws nothing while that feature is off, as one slim row across the
// foot of the page. The cards size to their content and sit three to a row on a wide screen, one to a row on a phone. Packs are not on
// Home: Settings → Tabs & Packs has the import.

import { STRINGS, html, jsonText } from '../strings.js';
import { BASE_CSS } from './style.js';
import { SHOW_MORE_WIDGET } from './show-more.js';

// The save points panel (MODULES §F93) is a host widget (screens/savepoints.js), drawn by the page.
const SAVEPOINTS_WIDGET = 'story-block.savepoints';
// "Before you start" while a module holds the story back (screens/ready-hint.js), also a host widget.
const READY_HINT_WIDGET = 'story-block.ready-hint';
// The RPG's "Your character" card while the story has no character (lean-rpg/view/start.js): a host widget that draws nothing unless the RPG is on.
export const RPG_START_WIDGET = 'story-block.rpg-start';

const S = STRINGS.home;
const M = STRINGS.mounts;

export const HOME_SCREEN_ID = 'story-block/home';

// A card's list is capped at about two normal cards with a "Show all" toggle (screens/show-more.js), so no count limit.

const TEMPLATE = `
<div class="home">
  <ss-widget name="${RPG_START_WIDGET}" class="rpg-start-slot"></ss-widget>
  <ss-widget name="${READY_HINT_WIDGET}" class="ready-slot"></ss-widget>

  <section class="panel scene" data-if="settings._heroShown != true">
    <h4 class="ss-section-label"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${html(S.where)}</h4>
    <p class="place"><b data-if="q.place.name">{{ q.place.name }}</b><span class="muted" data-if="!q.place.name">${html(S.unnamed)}</span><span class="muted" data-if="q.place.region"> · {{ q.place.region }}</span><ss-widget name="ss.editable" data-props='{"value":"{{ q.place.name }}","displayValue":false,"options":{{ q.places }},"label":"${jsonText(STRINGS.scene.editPlace)}","command":"scene.place","valueKey":"name","payload":{"with":{{ q.present }}}}'></ss-widget></p>
    <p class="time muted" data-if="state.director.time.minutes != null"><i class="fa-regular fa-clock" aria-hidden="true"></i> {{ fmt.time(state.director.time.minutes) }}</p>
    <div data-if="settings._weatherEnabled != false">
      <p class="weather muted" data-if="q.weather.text"><i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> {{ q.weather.text }}<ss-widget name="ss.editable" data-props='{"value":"{{ q.weather.text }}","displayValue":false,"maxLength":60,"label":"${jsonText(STRINGS.scene.editWeather)}","command":"scene.weather","valueKey":"text"}'></ss-widget></p>
      <p data-if="!q.weather.text"><ss-widget name="ss.editable" data-props='{"value":"{{ q.weather.text }}","displayValue":false,"maxLength":60,"label":"${jsonText(STRINGS.scene.editWeather)}","command":"scene.weather","valueKey":"text"}'></ss-widget></p>
    </div>
    <p class="here"><span class="muted">${html(S.here)}</span> <span data-if="len(q.present) > 0">{{ q.present }}</span><span data-if="len(q.present) == 0">—</span><ss-widget name="ss.editable" data-props='{"value":{{ q.present }},"displayValue":false,"kind":"list","maxLength":80,"label":"${jsonText(STRINGS.scene.editPresent)}","command":"scene.present","valueKey":"set"}'></ss-widget></p>
  </section>

  <section class="panel purse">
    <h4 class="ss-section-label"><i class="fa-solid fa-sack-dollar" aria-hidden="true"></i> ${html(S.purse)}</h4>
    <p class="wallet"><span data-if="len(q.currency.coins) == 0"><b data-if="q.wallet.coin">{{ q.wallet.coin }}</b><b data-if="!q.wallet.coin">0</b> <span data-if="q.wallet.coin == 1">{{ q.currency.name }}</span><span data-if="q.wallet.coin != 1">{{ q.currency.plural }}</span></span><span data-if="len(q.currency.coins) > 0"><b data-if="q.wallet.coin">{{ fmt.money(q.wallet.coin) }}</b><b data-if="!q.wallet.coin">{{ fmt.money(0) }}</b></span><ss-widget name="ss.editable" data-props='{"value":{{ q.wallet.coin }},"displayValue":false,"money":true,"currency":{{ q.currency }},"label":"${jsonText(STRINGS.inventory.editPurse)}","command":"wallet.set","valueKey":"amount"}'></ss-widget>
      <span class="muted"> · {{ len(q.items) }} <span data-if="len(q.items) == 1">${html(S.thing)}</span><span data-if="len(q.items) != 1">${html(S.things)}</span> ${html(S.carried)}</span></p>
    <ul class="worn">
      <li data-each="q.items as it" data-if="it.equipped != null"><span class="chip"><i class="fa-solid fa-check" aria-hidden="true"></i> {{ it.name }}</span></li>
    </ul>
  </section>

  <section class="panel quests" data-if="len(q.board.active) > 0 || len(q.board.offers) > 0">
    <h4 class="ss-section-label"><i class="fa-solid fa-scroll" aria-hidden="true"></i> ${html(S.quests)}</h4>
    <div class="sb-cap" data-capped="true">
      <ul>
        <li class="quest" data-each="q.board.active as t, i">
          <div class="quest-head"><b class="quest-title">{{ t.key }}</b> <span class="chip status" data-state="{{ t.status.state }}">{{ t.status.text }}</span></div>
          <p class="quest-goal muted" data-if="t.goal">{{ t.goal }}</p>
          <div class="progress" data-if="i == 0 && t.meter">
            <ss-widget name="ss.meter" data-props='{"value":"{{ t.progress.have }}","max":"{{ t.progress.need }}","label":"${jsonText(S.progress)}","tone":"accent"}'></ss-widget>
          </div>
        </li>
        <li class="quest offer" data-each="q.board.offers as t, i">
          <div class="quest-head"><b class="quest-title">{{ t.key }}</b> <span class="chip status" data-state="{{ t.status.state }}">{{ t.status.text }}</span></div>
          <p class="quest-goal muted" data-if="t.goal">{{ t.goal }}</p>
        </li>
      </ul>
    </div>
    <ss-widget name="${SHOW_MORE_WIDGET}" class="more-slot" data-props='{"target":".sb-cap","key":"story-block/home:quests","more":"${jsonText(STRINGS.showMore.more)}","less":"${jsonText(STRINGS.showMore.less)}"}'></ss-widget>
  </section>

  <section class="panel mounts" data-if="len(q.mounts) > 0">
    <h4 class="ss-section-label"><i class="fa-solid fa-horse" aria-hidden="true"></i> ${html(M.title)}</h4>
    <ul class="mount-list">
      <li class="mount" data-each="q.mounts as m">
        <span class="mount-ico" aria-hidden="true">
          <i class="fa-solid fa-cart-flatbed" data-if="contains(m.kind, 'cart') || contains(m.kind, 'wagon')"></i>
          <i class="fa-solid fa-horse" data-if="contains(m.kind, 'horse') || contains(m.kind, 'pony')"></i>
          <i class="fa-solid fa-horse-head" data-if="!contains(m.kind, 'cart') && !contains(m.kind, 'wagon') && !contains(m.kind, 'horse') && !contains(m.kind, 'pony')"></i>
        </span>
        <div class="mount-text">
          <div class="mount-name"><b>{{ m.name }}</b><span data-if="m.count > 1"> ×{{ m.count }}</span><ss-widget name="ss.editable" data-props='{"value":"{{ m.name }}","displayValue":false,"kind":"fields","label":"${jsonText(M.edit)}","command":"mounts.edit","payload":{"mount":"{{ m.name }}"},"fields":[{"key":"name","label":"${jsonText(M.editName)}","value":"{{ m.name }}","maxLength":40},{"key":"kind","label":"${jsonText(M.editKind)}","value":"{{ m.kind }}","maxLength":20},{"key":"count","label":"${jsonText(M.editCount)}","type":"number","value":"{{ m.count }}","min":1,"max":8},{"key":"pace","label":"${jsonText(M.editPace)}","type":"number","value":"{{ m.pace }}","min":1,"max":200},{"key":"condition","label":"${jsonText(M.editCondition)}","value":"{{ m.condition }}","maxLength":60},{"key":"where","label":"${jsonText(M.editWhere)}","value":"{{ m.where }}","maxLength":80}]}'></ss-widget></div>
          <div class="mount-sub muted"><span data-if="m.kind">{{ m.kind }}</span><span data-if="m.kind != '' && m.condition != ''"> · </span><span data-if="m.condition">{{ m.condition }}</span><span data-if="m.kind != '' && m.condition == '' && m.where != ''"> · </span><span data-if="m.condition != '' && m.where != ''"> · </span><span data-if="m.where">{{ m.where }}</span></div>
        </div>
        <span class="chip mount-pace">{{ m.pace }} ${html(M.perDay)}</span>
      </li>
    </ul>
    <p class="mount-note muted" data-if="q.pace.short == 0">${html(M.noteBefore)}{{ q.pace.pace }}${html(M.noteAfter)}</p>
    <p class="mount-note muted" data-if="q.pace.short > 0">${html(M.noteShortBefore)}{{ q.pace.pace }}${html(M.noteShortAfter)}</p>
  </section>

  <ss-widget name="story-block.block-cards" class="blocks-slot"></ss-widget>

  <ss-widget name="${SAVEPOINTS_WIDGET}" class="saves-slot"></ss-widget>
</div>`;

const CSS = `${BASE_CSS}
.home { display: grid; gap: var(--sb-gap); grid-template-columns: minmax(0, 1fr); align-items: start; }
/* A wide screen: three cards to a row, each as tall as its own content (no empty stretched bodies). A phone: one column. A card's long
   list is capped (.sb-cap, two normal cards tall, no scrollbar) with its own toggle below it. */
@media (min-width: 760px) { .home { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.panel { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.home > ss-widget { display: flex; flex-direction: column; min-width: 0; }
.home > ss-widget > .panel { flex: 1 1 auto; }
.sb-cap { min-width: 0; }
.sb-cap[data-capped="true"] { max-height: 15em; overflow: hidden; }
.more-slot { display: block; }
.more-slot:empty { display: none; }
.more-slot .sb-show-more { justify-self: start; }
/* A quest is a small stacked block: title and status pill on one line when they fit, the goal under it; a hairline and 8px either side between quests. */
.quests ul { display: grid; gap: 0; }
.chip.status[data-state="here"], .chip.status[data-state="ready"] { color: var(--sb-good); }
.chip.status[data-state="offered"] { color: var(--sb-accent); }
.panel p { margin: 2px 0; }
.quest { min-width: 0; overflow-wrap: anywhere; }
.quest + .quest { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--sb-border); }
.chip.status { max-width: 100%; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.quest-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; min-width: 0; }
.quest-title { min-width: 0; overflow-wrap: anywhere; }
.quest-head > .status { flex-shrink: 0; max-width: none; white-space: nowrap; }
.quest-goal { margin: 2px 0 0; font-size: 0.9em; overflow-wrap: anywhere; }
.worn { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.progress { margin-top: 4px; }
.saves-slot:empty { display: none; }
.saves-slot, .blocks-slot { grid-column: 1 / -1; }
.blocks-slot .ss-w-blocks-list { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); align-items: start; }
/* The Mounts card: one row per mount (an icon, the name with its pencil and what it is, a pace pill), then what the party travels at. */
.mount-list { display: grid; gap: 8px; margin-top: 4px; }
.mount { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; min-width: 0; }
.mount-ico { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; border: 1.5px solid var(--sb-border); }
.mount-text { min-width: 0; overflow-wrap: anywhere; }
.mount-sub { font-size: 0.85em; }
/* While a row's pencil form is open, the form takes the row's text column. */
.mount:has(.ss-w-editable-form) .mount-sub, .mount:has(.ss-w-editable-form) .mount-name > b, .mount:has(.ss-w-editable-form) .mount-name > span { display: none; }
.mount-name:has(.ss-w-editable-form) .ss-w-editable { width: 100%; }
.mount-pace { white-space: nowrap; font-weight: 700; background: color-mix(in srgb, var(--sb-accent) 28%, transparent); }
.mount-note { font-size: 0.85em; margin: 8px 0 0; }
.blocks-slot:empty { display: none; }
.ready-slot, .rpg-start-slot { grid-column: 1 / -1; }
.rpg-start-slot:empty, .rpg-start-slot[hidden] { display: none; }
.ready-slot:empty { display: none; }
.ready-hint { display: grid; gap: 6px; border-color: color-mix(in srgb, var(--sb-accent) 55%, var(--sb-border)); }
.ready-hint > h4 { margin: 0; }
.sb-ready-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.sb-ready-item { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; justify-content: space-between; }
.sb-ready-reason { flex: 1 1 14em; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.sb-ready-go { border-color: var(--sb-accent); font-weight: 600; }
/* The save points are one slim row across the page: the label, the Save point button and the words (or the list under them). */
.saves { display: flex; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding-top: 10px; padding-bottom: 10px; }
.saves > h4, .saves > p { margin: 0; }
.saves > h4 { flex: 0 0 auto; }
.saves > .sb-save-form, .saves > .sb-save-list, .saves > .sb-save-status { flex: 1 1 100%; }
.sb-save-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sb-save-name { flex: 1 1 10em; min-width: 0; }
.sb-save-list { display: grid; gap: 4px; }
.sb-save-list.sb-cap[data-capped="true"] { max-height: 15em; overflow: hidden; }
.saves > .sb-show-more { flex: 0 0 auto; }
.sb-save-point { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; justify-content: space-between; }
.sb-save-info { display: grid; min-width: 0; }
.sb-save-label { overflow-wrap: anywhere; }
.sb-save-when { font-size: 0.8em; }
.sb-save-actions { display: flex; gap: 4px; }
.sb-save-status { margin: 0; font-size: 0.85em; }
`;

export const homeScreen = Object.freeze({
    id: HOME_SCREEN_ID,
    title: S.title,
    icon: 'fa-house',
    bar: true,
    mounts: Object.freeze(['screen']),
    data: Object.freeze({
        place: Object.freeze({ query: 'scene.place' }),
        places: Object.freeze({ query: 'packs.content', args: Object.freeze({ kind: 'places' }) }),
        present: Object.freeze({ query: 'scene.present' }),
        weather: Object.freeze({ query: 'scene.weather' }),
        items: Object.freeze({ query: 'inventory.items' }),
        wallet: Object.freeze({ query: 'inventory.wallet', args: Object.freeze({ owner: 'party' }) }),
        currency: Object.freeze({ query: 'inventory.currency' }),
        board: Object.freeze({ query: 'quest.board' }),                               // a module that keeps quests
        mounts: Object.freeze({ query: 'mounts.list' }),
        pace: Object.freeze({ query: 'mounts.pace' }),
    }),
    template: TEMPLATE,
    css: CSS,
});
