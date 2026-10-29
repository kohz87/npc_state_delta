// `story-block/home` (SPEC §13.1, §13.4): the landing page of the full-screen game view. A summary of
// the place, time and people here, the purse and what is worn, and Story Director's quests.
// A query whose module is absent answers null; its panel stays hidden. Story Block alone shows
// the place and the purse. The time is written on the story's calendar (view/clock.js).
//
// The quests come from Story Director's `quest.board`: its open quests, then its offers, each with the
// status line the Director words itself (`status.text`: "Ready to turn in", "Not yet: 2/3 wolves",
// "Offered — say you take it", from `quest.details` where it has one), so Home never works out a
// quest's state on its own. The first open quest's progress bar is drawn when the board says it has a
// target (`meter`).
//
// First, while a module holds the story back (its canGenerate, MODULES §F12: a module needs a setup step), "Before you start" (the host's `story-block.ready-hint` widget): its reason and a
// button that runs its onBlocked hook. Without such a module
// it draws nothing.
//
// Last, the save points (MODULES §F93): the host's `story-block.savepoints` widget, which draws nothing
// while that feature is off. Packs are not on Home: Settings → Tabs & Packs has the import.

import { STRINGS, html, jsonText } from '../strings.js';
import { BASE_CSS } from './style.js';
import { SHOW_MORE_WIDGET } from './show-more.js';

// The save points panel (MODULES §F93) is a host widget (screens/savepoints.js), drawn by the page.
const SAVEPOINTS_WIDGET = 'story-block.savepoints';
// "Before you start" while a module holds the story back (screens/ready-hint.js), also a host widget.
const READY_HINT_WIDGET = 'story-block.ready-hint';

const S = STRINGS.home;

export const HOME_SCREEN_ID = 'story-block/home';

// A card's list is capped at about two normal cards with a "Show all" toggle (screens/show-more.js), so no count limit.

const TEMPLATE = `
<div class="home">
  <ss-widget name="${READY_HINT_WIDGET}" class="ready-slot"></ss-widget>

  <section class="panel scene">
    <h4 class="ss-section-label"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${html(S.where)}</h4>
    <p class="place"><b data-if="q.place.name">{{ q.place.name }}</b><span class="muted" data-if="!q.place.name">${html(S.unnamed)}</span><span class="muted" data-if="q.place.region"> · {{ q.place.region }}</span></p>
    <p class="time muted" data-if="state.director.time.minutes != null"><i class="fa-regular fa-clock" aria-hidden="true"></i> {{ fmt.time(state.director.time.minutes) }}</p>
    <p class="weather muted" data-if="q.weather.text"><i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> {{ q.weather.text }}</p>
    <p class="here" data-if="len(q.present) > 0"><span class="muted">${html(S.here)}</span> {{ q.present }}</p>
  </section>

  <section class="panel purse">
    <h4 class="ss-section-label"><i class="fa-solid fa-sack-dollar" aria-hidden="true"></i> ${html(S.purse)}</h4>
    <p class="wallet"><span data-if="len(q.currency.coins) == 0"><b data-if="q.wallet.coin">{{ q.wallet.coin }}</b><b data-if="!q.wallet.coin">0</b> <span data-if="q.wallet.coin == 1">{{ q.currency.name }}</span><span data-if="q.wallet.coin != 1">{{ q.currency.plural }}</span></span><span data-if="len(q.currency.coins) > 0"><b data-if="q.wallet.coin">{{ fmt.money(q.wallet.coin) }}</b><b data-if="!q.wallet.coin">{{ fmt.money(0) }}</b></span>
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

  <ss-widget name="${SAVEPOINTS_WIDGET}" class="saves-slot"></ss-widget>
</div>`;

const CSS = `${BASE_CSS}
.home { display: grid; gap: var(--sb-gap); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); align-items: stretch; }
/* One height per row: every card takes the row's height (the tallest), its content top-aligned. A card's long list is capped
   (.sb-cap, two normal cards tall, no scrollbar) with its own toggle below it, so one long card does not stretch the row. */
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
.ready-slot { grid-column: 1 / -1; }
.ready-slot:empty { display: none; }
.ready-hint { display: grid; gap: 6px; border-color: color-mix(in srgb, var(--sb-accent) 55%, var(--sb-border)); }
.ready-hint > h4 { margin: 0; }
.sb-ready-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.sb-ready-item { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; justify-content: space-between; }
.sb-ready-reason { flex: 1 1 14em; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.sb-ready-go { border-color: var(--sb-accent); font-weight: 600; }
.saves { display: grid; gap: 6px; align-content: start; }
.saves > h4 { margin: 0; }
.saves > .ss-button { justify-self: start; }
.sb-save-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sb-save-name { flex: 1 1 10em; min-width: 0; }
.sb-save-list { display: grid; gap: 4px; }
.sb-save-list.sb-cap[data-capped="true"] { max-height: 15em; overflow: hidden; }
.saves > .sb-show-more { justify-self: start; }
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
    mounts: Object.freeze(['screen']),
    data: Object.freeze({
        place: Object.freeze({ query: 'scene.place' }),
        present: Object.freeze({ query: 'scene.present' }),
        weather: Object.freeze({ query: 'scene.weather' }),
        items: Object.freeze({ query: 'inventory.items' }),
        wallet: Object.freeze({ query: 'inventory.wallet', args: Object.freeze({ owner: 'party' }) }),
        currency: Object.freeze({ query: 'inventory.currency' }),
        board: Object.freeze({ query: 'quest.board' }),                               // Story Director
    }),
    template: TEMPLATE,
    css: CSS,
});
