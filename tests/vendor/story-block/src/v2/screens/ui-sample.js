// The UI sample (a developer's page, Settings → Diagnostics → Show the UI sample): every building block of
// Story Suite's look (view/glass.css, view/widgets/: tile, bar, status, pill, hero, tiers, listcard, tabs, navbar, dialog) in light and in dark side by side, over
// SillyTavern's own background, for checking a theme and for screenshots. It is not a screen of the
// game view or a tab: it opens only from that button, shows made-up sample data, and changes nothing.
//
// It is drawn the way every screen is: an HTML template through SillyTavern's DOMPurify and the template
// allow-list (createScreenRenderer), the standard widgets by name. Each pane forces its scheme with the
// class `ss-scheme-light` or `ss-scheme-dark` (view/theme.js); with the "Follow SillyTavern only" panel style both panes show the
// theme as it is.

import { createScreenRenderer } from '../view/render-screen.js';
import { chipsField, newId, renderSettingsForm, sectionBlock } from '../view/form/index.js';
import { createSettings } from '../sdk.js';

export const UI_SAMPLE_ID = 'story-block/ui-sample';

export const UI_SAMPLE_TEXT = Object.freeze({
    title: 'Story Suite: UI sample',
    close: 'Close',
    closeTitle: 'Close the UI sample',
    note: 'Sample data. Settings → Story Suite → Panel style and Font change what you see here.',
});

// A made-up 64 px portrait (a base64 PNG), so the hero shows a picture beside the one with an initial.
const SAMPLE_PORTRAIT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAACxUlEQVR42u3YeU6aQRzG8d9ZegT/9iR23+wOooiggsoiiuCCCiqLIsq+ryIVrWvdqlbFrYfoETotiXkTCsaZgddJ3uQ5wOdL3pCZAVHTL1HTjfjxjfjJdcvTa8mzK8nzq9YXl21oLy+kry6kr4vtb4qyt+ey5vOO5jP5uzP5+zPFh1PFx9POTz+7PqOddH85UYqOleJjVcuRSnLU0/qjF63tsE96qG4/VMsONB0HGvm+Vr6vU+zpOvf6u3b13bt65fcBFdrOYM+OoXfb0Lc9pN4yaraM2i2TdtOk2xzu3xjRb4wMrI8Oro8ZvqGZh9bMxrVx0+rE8OrESGFytABM6y1jBWBabxlbAab1VvMKMK23jn8FpvVTEyiAZf30ZB6Y1k9b8sC0fsa6DEzrbSiAab1tKgdM6+3TOWBab59ZAqb1DhsKYFnvtGeBab3TkQXq+oZHjdVHUT/ryABF/Z107qjo55wZ4EVfGrl+bhYFEOsx6NyR6F1zaeBXXxq23uVKQy2+nN/FQqVVCMDUz8+noJ76Kg14erc7BRT1d9KrZ2Do3e4kUPy/Jw24v35hAQXwoa/UcF/94mIC8E4K5Pr/NtxXv+hBAQTnHGx3+TB+e6T3eONAckqjGYCl9/jiQHLGpBiAp/f6Y0ByQqYZgKX3oQCS8z3FADy9LxAFktsJxQA8vT+IAgjuVjQDsPSBUBRIboYUA/D0gXAECO+1/OqDkQgQ3sqpBGDrg9EwkL8p8KgP/Q0gfhEhDSDQh2MhoPKew5c+HA8BrdcoXvSRRBDovqXV57u/1UeTQajFS2CN/jHL9dFUAOr5jkldH0sHgGl9LO0HpvXxDApgWZ/I+uBOfWODiN9V0SeWfFBJz7u7fOX6ZM4L5foHSOeOq08te4Grf+B07kr6VB4F/NMzROcunfcAo/TbCQFCgBAgBAgBQoAQIAQQ7A9gt+fdUieuLgAAAABJRU5ErkJggg==';

/**
 * The demo form (the form engine, view/form/): a made-up module's settings schema in the registry's own shape,
 * drawn with the engine's renderers and written through a real settings store held in memory (nothing of the reader's
 * is touched). It has one of each field: a switch, text and a text area, a number, a slider, a select, one-of
 * chips, a Connection Manager profile, a list of "Name: Worth" lines, and read-only rows (one by `shows`, one
 * that follows the switch); the groups come from `group` and from a label's "Group: " prefix.
 */
export const UI_SAMPLE_FORM = Object.freeze({
    moduleId: 'demo',
    title: 'Demo form: one module\'s settings, from its schema',
    schema: Object.freeze({
        strict: Object.freeze({ type: 'bool', label: 'Strict checks', help: 'Code picks the stat and difficulty from your message. One cheap call per message.' }),
        harder: Object.freeze({ type: 'int', label: 'Check difficulty', min: 1, max: 5, help: 'Locked while Strict checks is off.', readOnly: values => values.strict !== true, shows: () => 3 }),
        storyTitle: Object.freeze({ type: 'text', label: 'Story title', help: 'Shown in the header.', max: 24 }),
        notes: Object.freeze({ type: 'text', multiline: true, label: 'Narrator notes', help: 'Anything the narrator should keep in mind.', max: 160 }),
        pace: Object.freeze({ type: 'choice', form: 'chips', label: 'Pace', options: Object.freeze([Object.freeze({ value: 'slow', label: 'Slow' }), Object.freeze({ value: 'steady', label: 'Steady' }), Object.freeze({ value: 'fast', label: 'Fast' })]) }),
        pack: Object.freeze({ type: 'text', label: 'Pack', help: 'Set by the pack in use.', readOnly: true, shows: () => 'Ersveil: Bluewatch' }),
        budget: Object.freeze({ type: 'int', form: 'slider', min: 0, max: 200, unit: ' pennies', label: 'Money: Starting purse', help: 'The coins the party starts with.', group: 'Money' }),
        prices: Object.freeze({ type: 'choice', label: 'Prices by place', group: 'Money', options: Object.freeze([Object.freeze({ value: 'by-place', label: 'Settlement type × surroundings (±30%)' }), Object.freeze({ value: 'flat', label: 'Flat prices everywhere' })]) }),
        coins: Object.freeze({
            type: 'list', label: 'Coins', group: 'Money', help: 'One coin per row, smallest first. The story\'s "40 silver" is paid as 400 pennies.',
            of: Object.freeze({ name: Object.freeze({ type: 'text', label: 'Name', max: 20 }), worth: Object.freeze({ type: 'int', label: 'Worth', min: 1, max: 1000000 }) }),
        }),
        daysPerWeek: Object.freeze({ type: 'int', label: 'Calendar: Days per week', min: 1, max: 12, help: 'The most is 12.' }),
        months: Object.freeze({
            type: 'list', form: 'lines', label: 'Calendar: Months', help: 'Name: Days, one a line.',
            of: Object.freeze({ name: Object.freeze({ type: 'text', label: 'Name', max: 20 }), days: Object.freeze({ type: 'int', label: 'Days', min: 1, max: 60 }) }),
        }),
        connection: Object.freeze({ type: 'profile', label: 'Assist: Connection for extra calls', group: 'Assist', help: 'Used by Assist, Delta\'s scan and the arc planner.' }),
    }),
    defaults: Object.freeze({
        strict: false, harder: 3, storyTitle: 'The Lowmere', notes: '', pace: 'steady', pack: '', budget: 60, prices: 'by-place', daysPerWeek: 7, connection: '',
        coins: Object.freeze([Object.freeze({ name: 'penny', worth: 1 }), Object.freeze({ name: 'copper bit', worth: 1 }), Object.freeze({ name: 'silver', worth: 10 })]),
        months: Object.freeze([Object.freeze({ name: 'Frostmoon', days: 30 }), Object.freeze({ name: 'Seedmoon', days: 31 })]),
    }),
    // What the Connection Manager would answer (names only), so the sample shows a real select.
    profiles: Object.freeze({ usable: true, profiles: Object.freeze([Object.freeze({ name: 'Flash Lite (cheap)' }), Object.freeze({ name: 'Main' })]) }),
    chips: Object.freeze({
        label: 'The safety net may add', help: 'Never coin, new items, XP, loot or healing.',
        options: Object.freeze(['time', 'place', 'present', 'weather', 'quest progress', 'wounds', 'hand-overs']), value: Object.freeze(['time', 'place', 'present', 'weather', 'quest progress', 'wounds']),
    }),
});

/**
 * Draws the demo form into `slot`: the engine's form over an in-memory settings store, a row of several-of chips (the
 * chip picker used on its own), and a line that shows what the store holds after each change. → { destroy() }.
 */
export function mountDemoForm(doc, slot) {
    const D = UI_SAMPLE_FORM;
    const es = {};
    const settings = createSettings({ root: () => es, registry: { module: id => (id === D.moduleId ? { settings: { schema: D.schema, defaults: structuredClone(D.defaults) } } : null) } });
    const stored = doc.createElement('p');
    stored.className = 'ss-sample-stored';
    const show = () => { stored.textContent = `Stored: ${JSON.stringify(es.storySuite?.modules?.[D.moduleId] ?? {})}`; };
    const form = renderSettingsForm(slot, { moduleId: D.moduleId, schema: D.schema, settings, doc, title: D.title, search: true, profiles: () => D.profiles, onChange: show });
    const section = sectionBlock(doc, { title: 'Chip picker' });
    const row = doc.createElement('div');
    row.className = 'ss-field';
    const text = doc.createElement('div');
    text.className = 'ss-field-text';
    const label = doc.createElement('span');
    label.className = 'ss-field-label';
    label.id = newId('chips-label');
    label.textContent = D.chips.label;
    const help = doc.createElement('small');
    help.className = 'ss-field-help';
    help.textContent = D.chips.help;
    text.append(label, help);
    const chips = chipsField({ doc, id: newId('chips'), key: 'chips', field: { type: 'choice', multiple: true, options: D.chips.options }, value: [...D.chips.value], labelledBy: label.id, onChange: () => {} });
    const control = doc.createElement('div');
    control.className = 'ss-field-control';
    control.appendChild(chips.el);
    row.append(text, control);
    section.body.appendChild(row);
    slot.append(section.el, stored);
    show();
    return { form, destroy() { form.destroy(); section.el.remove(); stored.remove(); } };
}

/** Made-up data for the sample (the concept's Astra). */
export const UI_SAMPLE_DATA = Object.freeze({
    pc: Object.freeze({ name: 'Astra', line: 'Soul Class II · Lv 12 · Wayfarer', hp: { cur: 50, max: 82 }, mp: { cur: 32, max: 40 }, sp: { cur: 30, max: 34 }, exp: { cur: 640, max: 1000 } }),
    statuses: Object.freeze([
        Object.freeze({ id: 'bleed', label: 'Bleeding', icon: 'fa-droplet', left: 40, unit: 'minutes', tone: 'bad' }),
        Object.freeze({ id: 'haste', label: 'Haste', icon: 'fa-forward', left: 2, unit: 'rounds', tone: 'warn' }),
        Object.freeze({ id: 'poison', label: 'Poisoned', icon: 'fa-skull-crossbones', left: 3, unit: 'turns', tone: 'good' }),
        Object.freeze({ id: 'blessed', label: 'Blessed', icon: 'fa-star', left: null, unit: 'turns', tone: 'accent' }),
    ]),
    skills: Object.freeze([
        Object.freeze({ id: 'moon', label: 'Moonlight Slash', icon: 'fa-wand-sparkles', count: '3', state: 'none', selected: true, tone: 'info', hint: 'Lv 3' }),
        Object.freeze({ id: 'frost', label: 'Frost Hex', icon: 'fa-snowflake', count: '2', state: 'ready', selected: false, tone: 'info', hint: 'Lv 2' }),
        Object.freeze({ id: 'death', label: 'Death Soul', icon: 'fa-skull', count: '–', state: 'locked', selected: false, tone: '', hint: 'Needs Blade Soul Lv 3' }),
    ]),
    // The hero card (ss.hero): a portrait (a made-up picture here), HP/MP/SP and the experience word, the corner, the badges.
    hero: Object.freeze({
        name: 'Astra', portrait: SAMPLE_PORTRAIT, className: 'Soul Class II', level: '12', title: 'Wayfarer', place: 'North Cut', time: '07:20', weather: 'Drizzle',
        bars: Object.freeze([
            Object.freeze({ kind: 'hp', label: 'HP', value: 50, max: 82 }), Object.freeze({ kind: 'mp', label: 'MP', value: 32, max: 40 }),
            Object.freeze({ kind: 'sp', label: 'SP', value: 30, max: 34 }), Object.freeze({ kind: 'exp', label: 'Soul growth', value: 640, max: 1000 }),
        ]),
        statuses: Object.freeze([
            Object.freeze({ id: 'bleed', label: 'Bleeding', icon: 'fa-droplet', left: 40, unit: 'minutes', tone: 'bad' }),
            Object.freeze({ id: 'haste', label: 'Haste', icon: 'fa-forward', left: 2, unit: 'rounds', tone: 'warn' }),
            Object.freeze({ id: 'blessed', label: 'Blessed', icon: 'fa-star', left: null, unit: 'turns', tone: 'accent' }),
        ]),
    }),
    // The compact hero (the strip under a reply): no picture, so the initial.
    heroCompact: Object.freeze({
        name: 'Mira', className: 'Salvager', level: '9', compact: true,
        bars: Object.freeze([
            Object.freeze({ kind: 'hp', label: 'HP', value: 71, max: 84 }), Object.freeze({ kind: 'mp', label: 'MP', value: 12, max: 30 }), Object.freeze({ kind: 'sp', label: 'SP', value: 22, max: 28 }),
        ]),
        statuses: Object.freeze([Object.freeze({ id: 'poison', label: 'Poisoned', icon: 'fa-skull-crossbones', left: 3, unit: 'turns', tone: 'good' })]),
    }),
    tiers: Object.freeze({
        columns: 3, selected: 'frost', label: 'Skills',
        tiers: Object.freeze([
            Object.freeze({ title: 'Basic', tiles: Object.freeze([
                Object.freeze({ id: 'moon', label: 'Moonlight Slash', icon: 'fa-wand-sparkles', count: '3', tone: 'info', hint: 'Lv 3' }),
                Object.freeze({ id: 'blade', label: 'Blade Soul', icon: 'fa-khanda', count: '2', tone: 'info', hint: 'Lv 2' }),
                Object.freeze({ id: 'seal', label: 'Seal Release', icon: 'fa-circle-notch', count: '1', tone: 'info', hint: 'Lv 1' }),
            ]) }),
            Object.freeze({ title: 'Advanced', tiles: Object.freeze([
                Object.freeze({ id: 'corr', label: 'Corrosion', icon: 'fa-skull', count: '1', state: 'ready', tone: 'info', hint: 'Lv 1' }),
                Object.freeze({ id: 'frost', label: 'Frost Hex', icon: 'fa-snowflake', count: '2', state: 'ready', tone: 'info', hint: 'Lv 2' }),
                Object.freeze({ id: 'death', label: 'Death Soul', icon: 'fa-skull-crossbones', count: '–', state: 'locked', hint: 'Needs Blade Soul Lv 3' }),
            ]) }),
            Object.freeze({ title: 'Finisher', tiles: Object.freeze([
                Object.freeze({ id: 'plague', label: 'Plague Fang', icon: 'fa-tooth', count: '–', state: 'locked', hint: 'Needs Corrosion Lv 3' }),
                Object.freeze({ id: 'phantom', label: 'Phantom Flash', icon: 'fa-bolt', count: '1', state: 'ready', tone: 'info', hint: 'Lv 1' }),
                Object.freeze({ id: 'nether', label: 'Netherflame', icon: 'fa-fire', count: '–', state: 'locked', hint: 'Needs INT 14' }),
            ]) }),
        ]),
    }),
    ready: Object.freeze({
        title: 'Ready to turn in', label: 'Quests ready to turn in',
        rows: Object.freeze([
            Object.freeze({ id: 'wolf', title: 'The North Cut Wolf', sub: 'to Elula · here', value: '4 silver' }),
            Object.freeze({ id: 'weir', title: 'Rats in the Weir', sub: 'to Master Kroll · Guild Office', value: '12 pennies' }),
        ]),
    }),
    here: Object.freeze({
        title: 'What can happen here', selected: 'varney',
        rows: Object.freeze([
            Object.freeze({ id: 'kroll', title: 'Master Kroll wants a word', tag: 'new', tone: 'good' }),
            Object.freeze({ id: 'varney', title: 'Varney\'s wolves are still out there', tag: 'open', tone: 'warn' }),
            Object.freeze({ id: 'elula', title: 'Elula needs the elderbark wash', sub: 'Folk Bitter Draught', tag: 'urgent', tone: 'bad' }),
            Object.freeze({ id: 'rats', title: 'Trench rats of the East Ditch', tag: 'elsewhere' }),
        ]),
    }),
    people: Object.freeze({
        title: 'People here · 2',
        rows: Object.freeze([
            Object.freeze({ id: 'elula', title: 'Elula', sub: 'Overwhelmed, tearful', value: 'Close', icon: 'fa-user' }),
            Object.freeze({ id: 'kroll', title: 'Master Kroll', sub: 'Busy, curt', value: 'Acquaintance', icon: 'fa-user' }),
        ]),
    }),
    tabs: Object.freeze({
        label: 'Panel sections', current: 'world',
        items: Object.freeze(['World', 'Quests', 'Party', 'Bag', 'Fight', 'Crafting', 'Trade', 'Chronicle'].map(label => Object.freeze({ id: label.toLowerCase(), label }))),
    }),
    nav: Object.freeze({
        label: 'Game view', current: 'skills',
        items: Object.freeze([
            Object.freeze({ id: 'party', label: 'Party', icon: 'fa-users' }), Object.freeze({ id: 'skills', label: 'Skills', icon: 'fa-star' }), Object.freeze({ id: 'bag', label: 'Bag', icon: 'fa-bag-shopping', count: '2' }),
            Object.freeze({ id: 'fight', label: 'Fight', icon: 'fa-khanda' }), Object.freeze({ id: 'world', label: 'World', icon: 'fa-globe' }), Object.freeze({ id: 'map', label: 'Map', icon: 'fa-map' }),
            Object.freeze({ id: 'trade', label: 'Trade', icon: 'fa-scale-balanced' }),
        ]),
    }),
    // The map (ss.map): four places, a route between them, the reader's place, and one place not yet found (the fog, unknown).
    map: Object.freeze({
        label: 'Sample map', current: 'hollow', fog: 'unknown', discovered: Object.freeze(['hollow', 'mill', 'gate']),
        nodes: Object.freeze([
            Object.freeze({ id: 'hollow', name: 'Hollow Tree', x: 18, y: 66, icon: 'fa-tree', kind: 'camp' }),
            Object.freeze({ id: 'mill', name: 'Old Mill', x: 44, y: 44, icon: 'fa-gear', kind: 'town' }),
            Object.freeze({ id: 'gate', name: 'North Gate', x: 70, y: 28, icon: 'fa-torii-gate', kind: 'town' }),
            Object.freeze({ id: 'keep', name: 'Keep', x: 88, y: 10, icon: 'fa-chess-rook', kind: 'town' }),
        ]),
        edges: Object.freeze([Object.freeze({ from: 'hollow', to: 'mill' }), Object.freeze({ from: 'mill', to: 'gate' }), Object.freeze({ from: 'gate', to: 'keep' })]),
        kinds: Object.freeze({ camp: Object.freeze({ label: 'Camp', icon: 'fa-campground' }), town: Object.freeze({ label: 'Town', icon: 'fa-city' }) }),
    }),
    dialog: Object.freeze({
        title: 'Rest at the Guild Office?', text: 'Resting takes about eight hours of story time.\n\nThe wolf\'s bleeding will be closed, and Haste will run out.',
        actions: Object.freeze([Object.freeze({ id: 'cancel', label: 'Not now' }), Object.freeze({ id: 'rest', label: 'Rest', kind: 'primary', icon: 'fa-moon' })]),
    }),
    bag: Object.freeze([
        Object.freeze({ id: 'draught', label: 'Healing Draught', icon: 'fa-flask', count: '3', tone: 'neutral' }),
        Object.freeze({ id: 'bitter', label: 'Folk Bitter Draught', icon: 'fa-leaf', count: '1', tone: 'uncommon' }),
        Object.freeze({ id: 'ring', label: 'Silver Ring', icon: 'fa-ring', count: '', tone: 'rare' }),
        Object.freeze({ id: 'chit', label: 'Council Chit', icon: 'fa-key', count: '', tone: 'epic' }),
    ]),
});

// One pane of the sample, in one scheme. Bars and badges come both as widgets and as plain classes, so
// the page shows that a template can use either.
function pane(scheme) {
    const name = scheme === 'light' ? 'Light' : 'Dark';
    return `
<section class="ss-sample-pane ss-scheme-${scheme}" aria-label="${name}">
  <p class="ss-label ss-glass-strong ss-sample-tag">${name} · glass card, pills, bars, status badges</p>
  <div class="ss-glass">
    <div class="ss-sample-row" style="align-items: center">
      <h3 class="ss-sample-title">{{ q.pc.name }}</h3>
      <ss-widget name="ss.pill" data-props='{"text":"{{ q.pc.line }}"}'></ss-widget>
    </div>
    <div class="ss-sample-row">
      <span class="ss-pill ss-pill-soft">Soft pill</span>
      <span class="ss-pill ss-pill-outline">Outline pill</span>
      <ss-widget name="ss.pill" data-props='{"text":"With an icon","icon":"fa-cloud-rain","style":"soft"}'></ss-widget>
    </div>
    <div class="ss-sample-grid3">
      <ss-widget name="ss.bar" data-props='{"label":"HP","kind":"hp","value":{{ q.pc.hp.cur }},"max":{{ q.pc.hp.max }}}'></ss-widget>
      <ss-widget name="ss.bar" data-props='{"label":"MP","kind":"mp","value":{{ q.pc.mp.cur }},"max":{{ q.pc.mp.max }}}'></ss-widget>
      <ss-widget name="ss.bar" data-props='{"label":"SP","kind":"sp","value":{{ q.pc.sp.cur }},"max":{{ q.pc.sp.max }}}'></ss-widget>
    </div>
    <div class="ss-bar ss-bar-exp" role="meter" aria-label="Soul growth" aria-valuemin="0" aria-valuemax="{{ q.pc.exp.max }}" aria-valuenow="{{ q.pc.exp.cur }}">
      <div class="ss-bar-head" aria-hidden="true"><span class="ss-bar-label">Soul growth (classes only)</span><span class="ss-bar-value">{{ q.pc.exp.cur }} / {{ q.pc.exp.max }}</span></div>
      <div class="ss-bar-track" data-bind-var="--ss-fill: ratio(q.pc.exp.cur, q.pc.exp.max)"><div class="ss-bar-fill"></div></div>
    </div>
    <div class="ss-sample-row">
      <ss-widget data-each="q.statuses as s" name="ss.status" data-props='{"label":"{{ s.label }}","icon":"{{ s.icon }}","left":"{{ s.left }}","unit":"{{ s.unit }}","tone":"{{ s.tone }}","id":"{{ s.id }}"}'></ss-widget>
    </div>
  </div>
  <p class="ss-label ss-glass-strong ss-sample-tag">Tiles · level badge, tick, lock, chosen</p>
  <div class="ss-glass ss-sample-grid3">
    <ss-widget data-each="q.skills as k" name="ss.tile" data-props='{"label":"{{ k.label }}","icon":"{{ k.icon }}","count":"{{ k.count }}","state":"{{ k.state }}","selected":"{{ k.selected }}","tone":"{{ k.tone }}","hint":"{{ k.hint }}","id":"{{ k.id }}"}'></ss-widget>
  </div>
  <p class="ss-label ss-glass-strong ss-sample-tag">Bag tiles · count in the corner, rarity rings</p>
  <div class="ss-glass ss-sample-row">
    <ss-widget data-each="q.bag as b" name="ss.tile" data-props='{"label":"{{ b.label }}","icon":"{{ b.icon }}","count":"{{ b.count }}","countStyle":"corner","tone":"{{ b.tone }}","showLabel":false,"id":"{{ b.id }}"}'></ss-widget>
  </div>
  <div class="ss-glass-strong">
    <p class="ss-label">Strong glass</p>
    <p style="margin: 4px 0 0">Navigation and cards over busy art. <span style="color: var(--ss-muted)">Muted text for the quiet parts.</span></p>
  </div>
  <p class="ss-label ss-glass-strong ss-sample-tag">Hero · portrait, bars, corner, badges</p>
  <ss-widget name="ss.hero" data-props='{"bind":"q.hero"}'></ss-widget>
  <p class="ss-label ss-glass-strong ss-sample-tag">Hero, compact · the strip under a reply</p>
  <ss-widget name="ss.hero" data-props='{"bind":"q.heroCompact"}'></ss-widget>
  <p class="ss-label ss-glass-strong ss-sample-tag">Tiers · tiles joined by a connector</p>
  <ss-widget name="ss.tiers" data-props='{"bind":"q.tiers","onSelect":"sample.pick"}'></ss-widget>
  <p class="ss-label ss-glass-strong ss-sample-tag">List cards · value, tag, chosen row, icon</p>
  <ss-widget name="ss.listcard" data-props='{"bind":"q.ready"}'></ss-widget>
  <ss-widget name="ss.listcard" data-props='{"bind":"q.here","onSelect":"sample.pick"}'></ss-widget>
  <ss-widget name="ss.listcard" data-props='{"bind":"q.people"}'></ss-widget>
  <p class="ss-label ss-glass-strong ss-sample-tag">Map · places, a route, the reader's place, fog, legend</p>
  <ss-widget name="ss.map" data-props='{"bind":"q.map"}'></ss-widget>
  <p class="ss-label ss-glass-strong ss-sample-tag">Tabs and navbar · arrows move, Enter chooses</p>
  <ss-widget name="ss.tabs" data-props='{"bind":"q.tabs","onSelect":"sample.go"}'></ss-widget>
  <ss-widget name="ss.navbar" data-props='{"bind":"q.nav","onSelect":"sample.go"}'></ss-widget>
  <p class="ss-label ss-glass-strong ss-sample-tag">Dialog · focus trap, Escape, focus returns</p>
  <div class="ss-sample-row"><button type="button" class="menu_button ss-sample-open-dialog">Open a dialog</button></div>
  <p class="ss-label ss-glass-strong ss-sample-tag">Form engine · switch, fields, slider, chips, lines, search, groups</p>
  <div class="ss-sample-form"></div>
</section>`;
}

/** The sample screen: a template (both panes) and its data. */
export const uiSampleScreen = Object.freeze({
    id: UI_SAMPLE_ID,
    title: 'UI sample',
    icon: 'fa-swatchbook',
    mounts: Object.freeze(['dialog']),
    template: `<div class="ss-sample-panes">${pane('light')}${pane('dark')}</div>`,
});

/** The template text of one pane, for tests. */
export const uiSamplePane = pane;

/**
 * Opens the sample over the page: a full-screen layer (SillyTavern's background shows through it) with a
 * Close button; Escape closes it too. `widgets()` → the registered widgets; `sanitize` SillyTavern's
 * DOMPurify. → { root, close() }. A second call closes the first.
 */
export function openUiSample({ doc = globalThis.document, widgets = () => ({}), sanitize = null } = {}) {
    doc.querySelector?.('#story_suite_ui_sample')?.remove();
    const before = doc.activeElement ?? null;
    const T = UI_SAMPLE_TEXT;
    const layer = doc.createElement('div');
    layer.id = 'story_suite_ui_sample';
    layer.className = 'ss-sample';
    layer.setAttribute('data-ss-screen', UI_SAMPLE_ID);
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'story_suite_ui_sample_title');
    const head = doc.createElement('div');
    head.className = 'ss-sample-head ss-glass-strong';
    const title = doc.createElement('b');
    title.id = 'story_suite_ui_sample_title';
    title.textContent = T.title;
    const note = doc.createElement('small');
    note.textContent = T.note;
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'menu_button ss-sample-close';
    close.textContent = T.close;
    close.title = T.closeTitle;
    head.append(title, note, close);
    const body = doc.createElement('div');
    body.className = 'ss-sample-body';
    layer.append(head, body);
    doc.body.appendChild(layer);
    const renderer = createScreenRenderer({ queryAt: () => null, widgets, sanitize });
    let cleanup = null;
    try {
        cleanup = renderer.render(body, uiSampleScreen, { mount: 'dialog', q: UI_SAMPLE_DATA, state: null, api: {} });
    } catch (error) {
        body.textContent = `The UI sample could not be drawn: ${error?.message ?? error}`;
    }
    // The demo form of the form engine, into each pane's slot (its own store each: nothing of the reader's is touched).
    const demos = [];
    for (const slot of layer.querySelectorAll?.('.ss-sample-form') ?? []) {
        try { demos.push(mountDemoForm(doc, slot)); } catch (error) { slot.textContent = `The demo form could not be drawn: ${error?.message ?? error}`; }
    }
    let open = true;
    const api = {
        root: layer,
        close() {
            if (!open) return;
            open = false;
            for (const demo of demos) { try { demo.destroy(); } catch { /* the layer goes either way */ } }
            try { cleanup?.(); } catch { /* the layer goes either way */ }
            layer.remove();
            if (before && before !== doc.body && before.isConnected !== false) before.focus?.();
        },
    };
    layer.addEventListener('keydown', event => {
        if (event?.key !== 'Escape') return;
        event.preventDefault?.();
        event.stopPropagation?.();
        api.close();
    });
    close.addEventListener('click', () => api.close());
    // "Open a dialog": the widget ss.dialog over the page (in a wrapper of its own: a fixed panel inside a glass
    // card with a backdrop filter would sit in that card), in the scheme of the pane its button is in.
    const dialogWidget = (typeof widgets === 'function' ? widgets() : {})?.['ss.dialog'];
    if (dialogWidget && typeof layer.querySelectorAll === 'function') {
        for (const opener of layer.querySelectorAll('.ss-sample-open-dialog')) {
            opener.addEventListener('click', () => {
                const scheme = opener.closest?.('.ss-scheme-dark') ? 'dark' : 'light';
                const wrap = doc.createElement('div');
                // ss-sample-dialog: inside the zoom and the phone's 44px rule like the sample itself (view/size.css)
                wrap.className = `ss-sample-dialog ss-scheme-${scheme}`;
                wrap.setAttribute('data-ss-screen', UI_SAMPLE_ID);
                doc.body.appendChild(wrap);
                let handle = null;
                const done = () => { handle?.destroy(); wrap.remove(); };
                handle = dialogWidget.render(wrap, { ...UI_SAMPLE_DATA.dialog, onSelect: 'sample.dialog' }, { command: () => { done(); } });
            });
        }
    }
    close.focus?.();
    return api;
}
