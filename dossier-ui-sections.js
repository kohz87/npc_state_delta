/* NPC State Delta dossier surface: the five section screens (Right now, With {{user}}, Ties, Past, Secrets) and their header with arrows and dots. Escaped markup only; reads the existing dossier projection, no new data. */
import { escapeHtml } from './src/util/html.js';
import { changeStamp, plain, relationshipValue, RELATIONSHIP_AXES, wholeNumber } from './dossier-ui-model.js';
import { recentChangeRowHtml } from './dossier-ui-relationship.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { castFromHtml, keyAwayHtml } from './dossier-ui-catalog.js';
import { bondTone, boardTone, moodDescriptors, moodTile, pullTile } from './dossier-ui-view-model.js';
import { barsHtml, moodBarList3 } from './dossier-ui-board.js';
import { tieTone } from './dossier-ui-bond-tone.js';
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

// The fields of the dossier Right now tells about, in the words the line "Updated this reply" uses.
const NOW_FIELD_WORDS = Object.freeze({ mood: 'mood', location: 'where', goal: 'goal', status: 'condition' });

// "Updated this reply (#3): mood, where, goal." from the stored field changes; an older change reads "Updated at reply #2: ...".
// Empty when none of the latest change's fields is one Right now shows.
function updatedLineHtml(npc, reply) {
    const changes = npc.fieldChanges;
    if (!changes || changes.latestTurn === null) return '';
    const words = (changes.latest || []).map(field => NOW_FIELD_WORDS[field]).filter(Boolean);
    if (!words.length) return '';
    const stamp = changeStamp({ turn: changes.latestTurn, message: changes.message });
    const when = !stamp.legacy && stamp.message !== null && stamp.message === wholeNumber(reply) ? `this reply (#${stamp.message})` : `at ${stamp.text}`;
    return `<p class="delta-now-updated delta-muted">Updated ${escapeHtml(when)}: ${escapeHtml(words.join(', '))}.</p>`;
}

// Right now, as the mockup draws it: the mood word with its few plain words and three bars across the row (Feeling, Energy,
// Control, also at rest); "Moved by" (what moved the mood); "Where and what" (where, doing, goal, condition, and the Pull last,
// marked New on its first day); then the line that says which of these the latest reply updated. The Story Director away block
// and the pack's cast block (with its Pin button) stay above, as they did in the old dossier.
export function nowSectionHtml(npc = {}, { reply = null } = {}) {
    const cast = npc.cast && typeof npc.cast === 'object' ? npc.cast : {};
    const mood = moodTile(npc);
    const pull = pullTile(npc);
    const rows = [
        ['Where', escapeHtml(plain(cast.where) || plain(npc.location))],
        ['Doing', escapeHtml(plain(cast.doing))],
        ['Goal', escapeHtml(plain(cast.goal) || plain(npc.goal))],
        ['Condition', escapeHtml(plain(npc.status))],
        ...(pull ? [['Pull', `<b>${escapeHtml(pull.text)}</b>${[pull.cause, pull.note].filter(Boolean).map(part => ` · ${escapeHtml(part)}`).join('')}`, pull.fresh ? 'New' : '']] : []),
    ].filter(([, value]) => value);
    const blocks = `${npc.key ? keyAwayHtml(npc.key) : ''}${npc.cast ? castFromHtml(npc.cast, npc.id) : ''}`;
    const words = moodDescriptors(mood);
    const cause = plain(npc.v2Meters?.mood?.cause);
    const kv = list => `<dl class="delta-kv">${list.map(([label, value, badge]) => `<dt>${escapeHtml(label)}${badge ? ` <span class="delta-new-badge">${escapeHtml(badge)}</span>` : ''}</dt><dd>${value}</dd>`).join('')}</dl>`;
    return `${blocks}<div class="delta-sheet delta-now">`
        + kv([['Mood', `<b>${escapeHtml(mood.text)}</b>${words.length ? ` · ${escapeHtml(words.join(', '))}` : ''}`]])
        + (moodBarList3(mood) ? `<div class="delta-now-bars">${barsHtml(moodBarList3(mood))}</div>` : '')
        + (cause ? `<h4>Moved by</h4><p class="delta-now-moved">${escapeHtml(cause)}</p>` : '')
        + (rows.length ? `<h4>Where and what</h4>${kv(rows)}` : '')
        + updatedLineHtml(npc, reply)
        + '</div>';
}

// With {{user}}: the four meters as bars that run from the centre (−100..100), the dynamic between them,
// and the list of recent changes: the last one with how it came about, then the earlier ones.
export function withSectionHtml(npc = {}) {
    const rel = npc.relationship && typeof npc.relationship === 'object' ? npc.relationship : {};
    const meters = RELATIONSHIP_AXES.map(([axis, label]) => {
        const value = relationshipValue(rel[axis]);
        const left = value < 0 ? 50 + value / 2 : 50;
        const width = Math.abs(value) / 2;
        return `<div class="delta-sheet-meter delta-sheet-${escapeHtml(axis)}"><span>${escapeHtml(label)}</span><i class="delta-sheet-track" aria-hidden="true"><b style="left:${left}%;width:${width}%"></b></i><strong>${value > 0 ? '+' : ''}${value}</strong></div>`;
    }).join('');
    const summary = plain(npc.relationshipSummary);
    // "Recent changes": the latest change first (signed numbers, via, date), then the earlier ones from the stored history (the latest's own
    // event is not repeated).
    const last = npc.lastRelationshipChange;
    const hasLast = last && last.impact !== 'none' && (last.reason || last.impact === 'manual' || last.hosted);
    const earlier = (Array.isArray(npc.recentRelationshipChanges) ? npc.recentRelationshipChanges : [])
        .filter((event, index) => !(hasLast && ((index === 0 && last.reason && event.reason === last.reason) || (last.hosted && wholeNumber(event.message) !== null && wholeNumber(event.message) === wholeNumber(last.message)))))
        .slice(0, 3);
    const rows = [...(hasLast ? [recentChangeRowHtml({ change: last })] : []), ...earlier.map(event => recentChangeRowHtml({ event }))].join('');
    return `<div class="delta-sheet">
        <div class="delta-sheet-meters">${meters}</div>
        ${summary ? `<p class="delta-sheet-prose">${escapeHtml(summary)}</p>` : ''}
        <div class="delta-sheet-recent"><h4>Recent changes</h4>${rows ? `<ul class="delta-list">${rows}</ul>` : '<p class="delta-muted">No relationship change recorded yet.</p>'}</div>
    </div>`;
}

// One important bond: the relation word (toned: green kin and friends, red rivals and enemies, gold debts and duties),
// the other person, and the dynamic. A tie tag from the notes (ally / rival / owes, "owed by" the other way) takes the word and the tone.
// An entry that does not parse is shown as written, in the plain tone.
function tieHtml(entry, tie = null) {
    const parsed = parseKeyRelationshipEntry(entry);
    if (!parsed) return `<div class="delta-bond" data-tone="grey"><p>${escapeHtml(plain(entry))}</p></div>`;
    const tags = tie?.tags ?? [];
    const word = tags.includes('owes') ? 'owes' : (tie?.owedBy && !tags.length ? 'owed by' : (tags[0] || parsed.relation));
    const tone = tags.length ? boardTone(tieTone(tags)) : (tie?.owedBy ? 'gold' : bondTone(parsed.relation));
    return `<div class="delta-bond" data-tone="${escapeHtml(tone)}"><span class="delta-bond-word">${escapeHtml(word)}</span><b>${escapeHtml(parsed.subject)}</b>${parsed.dynamic ? `<p>${escapeHtml(parsed.dynamic)}</p>` : ''}</div>`;
}

const dayText = day => (Number.isInteger(day) ? `day ${day}` : '');
const part = (label, kind, body) => (body ? `<section class="delta-notes-block" data-notes="${kind}"><h4>${escapeHtml(label)}</h4>${body}</section>` : '');

// Lies told: a caught lie in its words; lies not caught only as a count (never the words). Hidden when there are none.
export function liesHtml(lies = []) {
    const caught = lies.filter(lie => !lie.hidden);
    const hidden = lies.length - caught.length;
    const rows = caught.map(lie => `<p class="delta-note-row"><b>“${escapeHtml(lie.said)}”</b><span>to ${escapeHtml(lie.to)}${dayText(lie.day) ? ` · ${dayText(lie.day)}` : ''} · caught</span></p>`).join('');
    const count = hidden ? `<p class="delta-note-row"><b>${hidden === 1 ? 'a lie you have not caught' : `${hidden} lies you have not caught`}</b></p>` : '';
    return part('Lies told', 'lies', rows + count);
}

// What this person knows about others: only what the story told or opened (a secret not opened is not in the projection).
export function knowsHtml(knows = []) {
    return part('Knows about others', 'knows', knows.map(row => `<p class="delta-note-row"><b>${escapeHtml(row.text)}</b><span>${escapeHtml([row.how && `${row.how} it`, dayText(row.day)].filter(Boolean).join(' · '))}</span></p>`).join(''));
}

export function tiesSectionHtml(npc = {}) {
    const entries = Array.isArray(npc.keyRelationships) ? npc.keyRelationships : [];
    const notes = npc.v2Meters?.notes;
    const byName = new Map((notes?.ties ?? []).map(row => [row.name.toLowerCase(), row]));
    const extra = lieAndKnow(notes);
    if (!entries.length && !extra) return '<p class="delta-muted">No important ties recorded yet.</p>';
    return `<div class="delta-sheet delta-ties">${entries.map(entry => tieHtml(entry, byName.get(String(parseKeyRelationshipEntry(entry)?.subject ?? '').toLowerCase()))).join('')}${extra}</div>`;
}

const lieAndKnow = notes => (notes ? liesHtml(notes.lies) + knowsHtml(notes.knows) : '');

// Past: the remembered events as written on a timeline of dots (the projection carries no timestamps for them).
export function pastSectionHtml(npc = {}) {
    const memories = (Array.isArray(npc.memories) ? npc.memories : []).map(plain).filter(Boolean);
    if (!memories.length) return '<p class="delta-muted">Nothing remembered yet.</p>';
    return `<ol class="delta-sheet delta-past delta-timeline">${memories.map(memory => `<li><i class="delta-dot-mem" aria-hidden="true"></i>${escapeHtml(memory)}</li>`).join('')}</ol>`;
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
export function sectionScreenHtml(id, npc = {}, { userName = '', reply = null } = {}) {
    const body = SECTION_BODIES.get(id);
    if (!body) return '';
    return `<section class="delta-section-screen" data-delta-section="${escapeHtml(id)}" aria-label="${escapeHtml(sectionTitle(id, userName))}">
        ${sectionHeaderHtml(id, { npcName: npc?.name, userName })}
        <div class="delta-section-body">${body(npc ?? {}, { reply })}</div>
    </section>`;
}
