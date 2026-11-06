// The Dossiers list and its meter projections: dossier rows, search filtering, key marks and meter/note nodes.

import { normalizeSecrets } from '../npc-meters.js';
import { findKeyEntry, isKey } from '../key-people.js';
import { elementOf, meterBarNode } from './cast-ui-meter-bar.js';

export function createCastDossierList({ session, runtime, npcList, warn, keyPeople, part, headReply, presentList, dossierOf }) {
    let rowsCache = { key: null, rows: [] };

    // Every dossier as a row of v1's list (dossier-ui.js dossierIndexProjection), kept until Delta's state
    // changes (dossierRevision); before that list has loaded, plain rows from the dossiers' names.
    function dossierRows() {
        const api = runtime();
        let revision = '';
        try { revision = String(api?.dossierRevision?.() ?? ''); } catch { revision = ''; }
        const key = revision ? `${session.listParts ? 'full' : 'plain'}|${revision}` : null;
        if (key && rowsCache.key === key) return rowsCache.rows;
        let rows = [];
        try {
            const state = session.listParts?.project ? api?.getDossierState?.() : null;
            if (state && Array.isArray(state.npcs)) rows = state.npcs.map(npc => session.listParts.project(npc, state.portraitAssets || {}));
            else {
                rows = npcList().map(npc => ({
                    id: String(npc.id ?? ''), name: String(npc.name ?? '').trim() || 'Unnamed NPC', aliases: Array.isArray(npc.aliases) ? npc.aliases : [],
                    role: '', statusLabel: npc.archived ? 'Archived' : npc.present ? 'Present' : '', bucket: npc.archived ? 'archived' : 'active', portrait: '',
                }));
            }
        } catch (error) {
            warn('Story Suite v2 dossier list failed', error);
            rows = [];
        }
        rowsCache = { key, rows };
        return rows;
    }
    // The dossier rows and the meters are DOM nodes built with textContent: a name, a role, a stage or a note is text, never
    // markup. Story Block's list-row classes are the same as story-block-tabs.js dossierRowNodes (its builder, once loaded).
    // Before story-block-tabs.js has loaded: plain rows of names that still open each dossier.
    function plainRowNodes(rows, doc, total = 0) {
        if (!rows.length) return [elementOf(doc, 'p', 'npc-state-delta-story-empty', total ? 'No dossier matches.' : 'No dossiers yet. An NPC gets one when a scan finds them in the story.')];
        return rows.map(row => {
            const item = elementOf(doc, 'li', 'ss-listcard-row');
            const button = elementOf(doc, 'button', 'ss-listcard-item npc-state-delta-story-row');
            button.dataset.npcId = String(row.id ?? '');
            button.setAttribute('aria-label', `Open ${row.name} dossier`);
            button.setAttribute('type', 'button');
            const text = elementOf(doc, 'span', 'npc-state-delta-story-text ss-listcard-main');
            text.append(elementOf(doc, 'b', 'ss-listcard-title', row.name), elementOf(doc, 'small', 'ss-listcard-sub', row.statusLabel ?? ''));
            button.append(elementOf(doc, 'span', 'npc-state-delta-story-thumb ss-listcard-icon', Array.from(String(row.name ?? '').trim())[0]?.toUpperCase() ?? '?'), text);
            item.append(button);
            return item;
        });
    }
    // The dossier rows for a search, as nodes (story-block-tabs.js when loaded; the plain rows before that).
    function dossierRowNodesFor(query, doc) {
        const rows = dossierRows();
        let visible;
        try {
            if (session.listParts?.filter) visible = session.listParts.filter(rows, { query });
            else {
                const needle = String(query).trim().toLocaleLowerCase();
                visible = rows.filter(row => !needle || [row.name, ...(row.aliases ?? [])].some(name => String(name).toLocaleLowerCase().includes(needle)));
            }
        } catch { visible = rows; }
        try {
            return session.listParts?.rowNodes ? session.listParts.rowNodes(withMeters(visible), doc, { query, total: rows.length }) : plainRowNodes(visible, doc, rows.length);
        } catch {
            return plainRowNodes(visible, doc, rows.length);
        }
    }
    // Each row's stage and meters (npc.cast: the ranks and bars the present cards' meters show; the row draws at most DOSSIER_BAR_MAX).
    // Read when the list is drawn and never cached with the rows: a reply moves them without changing any dossier.
    // A ★ on the rows of key people (their `key` flag), read when the list is drawn like the meters.
    function withKeyMarks(rows) {
        const list = keyPeople();
        if (!list?.length) return rows;
        return rows.map(row => (isKey(findKeyEntry(list, row)) ? { ...row, key: true } : row));
    }
    function withMeters(rows) {
        rows = withKeyMarks(rows);
        if (!session.hosted || !rows.length || typeof session.sdkRef?.query !== 'function') return rows;
        let cast;
        try {
            const head = headReply?.();
            cast = session.sdkRef.query('npc.cast', Number.isInteger(head) ? { headReply: head } : {});
        } catch {
            return rows;
        }
        if (!Array.isArray(cast) || !cast.length) return rows;
        const byKey = Object.fromEntries(cast.map(entry => [entry.key, entry]));
        return rows.map(row => {
            const who = part.identify(byKey, row.name);
            const entry = who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
            return entry ? { ...row, stage: entry.rank || '', bars: entry.bars ?? [] } : row;
        });
    }
    // The dossier browser: a search box and every dossier, each opening its dossier view (Delta's own).
    function dossierListNode(el, doc) {
        const query = typeof el?.__npcStateDeltaV2Find === 'string' ? el.__npcStateDeltaV2Find : '';
        const wrap = elementOf(doc, 'div', 'npc-state-delta-story-dossiers npc-state-delta-v2-dossiers');
        wrap.append(elementOf(doc, 'span', 'npc-state-delta-kicker', 'DOSSIERS'));
        const box = elementOf(doc, 'input', 'text_pole npc-state-delta-story-search');
        box.setAttribute('type', 'search');
        box.setAttribute('placeholder', 'Search dossiers');
        box.setAttribute('aria-label', 'Search dossiers');
        box.setAttribute('maxlength', '80');
        box.value = query;
        wrap.append(box);
        const list = elementOf(doc, 'div', 'npc-state-delta-story-list ss-listcard ss-glass');
        list.append(...dossierRowNodesFor(query, doc));
        wrap.append(list);
        return wrap;
    }

    // The NPCs the meters show, in order: the present dossiers' (dossier order), then (beta) the people the story's change
    // lines gave meters who have no dossier yet (no scan has made one), straight from the state: those Story Block's scene has
    // here, or all of them when the scene cannot say. → { shown, byKey, cast } or null.
    function meterEntries() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
        let cast;
        try {
            const head = headReply?.();
            cast = session.sdkRef.query('npc.cast', Number.isInteger(head) ? { headReply: head } : {});
        } catch {
            return null;
        }
        if (!Array.isArray(cast) || !cast.length) return null;
        const byKey = Object.fromEntries(cast.map(entry => [entry.key, entry]));
        const shown = [];
        for (const npc of presentList()) {
            const who = part.identify(byKey, npc.name);
            const entry = who && Object.hasOwn(byKey, who.key) ? byKey[who.key] : null;
            if (entry && !shown.includes(entry)) shown.push(entry);
        }
        let scene = null;
        try {
            const list = session.sdkRef.query('scene.present');
            scene = Array.isArray(list) ? list.map(name => part.identify(byKey, String(name ?? ''))?.key).filter(Boolean) : null;
        } catch { scene = null; }
        for (const entry of cast) {
            if (shown.includes(entry) || dossierOf(entry.name)) continue;
            if (scene && !scene.includes(entry.key)) continue;
            shown.push(entry);
        }
        return { shown, byKey, cast };
    }
    const barNodesOf = (doc, entry, defs) => entry.bars.map(bar => meterBarNode(doc, defs.find(def => def.id === bar.id) ?? bar, bar.value, bar.stage, bar));
    // The notes and the next-stage line of one NPC (text only). A card shows its stage on its name line, so it leaves the rank out.
    function noteNodes(doc, entry, { card = false } = {}) {
        const nodes = [];
        if (!card && entry.rank) { const p = elementOf(doc, 'p', 'npc-state-delta-v2-rank'); p.append(elementOf(doc, 'b', '', entry.rank)); nodes.push(p); }
        if (entry.next) nodes.push(elementOf(doc, 'p', 'npc-state-delta-v2-next', entry.next));
        const texts = entry.opened?.length ? normalizeSecrets(dossierOf(entry.name)?.secrets) : [];
        for (const note of entry.opened ?? []) {
            const text = texts.find(secret => secret.id === note.id)?.text ?? '';
            const p = elementOf(doc, 'p', 'npc-state-delta-v2-note npc-state-delta-v2-note-open');
            p.append(elementOf(doc, 'b', '', note.title ?? ''));
            if (text) p.append(doc.createTextNode(`: ${text}`));
            nodes.push(p);
        }
        for (const note of entry.locked ?? []) nodes.push(elementOf(doc, 'p', 'npc-state-delta-v2-note npc-state-delta-v2-note-locked', note.text ?? ''));
        return nodes;
    }

    return { dossierRows, plainRowNodes, dossierRowNodesFor, withKeyMarks, withMeters, dossierListNode, meterEntries, barNodesOf, noteNodes };
}
