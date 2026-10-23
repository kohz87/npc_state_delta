// The NPC card (SPEC §13.1, mount `card`): under each reply, the meters of the NPCs present and of
// anyone whose meters that reply changed, one ss.meter bar per shown meter with its stage (and, on a
// host whose ss.meter takes them, the NPC's ceiling, the stage thresholds as ticks and the change). A card
// shows that reply's own state (the card mount runs `npc.cast` on stateAt(index)), so an older
// reply keeps the numbers it had and a swipe shows the swipe's own. Data only: Story Block renders
// it with its template renderer and standard widgets; packs and cards may restyle or replace it by id.

export const METERS_CARD_ID = 'npc-state-delta/meters';

// A reply whose ops touched the NPC shows that reply's change on each bar (`n.bars`, with `delta`);
// any other reply shows the bars without it (`n.still`). The stage reached on the ladder and what
// the next one needs follow, then the hidden notes still locked: their titles and rules only.
const TEMPLATE = `
<div class="nsd-meters">
  <section class="ss-glass nsd-meters-npc" data-each="q.cast as n" data-if="n.present == true || changed(state.npc.npcs[n.key])" data-class="nsd-meters-new: changed(state.npc.npcs[n.key])">
    <div class="nsd-meters-head">
      <h4 class="nsd-meters-name">{{ n.name }}</h4>
      <span class="ss-pill nsd-meters-rank" data-if="n.rank">{{ n.rank }}</span>
    </div>
    <div class="nsd-meters-bars" data-if="changed(state.npc.npcs[n.key])">
      <div class="nsd-meters-bar" data-each="n.bars as b">
        <ss-widget name="ss.meter" data-props='{"bind":"b"}'></ss-widget>
      </div>
    </div>
    <div class="nsd-meters-bars" data-if="!changed(state.npc.npcs[n.key])">
      <div class="nsd-meters-bar" data-each="n.still as b">
        <ss-widget name="ss.meter" data-props='{"bind":"b"}'></ss-widget>
      </div>
    </div>
    <p class="nsd-meters-next" data-if="n.next">{{ n.next }}</p>
    <p class="nsd-meters-locked" data-each="n.locked as l">{{ l.text }}</p>
  </section>
</div>
`

const CSS = `
.nsd-meters { display: grid; gap: var(--ss-space-2); }
.nsd-meters-npc { padding: var(--ss-space-3); }
.nsd-meters-new { border-color: var(--ss-accent); }
.nsd-meters-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.nsd-meters-name { margin: 0; min-width: 0; font-size: 15px; font-weight: 800; color: var(--ss-text); overflow-wrap: anywhere; }
.nsd-meters-new .nsd-meters-name::after { content: " •"; color: var(--ss-accent); }
.nsd-meters-rank { max-width: 100%; overflow-wrap: anywhere; }
.nsd-meters-bars { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 9em), 1fr)); gap: 8px 12px; min-width: 0; }
.nsd-meters .ss-w-meter-value { font-variant-numeric: tabular-nums; }
.nsd-meters-next, .nsd-meters-locked { margin: 0; font-size: 13px; color: var(--ss-muted); overflow-wrap: anywhere; }
`

export const metersCardScreen = Object.freeze({
    id: METERS_CARD_ID,
    title: 'NPCs',
    icon: 'fa-masks-theater',
    mounts: Object.freeze(['card']),
    data: Object.freeze({ cast: Object.freeze({ query: 'npc.cast' }) }),
    template: TEMPLATE,
    css: CSS,
});
