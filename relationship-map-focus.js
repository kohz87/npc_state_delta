/* NPC State Delta relationship map focus and look: pure helpers for "Focus" on one person (which nodes and
   bonds stay lit, each tied person's relation word and tone, the "Focus: Name ✕" chip) and the markup of the
   map's rings, faces, bond lines and person card. Layout and bond resolution stay in relationship-map-core.js.
   No host or state access; the markup is strings, portraits go through the dossier's portrait refs. */
import { MAP_CARD_BESIDE_MIN, MAP_CARD_MIN, MAP_CENTER, MAP_LENSES, MAP_SPAN, mapRadius, nodeBoxes, plain, resolveMapBonds, ringWordSpot, signed } from './relationship-map-core.js';
import { portraitHtml } from './dossier-ui-html.js';
import { dialHtml } from './dossier-ui-dial.js';
import { moodTile } from './dossier-ui-view-model.js';
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

// The word a tie tag gives (the Ties section's rule: owes first, else the first tag), or '' without tags.
export const tagWord = tags => { const list = Array.isArray(tags) ? tags : []; return list.includes('owes') ? 'owes' : (list[0] || ''); };

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
        // The focused person's own tie tag names the tie ("ally", "rival", "owes"), as in the Ties section; else the relation's family word.
        const word = tagWord(bond.tagsBy?.[id]) || relationWord(relation);
        const dynamic = plain(bond.dynamic?.[id]) || plain(bond.dynamic?.[other]);
        return { id: other, name: names.get(other) || '', relation, dynamic, word, tone: bondToneOf(word, relation, { bondTone, tags: bond.tagsBy?.[id] || bond.tags }) };
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
    const own = prefer ? bond.tagsBy?.[prefer] : null;
    const word = tagWord(own) || relationWord(relation);
    return { word, tone: bondToneOf(word, relation, { bondTone, tags: own || bond.tags }) };
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
    // The ring's word sits where no face or label is (ringWordSpot); relationship-map.js refines it against the measured labels.
    const spot = ringWordSpot(nodeBoxes(model.nodes));
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
        return { id: other, name: names.get(other) || '', word, tone, relation, dynamic: plain(line.dynamic?.[id]) || plain(line.dynamic?.[other]) };
    }).sort((a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

// "Warmth +11 · Trust +11 · Tension +13": the selected person's numbers toward the player (the dial in the card carries all four).
export function cardNumbersLine(selected) {
    const by = Object.fromEntries((selected?.axes || []).map(axis => [axis.key, axis.value]));
    const warmth = Math.round(((by.trust || 0) + (by.affection || 0)) / 2);
    return [['Warmth', warmth], ['Trust', by.trust || 0], ['Tension', by.tension || 0]].map(([label, value]) => `${label} ${signed(value)}`).join(' · ');
}

// "Her", "His" or "Their", from the gender the dossier holds (the heading "Her ties" in Focus).
export function possessiveWord(gender = '') {
    const text = plain(gender).toLocaleLowerCase();
    if (/^(?:f|she)|\b(?:female|woman|girl)\b/.test(text)) return 'Her';
    if (/^(?:m$|male|he\b)|\b(?:man|boy)\b/.test(text)) return 'His';
    return 'Their';
}

// The phone's one line: "warmth +11 · ally of Temiwa · rival of Bregje" (a tie word that reads "of": ally, rival; owes and the rest lead the name).
function compactLine(sel, ties, shortOf) {
    const warmth = cardNumbersLine(sel).split(' · ')[0].toLocaleLowerCase();
    const tied = ties.map(t => {
        const who = shortOf.get(t.id) || t.name;
        return /^(?:ally|rival|friend|enemy|kin)$/.test(t.word) ? `${t.word} of ${who}` : `${t.word || 'tied to'} ${who}`;
    });
    return [warmth, ...tied].join(' · ');
}

// The card (mockup screens 9 and 10). Beside the map: the dial round her portrait (a tap opens her profile), name, Key and mood pills, the
// numbers, "Bonds on the map" (inline) or, in Focus, "Her ties" (a row each, with the dynamic), Open dossier and Focus. Under the map on a phone:
// a face, name and one line; in Focus the "Rika's ties" block. Both sets of parts are in the markup; the container query shows one set.
export function mapCardHtml(model, focus, persona, { refs = null, npc = null } = {}) {
    const sel = model.selected;
    if (!sel) return '<aside class="delta-map-card delta-map-card-empty"><p class="delta-map-last">Pick an NPC on the map.</p></aside>';
    const id = escapeHtml(sel.id);
    const focused = focus.active && focus.focusId === sel.id;
    const node = (model.nodes || []).find(item => item.id === sel.id);
    const shortOf = new Map((model.nodes || []).map(item => [item.id, item.short]));
    const ties = selectedTies(model);
    const word = t => `<span data-tone="${t.tone}">${escapeHtml(t.word || 'tied')}</span>`;
    const inline = ties.length ? ties.map(t => `<span class="delta-map-tie">${word(t)} ${escapeHtml(t.name)}</span>`).join('<i class="delta-map-tie-sep"> · </i>') : 'No ties to anyone else on the map.';
    const rows = ties.map(t => `<span class="delta-map-tie">${word(t)} <b>${escapeHtml(t.name)}</b>${t.dynamic ? ` · ${escapeHtml(t.dynamic)}` : ''}</span>`).join('');
    const own = `${sel.name}'s ties`;
    const heading = `<b class="delta-map-ties-head"><span class="delta-map-beside">${escapeHtml(focused ? `${possessiveWord(npc?.gender)} ties` : 'Bonds on the map')}</span><span class="delta-map-stacked">${escapeHtml(own)}</span></b>`;
    const mood = npc ? moodTile(npc).text : '';
    const pills = [npc?.key ? '<span class="delta-pill delta-pill-key">★ Key</span>' : '', mood ? `<span class="delta-pill delta-pill-mood">${escapeHtml(mood)}</span>` : ''].filter(Boolean).join('');
    const dial = npc ? dialHtml(npc, { refs }) : `<div class="delta-map-card-face">${portraitHtml({ name: sel.name, portrait: node?.portrait || '' }, 'delta-map-card-img', { alt: false, refs })}</div>`;
    const focusBtn = focused ? '' : `<button type="button" class="delta-btn delta-map-focus ss-tap-pill" data-map-focus="${id}">Focus</button>`;
    return `<aside class="delta-map-card" data-focus="${focused ? 'on' : 'off'}" aria-label="${escapeHtml(`${sel.name} toward ${persona}`)}">
        <button type="button" class="delta-map-card-dial delta-map-beside" data-map-profile="${id}" aria-label="${escapeHtml(`${sel.name}: open the profile`)}">${dial}</button>
        <h3 class="delta-map-card-name delta-map-beside">${escapeHtml(sel.name)}</h3>
        <div class="delta-map-card-pills delta-map-beside">${pills}</div>
        <p class="delta-map-card-line delta-map-beside">${escapeHtml(cardNumbersLine(sel))}</p>
        ${focused ? '' : `<div class="delta-map-card-who delta-map-stacked"><span class="delta-map-card-face">${portraitHtml({ name: sel.name, portrait: node?.portrait || '' }, 'delta-map-card-img', { alt: false, refs })}</span><p><b>${escapeHtml(sel.name)}</b> <span>${escapeHtml(compactLine(sel, ties, shortOf))}</span></p></div>`}
        <div class="delta-map-ties${focused ? ' delta-map-ties-focus' : ''}">${focused ? heading : `<b class="delta-map-ties-head delta-map-beside">Bonds on the map</b>`}
            <p class="delta-map-ties-inline${focused ? '' : ' delta-map-beside'}">${inline}</p>${focused ? `<div class="delta-map-ties-rows delta-map-beside">${rows}</div>` : ''}</div>
        <div class="delta-map-actions"><button type="button" class="delta-btn delta-map-open ss-tap-pill" data-npc-id="${id}">Open dossier ›</button>${focusBtn}</div>
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
${root} .delta-map-focus-chip { display:inline-flex; align-items:center; gap:6px; min-height:34px; padding:0 4px 0 12px; border:1px solid var(--delta-accent); border-radius:999px; color:var(--delta-text); font-size:var(--dt-meta); }
${root} .delta-map-focus-clear { min-width:30px; min-height:30px; border:0; border-radius:50%; color:var(--delta-text); background:transparent; cursor:pointer; }
/* the card: under the map (phone) it is a face, name and one line, or in Focus the "Rika's ties" block; beside the map (when the circle and
   the card both fit, MAP_CARD_BESIDE_MIN) it is the mockup's side card: the dial, name, pills, numbers, the ties, Open dossier */
${root} .delta-map-card { flex:none; display:grid; justify-items:start; align-content:start; gap:clamp(6px,1cqw,10px); min-width:0; padding:clamp(10px,2cqw,16px) clamp(10px,3cqw,18px); border-top:1px solid var(--delta-line); font-size:var(--dt-body); }
${root} .delta-map-card .delta-map-beside { display:none; }
${root} .delta-map-card-who { display:flex; align-items:center; gap:10px; min-width:0; }
${root} .delta-map-card-who > p { margin:0; min-width:0; font-size:var(--dt-meta); color:var(--delta-muted); overflow-wrap:anywhere; }
${root} .delta-map-card-who > p > b { color:var(--delta-text); font-size:var(--dt-body); }
${root} .delta-map-card-face { flex:none; display:block; width:clamp(36px,10cqw,52px); aspect-ratio:1; overflow:hidden; border:2px solid var(--delta-accent); border-radius:50%; background:var(--face-flat, #3a3740); }
${root} .delta-map-card-img { display:block; width:100%; height:100%; object-fit:cover; object-position:center 12%; }
${root} .delta-map-card-img.delta-portrait-placeholder { display:grid; place-items:center; color:var(--delta-muted); font:700 clamp(12px,3.4cqw,18px)/1 var(--ss-font, system-ui, sans-serif); }
${root} .delta-map-ties { margin:0; display:grid; gap:4px; min-width:0; justify-self:stretch; font-size:var(--dt-meta); color:var(--delta-muted); line-height:1.5; }
${root} .delta-map-ties-head { display:block; font-size:var(--dt-kick); letter-spacing:.12em; text-transform:uppercase; color:var(--aff, var(--delta-accent)); }
${root} .delta-map-ties-inline { margin:0; color:var(--delta-text); font-size:var(--dt-body); }
${root} .delta-map-ties-focus .delta-map-ties-head { font-size:var(--dt-body); letter-spacing:0; text-transform:none; color:var(--delta-text); }
${root} .delta-map-tie > [data-tone] { color:color-mix(in srgb, var(--tone) 78%, var(--delta-text)); }
${root} .delta-map-ties-rows { display:grid; gap:clamp(5px,.8cqw,9px); }
${root} .delta-map-ties-rows .delta-map-tie { display:block; }
${root} .delta-map-ties-rows .delta-map-tie b { color:var(--delta-text); }
${root} .delta-map-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
${root} .delta-map-card-empty .delta-map-card-line { margin:0; }
@container dsr (min-width: ${MAP_CARD_BESIDE_MIN}px) {
  ${root} .delta-map-body { display:grid; grid-template-columns:minmax(0,1fr) clamp(${MAP_CARD_MIN}px,28cqw,360px); grid-template-rows:minmax(0,1fr); overflow:hidden; }
  ${root} .delta-map-stage { min-height:0; display:grid; grid-template-rows:minmax(0,1fr); padding-bottom:14px; }
  ${root} .delta-map-frame { container-type:size; }
  ${root} .delta-map { width:min(100cqw,100cqh); max-width:none; }
  ${root} .delta-map-card { justify-items:center; text-align:center; overflow:auto; padding:clamp(14px,2cqw,24px) clamp(12px,1.6cqw,20px); border-top:0; border-left:1px solid var(--delta-line); }
  ${root} .delta-map-card .delta-map-stacked, ${root} .delta-map-ties-focus .delta-map-ties-inline { display:none; }
  ${root} .delta-map-card .delta-map-beside { display:block; }
  ${root} .delta-map-card-dial { display:grid; width:min(100%,clamp(150px,18cqw,270px)); padding:0; border:0; background:none; color:inherit; font:inherit; cursor:pointer; }
  ${root} .delta-map-card-dial .dossier-dial { width:100%; }
  ${root} .delta-map-card-name { margin:2px 0 0 !important; padding:0 !important; border:0 !important; text-align:center !important; font-size:clamp(20px,1.2cqw + 12px,30px); line-height:1.1; font-weight:600; color:var(--delta-text); text-transform:none; letter-spacing:0; overflow-wrap:anywhere; }
  ${root} .delta-map-card-pills { display:flex; flex-wrap:wrap; justify-content:center; gap:6px; }
  ${root} .delta-map-card-line { margin:0; color:var(--delta-muted); font-size:var(--dt-meta); }
  ${root} .delta-map-ties { text-align:left; }
}
${root} .delta-map-key-line { margin:0; color:var(--delta-muted); font-size:var(--dt-meta); }
`;
}
