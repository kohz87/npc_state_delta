// The present cast and dossier views: action binding, the key-person pin, renderCast's cards/meters/notes and renderDossiers's
// cast-or-list composition. The DOM is built with textContent and the same Story Block classes as the original view.

import { elementOf, PANE_CLASS } from './dom.js';

export function createCastRenderPart(session, deps, dossier, { notifyChange, portraitFill }) {
    const {
        doc, enabled, KEY_PIN_COMMAND, keyPinOffered, npcList, part, runtime, send, worldShown,
    } = deps;

    // ---- the Dossiers tab (once Cast) ----

    function bindCastActions(el) {
        if (el.__npcStateDeltaV2Actions) return;
        el.__npcStateDeltaV2Actions = true;
        el.addEventListener?.('click', event => {
            const action = event.target?.closest?.('[data-npc-state-delta-action]')?.dataset?.npcStateDeltaAction;
            if (action === 'scan') return void runtime()?.scan?.();
            if (action === 'add') return void runtime()?.addNpc?.();
            // A dossier row opens that dossier (v1's Dossiers tab did the same); so does a World → People here row, anywhere on it.
            const row = event.target?.closest?.('.npc-state-delta-story-row')
                ?? event.target?.closest?.('.npc-state-delta-world-people[data-npc-id]');
            if (row?.dataset?.npcId) runtime()?.openDossier?.(row.dataset.npcId);
        });
        // The search box filters the list in place: only the list is drawn again, so the box keeps its focus.
        el.addEventListener?.('input', event => {
            const box = event.target;
            if (!box?.classList?.contains?.('npc-state-delta-story-search')) return;
            el.__npcStateDeltaV2Find = String(box.value ?? '').slice(0, 80);
            const list = el.querySelector?.('.npc-state-delta-story-list');
            if (list) list.replaceChildren(...dossier.dossierRowNodesFor(el.__npcStateDeltaV2Find, list.ownerDocument ?? doc));
        });
    }
    // The reader pins a dossier's person as a key person: `keypeople.pin { name, aliases?, nsd: true }` as the reader's action (cause ui).
    // → { ok, message } (Story Director's own answer, or why not).
    async function pinKeyPerson({ name, aliases } = {}) {
        const who = String(name ?? '').trim();
        if (!who) return { ok: false, message: 'Nobody to pin.' };
        if (!keyPinOffered()) return { ok: false, message: 'Story Director does not offer Key people here.' };
        const list = (Array.isArray(aliases) ? aliases : []).map(alias => String(alias ?? '').trim()).filter(Boolean).slice(0, 8);
        const out = await send(KEY_PIN_COMMAND, { name: who, ...(list.length ? { aliases: list } : {}), nsd: true });
        if (out?.ok) notifyChange();
        return { ok: out?.ok === true, message: String(out?.receipt?.summary ?? out?.message ?? (out ? '' : 'Story Director did not answer.')) };
    }

    // Delta's own present-cast cards (the same markup as v1's Present NPCs tab; the cards' text is set by fillPresentCast),
    // each with its NPC's stage on the name line, its meters inside the row and its notes under it. Then the NPCs with meters
    // but no card (a block of their own), then the dossier list (`list`). `track: false` (the game view's screen, the World
    // screen) leaves castEl, the Story panel's tab pane, alone. `people` (only Story Director's World → Now, the page API)
    // draws "People here": portrait, name, standing chip and the description; the Look and field lines, the Next line and the
    // notes (opened and hidden) stay in the dossier and on the Dossiers screen.
    function renderCast(el, { track = true, cast = true, list = false, people = false } = {}) {
        if (!el) return;
        if (track) session.castEl = el;
        bindCastActions(el);
        const api = runtime();
        const owner = el.ownerDocument ?? doc;
        let body = '';
        if (cast) {
            if (!api) body = session.emptyCast({ text: 'NPC State Delta is still loading.' });
            else if (!enabled()) body = session.emptyCast({ text: 'NPC State Delta is off.' });
            else body = String(api.presentCastHtml?.() || '') || session.emptyCast(api.castEmptyReason?.());
        }
        // World → Here (track false) shows no meters: its present cards keep the stage, notes and now lines; the Dossiers screen keeps the meters.
        const world = track === false;
        const meters = cast && api && enabled() ? dossier.meterEntries() : null;
        let listPart = null;
        let listText = '';
        if (list && !(cast && (!api || !enabled()))) {
            if (!api) listText = session.emptyCast({ text: 'NPC State Delta is still loading.' });
            else if (!enabled()) listText = session.emptyCast({ text: 'NPC State Delta is off.' });
            else listPart = dossier.dossierListNode(el, owner);
        }
        const pane = `<div class="${PANE_CLASS}">${body}${listText}</div>`;
        const rowsKey = list ? JSON.stringify([el.__npcStateDeltaV2Find ?? '', dossier.withKeyMarks(dossier.dossierRows()).map(row => [row.id, row.name, row.statusLabel, row.role, row.key === true]), meters?.cast ?? null]) : '';
        const key = `${pane}\u0001${meters ? JSON.stringify(meters.cast) : ''}\u0001${rowsKey}`;
        // A full redraw replaces the search box: the reader typing in it keeps the focus and the caret.
        const typing = list && owner?.activeElement?.classList?.contains?.('npc-state-delta-story-search') && el.contains?.(owner.activeElement);
        // Skip an unchanged redraw only while the element still holds what was drawn: Story Block's tab host empties the
        // shared pane (replaceChildren) before every render.
        const drawn = el.__npcStateDeltaV2CastNode;
        const stillShown = drawn ? drawn.parentNode === el : Boolean(el.innerHTML);
        if (el.__npcStateDeltaV2Cast === key && stillShown) return;
        el.innerHTML = pane;
        el.__npcStateDeltaV2Cast = key;
        el.__npcStateDeltaV2CastPane = pane;
        el.__npcStateDeltaV2CastNode = el.firstElementChild ?? null;
        const extras = [];
        if (world && cast) {
            // The chatter sits under the card (its own cell row); the side copy of the now lines and the idle line go.
            for (const cell of el.querySelectorAll?.('.npc-state-delta-present-cell') ?? []) {
                cell.classList?.add?.('npc-state-delta-world-cell');
                for (const node of [...(cell.children ?? [])]) if (node.classList?.contains?.('npc-state-delta-present-side')) node.remove?.();
                if (!people) continue;
                cell.classList?.add?.('npc-state-delta-world-people');
                for (const now of [...(cell.querySelectorAll?.('.npc-state-delta-present-now') ?? [])]) now.remove?.();
            }
        }
        if (meters && cast) {
            const defs = part.defs();
            const used = new Set();
            for (const cell of el.querySelectorAll?.('.npc-state-delta-present-cell[data-npc-id]') ?? []) {
                const npc = npcList().find(item => String(item.id ?? '') === String(cell.dataset?.npcId ?? ''));
                const who = npc ? part.identify(meters.byKey, npc.name) : null;
                const entry = who && Object.hasOwn(meters.byKey, who.key) ? meters.byKey[who.key] : null;
                if (!entry || used.has(entry)) continue;
                used.add(entry);
                const text = cell.querySelector?.('.npc-state-delta-present-card-text');
                const stage = cell.querySelector?.('.npc-state-delta-present-card-stage');
                if (stage) stage.textContent = entry.rank ?? '';
                if (text && !world) {
                    const bars = elementOf(owner, 'div', 'npc-state-delta-present-card-bars');
                    bars.append(...dossier.barNodesOf(owner, entry, defs));
                    text.append(bars);
                }
                if (people) continue;
                for (const line of dossier.noteNodes(owner, entry, { card: true })) cell.append(line);
            }
            const apart = world ? [] : meters.shown.filter(entry => !used.has(entry));
            if (apart.length) {
                const block = elementOf(owner, 'div', 'npc-state-delta-v2-meters');
                block.append(elementOf(owner, 'span', 'npc-state-delta-kicker', 'METERS'));
                for (const entry of apart) {
                    const section = elementOf(owner, 'section', 'npc-state-delta-v2-meter-npc');
                    section.dataset.npcKey = String(entry.key ?? '');
                    section.append(elementOf(owner, 'h4', '', entry.name ?? ''));
                    const bars = elementOf(owner, 'div', 'npc-state-delta-v2-meter-bars');
                    bars.append(...dossier.barNodesOf(owner, entry, defs));
                    section.append(bars, ...dossier.noteNodes(owner, entry));
                    block.append(section);
                }
                extras.push(block);
            }
        }
        if (listPart) extras.push(listPart);
        if (extras.length) {
            const wrap = elementOf(owner, 'div', PANE_CLASS);
            wrap.append(...extras);
            el.append(wrap);
        }
        // The now lines and chatter bubbles get their text through textContent, never markup.
        if (cast) api?.fillPresentCast?.(el);
        if (typing) {
            const box = el.querySelector?.('.npc-state-delta-story-search');
            try {
                box?.focus?.({ preventScroll: true });
                const end = String(box?.value ?? '').length;
                box?.setSelectionRange?.(end, end);
            } catch { /* focus is a convenience */ }
        }
    }

    // The Dossiers tab and screen: the present cast at the top only while Story Director's World does not
    // show it, then the dossier list.
    function renderDossiers(el, { track = true } = {}) {
        renderCast(el, { track, cast: !worldShown(), list: true });
        portraitFill();
    }

    return { bindCastActions, pinKeyPerson, renderCast, renderDossiers };
}
