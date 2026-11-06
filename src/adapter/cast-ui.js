// The Dossiers screens (src/storysuite-v2.js): the present cast's cards and meters (renderCast, renderDossiers), the page API for
// Story Director's World screen, the Dossiers widget and screen, the meter presets block, the key-person pin, and the cast sync
// that follows a reply (onTurn). The settings section and dossier/meter list live in the cast-ui-*.js parts and are wired here.
//
// A part of the adapter closure: createCastUiPart(session, deps) gets the adapter's shared state (session) and the adapter's options,
// constants and the parts built before it (deps), and returns what the other parts and the adapter use. Text is set with textContent;
// nothing is parsed as markup. No SillyTavern import.

import { FEATURE_PRESETS } from '../npc-meters.js';
import { presetIds } from '../npc-meters-presets.js';
import { metWithEntry } from '../cast-dossier.js';
import { createCastSettingsUi } from './cast-ui-settings.js';
import { createCastDossierList } from './cast-ui-dossier-list.js';
import { elementOf } from './cast-ui-meter-bar.js';

const PANE_CLASS = 'npc-state-delta-story-pane';

export { meterBarNode } from './cast-ui-meter-bar.js';

export function createCastUiPart(session, deps) {
    const {
        CAST_SCREEN_ID, CAST_SCREEN_ORDER, CAST_TAB_ID, CAST_WIDGET, castMade, castPeople, castPortraitDue, castSync, catalog,
        doc, dossierOf, DOSSIERS_ICON, DOSSIERS_TITLE, enabled, headReply, KEY_PIN_COMMAND, keyAwayMemory, keyPeople,
        keyPeopleAnswer, keyPinOffered, MODULE_ID, npcList, page, PAGE_API, PAGE_SLOT_CLASS, panel, part, presentList, runtime,
        send, storedSettings, TICK_TURNS, timers, warn, watchMs, worldShown,
    } = deps;

    const castViews = new Set(); // the game view's Cast screens (CAST_WIDGET) drawn now
    const watchers = new Set();  // the page API's onChange subscribers

    const { syncDrawer, unmountSection, mountSection } = createCastSettingsUi(session, deps);
    const {
        dossierRows, dossierRowNodesFor, withKeyMarks, dossierListNode, meterEntries, barNodesOf, noteNodes,
    } = createCastDossierList({ session, runtime, npcList, warn, keyPeople, part, headReply, presentList, dossierOf });

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
            if (list) list.replaceChildren(...dossierRowNodesFor(el.__npcStateDeltaV2Find, list.ownerDocument ?? doc));
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
        const meters = cast && api && enabled() ? meterEntries() : null;
        let listPart = null;
        let listText = '';
        if (list && !(cast && (!api || !enabled()))) {
            if (!api) listText = session.emptyCast({ text: 'NPC State Delta is still loading.' });
            else if (!enabled()) listText = session.emptyCast({ text: 'NPC State Delta is off.' });
            else listPart = dossierListNode(el, owner);
        }
        const pane = `<div class="${PANE_CLASS}">${body}${listText}</div>`;
        const rowsKey = list ? JSON.stringify([el.__npcStateDeltaV2Find ?? '', withKeyMarks(dossierRows()).map(row => [row.id, row.name, row.statusLabel, row.role, row.key === true]), meters?.cast ?? null]) : '';
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
                    bars.append(...barNodesOf(owner, entry, defs));
                    text.append(bars);
                }
                if (people) continue;
                for (const line of noteNodes(owner, entry, { card: true })) cell.append(line);
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
                    bars.append(...barNodesOf(owner, entry, defs));
                    section.append(bars, ...noteNodes(owner, entry));
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

    // ---- the page API for Story Director's World (PAGE_API) ----

    function notifyChange() {
        for (const fn of [...watchers]) {
            try { fn(); } catch (error) { warn('Story Suite v2 cast listener failed', error); }
        }
    }
    // Each `slot(name, aliases)` node inside its present person's card (the card's text, under the now lines).
    function fillSlots(el, slot) {
        for (const old of [...(el.querySelectorAll?.(`.${PAGE_SLOT_CLASS}`) ?? [])]) old.remove?.();
        const cells = [...(el.querySelectorAll?.('.npc-state-delta-present-cell[data-npc-id]') ?? [])];
        if (typeof slot !== 'function' || !cells.length) return cells.length;
        const list = npcList();
        for (const cell of cells) {
            const npc = list.find(item => String(item.id ?? '') === String(cell.dataset?.npcId ?? ''));
            if (!npc) continue;
            let node = null;
            try { node = slot(String(npc.name ?? '').trim(), Array.isArray(npc.aliases) ? [...npc.aliases] : []); } catch { node = null; }
            if (!node || typeof node !== 'object' || typeof node.nodeType !== 'number') continue;
            node.classList?.add?.(PAGE_SLOT_CLASS);
            (cell.querySelector?.('.npc-state-delta-present-card-text') ?? cell).append?.(node);
        }
        return cells.length;
    }
    const pageApi = Object.freeze({
        version: 1,
        /** True while Delta is hosted, loaded and on: its cards can be drawn. */
        available: () => session.hosted && Boolean(runtime()) && enabled(),
        /** Draws the present cast's cards and meters into `el`; → how many present cards it drew (0: none, or not available). */
        render(el, { slot = null } = {}) {
            if (!el || !pageApi.available()) return 0;
            try {
                renderCast(el, { track: false, people: true });
                return fillSlots(el, slot);
            } catch (error) {
                warn('Story Suite v2 World cast failed', error);
                return 0;
            }
        },
        /** `fn()` after Delta's cast or state may have changed; → unsubscribe. */
        onChange(fn) {
            if (typeof fn !== 'function') return () => {};
            watchers.add(fn);
            return () => { watchers.delete(fn); };
        },
    });
    function offerPage(on) {
        if (!page || (typeof page !== 'object' && typeof page !== 'function')) return;
        try {
            if (on) page[PAGE_API] = pageApi;
            else if (page[PAGE_API] === pageApi) delete page[PAGE_API];
        } catch (error) { warn('Story Suite v2 page API failed', error); }
    }

    // Story Block's tab host has ONE pane for every module's tab (host-ui.js createTabHost marks it
    // with the shown tab's id). Delta may draw into it on its own only while it still shows the Cast
    // tab and still holds what Delta drew there; otherwise it is another module's tab now.
    function castStillShown(el) {
        if (el?.dataset?.tabId !== CAST_TAB_ID) return false;
        const drawn = el.__npcStateDeltaV2CastNode;
        if (drawn) return drawn.parentNode === el;
        return typeof el.__npcStateDeltaV2CastPane === 'string' && el.innerHTML.startsWith(el.__npcStateDeltaV2CastPane);
    }

    // ---- the Cast in the game view ----

    // Each drawn Cast screen again (Delta's page events: a cast drawn in the chat, Delta on or off);
    // one no longer on the page is let go.
    function redrawCastViews() {
        for (const box of castViews) {
            if (box.isConnected === false) {
                castViews.delete(box);
                continue;
            }
            try { renderDossiers(box, { track: false }); } catch (error) { warn('Story Suite v2 Dossiers screen failed', error); }
        }
    }

    // CAST_WIDGET: render(el, props, api) → { update, destroy }. Props are the screen's data (npc.cast,
    // npc.present), passed only so the widget redraws when they change; what it draws is renderCast's.
    const castWidget = Object.freeze({
        props: Object.freeze({}),
        validate: () => [],
        render(el) {
            const owner = el?.ownerDocument ?? doc;
            if (typeof owner?.createElement !== 'function') return { update() {}, destroy() {} };
            const box = owner.createElement('div');
            box.className = 'npc-state-delta-v2-cast-view';
            el.append(box);
            castViews.add(box);
            bindCastActions(box);
            const draw = () => {
                try { renderDossiers(box, { track: false }); } catch (error) { warn('Story Suite v2 Dossiers screen failed', error); }
            };
            draw();
            return {
                update: draw,
                destroy() {
                    castViews.delete(box);
                    box.remove?.();
                },
            };
        },
    });

    const castScreen = Object.freeze({
        id: CAST_SCREEN_ID,
        title: DOSSIERS_TITLE,
        icon: DOSSIERS_ICON,
        mounts: Object.freeze(['screen']),
        order: CAST_SCREEN_ORDER,
        data: Object.freeze({ cast: Object.freeze({ query: 'npc.cast' }), present: Object.freeze({ query: 'npc.present' }) }),
        template: `<ss-widget name="${CAST_WIDGET}" data-props='{"cast":{{ q.cast }},"present":{{ q.present }}}'></ss-widget>`,
        css: '.npc-state-delta-v2-cast-view { display: block; }',
    });

    // ---- the meter presets (settings section) ----

    // A block of buttons above Delta's panel: each preset with its description and Use / Stop using.
    // It writes only the `presets` setting (no schema row shows it, so no stale row can overwrite it).
    function presetsBlock(api) {
        if (typeof doc?.createElement !== 'function') return null;
        const root = doc.createElement('div');
        root.className = 'npc-state-delta-v2-presets';
        const read = () => {
            try { return presetIds((api?.values?.() ?? storedSettings())?.presets); } catch { return []; }
        };
        const write = ids => {
            try {
                if (typeof api?.set === 'function') api.set('presets', ids);
                else session.sdkRef?.settings?.set?.(MODULE_ID, 'presets', ids);
            } catch (error) { warn('Story Suite v2 preset setting failed', error); }
        };
        const draw = () => {
            root.replaceChildren();
            const head = doc.createElement('b');
            // Hidden by style.css inside Delta's own "Meter presets" fold, whose title says it.
            head.className = 'npc-state-delta-v2-presets-head';
            head.textContent = 'Meter presets';
            root.appendChild(head);
            if (!part.featureOn(FEATURE_PRESETS)) {
                const off = doc.createElement('small');
                off.textContent = ' Turned off in Features.';
                root.appendChild(off);
                return;
            }
            const help = doc.createElement('small');
            help.textContent = ' One click adds a set of meters, a stage ladder for the NPCs you give it in the dossier editor, and their limits.';
            root.appendChild(help);
            const used = read();
            for (const preset of catalog()) {
                const row = doc.createElement('div');
                row.className = 'npc-state-delta-v2-preset';
                row.dataset.preset = preset.id;
                const name = doc.createElement('span');
                name.className = 'npc-state-delta-v2-preset-name';
                name.textContent = preset.name;
                const about = doc.createElement('small');
                about.textContent = preset.describe;
                const on = used.includes(preset.id);
                const button = doc.createElement('button');
                button.type = 'button';
                button.className = 'menu_button npc-state-delta-v2-preset-toggle';
                button.textContent = on ? 'Stop using' : 'Use';
                button.setAttribute?.('aria-pressed', on ? 'true' : 'false');
                button.addEventListener?.('click', () => {
                    const now = read();
                    write(now.includes(preset.id) ? now.filter(id => id !== preset.id) : [...now, preset.id]);
                    draw();
                });
                for (const node of [name, about, button]) row.appendChild(node);
                root.appendChild(row);
            }
        };
        try {
            draw();
        } catch (error) {
            warn('Story Suite v2 meter presets could not be shown', error);
            return null;
        }
        return root;
    }

    // ---- the per-reply step (npc.tick) ----

    function onTurn(turn) {
        if (!session.hosted || !TICK_TURNS.includes(turn?.type) || !enabled()) return;
        let wanted = false;
        try { wanted = part.tickWanted(); } catch { wanted = false; }
        // Key people (Story Director's): the step also keeps the memory of their last absence up to date.
        if (!wanted) wanted = (keyPeopleAnswer()?.length ?? 0) > 0 || Object.keys(keyAwayMemory()).length > 0;
        // The living cast: someone met whose dossier is not yet made, or a made one with a stage ladder of their own.
        if (!wanted) wanted = castWanted();
        if (!wanted) {
            // Nothing for the step to do: a cast dossier made while its picture was missing may still get it now.
            portraitFill();
            return;
        }
        session.lastTick = send('npc.tick', {}, { own: true }).then(async out => {
            await madeCastSync();
            return out;
        });
    }
    function castWanted() {
        const made = castMade();
        if (Object.values(made).some(record => record?.rungs > 0)) return true;
        const people = castPeople();
        return Array.isArray(people) && metWithEntry(people).some(person => !Object.hasOwn(made, person.key));
    }
    // After the step: Delta makes the dossiers of the people it has just recorded (index.js castSync), never twice at once.
    async function madeCastSync() {
        if (typeof castSync !== 'function') return;
        try { await castSync(); } catch (error) { warn('Story Suite v2 cast dossiers were not made', error); }
    }
    // A cast dossier made while its picture was missing gets the picture once Story Block answers for it (a pack imported without its pictures,
    // the pictures imported later). Asked when it can be: the step, the head changing, the host accepting Delta, the Dossiers tab drawn
    // (and the chat opening, index.js). Only when there is a picture to give, so nothing else is sent or saved.
    function portraitFill() {
        if (!session.hosted || typeof castSync !== 'function' || typeof castPortraitDue !== 'function') return;
        let due = false;
        try { due = castPortraitDue() === true; } catch { due = false; }
        if (due) void madeCastSync();
    }

    return {
        watchers, syncDrawer, unmountSection, mountSection, pinKeyPerson, renderDossiers, notifyChange, pageApi, offerPage,
        castStillShown, redrawCastViews, castWidget, castScreen, presetsBlock, onTurn, portraitFill,
    };
}
