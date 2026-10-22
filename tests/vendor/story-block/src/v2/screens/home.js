// `story-block/home` (SPEC §13.1, §13.4): the landing page of the full-screen game view. A summary of
// whatever is installed, read through each module's queries (MODULES §B–C): the hero and the party
// (RPG Battle), a fight under way or foes ahead, the place, time and who is here, the purse and what is
// worn, and the quests on hand (Story Director; one offered and not yet taken is marked Offered, as the
// Director's Quests screen counts offers: open, `offer`, not `taken`). A query whose module is not
// installed answers null (the mount catches the "no module answers" error), and every panel that needs it
// is behind a `data-if`, so a missing module's panel is simply not there. Story Block alone shows the
// place and the purse. The time is written on the story's calendar (the host's fmt.time, view/clock.js).

import { STRINGS, html, jsonText } from '../strings.js';
import { BASE_CSS } from './style.js';

const S = STRINGS.home;

export const HOME_SCREEN_ID = 'story-block/home';

const MAX_QUESTS = 3;

const TEMPLATE = `
<div class="home">
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
    <p class="here" data-if="len(q.present) > 0"><span class="muted">${html(S.here)}</span> {{ q.present }}</p>
  </section>

  <section class="panel purse">
    <h4><i class="fa-solid fa-sack-dollar" aria-hidden="true"></i> ${html(S.purse)}</h4>
    <p class="wallet"><b data-if="q.wallet.coin">{{ q.wallet.coin }}</b><b data-if="!q.wallet.coin">0</b> <span data-if="q.wallet.coin == 1">{{ q.currency.name }}</span><span data-if="q.wallet.coin != 1">{{ q.currency.plural }}</span>
      <span class="muted"> · {{ len(q.items) }} <span data-if="len(q.items) == 1">${html(S.thing)}</span><span data-if="len(q.items) != 1">${html(S.things)}</span> ${html(S.carried)}</span></p>
    <ul class="worn">
      <li data-each="q.items as it" data-if="it.equipped != null"><span class="chip"><i class="fa-solid fa-check" aria-hidden="true"></i> {{ it.name }}</span></li>
    </ul>
  </section>

  <section class="panel quests" data-if="len(q.quests) > 0">
    <h4><i class="fa-solid fa-scroll" aria-hidden="true"></i> ${html(S.quests)}</h4>
    <ul>
      <li class="quest" data-each="q.quests as t, i" data-if="i < ${MAX_QUESTS}">
        <b>{{ t.key }}</b> <span class="chip offered" data-if="t.offer == true && t.taken != true">${html(S.offered)}</span><span class="muted" data-if="t.fields.goal"> — {{ t.fields.goal }}</span>
        <div class="progress" data-if="i == 0">
          <ss-widget name="ss.meter" data-if="q.progress.need" data-props='{"value":"{{ q.progress.have }}","max":"{{ q.progress.need }}","label":"${jsonText(S.progress)}","tone":"accent"}'></ss-widget>
        </div>
      </li>
    </ul>
    <p class="more muted" data-if="len(q.quests) > ${MAX_QUESTS}">${html(S.moreQuests)}</p>
  </section>
</div>`;

const CSS = `${BASE_CSS}
.home { display: grid; gap: var(--sb-gap); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); align-items: start; }
.hero { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; }
.who { flex: 1; min-width: 0; }
.who h3 { margin: 0; color: var(--sb-accent); }
.sub { margin: 0 0 4px; font-size: 0.85em; }
.pools { display: grid; gap: 4px; }
.conds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.party ul, .quests ul { display: grid; gap: 6px; }
.fight { border-color: color-mix(in srgb, var(--sb-bad) 55%, var(--sb-border)); }
.fight .on b { color: var(--sb-bad); }
.chip.danger { color: var(--sb-bad); }
.panel p { margin: 2px 0; }
.worn { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.progress { margin-top: 4px; }
@media (max-width: 480px) { .hero { flex-direction: column; text-align: center; } }
`;

export const homeScreen = Object.freeze({
    id: HOME_SCREEN_ID,
    title: S.title,
    icon: 'fa-house',
    mounts: Object.freeze(['screen']),
    data: Object.freeze({
        place: Object.freeze({ query: 'scene.place' }),
        present: Object.freeze({ query: 'scene.present' }),
        items: Object.freeze({ query: 'inventory.items' }),
        wallet: Object.freeze({ query: 'inventory.wallet', args: Object.freeze({ owner: 'party' }) }),
        currency: Object.freeze({ query: 'inventory.currency' }),
        pc: Object.freeze({ query: 'party.pc' }),                                     // RPG Battle
        fight: Object.freeze({ query: 'combat.session' }),                            // RPG Battle
        offers: Object.freeze({ query: 'combat.offers' }),                            // RPG Battle
        quests: Object.freeze({ query: 'director.threads', args: Object.freeze({ kind: 'quest', status: 'active' }) }),   // Story Director
        progress: Object.freeze({ query: 'quest.progress', args: Object.freeze({ id: '$quests.0.id' }) }),            // Story Director
    }),
    template: TEMPLATE,
    css: CSS,
});
