// The NPC card (SPEC §13.1, mount `card`): under each reply, the meters of the NPCs present and of
// anyone whose meters that reply changed, one ss.meter bar per shown meter with its stage. A card
// shows that reply's own state (the card mount runs `npc.cast` on stateAt(index)), so an older
// reply keeps the numbers it had and a swipe shows the swipe's own. Data only: Story Block renders
// it with its template renderer and standard widgets; packs and cards may restyle or replace it by id.

export const METERS_CARD_ID = 'npc-state-delta/meters';

const TEMPLATE = `
<div class="nsd-meters">
  <section class="nsd-meters-npc" data-each="q.cast as n" data-if="n.present == true || changed(state.npc.npcs[n.key])" data-class="nsd-meters-new: changed(state.npc.npcs[n.key])">
    <h4 class="nsd-meters-name">{{ n.name }}</h4>
    <div class="nsd-meters-bars">
      <div class="nsd-meters-bar" data-each="n.bars as b">
        <ss-widget name="ss.meter" data-props='{"bind":"b"}'></ss-widget>
      </div>
    </div>
  </section>
</div>
`;

const CSS = `
.nsd-meters { display: grid; gap: 8px; padding: 6px 8px; font-size: 0.9em; }
.nsd-meters-npc { display: grid; gap: 4px; padding: 6px 8px; border-left: 3px solid var(--ss-accent, var(--SmartThemeQuoteColor)); border-radius: 6px; background: var(--SmartThemeBlurTintColor, transparent); }
.nsd-meters-name { margin: 0; font-size: 0.95em; }
.nsd-meters-new .nsd-meters-name::after { content: " •"; color: var(--ss-accent, var(--SmartThemeQuoteColor)); }
.nsd-meters-bars { display: grid; grid-template-columns: repeat(auto-fill, minmax(9em, 1fr)); gap: 4px 12px; }
.nsd-meters .ss-w-meter-value { font-variant-numeric: tabular-nums; }
`;

export const metersCardScreen = Object.freeze({
    id: METERS_CARD_ID,
    title: 'NPCs',
    icon: 'fa-masks-theater',
    mounts: Object.freeze(['card']),
    data: Object.freeze({ cast: Object.freeze({ query: 'npc.cast' }) }),
    template: TEMPLATE,
    css: CSS,
});
