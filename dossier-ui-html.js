/* NPC State Delta dossier surface: escaped dossier markup, cards, forms and portrait references. */
import { escapeHtml } from './src/util/html.js';
import { changeStamp, FIELD_CHANGE_LABELS, plain, wholeNumber } from './dossier-ui-model.js';

function listHtml(items, empty = 'None established yet.') {
    const rows = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!rows.length) return `<p class="delta-muted">${escapeHtml(empty)}</p>`;
    return `<ul class="delta-list">${rows.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function proseHtml(value, empty = 'Unknown') {
    const text = plain(value);
    return `<p${text ? '' : ' class="delta-muted"'}>${escapeHtml(text || empty)}</p>`;
}

// (perf) A data-URL picture reaches the panel by reference: the markup carries a short key (data-delta-portrait="3") and the
// controller sets the image's src property once the element is in the page, so the picture is never escaped into HTML, parsed
// back out of it, or copied into a render signature. A file path or plain URL stays in the markup as before. Presentation
// only: the stored record is never touched. A key lives while some dossier in the view shows its picture.
export function createPortraitRefs() {
    const keys = new Map();
    const sources = new Map();
    let next = 0;
    return {
        /** The key for a data URL (made the first time it is shown), or '' for anything else. */
        key(value) {
            const src = String(value ?? '');
            if (!src.startsWith('data:')) return '';
            let key = keys.get(src);
            if (!key) { next += 1; key = String(next); keys.set(src, key); sources.set(key, src); }
            return key;
        },
        src: key => sources.get(String(key)) || '',
        /** Forgets every picture not in `keep` (a Set of the sources the view still shows). */
        release(keep = new Set()) {
            for (const [src, key] of [...keys]) if (!keep.has(src)) { keys.delete(src); sources.delete(key); }
        },
        get size() { return keys.size; },
        /** Sets the src of every keyed image under `container` that has none yet. */
        fill(container) {
            for (const img of container?.querySelectorAll?.('img[data-delta-portrait]') || []) {
                if (img.hasAttribute?.('src')) continue;
                const src = sources.get(String(img.dataset?.deltaPortrait ?? ''));
                if (src) img.src = src;
            }
        },
    };
}

// The image's source attribute: the key for a data URL when `refs` is given, the escaped URL otherwise.
function imageSourceAttribute(src, refs = null) {
    const key = refs ? refs.key(src) : '';
    return key ? `data-delta-portrait="${key}"` : `src="${escapeHtml(src)}"`;
}

// What a render signature records for a picture: its key, or the URL itself.
function portraitMark(src, refs) {
    const key = refs.key(src);
    return key ? `ref:${key}` : plain(src);
}

// Up to two initials: the first letters of the first two words ("The inspector" reads "TI", "Marrit" reads "M").
export const initialsOf = name => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0].toUpperCase()).join('');

function portraitHtml(npc, className, { alt = true, refs = null } = {}) {
    const src = plain(npc?.portrait);
    if (src) return `<img class="${className}" ${imageSourceAttribute(src, refs)} alt="${alt ? `${escapeHtml(npc?.name || 'NPC')} portrait` : ''}" loading="lazy" decoding="async">`;
    const initial = escapeHtml(initialsOf(npc?.name) || '?');
    return `<div class="${className} delta-portrait-placeholder" aria-hidden="true"><span>${initial}</span></div>`;
}

// As written in the dossier, with the first letter of each part capitalised.
const capFirst = value => { const text = plain(value); return text ? `${[...text][0].toUpperCase()}${[...text].slice(1).join('')}` : ''; };

// ONE age: the real age when known, else "~N" from the apparent age (never a separate "Looks"); '' when neither is known.
function ageText(npc) {
    const real = plain(npc?.age);
    if (real) return real;
    const apparent = plain(npc?.apparentAge).replace(/^~\s*/, '');
    return apparent ? `~${apparent}` : '';
}

function identityLine(npc) {
    return [
        capFirst(npc?.species),
        capFirst(npc?.gender),
        capFirst(npc?.role),
        ageText(npc) ? `Age ${ageText(npc)}` : '',
    ].filter(Boolean).join(' · ') || 'Identity details not established';
}

function changedMark(npc, field) {
    const changes = npc?.fieldChanges;
    if (!changes?.latest?.includes(field)) return '';
    const stamp = changeStamp({ turn: changes.latestTurn, message: changes.message });
    return ` <em class="delta-changed-mark${stamp.legacy ? ' delta-legacy-turn' : ''}" title="${escapeHtml(stamp.title)}">• ${escapeHtml(stamp.mark)}</em>`;
}

function currentCard(label, value, fallback = 'Unknown', mark = '', from = '') {
    return `<div class="delta-current-card${mark ? ' delta-changed' : ''}"><b>${escapeHtml(label)}${mark}</b><span>${escapeHtml(plain(value, fallback))}${from ? `<em class="delta-from">${escapeHtml(from)}</em>` : ''}</span></div>`;
}

export function changeSummaryHtml(npc, current = {}) {
    const changes = npc?.fieldChanges;
    if (!changes || changes.latestTurn === null) return '';
    const stamp = changeStamp({ turn: changes.latestTurn, message: changes.message });
    let when = `<span class="delta-legacy-turn" title="${escapeHtml(stamp.title)}">${escapeHtml(stamp.text)}</span>`;
    if (!stamp.legacy) when = stamp.message === wholeNumber(current?.reply) ? 'this reply' : `at ${escapeHtml(stamp.text)}`;
    const labels = changes.latest.map(field => FIELD_CHANGE_LABELS[field]).filter(Boolean);
    return `<p class="delta-change-line"><span class="delta-changed-dot" aria-hidden="true">•</span> Updated ${when} · ${labels.length} field${labels.length === 1 ? '' : 's'} changed${labels.length ? `: ${escapeHtml(labels.join(', '))}` : ''}</p>`;
}

function birthdayCard(npc) {
    // (a generated birthday shows no source line: "deterministic fallback" is internal wording, not something to read on the profile)
    const source = npc.birthdaySource === 'established' ? 'Story established' : '';
    return `<div class="delta-current-card delta-continuity-birthday-card"><b>Birthday${changedMark(npc, 'birthDate')}</b><span>${escapeHtml(npc.birthday || 'Unknown')}${source ? `<small class="delta-continuity-source">${escapeHtml(source)}</small>` : ''}</span></div>`;   // the note sits in the value column, under the date, not in a cell of its own
}

export function appearanceFormsHtml(npc, { portraitRefs = null } = {}) {
    const model = npc.appearanceModel;
    const presentation = npc.currentPresentation || '';
    const compatibilityCurrent = !model.currentForm && !model.currentFormUnknown && presentation
        ? `<div class="delta-appearance-form-row"><b>Current outfit &amp; presentation<span class="delta-appearance-current-badge">Current</span></b>${proseHtml(presentation)}</div>`
        : '';
    const current = model.currentFormUnknown ? 'Unclassified / unknown'
        : model.currentForm || (compatibilityCurrent ? 'Current presentation' : 'No selected form');
    const unclassified = model.currentFormUnknown && model.unclassifiedAppearance
        ? `<div class="delta-appearance-form-row"><b>Current unclassified presentation<span class="delta-appearance-current-badge">Current</span></b>${proseHtml(model.unclassifiedAppearance)}</div>`
        : '';
    const formImages = npc.formPortraits || {};
    const rows = model.appearanceForms.map(form => {
        const image = formImages[form.name] || '';
        const thumb = image
            ? `<img class="delta-form-portrait-thumb" ${imageSourceAttribute(image, portraitRefs)} alt=""${escapeHtml(form.name)} form portrait" loading="lazy" decoding="async">`
            : '<span class="delta-form-portrait-thumb delta-form-portrait-empty" aria-hidden="true">+</span>';
        const action = npc.id ? `<button type="button" class="delta-btn delta-experience-portrait delta-form-portrait-button" data-npc-id="${escapeHtml(npc.id)}" data-form="${escapeHtml(form.name)}">${image ? 'Change portrait' : 'Add portrait'}</button>` : '';
        return `<div class="delta-appearance-form-row delta-appearance-form-with-portrait">${thumb}<div><b>${escapeHtml(form.name)}${form.name === model.currentForm ? '<span class="delta-appearance-current-badge">Current</span>' : ''}</b>${proseHtml(form.appearance)}${action}</div></div>`;
    }).join('');
    const empty = !unclassified && !compatibilityCurrent && !rows ? '<p class="delta-muted">No named forms established.</p>' : '';
    return `<details class="delta-appearance-form-summary" data-delta-key="appearance" open><summary><b>Appearance</b><small>Current: ${escapeHtml(current)}</small></summary><div class="delta-appearance-form-list">${model.overallAppearance && !(model.appearanceForms.length && (model.currentForm || model.currentFormUnknown)) ? `<div class="delta-appearance-form-row"><b>Physical features</b>${proseHtml(model.overallAppearance)}</div>` : ''}${unclassified}${compatibilityCurrent}${rows}${empty}</div></details>`;
}

// Cache only rendered section markup on its DOM node, never canonical state/history.
// Unchanged sections retain their nodes, selection, focus and open disclosure controls.
function reconcileDocumentSections(parent, markup, reset = false) {
    const template = document.createElement('template');
    template.innerHTML = markup;
    const children = [...template.content.children];
    children.forEach((candidate, index) => {
        const previous = parent.children[index];
        const signature = candidate.outerHTML;
        if (!reset && previous?.__deltaSectionMarkup === signature) return;
        candidate.__deltaSectionMarkup = signature;
        if (!reset && previous) {
            for (const detail of previous.querySelectorAll('details[data-delta-key]')) {
                const next = candidate.querySelector(`details[data-delta-key="${CSS.escape(detail.dataset.deltaKey)}"]`);
                if (next) next.open = detail.open;
            }
        }
        if (previous) previous.replaceWith(candidate);
        else parent.appendChild(candidate);
    });
    while (parent.children.length > children.length) parent.lastElementChild.remove();
}

function countsFor(rows) {
    const counts = { all: 0, active: 0, archived: 0 };
    for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.bucket === 'dead') continue;
        counts.all += 1;
        if (counts[row?.bucket] !== undefined) counts[row.bucket] += 1;
    }
    return counts;
}

function visibleElement(element) {
    return Boolean(element && element.isConnected && element.getClientRects?.().length);
}

export { listHtml, proseHtml, portraitMark, portraitHtml, identityLine, ageText, changedMark, currentCard, birthdayCard, reconcileDocumentSections, countsFor, visibleElement };
