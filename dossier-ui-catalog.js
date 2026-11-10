/* NPC State Delta dossier surface: index filtering, cast/key projections and dossier-state shaping. */
import { escapeHtml } from './src/util/html.js';
import { awayRange } from './src/key-people.js';
import { dossierDetailProjection, plain, wholeNumber } from './dossier-ui-model.js';
import { v2MetersProjection } from './dossier-ui-meters.js';

export function sortDossierIndex(rows = []) {
    const bucketRank = { active: 0, archived: 1, dead: 2 };
    return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => (
        Number(Boolean(b?.present)) - Number(Boolean(a?.present))
        || Number(Boolean(b?.worldActive)) - Number(Boolean(a?.worldActive))
        || (bucketRank[a?.bucket] ?? 9) - (bucketRank[b?.bucket] ?? 9)
        || String(a?.name || '').localeCompare(String(b?.name || ''))
    ));
}

// The dead stay out of the list: a search finds them, and the selected dossier (for example one
// opened from a chat card) stays visible while it is selected.
export function filterDossierIndex(rows = [], { query = '', filter = 'all', keepId = '' } = {}) {
    const needle = plain(query).toLocaleLowerCase();
    const mode = ['all', 'active', 'archived'].includes(filter) ? filter : 'all';
    const keep = plain(keepId);
    return sortDossierIndex(rows).filter(row => {
        if (row?.bucket === 'dead') {
            if (keep && row.id === keep) return true;
            if (!needle) return false;
        } else if (mode !== 'all' && row?.bucket !== mode) return false;
        if (!needle) return true;
        return [
            row?.name,
            row?.role,
            row?.species,
            row?.gender,
            row?.apparentAge,
            row?.homeBase,
            row?.location,
            row?.status,
            row?.statusLabel,
            ...(Array.isArray(row?.aliases) ? row.aliases : []),
        ].some(value => String(value || '').toLocaleLowerCase().includes(needle));
    });
}

export function chooseDossierSelection(currentId, visibleRows = [], allRows = []) {
    const current = plain(currentId);
    const visible = Array.isArray(visibleRows) ? visibleRows : [];
    const all = Array.isArray(allRows) ? allRows : [];
    if (current && visible.some(row => row?.id === current)) return current;
    if (visible[0]?.id) return visible[0].id;
    if (current && all.some(row => row?.id === current)) return current;
    return all[0]?.id || '';
}

// (key people) What the dossier shows of Story Director's key-person data for one dossier: { here, away, recent }, with the
// absence as { doing, since, back, steps: [{ date, text }], range } and `recent` the last absence of someone who has come back
// ({ away, justReturned }); null for anyone who is not a key person. Text only: the view draws it escaped.
function awayProjection(away) {
    if (!away || typeof away !== 'object') return null;
    const record = {
        doing: plain(away.doing), since: plain(away.since), back: plain(away.back),
        steps: (Array.isArray(away.steps) ? away.steps : []).slice(-12)
            .map(step => ({ date: plain(step?.date), text: plain(step?.text) })).filter(step => step.text),
    };
    return { ...record, range: awayRange(record) };
}
export function keyProjection(view) {
    if (!view || typeof view !== 'object') return null;
    const away = awayProjection(view.away);
    const recentAway = view.recent && typeof view.recent === 'object' ? awayProjection(view.recent.away) : null;
    return { here: view.here === true, away, recent: recentAway ? { away: recentAway, justReturned: view.recent.justReturned === true } : null };
}

/** The "While away" section: the dates and the steps while a key person is away, and after the return for a few replies. */
export function keyAwayHtml(key) {
    const shown = key?.away ?? key?.recent?.away ?? null;
    if (!shown) return '';
    const now = Boolean(key.away);
    const steps = shown.steps.map(step => `<li>${step.date ? `<b>${escapeHtml(step.date)}</b>: ` : ''}${escapeHtml(step.text)}</li>`).join('');
    const note = now
        ? 'Their meters and stable profile are held while they are away. The narrator gets this summary with their dossier when they return.'
        : 'They are back. Their meters and stable profile did not change while they were away.';
    return `<section class="delta-away" data-delta-section="away" aria-label="While away">
        <h5>While away${shown.range ? ` · ${escapeHtml(shown.range)}` : ''} <span class="delta-muted">(from Story Director)</span></h5>
        ${shown.doing ? `<p class="delta-away-doing">${escapeHtml(shown.doing)}</p>` : ''}
        ${steps ? `<ol>${steps}</ol>` : ''}
        <p class="delta-muted delta-away-note">${note}</p>
    </section>`;
}

// (the living cast) What the dossier shows for a person Delta made from the pack's cast: { badge, packName, firstMet, goal, routine,
// lastHeard: { text, on } | null, where, doing }; null for any other dossier. Text only: the view draws it escaped.
export function castProjection(view) {
    if (!view || typeof view !== 'object') return null;
    const heard = view.lastHeard && typeof view.lastHeard === 'object' && plain(view.lastHeard.text)
        ? { text: plain(view.lastHeard.text), on: plain(view.lastHeard.on) } : null;
    return {
        badge: plain(view.badge, 'Cast'), packName: plain(view.packName), firstMet: plain(view.firstMet),
        goal: plain(view.goal), routine: plain(view.routine), lastHeard: heard, where: plain(view.where), doing: plain(view.doing), pin: view.pin === true,
    };
}

/** The "From the Ersveil cast" block: where the person came from, their own path and when they were last heard of. */
export function castFromHtml(cast, npcId = '') {
    if (!cast) return '';
    const heard = cast.lastHeard ? `<b>Last heard:</b> ${escapeHtml(cast.lastHeard.text)}${cast.lastHeard.on ? ` (${escapeHtml(cast.lastHeard.on)})` : ''}` : '';
    const now = !cast.lastHeard && (cast.doing || cast.where)
        ? `<b>Now:</b> ${escapeHtml([cast.doing.replace(/[.\s]+$/, ''), cast.where ? `at ${cast.where}` : ''].filter(Boolean).join(' · '))}` : '';
    const path = cast.goal ? `<b>Their own path:</b> ${escapeHtml(cast.goal)}${cast.routine ? ` <span class="delta-muted">(${escapeHtml(cast.routine)})</span>` : ''}` : '';
    const lines = [path, heard || now].filter(Boolean).map(line => `<div>${line}</div>`).join('');
    return `<section class="delta-cast-from" data-delta-section="cast" aria-label="From the cast">
        <h5>From the ${cast.packName ? `${escapeHtml(cast.packName)} ` : ''}cast${cast.firstMet ? ` · first met ${escapeHtml(cast.firstMet)}` : ''}</h5>
        <div>Made at the first meeting from the pack's prepared dossier, no scan needed. Later scans add to it and change it as they do for anyone.</div>
        ${lines}
        ${cast.pin ? `<button type="button" class="delta-btn delta-cast-pin" data-delta-cast-pin="${escapeHtml(npcId)}">★ Pin as Key people</button>
        <div class="delta-muted delta-cast-pin-note">Pinned, they get the full Key people track (away, back date, return) and the narrator hears about them.</div>` : ''}
    </section>`;
}

export function projectDossierState(state = {}, status = {}) {
    const portraitAssets = state?.portraitAssets && typeof state.portraitAssets === 'object' ? state.portraitAssets : {};
    const records = Array.isArray(state?.npcs) ? state.npcs : [];
    const formPortraits = state?.formPortraits && typeof state.formPortraits === 'object' ? state.formPortraits : {};
    const customFieldNames = Array.isArray(state?.customFieldNames) ? state.customFieldNames : undefined;
    const meterViews = state?.meterViews && typeof state.meterViews === 'object' ? state.meterViews : {};
    const changeViews = state?.changeViews && typeof state.changeViews === 'object' ? state.changeViews : {};
    const keyViews = state?.keyViews && typeof state.keyViews === 'object' ? state.keyViews : {};
    const castViews = state?.castViews && typeof state.castViews === 'object' ? state.castViews : {};
    const details = records.map(npc => {
        const detail = dossierDetailProjection(npc, portraitAssets, formPortraits[npc?.id] || {}, { customFieldNames, hostChange: Object.hasOwn(changeViews, String(npc?.id ?? '')) ? changeViews[npc.id] : null });
        const meters = v2MetersProjection(Object.hasOwn(meterViews, String(npc?.id ?? '')) ? meterViews[npc.id] : null);
        const key = keyProjection(Object.hasOwn(keyViews, String(npc?.id ?? '')) ? keyViews[npc.id] : null);
        const cast = castProjection(Object.hasOwn(castViews, String(npc?.id ?? '')) ? castViews[npc.id] : null);
        return { ...detail, ...(meters ? { v2Meters: meters } : {}), ...(key ? { key } : {}), ...(cast ? { cast } : {}) };
    }).filter(npc => npc.id);
    return {
        chatKey: plain(status?.chatKey, 'no-chat'),
        hydrationStatus: plain(status?.hydrationStatus, 'ready'),
        hydrationError: plain(status?.hydrationError),
        turn: Number.isFinite(Number(state?.turn)) ? Number(state.turn) : 0,
        reply: wholeNumber(state?.reply) ?? -1,
        npcs: details,
        index: sortDossierIndex(details.map(npc => ({
            id: npc.id,
            name: npc.name,
            aliases: npc.aliases,
            role: npc.role,
            species: npc.species,
            gender: npc.gender,
            apparentAge: npc.apparentAge,
            homeBase: npc.homeBase,
            location: npc.location,
            status: npc.status,
            present: npc.present,
            worldActive: npc.worldActive,
            archived: npc.archived,
            archiveReason: npc.archiveReason,
            lifeState: npc.lifeState,
            bucket: npc.bucket,
            statusLabel: npc.statusLabel,
            portrait: npc.portrait,
            updatedAt: npc.updatedAt,
            ...(npc.key ? { key: true } : {}),
        }))),
    };
}
