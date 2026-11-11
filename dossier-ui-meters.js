/* NPC State Delta dossier surface: hosted meters and Secrets section projections and markup. */
import { escapeHtml } from './src/util/html.js';
import { plain, stringList } from './dossier-ui-model.js';

// (v2 meters, hosted) An NPC's Story Suite meters beyond the four axes: custom meters, the stage on
// the ladder and what the next one needs, milestones, and the hidden notes still locked (their
// "Secrets" section: a hidden note is only its rule, never its title, text or event wording). Null without a host.
export function v2MetersProjection(view) {
    if (!view || typeof view !== 'object') return null;
    const bars = (Array.isArray(view.bars) ? view.bars : []).filter(bar => bar && !bar.builtIn && plain(bar.id)).slice(0, 12).map(bar => {
        const min = Number.isFinite(Number(bar.min)) ? Number(bar.min) : 0;
        const max = Number.isFinite(Number(bar.max)) && Number(bar.max) > min ? Number(bar.max) : min + 100;
        const value = Math.max(min, Math.min(max, Math.round(Number(bar.value) || 0)));
        const ceiling = Number.isInteger(bar.ceiling) && bar.ceiling < max ? bar.ceiling : null;
        return { id: plain(bar.id), label: plain(bar.label, plain(bar.id)), value, min, max, text: plain(bar.text, String(value)), ceiling, delta: Number.isInteger(bar.delta) ? bar.delta : 0 };
    });
    const net = view.relChange && typeof view.relChange === 'object' ? view.relChange : null;
    return {
        ...(net && Number.isInteger(net.message) && net.message >= 0 ? { relChange: { message: net.message, delta: net.delta, ...(net.event && typeof net.event === 'object' ? { event: net.event } : {}) } } : {}),
        bars,
        rank: plain(view.rank),
        next: plain(view.next),
        milestones: stringList(view.milestones, 16),
        secrets: secretsProjection(view.secrets),
        ...(tiesProjection(view.ties) ? { ties: tiesProjection(view.ties) } : {}),
        ...(moodProjection(view.mood) ? { mood: moodProjection(view.mood) } : {}),
        ...(pullProjection(view.pull) ? { pull: pullProjection(view.pull) } : {}),
        ...(notesProjection(view.notes) ? { notes: notesProjection(view.notes) } : {}),
    };
}

const int = (value, min, max, fallback = 0) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback));
const list = (value, cap) => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object').slice(0, cap) : []);

// Mood (feature mood-pull): the word, the Feeling, Energy and Control bars (steps of max) and what moved it. Null without a mood.
function moodProjection(mood) {
    if (!mood || typeof mood !== 'object' || !plain(mood.word)) return null;
    const max = int(mood.bars?.max, 1, 12, 6);
    // Feeling is the valence (-3 unpleasant .. 3 pleasant) as a step of max like the other two; without one it rests in the middle.
    const feeling = Number.isFinite(Number(mood.valence)) ? int(Number(mood.valence) + max / 2, 0, max) : Math.round(max / 2);
    return { word: plain(mood.word), feeling, energy: int(mood.bars?.energy, 0, max), control: int(mood.bars?.control, 0, max), max, cause: plain(mood.cause).slice(0, 120) };
}

// Pull (feature mood-pull): the instinct, its strength 1..3, what causes it and for how many days. Null without one.
const PULL_KINDS = new Set(['belonging', 'closure', 'awe']);
function pullProjection(pull) {
    if (!pull || typeof pull !== 'object' || !PULL_KINDS.has(pull.kind)) return null;
    return { kind: pull.kind, level: int(pull.level, 0, 3), days: int(pull.days, 0, 9999), cause: plain(pull.cause).slice(0, 120) };
}

// The dossier notes (feature notes). An uncaught lie carries no words (said is null) and a secret not opened is dropped: the
// projection never holds what the story has not shown. Plain rows; the sections escape them.
function notesProjection(notes) {
    if (!notes || typeof notes !== 'object') return null;
    const day = value => (Number.isInteger(value) && value >= 0 ? value : null);
    const lies = list(notes.lies, 6).map(row => (row.hidden || row.said == null
        ? { hidden: true, day: day(row.day) }
        : { hidden: false, to: plain(row.to), said: plain(row.said), day: day(row.day), caught: row.caught ? { day: day(row.caught.day) } : null }));
    const knows = list(notes.knows, 6).filter(row => !row.hidden && plain(row.text)).map(row => ({ about: plain(row.about), how: plain(row.how), day: day(row.day), text: plain(row.text), secret: row.secret === true }));
    const tastes = list(notes.tastes, 12).filter(row => plain(row.item)).map(row => ({ sign: row.sign === '-' ? '-' : '+', item: plain(row.item), from: plain(row.from), mirrored: row.mirrored === true }));
    const ties = list(notes.ties, 12).filter(row => plain(row.name)).map(row => ({ name: plain(row.name), tags: (Array.isArray(row.tags) ? row.tags : []).filter(tag => TIE_WORDS.has(tag)), owedBy: row.owedBy === true }));
    const drives = list(notes.drives, 8).filter(row => plain(row.label)).map(row => ({ label: plain(row.label), strength: int(row.strength, 0, 3), word: plain(row.word) }));
    const look = notes.look && Number.isInteger(notes.look.day) ? { day: notes.look.day } : null;
    return lies.length || knows.length || tastes.length || ties.length || drives.length || look ? { lies, knows, tastes, ties, drives, look } : null;
}

// Tie tags toward other people by dossier id ({ id: ['ally', 'rival', 'owes'] }): the relationship map colours its lines with them.
const TIE_WORDS = new Set(['ally', 'rival', 'owes']);
function tiesProjection(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const out = {};
    for (const [id, tags] of Object.entries(map).slice(0, 24)) {
        const kept = (Array.isArray(tags) ? tags : []).filter(tag => TIE_WORDS.has(tag));
        if (id && kept.length) out[id] = kept;
    }
    return Object.keys(out).length ? out : null;
}

// The notes of a dossier for its Secrets section, in the order written: an opened one { state: 'open', title, text,
// pill }, a hidden one { state: 'hidden', opens, width } (a bar and the rule; nothing of its title or text).
function secretsProjection(list) {
    return (Array.isArray(list) ? list : []).slice(0, 8).map(note => {
        if (note?.state === 'open') return { state: 'open', title: plain(note.title, 'A hidden note'), text: plain(note.text), pill: plain(note.pill, 'Opened') };
        if (note?.state === 'hidden') return { state: 'hidden', opens: plain(note.opens, 'Opens with the story'), width: Math.max(30, Math.min(80, Math.round(Number(note.width) || 55))) };
        return null;
    }).filter(Boolean);
}

/**
 * The Secrets section ('' when the dossier has no notes): "Secrets · n opened · m still hidden"; an opened note is
 * its title, an "Opened · Trust 20" pill and its text; a hidden one a blank striped bar and "Opens at Trust 60" or
 * "Opens with the story" (never the title, the text or the event's wording).
 */
export function v2SecretsHtml(view) {
    const notes = view?.secrets ?? [];
    if (!notes.length) return '';
    const open = notes.filter(note => note.state === 'open').length;
    const rows = notes.map(note => (note.state === 'open'
        ? `<div class="delta-secret delta-secret-open"><div class="delta-secret-head"><b>${escapeHtml(note.title)}</b><span class="delta-secret-pill">${escapeHtml(note.pill)}</span></div>${note.text ? `<p>${escapeHtml(note.text)}</p>` : ''}</div>`
        : `<div class="delta-secret delta-secret-hidden"><span class="delta-secret-bar" style="width:${note.width}%" aria-hidden="true"></span><span class="delta-secret-when">${escapeHtml(note.opens)}</span></div>`)).join('');
    return `<section class="delta-section delta-secrets" data-delta-section="secrets">
                <h3>Secrets <small class="delta-secrets-count">· ${open} opened · ${notes.length - open} still hidden</small></h3>
                ${rows}
                <p class="delta-muted delta-secrets-note">The narrator knows them all and keeps them; each appears here when it opens.</p>
            </section>`;
}

export function v2MetersHtml(view) {
    if (!view) return '';
    const at = (bar, point) => Math.max(0, Math.min(100, ((point - bar.min) / (bar.max - bar.min)) * 100));
    const bars = view.bars.map(bar => `<div class="delta-rel-axis delta-rel-custom" data-meter="${escapeHtml(bar.id)}">
        <div class="delta-rel-label"><span>${escapeHtml(bar.label)}</span><b>${escapeHtml(bar.text)}${bar.delta ? `<span class="delta-rel-step delta-rel-step-${bar.delta > 0 ? 'good' : 'bad'}">${bar.delta > 0 ? '▲' : '▼'}${Math.abs(bar.delta)}</span>` : ''}</b></div>
        <div class="delta-rel-track" aria-label="${escapeHtml(`${bar.label} ${bar.value}`)}">${bar.ceiling !== null ? `<span class="delta-rel-ceiling" style="left:${at(bar, bar.ceiling)}%" title="${escapeHtml(`Ceiling ${bar.ceiling}`)}"></span>` : ''}<i style="left:${at(bar, bar.value)}%"></i></div>
    </div>`).join('');
    const lines = [
        view.rank ? `<p class="delta-v2-rank"><b>${escapeHtml(view.rank)}</b></p>` : '',
        view.next ? `<p class="delta-muted delta-v2-next">${escapeHtml(view.next)}</p>` : '',
        view.milestones.length ? `<p class="delta-v2-milestones"><span class="delta-kicker">MILESTONES</span> ${view.milestones.map(escapeHtml).join(' · ')}</p>` : '',
    ].filter(Boolean).join('');
    return `${bars ? `<div class="delta-rel-grid delta-v2-meters">${bars}</div>` : ''}${lines}`;
}
