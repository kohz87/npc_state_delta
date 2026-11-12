/* NPC State Delta dossier surface: the six section screens (Mood, Right now, With {{user}}, Ties, Past, Secrets) and their header with arrows and dots. Escaped markup only; reads the existing dossier projection, no new data. */
import { escapeHtml } from './src/util/html.js';
import { changeStamp, plain, relationshipValue, RELATIONSHIP_AXES, wholeNumber } from './dossier-ui-model.js';
import { changeRowHtml, NO_REASON, recentChangeRowHtml } from './dossier-ui-relationship.js';
import { parseKeyRelationshipEntry } from './social-bonds.js';
import { castFromHtml, keyAwayHtml } from './dossier-ui-catalog.js';
import { bondTone, boardTone, MOOD_AXES, moodDescriptors, moodTile, possessiveWord, pullTile } from './dossier-ui-view-model.js';
import { meterRowHtml, moodRowsHtml, pullRowHtml, signedText } from './dossier-ui-board.js';
import { tieTone } from './dossier-ui-bond-tone.js';
import { SECTION_KEYS } from './dossier-ui-screens.js';

// The six sections in the order the arrows, a sideways swipe and the dots walk them.
export const SECTION_IDS = SECTION_KEYS;

// The heading of one section. "With" takes the persona's name in each chat (the mockup's "With {{user}}").
export function sectionTitle(id, userName = '') {
    const who = plain(userName);
    if (id === 'mood') return 'Mood';
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

// The header every section shares: ‹ and › (disabled at the ends), the title, "Name · N of 6" and one dot per section.
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
    return `<button type="button" class="delta-section-back" data-delta-screen="board" aria-label="Back to the dossier">‹ Dossier</button>
    <header class="delta-section-head" data-delta-section-head="${escapeHtml(id)}">
        <button type="button" class="delta-section-arrow" data-delta-section-step="-1" aria-label="Previous section"${prev ? '' : ' disabled'}>‹</button>
        <div class="delta-section-title">
            <b>${escapeHtml(sectionTitle(id, userName))}</b>
            <span>${who ? `${escapeHtml(who)} · ` : ''}${at + 1} of ${SECTION_IDS.length}</span>
            <div class="delta-section-dots">${dots}</div>
        </div>
        <button type="button" class="delta-section-arrow" data-delta-section-step="1" aria-label="Next section"${next ? '' : ' disabled'}>›</button>
    </header>`;
}

// The fields each of the two sections tells about, in the words the line "Updated this reply" uses.
const MOOD_FIELD_WORDS = Object.freeze({ mood: 'mood' });
const NOW_FIELD_WORDS = Object.freeze({ location: 'where', goal: 'goal', status: 'condition' });

// A sub-heading inside a section (Recent changes, Pull, Lies told, Knows about others, Where and what): one class, so one CSS rule spaces them all.
const subhead = text => `<h4 class="delta-subhead">${escapeHtml(text)}</h4>`;

// "Updated this reply (#3): where, goal." from the stored field changes; an older change reads "Updated at reply #2: ...".
// Empty when none of the latest change's fields is one this section shows.
function updatedLineHtml(npc, reply, fieldWords) {
    const changes = npc.fieldChanges;
    if (!changes || changes.latestTurn === null) return '';
    const words = (changes.latest || []).map(field => fieldWords[field]).filter(Boolean);
    if (!words.length) return '';
    const stamp = changeStamp({ turn: changes.latestTurn, message: changes.message });
    const when = !stamp.legacy && stamp.message !== null && stamp.message === wholeNumber(reply) ? `this reply (#${stamp.message})` : `at ${stamp.text}`;
    return `<p class="delta-now-updated delta-muted">Updated ${escapeHtml(when)}: ${escapeHtml(words.join(', '))}.</p>`;
}

// "Recent changes" under the mood rows: the last three moves of Feeling / Energy / Control (date and reply on the left, the changes over their reason on the
// right, the With {{user}} list's own row); when the reply on show moved nothing the list starts with a "no change" row (it counts in the three).
const RECENT_MOOD = 3;
function moodHistoryHtml(npc, mood, reply) {
    const title = subhead('Recent changes');
    if (!mood.known) return `<div class="delta-sheet-recent">${title}<p class="delta-muted">No mood change recorded yet.</p></div>`;
    const now = wholeNumber(reply);
    const mark = number => (Number.isInteger(number) ? `<small>#${number}</small>` : '');
    const quiet = mood.quiet ? [changeRowHtml(`<span class="delta-chg-when">${mark(now)}</span>`, `<span class="delta-chg-d" data-good="muted">${mood.atRest ? 'no mood change this reply' : `no change \u00b7 fading toward ${escapeHtml(possessiveWord(npc.gender, { lower: true }))} calm`}</span>`, [])] : [];
    const moves = mood.log.map(row => {
        const heads = MOOD_AXES.filter(([key]) => row[key]).map(([key, label]) => `<span class="delta-chg-d" data-good="${row[key] > 0 ? 'yes' : 'no'}">${escapeHtml(label)} ${escapeHtml(signedText(row[key]))}</span>`).join(' \u00b7 ');
        return changeRowHtml(`<span class="delta-chg-when">${[row.date ? escapeHtml(row.date) : '', mark(row.n)].filter(Boolean).join('<br>')}</span>`, heads, [row.why || NO_REASON]);
    });
    // A chat from before the history existed has only the last cause: it stands as one row (no numbers, date or reply were kept).
    const older = !mood.log.length && mood.cause ? [changeRowHtml('<span class="delta-chg-when"></span>', '<span class="delta-chg-d" data-good="muted">last mood move</span>', [mood.cause])] : [];
    return `<div class="delta-sheet-recent">${title}<ul class="delta-list">${[...quiet, ...moves, ...older].slice(0, RECENT_MOOD).join('')}</ul></div>`;
}

// Mood, as the mockup draws it: the mood word with its few plain words and three meter rows (Feeling, Energy, Control: the number on the
// -3..+3 scale and this reply's change, also at rest); "Recent changes" (the last three moves of the mood); the Pull as one line under its heading
// (marked New on its first day); then the line that says whether the latest reply updated the mood.
export function moodSectionHtml(npc = {}, { reply = null } = {}) {
    const mood = moodTile(npc, reply);
    const pull = pullTile(npc);
    const words = moodDescriptors(mood);
    return '<div class="delta-sheet delta-now">'
        + `<dl class="delta-kv"><dt>Mood</dt><dd><b>${escapeHtml(mood.text)}</b>${words.length ? ` · ${escapeHtml(words.join(', '))}` : ''}</dd></dl>`
        + moodRowsHtml(mood)
        + moodHistoryHtml(npc, mood, reply)
        + (pull ? subhead('Pull') + pullRowHtml(pull) : '')
        + updatedLineHtml(npc, reply, MOOD_FIELD_WORDS)
        + '</div>';
}

// Right now: where she is, what she is doing and wants, her condition, then the line that says which of these the latest reply updated.
// The Story Director away block and the pack's cast block (with its Pin button) stay above, as they did in the old dossier.
export function nowSectionHtml(npc = {}, { reply = null } = {}) {
    const cast = npc.cast && typeof npc.cast === 'object' ? npc.cast : {};
    const rows = [
        ['Where', escapeHtml(plain(cast.where) || plain(npc.location))],
        ['Doing', escapeHtml(plain(cast.doing))],
        ['Goal', escapeHtml(plain(cast.goal) || plain(npc.goal))],
        ['Condition', escapeHtml(plain(npc.status))],
    ].filter(([, value]) => value);
    const blocks = `${npc.key ? keyAwayHtml(npc.key) : ''}${npc.cast ? castFromHtml(npc.cast) : ''}`;
    const kv = list => `<dl class="delta-kv">${list.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join('')}</dl>`;
    return `${blocks}<div class="delta-sheet delta-now">`
        + (rows.length ? subhead('Where and what') + kv(rows) : '')
        + updatedLineHtml(npc, reply, NOW_FIELD_WORDS)
        + '</div>';
}

// With {{user}}: the four meters as bars that run from the centre (−100..100), the dynamic between them, the lies this person told,
// and the list of recent changes: the last one with how it came about, then the earlier ones.
export function withSectionHtml(npc = {}) {
    const lies = npc.v2Meters?.notes ? liesHtml(npc.v2Meters.notes.lies) : '';
    const rel = npc.relationship && typeof npc.relationship === 'object' ? npc.relationship : {};
    const meters = RELATIONSHIP_AXES.map(([axis, label]) => meterRowHtml({ label, value: relationshipValue(rel[axis]), range: 100, text: `${relationshipValue(rel[axis]) > 0 ? '+' : ''}${relationshipValue(rel[axis])}`, cls: `delta-sheet-${axis}` })).join('');
    const summary = plain(npc.relationshipSummary);
    // "Recent changes": the latest change first (signed numbers, via, date), then the earlier ones from the stored history (the latest's own
    // event is not repeated).
    const last = npc.lastRelationshipChange;
    const hasLast = last && last.impact !== 'none' && (last.reason || last.impact === 'manual' || last.hosted);
    const earlier = (Array.isArray(npc.recentRelationshipChanges) ? npc.recentRelationshipChanges : [])
        .filter((event, index) => !(hasLast && ((index === 0 && last.reason && event.reason === last.reason) || (last.hosted && wholeNumber(event.message) !== null && wholeNumber(event.message) === wholeNumber(last.message)))))
        .slice(0, 3);
    // At most the last three, the latest change counted among them.
    const rows = [...(hasLast ? [recentChangeRowHtml({ change: last })] : []), ...earlier.map(event => recentChangeRowHtml({ event }))].slice(0, 3).join('');
    return `<div class="delta-sheet">
        <div class="delta-sheet-meters">${meters}</div>
        ${summary ? `<p class="delta-sheet-prose">${escapeHtml(summary)}</p>` : ''}
        ${lies}
        <div class="delta-sheet-recent">${subhead('Recent changes')}${rows ? `<ul class="delta-list">${rows}</ul>` : '<p class="delta-muted">No relationship change recorded yet.</p>'}</div>
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
const part = (label, kind, body) => (body ? `<section class="delta-notes-block" data-notes="${kind}">${subhead(label)}${body}</section>` : '');

// Lies told (in With {{user}}, after the dynamic): a caught lie in its words; lies not caught only as a count (never the words). Hidden when there are none.
export function liesHtml(lies = []) {
    const caught = lies.filter(lie => !lie.hidden);
    const hidden = lies.length - caught.length;
    const rows = caught.map(lie => `<p class="delta-note-row"><b>“${escapeHtml(lie.said)}”</b><span>to ${escapeHtml(lie.to)}${dayText(lie.day) ? ` · ${dayText(lie.day)}` : ''} · caught</span></p>`).join('');
    const count = hidden ? `<p class="delta-note-row"><b>${hidden === 1 ? 'a lie you have not caught' : `${hidden} lies you have not caught`}</b></p>` : '';
    return part('Lies told', 'lies', rows + count);
}

// What this person knows about others (in Secrets, after the list): only what the story told or opened (a secret not opened is not in the projection).
export function knowsHtml(knows = []) {
    return part('Knows about others', 'knows', knows.map(row => `<p class="delta-note-row"><b>${escapeHtml(row.text)}</b><span>${escapeHtml([row.how && `${row.how} it`, dayText(row.day)].filter(Boolean).join(' · '))}</span></p>`).join(''));
}

// Ties: the relationships only; lies told live in With {{user}} and what she knows about others in Secrets.
export function tiesSectionHtml(npc = {}) {
    const entries = Array.isArray(npc.keyRelationships) ? npc.keyRelationships : [];
    const byName = new Map((npc.v2Meters?.notes?.ties ?? []).map(row => [row.name.toLowerCase(), row]));
    if (!entries.length) return '<p class="delta-muted">No important ties recorded yet.</p>';
    return `<div class="delta-sheet delta-ties">${entries.map(entry => tieHtml(entry, byName.get(String(parseKeyRelationshipEntry(entry)?.subject ?? '').toLowerCase()))).join('')}</div>`;
}

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
    const knows = npc.v2Meters?.notes ? knowsHtml(npc.v2Meters.notes.knows) : '';
    if (!notes.length) return knows ? `<div class="delta-sheet">${knows}</div>` : '<p class="delta-muted">No secrets for this character yet.</p>';
    const opened = notes.filter(note => note.state === 'open').length;
    const rows = notes.map(note => (note.state === 'open'
        ? `<div class="delta-secret delta-secret-open"><div class="delta-secret-head"><b>${escapeHtml(plain(note.title))}</b><span class="delta-secret-pill">${escapeHtml(plain(note.pill))}</span></div>${plain(note.text) ? `<p>${escapeHtml(plain(note.text))}</p>` : ''}</div>`
        : `<div class="delta-secret delta-secret-hidden"><span class="delta-secret-bar" style="width:${Math.max(0, Math.min(100, Number(note.width) || 0))}%" aria-hidden="true"></span><span class="delta-secret-when">${escapeHtml(plain(note.opens))}</span></div>`)).join('');
    return `<p class="delta-muted delta-secrets-intro">${opened} opened · ${notes.length - opened} still hidden. The narrator knows them all and keeps them; each appears here when it opens.</p>
        <div class="delta-sheet delta-secrets">${rows}${knows}</div>`;
}

const SECTION_BODIES = new Map([
    ['mood', moodSectionHtml],
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
