// The New character wizard's Stats step: the steppers, radar and Standard growth note.
export function createStatsStep(ctx) {
    const { snap, pointsLeft, STATS, draftCreation, growthText, growthOf, RPG_STRINGS, fill, W, drawSummary, h, doc, stepper, put,
        draft, radar, button, redraw, startStats, statBounds, LEVEL_WORD, safe, packNote, body } = ctx;
    let handles = [], steppers = [], radarHandle = null;
    // ---- Stats ----
    const axes = now => STATS.map(stat => ({ label: stat.toUpperCase(), value: now.stats[stat], max: 20, before: now.from ? now.from.stats[stat] : draftCreation(now).start }));
    // The Standard formula's one line of what the next points buy; Classic's bars do not grow with stats.
    const growth = now => (draftCreation(now).standard ? growthText(growthOf(now.stats, { statMax: draftCreation(now).statMax })) : '');
    let growthNode = null;
    function refreshStats() {
        const now = snap(), left = pointsLeft(now);
        STATS.forEach((stat, at) => steppers[at]?.update({ name: stat, value: now.stats[stat], min: statBounds(now, stat)[0], max: statBounds(now, stat)[1], budget: left, label: stat.toUpperCase(), budgetLabel: RPG_STRINGS.sheet.budgetLabel, showBudget: false }));
        radarHandle?.update({ axes: axes(now), max: 20, label: fill(W.radar, { name: now.name || W.title }), tone: 'accent' });
        if (growthNode) growthNode.textContent = growth(now);
        drawSummary();
    }
    function drawStats() {
        const now = snap(), left = pointsLeft(now);
        // One card (the Spend points view's): an even grid of label-over-stepper cells with the radar beside it, then Reset and the help
        // under the grid's left edge. The points left show once, in the summary row above, so the steppers leave their own line out.
        const card = h(doc, 'div', 'rpg-wiz-stats-card');
        const sheet = h(doc, 'div', 'rpg-sheet-body rpg-wiz-stats-body');
        const grid = h(doc, 'div', 'rpg-steppers rpg-wiz-steppers');
        sheet.appendChild(grid);
        for (const stat of STATS) {
            const slot = h(doc, 'div', 'rpg-stat-step');
            slot.setAttribute('data-stat', stat);
            grid.appendChild(slot);
            const handle = stepper.render(slot, { name: stat, value: now.stats[stat], min: statBounds(now, stat)[0], max: statBounds(now, stat)[1], budget: left, label: stat.toUpperCase(), showBudget: false },
                { onDraft: (name, value) => { if (STATS.includes(name) && Number.isSafeInteger(value)) put({ ...draft(), stats: { ...snap().stats, [name]: value } }); refreshStats(); } });
            handles.push(handle);
            steppers.push(handle);
        }
        const chart = h(doc, 'div', 'rpg-radar');
        radarHandle = radar.render(chart, { axes: axes(now), max: 20, label: fill(W.radar, { name: now.name || W.title }), tone: 'accent' }, {});
        handles.push(radarHandle);
        sheet.appendChild(chart);
        card.appendChild(sheet);
        const actions = h(doc, 'div', 'rpg-actions rpg-wiz-stats-actions');
        button(actions, W.statsReset, 'ss-button rpg-wiz-reset', () => { put({ ...draft(), stats: startStats(snap()) }); redraw(); });
        const creation = draftCreation(now), standard = creation.standard === true;
        const words = { ...creation, label: LEVEL_WORD };
        actions.appendChild(h(doc, 'p', 'rpg-sheet-note', now.from ? fill(standard ? W.statsNoteImportStandard : W.statsNoteImport, { ...words, n: now.from.points }) : fill(standard ? W.statsNoteStandard : W.statsNote, words)));
        const fromPack = standard ? safe(packNote, '') : '';
        if (fromPack) actions.appendChild(h(doc, 'p', 'rpg-sheet-note rpg-wiz-pack', fill(RPG_STRINGS.settings.fromPack, { name: fromPack })));
        card.appendChild(actions);
        // Standard: Health, Stamina and Mana grow with VIT, AGI and INT, and luck with LUK; the line follows the steppers.
        growthNode = standard ? h(doc, 'p', 'rpg-wiz-growth', growth(now)) : null;
        if (growthNode) { growthNode.setAttribute('data-wiz', 'growth'); card.appendChild(growthNode); }
        body.appendChild(card);
    }

    function clear() {
        for (const handle of handles) handle.destroy?.();
        handles = []; steppers = []; radarHandle = null;
    }

    return { drawStats, clear };
}
