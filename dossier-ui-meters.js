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
    return {
        bars,
        rank: plain(view.rank),
        next: plain(view.next),
        milestones: stringList(view.milestones, 16),
        secrets: secretsProjection(view.secrets),
    };
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
