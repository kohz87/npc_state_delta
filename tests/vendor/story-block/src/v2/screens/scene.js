// `story-block/scene` (SPEC §13.1): where the story is and who is there, from the head state. The place
// (name, kind, region) is marked when the last reply moved it; the story time shows when Story Director
// keeps a clock. Each person present gets a portrait when NPC State Delta answers `npc.portrait`
// (MODULES §F11): the screen asks `npc.known` first, and without NSD that answer is null, so the
// portraits are left out and the names stand alone.
// The weather (`scene.weather`, MODULES §F120) sits with the place while `story-block.weather` is on. Without
// Story Director's World (which shows each thought next to its person), each person present has their Inner
// chatter thought from the newest reply under their name (`scene.chatter`, MODULES §F115; [] while World is
// there, null while the chatter is off).

import { STRINGS, html } from '../strings.js';
import { BASE_CSS } from './style.js';

const S = STRINGS.scene;

export const SCENE_SCREEN_ID = 'story-block/scene';

// The portrait's picture comes from a per-person query in the condition language; written as JSON here
// so the quotes inside the expression are escaped for the data-props attribute.
const PORTRAIT_PROPS = JSON.stringify({ bind: 'query("npc.portrait", { name: p })', name: '{{ p }}', frame: 'circle', size: 'md' });

const TEMPLATE = `
<div class="scene">
  <header class="place panel" data-class="moved: changed('state.scene.place')">
    <i class="fa-solid fa-location-dot pin" aria-hidden="true"></i>
    <div class="where">
      <h3 data-if="q.place.name">{{ q.place.name }}</h3>
      <h3 class="muted" data-if="!q.place.name">${html(S.unnamed)}</h3>
      <p class="sub muted">
        <span class="kind" data-if="q.place.kind">{{ q.place.kind }}</span>
        <span class="region" data-if="q.place.region">{{ q.place.region }}</span>
        <span class="time" data-if="state.director.time.minutes != null"><i class="fa-regular fa-clock" aria-hidden="true"></i> {{ fmt.time(state.director.time.minutes) }}</span>
        <span class="weather" data-if="q.weather.text" title="${html(S.weather)}"><i class="fa-solid fa-cloud-sun" aria-hidden="true"></i> {{ q.weather.text }}</span>
      </p>
    </div>
  </header>
  <section class="present panel" data-class="moved: changed('state.scene.present')">
    <h4><i class="fa-solid fa-users" aria-hidden="true"></i> ${html(S.here)} <span class="count" data-if="len(q.present) > 0">{{ len(q.present) }}</span></h4>
    <p class="nobody muted" data-if="len(q.present) == 0">${html(S.nobody)}</p>
    <ul class="cast" data-class="faces: q.cast != null">
      <li class="who" data-each="q.present as p">
        <ss-widget name="ss.portrait" class="face" data-if="q.cast != null" data-props='${PORTRAIT_PROPS}'></ss-widget>
        <span class="name">{{ p }}</span>
        <span class="thought" data-each="q.chatter as c" data-if="c.name == p">{{ c.text }}</span>
      </li>
    </ul>
  </section>
</div>`;

const CSS = `${BASE_CSS}
.scene { display: grid; gap: var(--sb-gap); }
.place { display: flex; gap: 10px; align-items: center; }
.pin { font-size: 1.4em; color: var(--sb-accent); }
.where h3 { margin: 0; font-size: 1.15em; }
.sub { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 2px 0 0; font-size: 0.85em; }
.kind { text-transform: capitalize; }
.panel { transition: border-color 0.3s ease; }
.moved { border-color: var(--sb-accent); }
.count { min-width: 1.4em; padding: 0 5px; border-radius: 9px; text-align: center; background: var(--sb-surface); color: var(--sb-fg); }
.cast { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.who { display: inline-flex; flex-wrap: wrap; gap: 2px 6px; align-items: baseline; }
.faces .who { flex-direction: column; text-align: center; max-width: 6em; }
.faces .name { font-size: 0.85em; overflow-wrap: anywhere; }
.thought { font-size: 0.85em; font-style: italic; opacity: 0.85; overflow-wrap: anywhere; }
.weather { display: inline-flex; gap: 4px; align-items: baseline; }
`;

export const sceneScreen = Object.freeze({
    id: SCENE_SCREEN_ID,
    title: S.title,
    icon: 'fa-map-location-dot',
    mounts: Object.freeze(['tab', 'screen']),
    data: Object.freeze({
        place: Object.freeze({ query: 'scene.place' }),
        present: Object.freeze({ query: 'scene.present' }),
        // NPC State Delta's list of known people: only used to tell whether portraits can be asked for.
        cast: Object.freeze({ query: 'npc.known' }),
        weather: Object.freeze({ query: 'scene.weather' }),
        chatter: Object.freeze({ query: 'scene.chatter' }),
    }),
    template: TEMPLATE,
    css: CSS,
});
