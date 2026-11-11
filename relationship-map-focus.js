/* NPC State Delta relationship map focus and look: pure helpers for "Focus" on one person (which nodes and
   bonds stay lit, each tied person's relation word and tone, the "Focus: Name ✕" chip) and the markup of the
   map's rings, faces, bond lines and person card. Layout and bond resolution stay in relationship-map-core.js.
   No host or state access; the markup is strings, portraits go through the dossier's portrait refs. */
import { MAP_CENTER, MAP_LENSES, MAP_SPAN, mapRadius, plain, resolveMapBonds, signed } from './relationship-map-core.js';
import { portraitHtml } from './dossier-ui-html.js';
import { KNOWN_SOCIAL_RELATION_FAMILIES, socialRelationFamily } from './social-relations.js';
import { escapeHtml } from './src/util/html.js';

export const FOCUS_TONES = Object.freeze({ good: 'good', bad: 'bad', gold: 'gold', grey: 'grey' });
export const FOCUS_STATES = Object.freeze({ focus: 'focus', tied: 'tied', dim: 'dim', plain: 'plain' });

// Green: kin, partner, friendship and the ties of teaching or guardianship (ally is the mockup's word for a friend).
const GOOD_WORDS = new Set([
    'child', 'parent', 'sibling', 'partner', 'mentor', 'student', 'guardian', 'ward', 'friend', 'cousin',
    'aunt-uncle', 'niece-nephew', 'grandparent', 'grandchild', 'parent-in-law', 'child-in-law', 'sibling-in-law',
    'ally',
]);
// Red: open hostility.
const BAD_WORDS = new Set(['rival', 'enemy']);
// Gold: a debt or a duty owed one way.
const GOLD_WORDS = new Set(['owes', 'debt', 'duty']);

// Free relation text that is not a known family still gets a word when it names one of the above.
const WORD_HINTS = Object.freeze([
    [/\ballies\b|\bally\b/, 'ally'],
    [/\benem(?:y|ies)\b/, 'enemy'],
    [/\brivals?\b/, 'rival'],
    [/\bowes?\b|\bowing\b|\bowed\b/, 'owes'],
    [/\bdebts?\b/, 'debt'],
    [/\bduty\b|\bduties\b/, 'duty'],
]);

// The relation word under a tied person's name: the known family when there is one, else the first
// hint word in the text, else the first two words of the text (cut to 18 characters).
export function relationWord(relation = '') {
    const text = plain(relation).toLocaleLowerCase();
    if (!text) return '';
    const family = socialRelationFamily(text);
    if (KNOWN_SOCIAL_RELATION_FAMILIES.has(family)) return family;
    const hint = WORD_HINTS.find(([pattern]) => pattern.test(text));
    if (hint) return hint[1];
    return text.split(/\s+/).slice(0, 2).join(' ').slice(0, 18);
}

// The local tone rule, keyed by the relation word. Anything not listed is grey.
export function localBondTone(word = '') {
    const key = plain(word).toLocaleLowerCase();
    if (BAD_WORDS.has(key)) return FOCUS_TONES.bad;
    if (GOLD_WORDS.has(key)) return FOCUS_TONES.gold;
    if (GOOD_WORDS.has(key)) return FOCUS_TONES.good;
    return FOCUS_TONES.grey;
}

// A bondTone(word, relation) passed in through options wins when it returns a known tone; otherwise
// the local rule decides. No bondTone helper exists in this repository yet, so callers pass none.
export function bondToneOf(word = '', relation = '', { bondTone } = {}) {
    if (typeof bondTone === 'function') {
        const tone = bondTone(word, relation);
        if (Object.values(FOCUS_TONES).includes(tone)) return tone;
    }
    return localBondTone(word);
}

// The "Focus: Name ✕" chip. Name and id are escaped; the ✕ button carries data-map-focus-clear.
export function focusChip(npcId = '', name = '') {
    const id = plain(npcId);
    if (!id) return null;
    const shown = plain(name) || id;
    const label = `Focus: ${shown}`;
    const clearLabel = `Stop focusing on ${shown}`;
    return {
        npcId: id,
        label,
        clearLabel,
        html: `<span class="delta-map-focus-chip" data-map-focus-id="${escapeHtml(id)}">${escapeHtml(label)}`
            + ` <button type="button" class="delta-map-focus-clear" data-map-focus-clear="${escapeHtml(id)}"`
            + ` aria-label="${escapeHtml(clearLabel)}" title="${escapeHtml(clearLabel)}">✕</button></span>`,
    };
}

// The focus model for the map as drawn. `map` is buildMapModel's result (its nodes are the shown people);
// `projection` is the same projection the map was built from, so bonds resolve the same way.
// Every shown node gets a state: focus (the person), tied (has a bond with them), dim (everyone else),
// or plain when no focus is active. Bonds listed are only those touching the focused person.
export function buildFocusModel(projection = {}, map = {}, focusId = '', { bondTone } = {}) {
    const id = plain(focusId);
    const nodes = Array.isArray(map?.nodes) ? map.nodes : [];
    const focus = nodes.find(node => node.id === id) || null;
    const states = Object.fromEntries(nodes.map(node => [node.id, FOCUS_STATES.plain]));
    if (!focus) return { active: false, focusId: '', name: '', states, litIds: [], bonds: [], ties: [], chip: null };

    const npcs = Array.isArray(projection?.npcs) ? projection.npcs.filter(npc => npc?.id) : [];
    const names = new Map(nodes.map(node => [node.id, plain(node.name)]));
    const bonds = resolveMapBonds(npcs, new Set(names.keys())).filter(bond => bond.a === id || bond.b === id);
    const ties = bonds.map(bond => {
        const other = bond.a === id ? bond.b : bond.a;
        // The focused person's own wording wins; the other side's wording is the fallback.
        const relation = plain(bond.relation?.[id]) || plain(bond.relation?.[other]);
        const word = relationWord(relation);
        return { id: other, name: names.get(other) || '', relation, word, tone: bondToneOf(word, relation, { bondTone }) };
    }).sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));

    const litIds = [id, ...ties.map(tie => tie.id)];
    const lit = new Set(litIds);
    for (const node of nodes) {
        if (node.id === id) states[node.id] = FOCUS_STATES.focus;
        else states[node.id] = lit.has(node.id) ? FOCUS_STATES.tied : FOCUS_STATES.dim;
    }
    return {
        active: true,
        focusId: id,
        name: plain(focus.name),
        states,
        litIds,
        bonds: bonds.map(bond => ({ a: bond.a, b: bond.b })),
        ties,
        chip: focusChip(id, focus.name),
    };
}

// A face's ring tone for how that person stands with you under the lens (not a number between NPCs).
export function faceTone(value = 0) {
    return value >= 25 ? FOCUS_TONES.good : (value <= -25 ? FOCUS_TONES.bad : FOCUS_TONES.grey);
}

// The bond's tone and word from either side's wording (the focused or first-named side wins).
export function bondLine(bond = {}, { bondTone, prefer = '' } = {}) {
    const ids = [prefer, bond.a, bond.b].filter(Boolean);
    const relation = ids.map(id => plain(bond.relation?.[id])).find(Boolean) || '';
    const word = relationWord(relation);
    return { word, tone: bondToneOf(word, relation, { bondTone }) };
}

const RING_VALUES = Object.freeze([75, 25, 0, -50]);

// Rings are plain circles (the outermost dashed = cold); bonds are dashed tone lines, solid and thick in focus.
export function mapSvgHtml(model, focus, opts = {}) {
    const lens = MAP_LENSES.find(item => item.key === model.lens) || MAP_LENSES[0];
    const circle = (r, cls) => `<circle class="${cls}" cx="${MAP_CENTER}" cy="${MAP_CENTER}" r="${r.toFixed(1)}"></circle>`;
    const rings = RING_VALUES.map(value => circle(mapRadius(value), value === 0 ? 'delta-map-ring delta-map-ring-zero' : 'delta-map-ring')).join('');
    const bonds = model.lines.filter(line => !focus.active || line.a === focus.focusId || line.b === focus.focusId).map(line => {
        const { tone } = bondLine(line, { ...opts, prefer: focus.focusId });
        const cls = `delta-map-bond${line.touches ? ' delta-map-bond-selected' : ''}${focus.active ? ' delta-map-bond-solid' : ''}`;
        return `<line class="${cls}" data-tone="${tone}" x1="${line.from.x.toFixed(1)}" y1="${line.from.y.toFixed(1)}" x2="${line.to.x.toFixed(1)}" y2="${line.to.y.toFixed(1)}"></line>`;
    }).join('');
    return `<svg class="delta-map-svg" viewBox="0 0 ${MAP_SPAN} ${MAP_SPAN}" aria-hidden="true" focusable="false">${circle(mapRadius(-100), 'delta-map-outer')}${rings}`
        + `<text class="delta-map-outer-word" x="${MAP_CENTER}" y="${(MAP_CENTER + mapRadius(-80)).toFixed(1)}">${escapeHtml(lens.negative)}</text>${bonds}</svg>`;
}

// One face: portrait through the refs (never a raw data URL), ring by tone, name, then the number
// or, in focus, the relation word under each tied name.
export function mapNodeHtml(node, focus, { refs = null, bondTone, ties = new Map() } = {}) {
    const state = focus.states[node.id] || FOCUS_STATES.plain;
    const tie = ties.get(node.id);
    const tone = tie ? tie.tone : faceTone(node.value);
    const delta = node.delta ? `<span class="delta-map-delta" aria-hidden="true">${escapeHtml(signed(node.delta))}</span>` : '';
    const under = tie ? `<small class="delta-map-word" data-tone="${tie.tone}">${escapeHtml(tie.word)}</small>` : `<small>${escapeHtml(signed(node.value))}</small>`;
    const label = `<span class="delta-map-label"><b class="delta-map-name">${escapeHtml(node.name)}</b><b class="delta-map-short">${escapeHtml(node.short)}</b>${under}</span>`;
    const said = `${node.name}, ${signed(node.value)}${tie ? `, ${tie.word}` : ''}`;
    return `<button type="button" class="delta-map-node" data-npc-id="${escapeHtml(node.id)}" data-status="${node.status}" data-tone="${tone}" data-focus="${state}" aria-pressed="${node.selected}" aria-label="${escapeHtml(said)}" style="left:${node.x.toFixed(2)}%;top:${node.y.toFixed(2)}%"><span class="delta-map-avatar">${portraitHtml({ name: node.short, portrait: node.portrait }, 'delta-map-face', { alt: false, refs })}</span>${delta}${label}</button>`;
}

// The card under the map: who is selected, the Focus button, and in focus the ties as "word Name".
export function mapCardHtml(model, focus, persona, barsHtml = '') {
    const sel = model.selected;
    if (!sel) return '<section class="delta-map-strip"><p class="delta-map-last">Pick an NPC on the map.</p></section>';
    const id = escapeHtml(sel.id);
    const focused = focus.active && focus.focusId === sel.id;
    const ties = focused ? `<p class="delta-map-ties"><b>${escapeHtml(`${sel.name}'s ties`)}</b> ${focus.ties.length ? focus.ties.map(t => `<span data-tone="${t.tone}">${escapeHtml(t.word || 'tied')}</span> ${escapeHtml(t.name)}`.trim()).join(' · ') : 'No ties to anyone else on the map.'}</p>` : '';
    const focusBtn = focused ? '' : `<button type="button" class="delta-btn delta-map-focus" data-map-focus="${id}">Focus</button>`;
    return `<section class="delta-map-strip" aria-label="${escapeHtml(`${sel.name} toward ${persona}`)}">
        <div class="delta-map-strip-head"><b>${escapeHtml(sel.name)}</b><small>toward ${escapeHtml(persona)}</small></div>
        ${barsHtml}${ties}
        <p class="delta-map-last">${sel.lastReason ? `${sel.lastWhen ? `<b>${escapeHtml(sel.lastWhen)}</b> ` : ''}${escapeHtml(sel.lastReason)}` : 'No relationship change recorded yet.'}</p>
        <div class="delta-map-actions">${focusBtn}<button type="button" class="delta-btn delta-primary delta-map-open" data-npc-id="${id}">Open dossier ›</button></div>
    </section>`;
}

// The key line under the lens switch: closer = higher on the chosen lens.
export function mapKeyLine(lensKey, persona) {
    const lens = MAP_LENSES.find(item => item.key === lensKey) || MAP_LENSES[0];
    const word = lens.key === 'warmth' ? 'warmer' : `higher ${lens.label.toLocaleLowerCase()}`;
    return `Closer to ${escapeHtml(persona)} = ${word} · the dashed outer ring = ${escapeHtml(lens.negative)}`;
}

// Focus-only and tone styles, added to the map's stylesheet.
export function focusStyles(root) {
    return `
${root} .delta-map-pane { --map-good:var(--delta-good); --map-bad:var(--delta-danger); --map-gold:var(--delta-warn); --map-grey:rgba(255,255,255,.34); }
${root} [data-tone="good"] { --tone:var(--map-good); } ${root} [data-tone="bad"] { --tone:var(--map-bad); } ${root} [data-tone="gold"] { --tone:var(--map-gold); } ${root} [data-tone="grey"] { --tone:var(--map-grey); }
${root} .delta-map-bond { stroke:var(--tone,var(--map-grey)); stroke-dasharray:5 4; opacity:.9; }
${root} .delta-map-bond-solid { stroke-dasharray:none; stroke-width:3; }
${root} .delta-map-node[data-focus="dim"] { opacity:.22; }
${root} .delta-map-node[data-focus="focus"] .delta-map-avatar { box-shadow:0 0 0 4px rgba(216,188,120,.25); }
${root} .delta-map-word { color:var(--tone); font-size:.68rem; font-weight:700; line-height:1.2; }
${root} .delta-map-focus-chip { display:inline-flex; align-items:center; gap:6px; min-height:34px; padding:0 4px 0 12px; border:1px solid var(--delta-accent); border-radius:999px; color:var(--delta-text); font-size:.8rem; }
${root} .delta-map-focus-clear { min-width:30px; min-height:30px; border:0; border-radius:50%; color:var(--delta-text); background:transparent; cursor:pointer; }
${root} .delta-map-ties { grid-column:1/-1; margin:0; font-size:.8rem; color:var(--delta-muted); }
${root} .delta-map-ties b { color:var(--delta-text); margin-right:6px; }
${root} .delta-map-ties span { color:var(--tone); font-weight:700; }
${root} .delta-map-actions { display:flex; gap:8px; }
${root} .delta-map-key-line { margin:0; color:var(--delta-muted); font-size:.78rem; }
`;
}
