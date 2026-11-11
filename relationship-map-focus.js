/* NPC State Delta relationship map focus and look: pure helpers for "Focus" on one person (which nodes and
   bonds stay lit, each tied person's relation word and tone, the "Focus: Name ✕" chip) and the markup of the
   map's rings, faces, bond lines and person card. Layout and bond resolution stay in relationship-map-core.js.
   No host or state access; the markup is strings, portraits go through the dossier's portrait refs. */
import { MAP_CENTER, MAP_LENSES, MAP_SPAN, mapRadius, plain, resolveMapBonds, ringWordSpot, signed } from './relationship-map-core.js';
import { portraitHtml } from './dossier-ui-html.js';
import { KNOWN_SOCIAL_RELATION_FAMILIES, socialRelationFamily } from './social-relations.js';
import { escapeHtml } from './src/util/html.js';
import { tieTone } from './dossier-ui-bond-tone.js';

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
export function bondToneOf(word = '', relation = '', { bondTone, tags } = {}) {
    // A tie tag the story gave (ally, rival, owes) wins over the relation word's tone (dossier-ui-bond-tone.js).
    const tied = { hostile: FOCUS_TONES.bad, duty: FOCUS_TONES.gold, close: FOCUS_TONES.good }[tieTone(tags)];
    if (tied) return tied;
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
            + ` <button type="button" class="delta-map-focus-clear ss-tap-pill" data-map-focus-clear="${escapeHtml(id)}"`
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
        return { id: other, name: names.get(other) || '', relation, word, tone: bondToneOf(word, relation, { bondTone, tags: bond.tags }) };
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
    return { word, tone: bondToneOf(word, relation, { bondTone, tags: bond.tags }) };
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
    // The ring's word sits where no face or label is (ringWordSpot), not at a fixed place.
    const spot = ringWordSpot(model.nodes);
    return `<svg class="delta-map-svg" viewBox="0 0 ${MAP_SPAN} ${MAP_SPAN}" aria-hidden="true" focusable="false">${circle(mapRadius(-100), 'delta-map-outer')}${rings}`
        + `<text class="delta-map-outer-word" x="${spot.x.toFixed(1)}" y="${spot.y.toFixed(1)}" text-anchor="${spot.anchor}">${escapeHtml(lens.negative)}</text>${bonds}</svg>`;
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
    return `<button type="button" class="delta-map-node" data-npc-id="${escapeHtml(node.id)}" data-status="${node.status}" data-tone="${tone}" data-focus="${state}" aria-pressed="${node.selected}" aria-label="${escapeHtml(said)}" style="left:${node.x.toFixed(2)}%;top:${node.y.toFixed(2)}%"><span class="delta-map-avatar">${portraitHtml({ name: node.name, portrait: node.portrait }, 'delta-map-face', { alt: false, refs })}</span>${delta}${label}</button>`;
}

// The people the selected one is tied to on the map, with the relation word and tone (from the model's bond lines, so it needs no focus).
export function selectedTies(model) {
    const id = model?.selected?.id;
    if (!id) return [];
    const names = new Map((model.nodes || []).map(node => [node.id, node.name]));
    return (model.lines || []).filter(line => line.a === id || line.b === id).map(line => {
        const other = line.a === id ? line.b : line.a;
        const { word, tone } = bondLine(line, { prefer: id });
        const relation = plain(line.relation?.[id]) || plain(line.relation?.[other]);
        return { id: other, name: names.get(other) || '', word, tone, relation };
    }).sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

// "Warmth +11 · Trust +11 · Affection +10 · Desire +6 · Tension +13": the selected person's numbers toward the player.
export function cardNumbersLine(selected) {
    const by = Object.fromEntries((selected?.axes || []).map(axis => [axis.key, axis.value]));
    const warmth = Math.round(((by.trust || 0) + (by.affection || 0)) / 2);
    const parts = [['Warmth', warmth], ...(selected?.axes || []).map(axis => [axis.label, axis.value])];
    return parts.map(([label, value]) => `${label} ${signed(value)}`).join(' · ');
}

// The card: on desktop it stands beside the map (portrait, name, the numbers, her ties, Open dossier); on phone it is the full-width
// "Rika's ties" block under the map. Ties are listed with or without Focus; Focus lights them on the map.
export function mapCardHtml(model, focus, persona, { refs = null } = {}) {
    const sel = model.selected;
    if (!sel) return '<aside class="delta-map-card delta-map-card-empty"><p class="delta-map-last">Pick an NPC on the map.</p></aside>';
    const id = escapeHtml(sel.id);
    const focused = focus.active && focus.focusId === sel.id;
    const node = (model.nodes || []).find(item => item.id === sel.id);
    const ties = selectedTies(model);
    const tieRows = ties.length
        ? ties.map(t => `<span class="delta-map-tie"><span data-tone="${t.tone}">${escapeHtml(t.word || 'tied')}</span> ${escapeHtml(t.name)}${t.relation && t.relation.toLocaleLowerCase() !== (t.word || '').toLocaleLowerCase() ? `<em> · ${escapeHtml(t.relation)}</em>` : ''}</span>`).join('<i class="delta-map-tie-sep"> · </i>')
        : 'No ties to anyone else on the map.';
    const focusBtn = focused ? '' : `<button type="button" class="delta-btn delta-map-focus ss-tap-pill" data-map-focus="${id}">Focus</button>`;
    return `<aside class="delta-map-card" aria-label="${escapeHtml(`${sel.name} toward ${persona}`)}">
        <div class="delta-map-card-face">${portraitHtml({ name: sel.name, portrait: node?.portrait || '' }, 'delta-map-card-img', { alt: false, refs })}</div>
        <h3 class="delta-map-card-name">${escapeHtml(sel.name)}</h3>
        <p class="delta-map-card-line">${escapeHtml(cardNumbersLine(sel))}</p>
        <p class="delta-map-ties"><b>${escapeHtml(`${sel.name}'s ties`)}</b> ${tieRows}</p>
        <p class="delta-map-last">${sel.lastReason ? `${sel.lastWhen ? `<b>${escapeHtml(sel.lastWhen)}</b> ` : ''}${escapeHtml(sel.lastReason)}` : 'No relationship change recorded yet.'}</p>
        <div class="delta-map-actions">${focusBtn}<button type="button" class="delta-btn delta-primary delta-map-open ss-tap-pill" data-npc-id="${id}">Open dossier ›</button></div>
    </aside>`;
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
${root} .delta-map-word { color:color-mix(in srgb, var(--tone) 75%, var(--delta-text)); font-size:.68rem; font-weight:700; line-height:1.2; }
${root} .delta-map-focus-chip { display:inline-flex; align-items:center; gap:6px; min-height:34px; padding:0 4px 0 12px; border:1px solid var(--delta-accent); border-radius:999px; color:var(--delta-text); font-size:.8rem; }
${root} .delta-map-focus-clear { min-width:30px; min-height:30px; border:0; border-radius:50%; color:var(--delta-text); background:transparent; cursor:pointer; }
${root} .delta-map-ties { margin:0; font-size:var(--dt-meta); color:var(--delta-muted); }
${root} .delta-map-ties b { color:var(--delta-text); margin-right:6px; }
${root} .delta-map-tie > [data-tone] { color:color-mix(in srgb, var(--tone) 75%, var(--delta-text)); font-weight:700; }
${root} .delta-map-tie em { font-style:normal; }
${root} .delta-map-actions { display:flex; flex-wrap:wrap; gap:8px; }
${root} .delta-map-key-line { margin:0; color:var(--delta-muted); font-size:.78rem; }
`;
}
