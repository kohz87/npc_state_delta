// The Spend points / Stats sheet (RB's Stats step reborn): the three stage bars on top, an `ss.stepper` per stat
// (1 to 20) spending the character's shared `points`, the points-left pill and an `ss.radar` with the new shape over
// the old one. Save writes every changed stat and `points` in ONE multi-field `dm.set` (one action on the latest reply,
// so it counts once against the reply's budget, and one "You set" line in "Changed this reply"); Cancel writes nothing. The Party tab
// opens it in place over its cards. Every node is built with createElement and textContent.

import { h } from '../../view/widgets/dom.js';
import { radar } from '../../view/widgets/radar.js';
import { stepper } from '../../view/widgets/stepper.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { refusalText } from '../../strings.js';
import { drawStageBars, fieldsPayload } from './bars.js';

const S = RPG_STRINGS.sheet;

/** Points spent from `start` to `draft` (stats only go up from where they were). */
export const spentOf = (stats, start, draft) => stats.reduce((sum, stat) => sum + Math.max(0, draft[stat.key] - start[stat.key]), 0);

const startOf = character => Object.fromEntries(character.stats.map(stat => [stat.key, stat.value]));

/**
 * A sheet's own record, kept outside the DOM (the Party tab is drawn again on every change of the story, and the sheet
 * with it): the character it is for, the stats and points it started from, the draft, whether a save is under way and
 * what the last save said.
 */
export const newSession = character => ({ module: character.module, subject: character.subject, start: startOf(character), pool: character.points, draft: startOf(character), busy: false, message: '' });

// The story moved under the sheet (a reply raised the points, a stat was edited elsewhere): the draft starts again from it.
const staleFor = (session, character) => !session.busy && (character.points !== session.pool || character.stats.some(stat => stat.value !== session.start[stat.key]));

/**
 * Draws the sheet for `character` (a readParty record) into `parent`.
 * Options: `api` ({ command }), `session` (newSession's record, kept by the caller so the sheet survives a redraw of the
 * page), `onClose({ saved: false })` (Cancel), `onDone({ ok })` (a save ended: the sheet is closed on success), `doc`.
 * → { el, session, draft(), save(), reset(), destroy() }. A save in flight goes on when the sheet is destroyed (the page
 * redrew itself after the first write); `onDone` still tells how it ended.
 */
export function renderDistribute(parent, { character, session = null, api = {}, onClose = () => {}, onDone = () => {}, doc = parent.ownerDocument ?? globalThis.document } = {}) {
    const root = h(doc, 'section', 'rpg-sheet ss-glass');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    parent.appendChild(root);
    const run = session ?? newSession(character);
    if (staleFor(run, character)) Object.assign(run, newSession(character), { message: run.message });
    let alive = true;
    let handles = [], steppers = [], radarHandle = null, pill = null, saveButton = null, resetButton = null, note = null;

    const clear = () => { for (const handle of handles) handle.destroy?.(); handles = []; steppers = []; radarHandle = null; root.replaceChildren(); };
    const changedStats = () => character.stats.filter(stat => run.draft[stat.key] !== run.start[stat.key]);
    const pointsLeft = () => run.pool - spentOf(character.stats, run.start, run.draft);
    const pillText = left => fill(left === 1 ? S.pointsLeftOne : S.pointsLeft, { n: left });
    const axes = () => character.stats.map(stat => ({ label: stat.label, value: run.draft[stat.key], max: stat.max, before: run.start[stat.key] }));
    const words = () => (run.busy ? S.saving : run.message || (character.points > 0 ? fill(S.hint, { label: character.soulLabel }) : S.noPoints));

    // The pill, the steppers' budgets, the radar and the buttons follow the draft; nothing is redrawn from scratch.
    function refresh() {
        const left = pointsLeft();
        if (pill) pill.textContent = pillText(left);
        character.stats.forEach((stat, at) => steppers[at]?.update({ name: stat.key, value: run.draft[stat.key], min: run.start[stat.key], max: stat.max, budget: left, label: stat.label, budgetLabel: S.budgetLabel, disabled: run.busy }));
        radarHandle?.update({ axes: axes(), max: 20, label: fill(S.radar, { name: character.name }), tone: 'accent' });
        const changed = changedStats().length > 0;
        if (saveButton) saveButton.disabled = run.busy || !changed;
        if (resetButton) resetButton.disabled = run.busy || !changed;
        if (note) note.textContent = words();
    }

    function draw() {
        clear();
        const spending = character.points > 0;
        root.setAttribute('aria-label', fill(spending ? S.spendTitle : S.title, { name: character.name }));
        const head = h(doc, 'div', 'rpg-sheet-head');
        head.appendChild(h(doc, 'h3', 'rpg-sheet-name', character.name));
        const pills = h(doc, 'div', 'rpg-pills');
        pills.appendChild(h(doc, 'span', 'ss-pill', fill(RPG_STRINGS.party.soul, { label: character.soulLabel, name: character.soulName })));
        pills.appendChild(h(doc, 'span', 'ss-pill', fill(S.xpPill, { xp: character.xp })));
        pill = h(doc, 'span', 'ss-pill rpg-points-left');
        pill.setAttribute('role', 'status');
        pills.appendChild(pill);
        head.appendChild(pills);
        root.appendChild(head);
        drawStageBars(doc, root, character, { api, handles });
        const body = h(doc, 'div', 'rpg-sheet-body');
        const grid = h(doc, 'div', 'rpg-steppers');
        for (const stat of character.stats) {
            const slot = h(doc, 'div', 'rpg-stat-step');
            slot.setAttribute('data-stat', stat.key);
            grid.appendChild(slot);
            const handle = stepper.render(slot, { name: stat.key, value: run.draft[stat.key], min: run.start[stat.key], max: stat.max, budget: 0, label: stat.label, budgetLabel: S.budgetLabel },
                { onDraft: (name, value) => { run.draft[name] = value; run.message = ''; refresh(); } });
            handles.push(handle);
            steppers.push(handle);
        }
        const chart = h(doc, 'div', 'rpg-radar');
        radarHandle = radar.render(chart, { axes: axes(), max: 20, label: fill(S.radar, { name: character.name }), tone: 'accent' }, {});
        handles.push(radarHandle);
        body.append(grid, chart);
        root.appendChild(body);
        const actions = h(doc, 'div', 'rpg-actions');
        const button = (text, cls, fn) => {
            const node = h(doc, 'button', cls, text);
            node.setAttribute('type', 'button');
            node.addEventListener('click', fn);
            actions.appendChild(node);
            return node;
        };
        saveButton = button(spending ? S.saveStats : S.save, 'ss-button ss-button-primary rpg-save', () => { save(); });
        resetButton = button(S.reset, 'ss-button rpg-reset', () => reset());
        button(S.cancel, 'ss-button rpg-cancel', () => { if (!run.busy) onClose({ saved: false }); });
        note = h(doc, 'p', 'rpg-sheet-note');
        note.setAttribute('role', 'status');
        actions.appendChild(note);
        root.appendChild(actions);
        refresh();
    }

    function reset() {
        run.draft = { ...run.start };
        run.message = '';
        refresh();
    }

    // The changed stats and the points left go as one `dm.set` with `fields`: one action, all or nothing.
    async function save() {
        if (run.busy || !alive) return { ok: false };
        const changed = changedStats();
        if (!changed.length) { onClose({ saved: false }); return { ok: true }; }
        const left = pointsLeft();
        if (typeof api.command !== 'function' || left < 0) return { ok: false };
        run.busy = true;
        run.message = '';
        refresh();
        let failure = null;
        try {
            const fields = Object.fromEntries([...changed.map(stat => [stat.key, run.draft[stat.key]]), ['points', left]]);
            const result = await api.command('dm.set', fieldsPayload(character, fields));
            if (!result?.ok) failure = result ?? { ok: false };
        } catch (error) {
            failure = { ok: false, message: String(error?.message ?? error) };
        }
        run.busy = false;
        run.message = failure ? refusalText(failure, S.failed) : '';
        if (alive) refresh();
        onDone({ ok: !failure });
        return { ok: !failure };
    }

    draw();
    return {
        el: root,
        session: run,
        draft: () => ({ ...run.draft }),
        save,
        reset,
        destroy() {
            alive = false;
            clear();
            root.remove();
        },
    };
}
