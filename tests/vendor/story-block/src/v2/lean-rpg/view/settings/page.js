// Draws Settings → RPG and keeps it live: the page shell, card order, search, focus, the Combat save lifecycle and
// the in-place Formula, odds and planner updates. Section drawing lives in the sibling part files; this file keeps
// the shared render closure and the order in which the cards are made.

import { h } from '../../../view/widgets/dom.js';
import { combatBlock } from '../settings-data.js';
import { CARD_WORDS, SETTINGS_MODULE } from './constants.js';
import { createControls } from './controls.js';
import { createBasicSections } from './sections.js';
import { createDifficultySection } from './difficulty.js';
import { createCombatSection } from './combat.js';
import { createPlannerSection } from './planner.js';

/**
 * Draws the page into `parent`. Options: `settings` (the store: `settings(id)`, `settings.set(id, key, value)`), `doc`,
 * `featureOn()`, `onChange()` (another page draws something that depends on a setting here), `headState()` (the story's head
 * state), `readerName()` (the persona's name), `roleOf(definition)` (what a block is read as), `command(type, payload)` (the
 * host's commands: the Combat rules text is saved with `dm.redefine`, and added with `dm.define`).
 * → { el, filter(text) → count, refresh(), refreshSize(), destroy() }, as a settings page body expects.
 */
export function renderRpgSettings(parent, { settings, doc = parent.ownerDocument ?? globalThis.document, featureOn = () => true, onChange = () => {}, headState = () => null, readerName = () => '', roleOf, command = null, pack = () => null, gear = null, boardFeature = null, gearOf = () => null } = {}) {
    const root = h(doc, 'div', 'rpg-set');
    parent.appendChild(root);
    const values = () => settings(SETTINGS_MODULE) ?? {};
    const put = (key, value) => { settings.set(SETTINGS_MODULE, key, value); onChange(); };
    const cards = {};
    let alive = true, oddsParts = null;
    // The Combat card's live state: the last note, the block text last seen, and its save hook while the card is drawn.
    const combatState = { note: '', shown: null, flush: null };
    // The page going out of sight (a tab switch, the window closing) keeps what was typed in the Combat box.
    const hidden = () => { if (doc.visibilityState === 'hidden') flush(); };
    const flush = () => { try { combatState.flush?.(); } catch { /* the box is saved when it is next left */ } };
    doc.addEventListener?.('visibilitychange', hidden);
    doc.defaultView?.addEventListener?.('pagehide', flush);

    const { card, chips, field, numberRow, packNote } = createControls({ doc, cards, root, put, redraw, pack, values });
    const basic = createBasicSections({ doc, card, chips, field, numberRow, packNote, values, settings, put, pack, boardFeature, gear, onChange });
    const difficulty = createDifficultySection({ doc, card, chips, field, packNote, values, settings, put, live, pack, headState, readerName, gearOf,
        getOddsParts: () => oddsParts, setOddsParts: parts => { oddsParts = parts; } });
    const combat = createCombatSection({ doc, root, card, values, pack, roleOf, command, headState, onChange, redraw, isAlive: () => alive, state: combatState });
    const planner = createPlannerSection({ doc, card, values, put, headState, pack });

    // ---- drawing
    function draw() {
        for (const node of Object.values(cards)) node.remove();
        for (const key of Object.keys(cards)) delete cards[key];
        basic.drawFormula();
        basic.drawLevels();
        basic.drawGear();
        basic.drawRolls();
        difficulty.drawDifficulty();
        combat.drawCombat();
        planner.drawPlanner();
        basic.drawJoin();
        live();
        place();
    }
    // The parts that follow the story and the numbers without rebuilding a box the reader may be typing in.
    function live() {
        // (the Stat formula card shows the numbers in force, so it is drawn again in its place when they change)
        const old = cards.formula;
        if (old && !old.hidden) { basic.drawFormula(); root.insertBefore(cards.formula, old); old.remove(); }
        difficulty.drawOdds();
        planner.drawPreview();
    }
    // Rebuilds the page, then puts the focus back on what was pressed.
    function redraw(focus = null) {
        if (!alive) return;
        draw();
        if (focus) root.querySelector(focus)?.focus?.({ preventScroll: true });
    }
    const place = () => { root.hidden = !featureOn(); };
    const typing = () => { const active = doc.activeElement; return Boolean(active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName ?? '')); };
    draw();

    return {
        el: root,
        filter(text) {
            const wanted = String(text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            const on = featureOn();
            let shown = 0;
            for (const [key, node] of Object.entries(cards)) {
                const match = on && wanted.every(word => CARD_WORDS[key].includes(word));
                node.hidden = !match;
                if (match) shown += 1;
            }
            root.hidden = !on;
            return shown;
        },
        refresh() { if (typing()) { live(); place(); } else redraw(); },
        // The story moved: the odds and the prompt follow it, and the Combat rules box when its block changed and is not being typed in.
        refreshSize() {
            if (!alive) return;
            live();
            const block = combatBlock(headState(), { roleOf });
            if ((block ? `${block.module}\n${block.prompt}` : '') !== combatState.shown && !typing()) redraw();
        },
        destroy() {
            flush();
            alive = false;
            doc.removeEventListener?.('visibilitychange', hidden);
            doc.defaultView?.removeEventListener?.('pagehide', flush);
            root.remove();
        },
    };
}
