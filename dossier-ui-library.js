/* NPC State Delta dossier surface: the library screen (faces ringed by tone, search, key people first).
   Replaces the cast rail's renderRail: pure list shaping and markup; the panel owns the DOM and the refs. */
import { escapeHtml } from './src/util/html.js';
import { filterDossierIndex } from './dossier-ui-catalog.js';
import { portraitHtml, portraitMark } from './dossier-ui-html.js';

// Ring colour per tone. Catalog rows carry `tone` ('ally' | 'rival' | 'owed', from the bond tone of
// their relationship); any other value (or none) is neutral.
export const FACE_RING_VARS = Object.freeze({ ally: 'var(--good)', rival: 'var(--bad)', owed: 'var(--held)' });

export function faceRingVar(tone = '') {
    return Object.hasOwn(FACE_RING_VARS, tone) ? FACE_RING_VARS[tone] : 'var(--dial)';
}

// Key people first. A stable partition: the sort order inside each group is kept.
export function keyFirstRows(rows = []) {
    const list = Array.isArray(rows) ? rows : [];
    return [...list.filter(row => row?.key === true), ...list.filter(row => row?.key !== true)];
}

// What the library shows: the same search and filter as before (the dead only by search, or while
// selected), then key people first.
export function libraryRows(index = [], { query = '', filter = 'all', keepId = '' } = {}) {
    return keyFirstRows(filterDossierIndex(index, { query, filter, keepId }));
}

// Cache key for the library: a face changes only when one of these fields, its ring or its
// selection changes. Include the portrait mark so a new portrait re-draws.
export function librarySignature(rows = [], { selectedId = '', refs = null } = {}) {
    return JSON.stringify((Array.isArray(rows) ? rows : []).map(row => [
        row.id, row.name, row.statusLabel, row.role, row.species, row.gender, row.bucket,
        row.key === true, row.mood || '', row.tone || '', portraitMark(row.portrait, refs), row.id === selectedId,
    ]));
}

// The bar under every other screen: it goes back to the library ("▸ DOSSIER LIBRARY · 10 NPCs").
export function libraryFootHtml(count = 0) {
    return `<button type="button" class="delta-library-foot" data-delta-screen="library">▸ Dossier library · ${Number(count) || 0} NPC${Number(count) === 1 ? '' : 's'}</button>`;
}

export function librarySearchHtml(query = '', count = 0) {
    return `<label class="delta-library-search"><span aria-hidden="true">⌕</span><input type="search" data-delta-library-search placeholder="Search ${Number(count) > 0 ? `${Number(count)} people` : 'people'}…" aria-label="Search dossiers" autocomplete="off" value="${escapeHtml(String(query || ''))}"></label>`;
}

export function libraryFaceHtml(npc, { selected = false, refs = null } = {}) {
    const id = escapeHtml(npc.id);
    const line = [npc.role || npc.species].filter(Boolean).join(' · ') || 'Details pending';
    // The mood is what the person is like right now; an archived or dead dossier shows that instead.
    const state = [npc.key === true ? '★ key' : '', npc.bucket === 'active' && npc.mood ? npc.mood : npc.statusLabel].filter(Boolean).join(' · ');
    return `<button type="button" class="delta-library-face${selected ? ' selected' : ''}" role="option" aria-selected="${selected}" data-npc-id="${id}" data-bucket="${escapeHtml(npc.bucket || '')}" data-tone="${escapeHtml(npc.tone || '')}" style="--rc:${faceRingVar(npc.tone)}">
        <span class="delta-library-av">${portraitHtml(npc, 'delta-library-portrait', { alt: false, refs })}</span>
        <b>${escapeHtml(npc.name || 'Unnamed')}</b><span class="delta-library-meta">${escapeHtml(line)}</span><span class="delta-library-meta delta-library-state">${escapeHtml(state)}</span>
    </button>`;
}

// The faces, or the empty state. The caller runs refs.fill(container) after writing the markup.
export function libraryHtml(rows = [], { selectedId = '', refs = null, emptyHint = '' } = {}) {
    if (!Array.isArray(rows) || !rows.length) {
        return `<div class="delta-no-results"><b>No dossiers match this view.</b><span>${escapeHtml(emptyHint || 'Change the search or filter to bring the cast back.')}</span></div>`;
    }
    return `<div class="delta-library-faces" role="listbox" aria-label="Dossiers">${rows.map(npc => libraryFaceHtml(npc, { selected: npc.id === selectedId, refs })).join('')}</div>`;
}
