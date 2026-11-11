// The fight board's compact status chips and its choosing-member strips: foe groups and the party as chips with a 4-segment
// Health mini-bar, the Mana and Stamina strip above the skills, and a skill button with its cost and a "not enough" state.
// Pure render helpers: each takes a document and plain numbers and strings, and returns a DOM node. They keep no state and attach
// no clicks; view.js attaches the press (pressButton) and passes the affordability reason from plan.js actionSkills.
// Text goes in as textContent only, never as markup; names are flattened to one line by text().

import { h, text } from '../../view/widgets/dom.js';

export const SEGMENTS = 4;
export const NOT_ENOUGH = 'not enough';
const TONES = Object.freeze(['good', 'warn', 'bad']);
const toneOf = tone => (TONES.includes(tone) ? tone : 'neutral');
const numberOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const hasValue = value => value !== undefined && value !== null && value !== '';

/** Lit segments of a bar: the share of blocks left, rounded up so any block left lights one segment. */
export function litSegments(value, max) {
    if (!(max > 0)) return 0;
    const share = Math.min(1, Math.max(0, numberOr(value) / max));
    return Math.ceil(share * SEGMENTS - 1e-9);
}

/** The Health mini-bar: four segments in the chip's tone, lit by the blocks left (`max` 0 or less: all dark). */
export function healthMiniBar(doc, { value, max, tone } = {}) {
    const bar = h(doc, 'span', `rpg-mini rpg-mini-${toneOf(tone)}`);
    const lit = litSegments(value, max);
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-label', 'Health');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(max > 0 ? max : 0));
    bar.setAttribute('aria-valuenow', String(max > 0 ? Math.min(max, Math.max(0, numberOr(value))) : 0));
    for (let at = 0; at < SEGMENTS; at++) bar.appendChild(h(doc, 'i', at < lit ? 'lit' : 'off'));
    return bar;
}

// One chip: name (with ×count for a group), "Lv N" when known, then the Health mini-bar.
function chip(doc, { name, level, count = 1, value, max, tone, party = false } = {}) {
    const node = h(doc, 'div', `rpg-chip${party ? ' rpg-chip-party' : ''}${max > 0 && !(numberOr(value) > 0) ? ' rpg-chip-down' : ''}`);
    const label = h(doc, 'span', 'rpg-chip-name');
    const shown = text(name, 60);
    label.appendChild(h(doc, 'span', 'rpg-chip-title', numberOr(count, 1) > 1 ? `${shown} ×${Math.trunc(count)}` : shown));   // wraps between words, 2 lines at most (board.css)
    if (hasValue(level)) label.appendChild(h(doc, 'small', 'rpg-chip-level', `Lv ${text(level, 6)}`));
    node.appendChild(label);
    node.appendChild(healthMiniBar(doc, { value, max, tone }));
    return node;
}

/** A foe group as ONE chip: "Ridge hounds ×12" (pass `count`), its level, and its Health mini-bar. */
export function foeGroupChip(doc, props = {}) {
    return chip(doc, { ...props, party: false });
}

/** A party member as a chip: name, level and Health mini-bar (the party's chips take the accent border in board.css). */
export function partyChip(doc, props = {}) {
    return chip(doc, { ...props, count: 1, party: true });
}

/** One Mana or Stamina row: label, a bar at value/max, and "10/10". */
function resourceRow(doc, kind, label, { value, max } = {}) {
    const row = h(doc, 'span', `rpg-res rpg-res-${kind}`);
    const cap = Math.max(0, numberOr(max));
    const now = Math.min(cap, Math.max(0, numberOr(value)));
    const width = cap > 0 ? Math.round((now / cap) * 100) : 0;
    row.appendChild(h(doc, 'em', 'rpg-res-label', label));
    const track = h(doc, 'i', 'rpg-res-track');
    const fill = h(doc, 'b', 'rpg-res-fill');
    fill.style.width = `${width}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(h(doc, 'span', 'rpg-res-count', `${now}/${cap}`));
    return row;
}

/**
 * The choosing member's strip, right above the skills: `mana` and `stamina` as { value, max } (blocks left and blocks in the bar).
 * A member with no Mana (`mana` null, or a bar of size 0) shows Stamina only.
 */
export function resourceStrip(doc, { mana = null, stamina = null } = {}) {
    const strip = h(doc, 'div', 'rpg-actor');
    if (mana && numberOr(mana.max) > 0) strip.appendChild(resourceRow(doc, 'mp', 'Mana', mana));
    if (stamina) strip.appendChild(resourceRow(doc, 'sp', 'Stamina', stamina));
    return strip;
}

/**
 * A skill button: name, then "area · STR · 2 Stamina" (the resource is Mana when `uses` is 'mana', else Stamina; the cost only when known).
 * `blocked` (the member cannot pay: pass the truthy reason from plan.js actionSkills) greys it, disables it and says "not enough".
 */
export function skillButton(doc, { name, stat, uses, cost, area = false, blocked = false } = {}) {
    const resource = uses === 'mana' ? 'Mana' : 'Stamina';
    const isBlocked = Boolean(blocked);
    const node = h(doc, 'button', `rpg-skill${area ? ' rpg-skill-area' : ''}${isBlocked ? ' rpg-skill-blocked' : ''}`);
    node.setAttribute('type', 'button');
    node.disabled = isBlocked;
    node.appendChild(h(doc, 'b', 'rpg-skill-name', text(name, 60)));
    const paid = uses === 'mana' || uses === 'stamina', costed = !paid ? '' : Number.isInteger(cost) && cost > 0 ? `${cost} ${resource}` : resource;
    const parts = [area ? 'area' : '', hasValue(stat) ? text(stat, 12).toUpperCase() : '', costed].filter(Boolean);
    if (isBlocked) parts.push(NOT_ENOUGH);
    node.appendChild(h(doc, 'small', 'rpg-skill-cost', parts.join(' · ')));
    return node;
}

/** A target button: its label (the button's whole text) and the Health mini-bar of what it picks (a group or a member). */
export function targetButton(doc, { label, value, max, tone } = {}) {
    const node = h(doc, 'button', 'rpg-skill rpg-target', text(label, 90));
    node.setAttribute('type', 'button');
    node.appendChild(healthMiniBar(doc, { value, max, tone }));
    return node;
}

/** The status block: foe group chips, then party chips (each list is `[{ name, count?, level?, value, max, tone }]`). */
export function statusChips(doc, { foes = [], party = [] } = {}) {
    const box = h(doc, 'div', 'rpg-board-cards');
    const side = (cls, list, make) => { if (!list.length) return; const row = h(doc, 'div', `rpg-chips ${cls}`); for (const item of list) row.appendChild(make(doc, item)); box.appendChild(row); };
    side('rpg-chips-foes', foes, foeGroupChip);
    side('rpg-chips-party', party, partyChip);
    return box;
}
