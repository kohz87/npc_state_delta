/* NPC State Delta dossier surface: the profile screen (portrait with the four meter numbers, identity, appearance forms,
   character, background). Markup only, built from the detail projection; the screens module draws it and fills portraits. */
import { escapeHtml } from './src/util/html.js';
import { plain } from './dossier-ui-model.js';
import { appearanceFormsHtml, birthdayCard, changedMark, currentCard, identityLine, portraitHtml, proseHtml } from './dossier-ui-html.js';

const METER_LABELS = Object.freeze([['trust', 'Trust'], ['affection', 'Affection'], ['desire', 'Desire'], ['tension', 'Tension']]);

function signed(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return `${number > 0 ? '+' : ''}${number}`;
}

// The four axes as whole items under the name (["Trust +11", "Affection +10", ...]); empty when none is stored.
export function profileMeterItems(npc = {}) {
    const rel = npc?.relationship && typeof npc.relationship === 'object' ? npc.relationship : {};
    return METER_LABELS
        .map(([axis, word]) => (signed(rel[axis]) ? `${word} ${signed(rel[axis])}` : ''))
        .filter(Boolean);
}

// A block: its small coloured heading and its body. `heading: false` leaves the heading out (the phone's first block is the name and
// its line, as in the mockup, not a block called Identity).
function block(key, title, body, { heading = true, mark = '' } = {}) {
    return `<section class="delta-profile-block" data-delta-profile="${key}">${heading ? `<h3>${escapeHtml(title)}${mark}</h3>` : ''}${body}</section>`;
}

function identityBody(npc) {
    const aliases = Array.isArray(npc.aliases) ? npc.aliases.join(', ') : plain(npc.aliases);
    const custom = (Array.isArray(npc.customFields) ? npc.customFields : [])
        .map(([name, value]) => currentCard(name, value))
        .join('');
    return `<div class="delta-current-grid">`
        + currentCard('Age', npc.age, 'Unknown', changedMark(npc, 'age'))
        + currentCard('Looks', npc.apparentAge, 'Unknown', changedMark(npc, 'apparentAge'))
        + currentCard('Home base', npc.homeBase, 'Unknown', changedMark(npc, 'homeBase'))
        + currentCard('Known as', aliases)
        + birthdayCard(npc)
        + custom
        + `</div>`;
}

// Tastes (likes, dislikes and who or what they come from) and Drives (the instinct strengths): only with data (feature notes).
function tastesBody(notes) {
    if (!notes?.tastes?.length) return '';
    return block('tastes', 'Tastes', `<ul class="delta-tastes">${notes.tastes.map(row => `<li><span class="delta-taste-sign" aria-label="${row.sign === '-' ? 'dislikes' : 'likes'}">${row.sign === '-' ? '✕' : '♥'}</span><b>${escapeHtml(row.item)}</b>${row.from || row.mirrored ? `<span class="delta-muted">${escapeHtml([row.from, row.mirrored ? 'echoes you' : ''].filter(Boolean).join(' · '))}</span>` : ''}</li>`).join('')}</ul>`);
}

function drivesBody(notes) {
    if (!notes?.drives?.length) return '';
    return block('drives', 'Drives', `<div class="delta-drives">${notes.drives.map(row => `<div class="delta-drive"><span>${escapeHtml(row.label)}</span><i title="${escapeHtml(row.word)}"><b style="width:${Math.round((row.strength / 3) * 100)}%"></b></i></div>`).join('')}</div>`);
}

// Flat rows as the mockup has them: Look (the enduring body), Wearing (what the current form or presentation is), Habits (mannerisms).
// Named forms (each can take its own portrait) stay one tap away in a folded list, so no portrait control is lost.
function appearanceBody(npc, portraitRefs) {
    const model = npc.appearanceModel;
    if (!model || typeof model !== 'object') return '<p class="delta-muted">No appearance established yet.</p>';
    const locked = npc.v2Meters?.notes?.look;
    const forms = Array.isArray(model.appearanceForms) ? model.appearanceForms : [];
    const wearing = forms.find(form => form.name === model.currentForm)?.appearance || plain(model.unclassifiedAppearance) || plain(npc.currentPresentation);
    const habits = Array.isArray(npc.mannerisms) ? npc.mannerisms.filter(Boolean).join('; ') : plain(npc.mannerisms);
    const row = (label, text, mark = '') => (plain(text) ? `<dt>${label}${mark}</dt><dd>${escapeHtml(plain(text))}</dd>` : '');
    const note = locked ? `<p class="delta-muted delta-look-lock">🔒 The look was set ${Number.isInteger(locked.day) ? `on day ${locked.day}` : 'when first seen'} and stays as it was; changes need an edit or a story event.</p>` : '';
    const rows = row('Look', model.overallAppearance)
        + row('Wearing', wearing, changedMark(npc, 'currentPresentation')) + row('Habits', habits, changedMark(npc, 'mannerisms'));
    const more = forms.length ? `<details class="delta-profile-forms"><summary>Forms and portraits · ${forms.length}</summary>${appearanceFormsHtml(npc, { portraitRefs })}</details>` : '';
    return `${rows ? `<dl class="delta-kv delta-profile-kv">${rows}</dl>` : '<p class="delta-muted">No appearance established yet.</p>'}${note}${more}`;
}

// Personality as plain prose, then label / value rows (Speech, Levers) as the mockup draws it: no sub-headings.
function characterBody(npc) {
    const levers = Array.isArray(npc.behaviorProfile) ? npc.behaviorProfile.filter(Boolean).map(item => String(item).trim().replace(/[.;]+$/, '')).join('; ') : plain(npc.behaviorProfile);
    const row = (label, text, mark = '') => (plain(text) ? `<dt>${label}${mark}</dt><dd>${escapeHtml(plain(text))}</dd>` : '');
    const rows = row('Speech', npc.speech, changedMark(npc, 'speech')) + row('Levers', levers, changedMark(npc, 'behaviorProfile'));
    return `${proseHtml(npc.personality)}${rows ? `<dl class="delta-kv delta-profile-kv">${rows}</dl>` : ''}`;
}

// The portrait fills the top (phone) or the left column (desktop). The back control goes to the board; the
// screens module handles the click. Pictures travel by reference (portraitRefs.fill runs after the markup is in the page).
function portraitBlock(npc, portraitRefs, desktop) {
    const back = `<button type="button" class="delta-profile-back" data-delta-screen="board" aria-label="Back to the dossier">‹ Dossier</button>`;
    const items = profileMeterItems(npc);
    // each meter is one whole item; the dot follows it in CSS, so a wrapped line never breaks inside "Trust +11"
    const caption = desktop
        ? `<div class="delta-profile-caption"><b>${escapeHtml(plain(npc.name, 'Unnamed NPC'))}</b>${items.length ? `<span class="delta-profile-meters">${items.map(item => `<i>${escapeHtml(item)}</i>`).join('')}</span>` : ''}</div>`
        : '';
    const form = plain(npc.portraitForm);
    const stale = npc.portraitAppearanceChanged
        ? `<span class="delta-portrait-stale" title="The dossier appearance changed after this portrait was attached. Generate or upload a new portrait to match.">${escapeHtml(form && form !== npc.appearanceModel?.currentForm ? `Portrait shows the ${form} form` : 'Appearance changed since portrait')}</span>` : '';
    return `<div class="delta-profile-portrait">${portraitHtml(npc, 'delta-profile-image', { refs: portraitRefs })}${stale}${back}${caption}</div>`;
}

function headBlock(npc, desktop) {
    const line = `<p class="delta-profile-line">${escapeHtml(identityLine(npc))}</p>`;
    return desktop
        ? `<header class="delta-profile-head"><h2 class="delta-profile-title">Profile</h2>${line}</header>`
        : `<header class="delta-profile-head"><h2 class="delta-profile-title">${escapeHtml(plain(npc.name, 'Unnamed NPC'))}</h2>${line}</header>`;
}

// The profile screen for one NPC. `layout` is 'phone' (full screen, one column) or 'desktop' (portrait left, the
// details in two columns on the right). `portraitRefs` is the view's createPortraitRefs() instance.
export function dossierProfileHtml(npc = {}, { layout = 'phone', portraitRefs = null } = {}) {
    const desktop = layout === 'desktop';
    const identity = block('identity', 'Identity', identityBody(npc), { heading: false });
    const appearance = block('appearance', 'Appearance', appearanceBody(npc, portraitRefs));
    const character = block('character', 'Character', characterBody(npc), { mark: changedMark(npc, 'personality') })   // the change mark sits in the heading, in line with the other rows' marks;
    const notes = npc.v2Meters?.notes;
    const tastes = tastesBody(notes) + drivesBody(notes);
    const background = block('background', 'Background', proseHtml(npc.background));
    // The blocks run in the mockup's order: Identity | Appearance, Character | Tastes, Drives | Background (a block with no data is left out).
    const body = `<div class="delta-profile-cols">${identity}${appearance}${character}${tastes}${background}</div>`;
    return `<div class="delta-profile delta-profile-${desktop ? 'desktop' : 'phone'}" data-delta-screen-body="profile">`
        + `${portraitBlock(npc, portraitRefs, desktop)}<div class="delta-profile-sheet">${headBlock(npc, desktop)}${body}</div></div>`;
}
