/* NPC State Delta dossier surface: the five section screens (Right now, With {{user}}, Ties, Past, Secrets) and their header with arrows and dots. Escaped markup only; reads the existing dossier projection, no new data. */
import { escapeHtml } from './src/util/html.js';
import { changeStamp, plain, relationshipValue, RELATIONSHIP_AXES } from './dossier-ui-model.js';
import { lastRelationshipChangeHtml } from './dossier-ui-relationship.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { castFromHtml, keyAwayHtml } from './dossier-ui-catalog.js';
import { bondTone } from './dossier-ui-view-model.js';
import { SECTION_KEYS } from './dossier-ui-screens.js';

// The five sections in the order the arrows, a sideways swipe and the dots walk them.
export const SECTION_IDS = SECTION_KEYS;

// The heading of one section. "With" takes the persona's name in each chat (the mockup's "With {{user}}").
export function sectionTitle(id, userName = '') {
    const who = plain(userName);
    if (id === 'now') return 'Right now';
    if (id === 'with') return who ? `With ${who}` : 'With you';
    if (id === 'ties') return 'Ties';
    if (id === 'past') return 'Past';
    if (id === 'secrets') return 'Secrets';
    return '';
}

// The section one step away (-1 back, 1 forward), or null at either end or for an unknown id.
export function sectionStep(id, step) {
    const at = SECTION_IDS.indexOf(id);
    if (at < 0) return null;
    return SECTION_IDS[at + Math.sign(Number(step) || 0)] ?? null;
}

// The header every section shares: ‹ and › (disabled at the ends), the title, "Name · N of 5" and one dot per section.
// The arrows carry data-delta-section-step="-1|1" and the dots data-delta-section-go="<id>" for the screens' handler.
export function sectionHeaderHtml(id, { npcName = '', userName = '' } = {}) {
    const at = SECTION_IDS.indexOf(id);
    if (at < 0) return '';
    const prev = sectionStep(id, -1);
    const next = sectionStep(id, 1);
    const who = plain(npcName);
    const dots = SECTION_IDS.map((other, index) => {
        const current = index === at;
        return `<button type="button" class="delta-section-dot${current ? ' on' : ''}" data-delta-section-go="${escapeHtml(other)}" aria-label="${escapeHtml(sectionTitle(other, userName))}"${current ? ' aria-current="step"' : ''}></button>`;
    }).join('');
    return `<header class="delta-section-head" data-delta-section-head="${escapeHtml(id)}">
        <button type="button" class="delta-section-arrow" data-delta-section-step="-1" aria-label="Previous section"${prev ? '' : ' disabled'}>‹</button>
        <div class="delta-section-title">
            <b>${escapeHtml(sectionTitle(id, userName))}</b>
            <span>${who ? `${escapeHtml(who)} · ` : ''}${at + 1} of ${SECTION_IDS.length}</span>
            <div class="delta-section-dots">${dots}</div>
        </div>
        <button type="button" class="delta-section-arrow" data-delta-section-step="1" aria-label="Next section"${next ? '' : ' disabled'}>›</button>
    </header>`;
}

// Right now: mood, where and what she is doing, her goal and condition, and the away block while a key person is away.
// Phase 1 leaves out the "Pull" tile (no data yet).
export function nowSectionHtml(npc = {}) {
    const cast = npc.cast && typeof npc.cast === 'object' ? npc.cast : {};
    const rows = [
        ['Mood', plain(npc.mood)],
        ['Where', plain(cast.where) || plain(npc.location)],
        ['Doing', plain(cast.doing)],
        ['Goal', plain(cast.goal) || plain(npc.goal)],
        ['Condition', plain(npc.status)],
    ].filter(([, value]) => value);
    // The Story Director away block and the pack's cast block (with its Pin button) live here, as they did in the old dossier.
    const blocks = `${npc.key ? keyAwayHtml(npc.key) : ''}${npc.cast ? castFromHtml(npc.cast, npc.id) : ''}`;
    if (!rows.length) return blocks || '<p class="delta-muted">Nothing about this moment is known yet.</p>';
    return `${blocks}<dl class="delta-sheet delta-kv">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`;
}

// With {{user}}: the four meters as bars that run from the centre (−100..100), the dynamic between them,
// the last change with how it came about, and the three recent changes before it.
export function withSectionHtml(npc = {}) {
    const rel = npc.relationship && typeof npc.relationship === 'object' ? npc.relationship : {};
    const meters = RELATIONSHIP_AXES.map(([axis, label]) => {
        const value = relationshipValue(rel[axis]);
        const left = value < 0 ? 50 + value / 2 : 50;
        const width = Math.abs(value) / 2;
        return `<div class="delta-sheet-meter delta-sheet-${escapeHtml(axis)}"><span>${escapeHtml(label)}</span><i class="delta-sheet-track" aria-hidden="true"><b style="left:${left}%;width:${width}%"></b></i><strong>${value > 0 ? '+' : ''}${value}</strong></div>`;
    }).join('');
    const summary = plain(npc.relationshipSummary);
    const recent = (Array.isArray(npc.recentRelationshipChanges) ? npc.recentRelationshipChanges : []).slice(0, 3).map(event => {
        const when = changeStamp(event).label;
        const impact = plain(event?.impact);
        return `<li>${when ? `<span class="delta-sheet-when">${escapeHtml(when)}</span>` : ''}${impact ? `<span class="delta-sheet-impact">${escapeHtml(impact)}</span>` : ''}<span>${escapeHtml(plain(event?.reason))}</span></li>`;
    }).join('');
    return `<div class="delta-sheet">
        <div class="delta-sheet-meters">${meters}</div>
        ${summary ? `<p class="delta-sheet-prose">${escapeHtml(summary)}</p>` : ''}
        ${lastRelationshipChangeHtml(npc.lastRelationshipChange)}
        ${recent ? `<div class="delta-sheet-recent"><h4>Recent changes</h4><ul class="delta-list">${recent}</ul></div>` : ''}
    </div>`;
}

// One important bond: the relation word (toned: green kin and friends, red rivals and enemies, gold debts and duties),
// the other person, and the dynamic. An entry that does not parse is shown as written, in the plain tone.
function tieHtml(entry) {
    const parsed = parseKeyRelationshipEntry(entry);
    if (!parsed) return `<div class="delta-bond" data-tone="grey"><p>${escapeHtml(plain(entry))}</p></div>`;
    const tone = bondTone(parsed.relation);
    return `<div class="delta-bond" data-tone="${escapeHtml(tone)}"><span class="delta-bond-word">${escapeHtml(parsed.relation)}</span><b>${escapeHtml(parsed.subject)}</b>${parsed.dynamic ? `<p>${escapeHtml(parsed.dynamic)}</p>` : ''}</div>`;
}

export function tiesSectionHtml(npc = {}) {
    const entries = Array.isArray(npc.keyRelationships) ? npc.keyRelationships : [];
    if (!entries.length) return '<p class="delta-muted">No important ties recorded yet.</p>';
    return `<div class="delta-sheet delta-ties">${entries.map(tieHtml).join('')}</div>`;
}

// Past: the remembered events as written (the projection carries no timestamps).
export function pastSectionHtml(npc = {}) {
    const memories = (Array.isArray(npc.memories) ? npc.memories : []).map(plain).filter(Boolean);
    if (!memories.length) return '<p class="delta-muted">Nothing remembered yet.</p>';
    return `<ol class="delta-sheet delta-past">${memories.map(memory => `<li>${escapeHtml(memory)}</li>`).join('')}</ol>`;
}

// Secrets: the hosted meters' notes (npc.v2Meters.secrets). An open note shows its title and text; a hidden note shows
// only its bar and its rule ("opens at Trust 60"), never its title or text. Same data as dossier-ui-meters.js v2SecretsHtml.
export function secretsSectionHtml(npc = {}) {
    const notes = Array.isArray(npc.v2Meters?.secrets) ? npc.v2Meters.secrets.filter(note => note && typeof note === 'object') : [];
    if (!notes.length) return '<p class="delta-muted">No secrets for this character yet.</p>';
    const opened = notes.filter(note => note.state === 'open').length;
    const rows = notes.map(note => (note.state === 'open'
        ? `<div class="delta-secret delta-secret-open"><div class="delta-secret-head"><b>${escapeHtml(plain(note.title))}</b><span class="delta-secret-pill">${escapeHtml(plain(note.pill))}</span></div>${plain(note.text) ? `<p>${escapeHtml(plain(note.text))}</p>` : ''}</div>`
        : `<div class="delta-secret delta-secret-hidden"><span class="delta-secret-bar" style="width:${Math.max(0, Math.min(100, Number(note.width) || 0))}%" aria-hidden="true"></span><span class="delta-secret-when">${escapeHtml(plain(note.opens))}</span></div>`)).join('');
    return `<p class="delta-muted">${opened} opened · ${notes.length - opened} still hidden. The narrator knows them all and keeps them; each appears here when it opens.</p>
        <div class="delta-sheet delta-secrets">${rows}</div>`;
}

const SECTION_BODIES = new Map([
    ['now', nowSectionHtml],
    ['with', withSectionHtml],
    ['ties', tiesSectionHtml],
    ['past', pastSectionHtml],
    ['secrets', secretsSectionHtml],
]);

// One whole section screen: its header with arrows and dots, then its body. Empty string for an unknown id.
export function sectionScreenHtml(id, npc = {}, { userName = '' } = {}) {
    const body = SECTION_BODIES.get(id);
    if (!body) return '';
    return `<section class="delta-section-screen" data-delta-section="${escapeHtml(id)}" aria-label="${escapeHtml(sectionTitle(id, userName))}">
        ${sectionHeaderHtml(id, { npcName: npc?.name, userName })}
        <div class="delta-section-body">${body(npc ?? {})}</div>
    </section>`;
}
