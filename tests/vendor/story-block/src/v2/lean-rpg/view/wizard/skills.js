// The New character wizard's Skills step: starting sets and the editable skill rows.
export function createSkillsStep(ctx) {
    const { snap, skillSetsOf, safe, api, current, draft, h, doc, W, fill, draftSlots, draftCreation, button, put, drawSummary, redraw, body, withSet,
        setLine, input, CREATION, select, STATS, USES, RANK_NAMES, START_RANKS, mayStartAdept, withSkillPatch, withoutSkill, withSkill } = ctx;
    // ---- Skills ----
    function drawSkills() {
        const now = snap(), sets = skillSetsOf({
            packSets: safe(() => api?.query?.('packs.content', { kind: 'rpg' }), []),
            packNames: Object.fromEntries(safe(() => api?.query?.('packs.list'), []).map(pack => [pack.id, pack.name])),
        });
        const pending = current().pendingSet;
        if (pending && !draft().skills.some(skill => Number.isSafeInteger(skill.rank))) current().pendingSet = null;
        if (current().pendingSet) {
            const ask = h(doc, 'div', 'rpg-wiz-replace');
            ask.setAttribute('role', 'alert');
            ask.setAttribute('data-wiz', 'replace');
            ask.appendChild(h(doc, 'span', 'rpg-wiz-replace-text', W.replaceAsk));
            button(ask, W.replaceYes, 'ss-button ss-button-primary rpg-wiz-replace-yes', () => { const set = current().pendingSet; current().pendingSet = null; put(withSet(draft(), set)); drawSummary(); redraw(); });
            button(ask, W.replaceKeep, 'ss-button rpg-wiz-replace-keep', () => { current().pendingSet = null; redraw(); });
            body.appendChild(ask);
        }
        body.appendChild(h(doc, 'p', 'rpg-wiz-p', fill(W.skillsIntro, { max: draftSlots(draft()) })));
        body.appendChild(h(doc, 'h3', 'rpg-wiz-h', W.templates));
        const grid = h(doc, 'div', 'rpg-wiz-grid');
        body.appendChild(grid);
        for (const set of sets) {
            const used = draft().set === set.id;
            const card = button(grid, '', 'rpg-wiz-card', () => {
                // A template would replace skills that came from a file with their ranks: ask first.
                if (draft().skills.some(skill => Number.isSafeInteger(skill.rank))) { current().pendingSet = set; redraw(); return; }
                put(withSet(draft(), set)); drawSummary(); redraw();
            });
            card.setAttribute('aria-pressed', String(used));
            card.setAttribute('data-set', set.id);
            const top = h(doc, 'span', 'rpg-wiz-card-top');
            top.appendChild(h(doc, 'b', '', set.name));
            if (used) top.appendChild(h(doc, 'span', 'rpg-wiz-tag', W.used));
            card.appendChild(top);
            card.appendChild(h(doc, 'span', 'rpg-wiz-card-skills', setLine(set)));
            if (set.about) card.appendChild(h(doc, 'span', 'rpg-wiz-card-desc', set.about));
            card.appendChild(h(doc, 'span', 'rpg-wiz-card-src', set.source));
        }
        body.appendChild(h(doc, 'h3', 'rpg-wiz-h', W.yourSkills));
        if (draft().skills.some(skill => Number.isSafeInteger(skill.rank))) body.appendChild(h(doc, 'p', 'rpg-wiz-note', W.importRanks));
        if (draft().skills.some(skill => skill.sig === true)) body.appendChild(h(doc, 'p', 'rpg-wiz-note', W.signatureNote));
        const rows = h(doc, 'div', 'rpg-wiz-rows');
        body.appendChild(rows);
        const head = h(doc, 'div', 'rpg-wiz-row rpg-wiz-headrow');
        for (const label of [W.colSkill, W.colAbout, W.colStat, W.colUses, W.colType, W.colStart, '']) head.appendChild(h(doc, 'span', 'rpg-wiz-colhead', label));
        rows.appendChild(head);
        draft().skills.forEach((skill, at) => {
            const label = skill.name || W.newSkill;
            const row = h(doc, 'div', 'rpg-wiz-row');
            row.setAttribute('data-skill', String(at));
            const name = input(skill.name, CREATION.skillName, W.skillName);
            name.className = 'rpg-wiz-input rpg-wiz-n';
            name.setAttribute('data-field', 'name');
            const about = input(skill.about, CREATION.skillAbout, fill(W.skillAbout, { name: label }));
            about.className = 'rpg-wiz-input rpg-wiz-d';
            about.setAttribute('data-field', 'about');
            const stat = select([...(skill.stat ? [] : [{ value: '', label: '—' }]), ...STATS.map(key => ({ value: key, label: key.toUpperCase() }))], skill.stat ?? '', fill(W.skillStat, { name: label }));
            stat.setAttribute('data-field', 'stat');
            const uses = select(USES.map(key => ({ value: key, label: W[key] })), skill.uses, fill(W.skillUses, { name: label }));
            uses.setAttribute('data-field', 'uses');
            // Combat or utility (utility: for the story only, off the fight board): the pool that is full refuses the change and the row goes back.
            const type = select(['combat', 'utility'].map(key => ({ value: key, label: key === 'utility' ? W.typeUtility : W.typeCombat })), skill.type === 'utility' ? 'utility' : 'combat', fill(W.skillType, { name: label }));
            type.setAttribute('data-field', 'type');
            // A rank the file gave is shown and cannot be changed; a new skill starts at Novice or (for one) Adept.
            const ranked = Number.isSafeInteger(skill.rank);
            const start = ranked ? select(RANK_NAMES.map((name, rank) => ({ value: rank, label: name, disabled: true })), skill.rank, fill(W.skillStart, { name: label }))
                : select(START_RANKS.map(rank => ({ value: rank, label: RANK_NAMES[rank], disabled: rank === 1 && !mayStartAdept(draft(), at) })), skill.start, fill(W.skillStart, { name: label }));
            start.setAttribute('data-field', 'start');
            if (ranked) start.disabled = true;
            const patch = value => { put(withSkillPatch(draft(), at, value)); drawSummary(); };
            name.addEventListener('input', () => patch({ name: name.value }));
            about.addEventListener('input', () => patch({ about: about.value }));
            stat.addEventListener('change', () => patch({ stat: stat.value }));
            uses.addEventListener('change', () => patch({ uses: uses.value }));
            type.addEventListener('change', () => { patch({ type: type.value }); redraw(); });
            start.addEventListener('change', () => { patch({ start: Number(start.value) }); redraw(); });
            row.append(name, about, stat, uses, type, start);
            const remove = button(row, '', 'rpg-wiz-x', () => { put(withoutSkill(draft(), at)); drawSummary(); redraw(); });
            remove.setAttribute('aria-label', fill(W.remove, { name: label }));
            // A signature skill (a pack's cast member brought it): the pencil's rules, its name and what it does may be fixed; the stat, resource and rank stay and it cannot be taken out.
            if (skill.sig === true) {
                for (const control of [stat, uses, type, start, remove]) control.disabled = true;
                row.setAttribute('data-signature', 'true');
            }
            remove.appendChild(h(doc, 'span', '', '×'));
            rows.appendChild(row);
        });
        const left = draftSlots(now) - now.skills.length;
        const add = h(doc, 'div', 'rpg-wiz-add');
        const addButton = button(add, W.add, 'ss-button rpg-wiz-add-button', () => { put(withSkill(draft())); drawSummary(); redraw(); });
        addButton.disabled = left <= 0;
        add.appendChild(h(doc, 'p', 'rpg-wiz-note', `${left <= 0 ? W.slotsFull : left === 1 ? W.slotLeft : fill(W.slotsLeft, { n: left })} ${draftCreation(now).standard ? W.skillsNoteStandard : W.skillsNote}`));
        body.appendChild(add);
    }

    return { drawSkills };
}
