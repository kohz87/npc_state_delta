// `story-block/home` (SPEC §13.1, §13.4): the landing page of the full-screen game view. A summary of
// whatever is installed, read through each module's queries (MODULES §B–C): the hero and the party
// (RPG Battle), a fight under way or foes ahead, the place, time and who is here, the purse and what is
// worn, and the quests on hand (Story Director). A query whose module is not
// installed answers null (the mount catches the "no module answers" error), and every panel that needs it
// is behind a `data-if`, so a missing module's panel is simply not there. Story Block alone shows the
// place and the purse. The time is written on the story's calendar (the host's fmt.time, view/clock.js).
//
// The quests come from Story Director's `quest.board`: its open quests, then its offers, each with the
// status line the Director words itself (`status.text`: "Ready to turn in", "Not yet: 2/3 wolves",
// "Offered — say you take it", from `quest.details` where it has one), so Home never works out a
// quest's state on its own. The first open quest's progress bar is drawn when the board says it has a
// target (`meter`).
//
// First, while a module holds the story back (its canGenerate, MODULES §F12: RPG Battle until your
// character exists), "Before you start" (the host's `story-block.ready-hint` widget): its reason and a
// button that runs its onBlocked hook (RPG Battle's opens the character wizard). Without such a module
// it draws nothing.
//
// Last, the save points (MODULES §F93): the host's `story-block.savepoints` widget, which draws nothing
// while that feature is off; and, while no pack is installed, "Import a pack" (the host's
// `story-block.packs-hint` widget), which opens the settings at the Packs fold.

import { STRINGS, html, jsonText } from '../strings.js';
import { BASE_CSS } from './style.js';

// The save points panel (MODULES §F93) is a host widget (screens/savepoints.js), drawn by the page.
const SAVEPOINTS_WIDGET = 'story-block.savepoints';
// "Import a pack" while no pack is installed (screens/packs-hint.js), also a host widget.
const PACKS_HINT_WIDGET = 'story-block.packs-hint';
// "Before you start" while a module holds the story back (screens/ready-hint.js), also a host widget.
const READY_HINT_WIDGET = 'story-block.ready-hint';

const S = STRINGS.home;

export const HOME_SCREEN_ID = 'story-block/home';

const MAX_QUESTS = 3;   // open quests shown
const MAX_OFFERS = 2;   // offers shown below them

const TEMPLATE = `
<div class="home">
  <ss-widget name="${READY_HINT_WIDGET}" class="ready-slot"></ss-widget>
  <section class="panel hero" data-if="q.pc">
    <ss-widget name="ss.portrait" class="face" data-props='{"src":"{{ q.pc.portrait }}","name":"{{ q.pc.name }}","frame":"rounded","size":"lg"}'></ss-widget>
    <div class="who">
      <h3>{{ q.pc.name }}</h3>
      <p class="sub muted"><span data-if="q.pc.level">${html(S.level, { level: '{{ q.pc.level }}' })}</span><span data-if="q.pc.role"> · {{ q.pc.role }}</span></p>
      <div class="pools">
        <ss-widget name="ss.meter" data-if="q.pc.hp.max" data-props='{"bind":"q.pc.hp","label":"${jsonText(S.hp)}","tone":"bad","icon":"fa-heart"}'></ss-widget>
        <ss-widget name="ss.meter" data-if="q.pc.mp.max" data-props='{"bind":"q.pc.mp","label":"${jsonText(S.mp)}","tone":"info","icon":"fa-wand-sparkles"}'></ss-widget>
        <ss-widget name="ss.meter" data-if="q.pc.sp.max" data-props='{"bind":"q.pc.sp","label":"${jsonText(S.sp)}","tone":"warn","icon":"fa-bolt"}'></ss-widget>
      </div>
      <div class="conds" data-if="len(q.pc.conditions) > 0">
        <ss-widget name="ss.badge" data-each="q.pc.conditions as c" data-props='{"label":"{{ c.kind }}","tone":"bad","kind":"{{ c.kind }}","showLabel":true}'></ss-widget>
      </div>
    </div>
  </section>

  <section class="panel party" data-if="len(state.party.order) > 1">
    <h4><i class="fa-solid fa-people-group" aria-hidden="true"></i> ${html(S.party)}</h4>
    <ul>
      <li class="member" data-each="state.party.order as id" data-if="id != state.party.pc">
        <ss-widget name="ss.meter" data-props='{"bind":"state.party.actors[id].hp","label":"{{ state.party.actors[id].name }}","tone":"bad"}'></ss-widget>
      </li>
    </ul>
  </section>

  <section class="panel fight" data-if="q.fight.status == 'active' || len(q.offers) > 0">
    <h4><i class="fa-solid fa-khanda" aria-hidden="true"></i> ${html(S.fight)}</h4>
    <p class="on" data-if="q.fight.status == 'active'"><b>${html(S.fightOn)}</b> ${html(S.fightOpen)}</p>
    <ul data-if="q.fight.status != 'active'">
      <li class="offer" data-each="q.offers as o">
        ${html(S.ahead)} <span data-each="o.foes as f, j"><span data-if="j > 0">, </span>{{ f.count }} {{ f.name }}</span>
        <span class="chip danger" data-if="o.stakes == 'death'">${html(S.toTheDeath)}</span>
      </li>
    </ul>
  </section>

  <section class="panel scene">
    <h4><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${html(S.where)}</h4>
    <p class="place"><b data-if="q.place.name">{{ q.place.name }}</b><span class="muted" data-if="!q.place.name">${html(S.unnamed)}</span><span class="muted" data-if="q.place.region"> · {{ q.place.region }}</span></p>
    <p class="time muted" data-if="state.director.time.minutes != null"><i class="fa-regular fa-clock" aria-hidden="true"></i> {{ fmt.time(state.director.time.minutes) }}</p>
    <p class="weather muted" data-if="q.weather.text"><i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> {{ q.weather.text }}</p>
    <p class="here" data-if="len(q.present) > 0"><span class="muted">${html(S.here)}</span> {{ q.present }}</p>
  </section>

  <section class="panel purse">
    <h4><i class="fa-solid fa-sack-dollar" aria-hidden="true"></i> ${html(S.purse)}</h4>
    <p class="wallet"><span data-if="len(q.currency.coins) == 0"><b data-if="q.wallet.coin">{{ q.wallet.coin }}</b><b data-if="!q.wallet.coin">0</b> <span data-if="q.wallet.coin == 1">{{ q.currency.name }}</span><span data-if="q.wallet.coin != 1">{{ q.currency.plural }}</span></span><span data-if="len(q.currency.coins) > 0"><b data-if="q.wallet.coin">{{ fmt.money(q.wallet.coin) }}</b><b data-if="!q.wallet.coin">{{ fmt.money(0) }}</b></span>
      <span class="muted"> · {{ len(q.items) }} <span data-if="len(q.items) == 1">${html(S.thing)}</span><span data-if="len(q.items) != 1">${html(S.things)}</span> ${html(S.carried)}</span></p>
    <ul class="worn">
      <li data-each="q.items as it" data-if="it.equipped != null"><span class="chip"><i class="fa-solid fa-check" aria-hidden="true"></i> {{ it.name }}</span></li>
    </ul>
  </section>

  <section class="panel quests" data-if="len(q.board.active) > 0 || len(q.board.offers) > 0">
    <h4><i class="fa-solid fa-scroll" aria-hidden="true"></i> ${html(S.quests)}</h4>
    <ul>
      <li class="quest" data-each="q.board.active as t, i" data-if="i < ${MAX_QUESTS}">
        <b>{{ t.key }}</b> <span class="chip status" data-state="{{ t.status.state }}">{{ t.status.text }}</span><span class="muted" data-if="t.goal"> — {{ t.goal }}</span>
        <div class="progress" data-if="i == 0 && t.meter">
          <ss-widget name="ss.meter" data-props='{"value":"{{ t.progress.have }}","max":"{{ t.progress.need }}","label":"${jsonText(S.progress)}","tone":"accent"}'></ss-widget>
        </div>
      </li>
      <li class="quest offer" data-each="q.board.offers as t, i" data-if="i < ${MAX_OFFERS}">
        <b>{{ t.key }}</b> <span class="chip status" data-state="{{ t.status.state }}">{{ t.status.text }}</span><span class="muted" data-if="t.goal"> — {{ t.goal }}</span>
      </li>
    </ul>
    <p class="more muted" data-if="len(q.board.active) > ${MAX_QUESTS} || len(q.board.offers) > ${MAX_OFFERS}">${html(S.moreQuests)}</p>
  </section>

  <ss-widget name="${SAVEPOINTS_WIDGET}" class="saves-slot"></ss-widget>
  <ss-widget name="${PACKS_HINT_WIDGET}" class="packs-slot"></ss-widget>
</div>`;

const CSS = `${BASE_CSS}
.home { display: grid; gap: var(--sb-gap); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); align-items: start; }
.hero { grid-column: 1 / -1; display: flex; flex-direction: row; gap: 12px; align-items: center; text-align: start; }
.hero .face { flex: none; }
.who { flex: 1 1 0; min-width: 0; }
.who h3 { margin: 0; color: var(--sb-accent); }
.sub { margin: 0 0 4px; font-size: 0.85em; }
.pools { display: grid; gap: 4px; min-width: 0; }
.pools > * { min-width: 0; }
.conds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.party ul, .quests ul { display: grid; gap: 6px; }
.fight { border-color: color-mix(in srgb, var(--sb-bad) 55%, var(--sb-border)); }
.fight .on b { color: var(--sb-bad); }
.chip.danger { color: var(--sb-bad); }
.chip.status[data-state="here"], .chip.status[data-state="ready"] { color: var(--sb-good); }
.chip.status[data-state="offered"] { color: var(--sb-accent); }
.panel p { margin: 2px 0; }
.quest { min-width: 0; overflow-wrap: anywhere; }
.chip.status { max-width: 100%; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.worn { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.progress { margin-top: 4px; }
.saves-slot:empty, .packs-slot:empty { display: none; }
.ready-slot { grid-column: 1 / -1; }
.ready-slot:empty { display: none; }
.ready-hint { display: grid; gap: 6px; border-color: color-mix(in srgb, var(--sb-accent) 55%, var(--sb-border)); }
.ready-hint > h4 { margin: 0; }
.sb-ready-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.sb-ready-item { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; justify-content: space-between; }
.sb-ready-reason { flex: 1 1 14em; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.sb-ready-go { border-color: var(--sb-accent); font-weight: 600; }
.packs-hint { display: grid; gap: 6px; }
.packs-hint > h4 { margin: 0; }
.packs-hint > .btn { justify-self: start; }
.saves { display: grid; gap: 6px; }
.saves > h4 { margin: 0; }
.saves > .btn { justify-self: start; }
.sb-save-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sb-save-name { flex: 1 1 10em; min-width: 0; }
.sb-save-list { display: grid; gap: 4px; max-height: 16em; overflow-y: auto; }
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
        pc: Object.freeze({ query: 'party.pc' }),                                     // RPG Battle
        fight: Object.freeze({ query: 'combat.session' }),                            // RPG Battle
        offers: Object.freeze({ query: 'combat.offers' }),                            // RPG Battle
        board: Object.freeze({ query: 'quest.board' }),                               // Story Director
    }),
    template: TEMPLATE,
    css: CSS,
});
