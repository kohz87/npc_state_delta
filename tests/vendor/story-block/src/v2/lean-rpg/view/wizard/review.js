// The New character wizard's Review step and Create: definitions, best-effort extra blocks and imported things.
export function createReviewStep(ctx) {
    const { DM_LIMITS, W, fill, current, snap, world, problemsOf, blockNames, kindWord, h, doc, body, RANK_NAMES, rankOf, pointsLeft, statsLine,
        extraName, button, safe, api, refusalText, ownerFor, importedAdds, thingsPhrase, moneyText, currency, buildDefinitions, levelCap,
        headState, extraDefinitions, draftCreation, isAlive, redraw } = ctx;
    // ---- Review ----
    const whyNot = skipped => fill(skipped.some(item => item.why === 'room') ? W.extraRoom : W.extraActions, { max: DM_LIMITS.definitions });
    function drawReview() {
        if (current().finished) { drawFinished(); return; }
        const now = snap(), where = world();
        const problems = problemsOf(now, where);
        const names = blockNames(now.name || '…');
        const list = h(doc, 'div', 'rpg-wiz-review');
        body.appendChild(list);
        list.appendChild(h(doc, 'h3', 'rpg-wiz-h', W.reviewHead));
        list.appendChild(h(doc, 'p', 'rpg-wiz-p rpg-wiz-review-who', fill(W.reviewWho, { name: now.name || '—', kind: kindWord(now.kind) })));
        const about = h(doc, 'p', 'rpg-wiz-p', now.about || W.reviewNoAbout);
        about.setAttribute('data-review', 'about');
        list.appendChild(about);
        list.appendChild(h(doc, 'p', 'rpg-wiz-p', `${W.statsHead}: ${statsLine(now)}`));
        const skills = h(doc, 'ul', 'rpg-wiz-review-skills');
        for (const skill of now.skills) skills.appendChild(h(doc, 'li', '', `${skill.name || '—'} · ${skill.stat ? skill.stat.toUpperCase() : '—'} · ${W[skill.uses]} · ${W.startsAt} ${RANK_NAMES[rankOf(skill)]}`));
        if (!now.skills.length) skills.appendChild(h(doc, 'li', '', W.noSkills));
        list.appendChild(skills);
        list.appendChild(h(doc, 'p', 'rpg-wiz-note', current().imported ? fill(W.reviewStartImported, { level: now.level ?? 1 })
            : fill(now.level > 1 ? W.reviewStartSoul : W.reviewStart, { level: now.level ?? 1 })));
        const left = Math.max(0, pointsLeft(now));
        if (left > 0) list.appendChild(h(doc, 'p', 'rpg-wiz-note', fill(left === 1 ? W.reviewLeftOne : W.reviewLeft, { n: left })));
        list.appendChild(h(doc, 'p', 'rpg-wiz-note', fill(W.reviewBlocks, { character: names.character, skills: names.skills })));
        const { add, skipped } = where.extras;
        if (add.length) {
            const also = h(doc, 'p', 'rpg-wiz-note', fill(W.reviewAlso, { list: add.map(extraName).join(', ') }));
            also.setAttribute('data-review', 'also');
            list.appendChild(also);
        }
        const adds = importedAdds();
        if (adds.things || adds.money) {
            const parts = [adds.things ? thingsPhrase(adds.things, now) : '', adds.money ? fill(W.reviewMoney, { amount: moneyText(adds.money, currency()) }) : ''];
            const more = h(doc, 'p', 'rpg-wiz-note rpg-wiz-also-import', fill(W.reviewAlsoImport, { list: parts.filter(Boolean).join(' · ') }));
            more.setAttribute('data-review', 'import-also');
            list.appendChild(more);
        }
        if (skipped.length && where.room) {
            const not = h(doc, 'p', 'rpg-wiz-note', fill(W.reviewNotAdded, { list: skipped.map(item => extraName(item.role)).join(', '), why: whyNot(skipped) }));
            not.setAttribute('data-review', 'not-added');
            list.appendChild(not);
        }
        const bad = h(doc, 'ul', 'rpg-wiz-problems');
        bad.setAttribute('role', 'alert');
        bad.hidden = problems.length === 0;
        if (problems.length) bad.appendChild(h(doc, 'li', 'rpg-wiz-problems-head', W.problems));
        for (const problem of problems) bad.appendChild(h(doc, 'li', '', problem));
        list.appendChild(bad);
        const actions = h(doc, 'div', 'rpg-actions');
        const make = button(actions, current().busy ? W.creating : W.create, 'ss-button ss-button-primary rpg-wiz-create', () => { create(make, status); });
        make.disabled = problems.length > 0 || current().busy;
        const status = h(doc, 'p', 'rpg-wiz-status', current().message);
        status.setAttribute('role', 'status');
        actions.appendChild(status);
        body.appendChild(actions);
    }

    // The character is made but a block the fights need was not: the window stays to say so, and Done closes it.
    function drawFinished() {
        const box = h(doc, 'div', 'rpg-wiz-review');
        const status = h(doc, 'p', 'rpg-wiz-status', current().finished);
        status.setAttribute('role', 'status');
        box.appendChild(status);
        const actions = h(doc, 'div', 'rpg-actions');
        button(actions, W.finish, 'ss-button ss-button-primary rpg-wiz-done', () => { current().handle?.close?.(); });
        body.append(box, actions);
    }
    // Adds what an imported file had besides the character: one `inventory.add` for each thing (the carry limit and the rest of the inventory's
    // rules apply), then the purse raised by the file's money. → the things that could not be added, in plain words ([] when all were).
    async function addImported(file, draftNow, call) {
        const owner = ownerFor(draftNow), failed = [];
        for (const item of file.items ?? []) {
            const added = await call('inventory.add', { name: item.name, qty: item.qty, owner, starting: true, ...(item.note ? { note: item.note } : {}),
                ...(item.kind ? { kind: item.kind } : {}), ...(item.rarity ? { rarity: item.rarity } : {}),
                ...(item.slot ? { slot: item.slot } : {}), ...(item.stats ? { stats: item.stats } : {}) });
            if (!added.ok) failed.push(fill(W.notAdded, { what: `${item.name}${item.qty === 1 ? '' : ` ×${item.qty}`}`, why: refusalText(added, W.generic) }));
        }
        if (file.money > 0) {
            const purse = safe(() => api?.query?.('inventory.wallet', { owner: 'party' }), null)?.coin;
            const set = await call('wallet.set', { owner: 'party', amount: (Number.isSafeInteger(purse) ? purse : 0) + file.money, starting: true });
            if (!set.ok) failed.push(fill(W.moneyNotAdded, { why: refusalText(set, W.generic) }));
        }
        return failed;
    }
    // Create: two defines, the Character first; if the second fails the first is taken back, so nothing is left half made.
    async function create(make, status) {
        const run = current();
        if (run.busy || !isAlive()) return { ok: false };
        const now = snap(), where = world();
        if (problemsOf(now, where).length) return { ok: false };
        if (typeof api?.command !== 'function') { run.message = W.generic; status.textContent = run.message; return { ok: false }; }
        run.busy = true;
        run.message = '';
        make.disabled = true;
        make.textContent = W.creating;
        status.textContent = '';
        const call = async (type, payload) => {
            try { return (await api.command(type, payload)) ?? { ok: false }; } catch (error) { return { ok: false, message: String(error?.message ?? error) }; }
        };
        const definitions = buildDefinitions(now, { used: where.used, cap: safe(levelCap, null) });
        let failure = '';
        const first = await call('dm.define', { definition: definitions.character });
        // Still no state after the host tried to start one (sdk.command): the chat has no message to hold it, said in one plain sentence.
        if (!first.ok) failure = safe(headState, null) ? fill(W.failedFirst, { why: refusalText(first, W.generic) }) : W.noChat;
        else {
            const second = await call('dm.define', { definition: definitions.skills });
            if (!second.ok) {
                const undone = await call('dm.remove', { module: `pack.chat/${definitions.character.slug}` });
                const why = refusalText(second, W.generic);
                failure = undone.ok ? fill(W.failedSecond, { why }) : fill(W.failedBoth, { why, name: definitions.character.name });
            }
        }
        // The blocks the fights need that the story lacks (best effort: the character is made whatever happens here).
        let unadded = [];
        if (!failure) {
            unadded = where.extras.skipped.map(item => ({ role: item.role, why: whyNot([item]) }));
            const used = [...where.used, `pack.chat/${definitions.character.slug}`, `pack.chat/${definitions.skills.slug}`];
            for (const definition of extraDefinitions(where.extras.add, { used })) {
                const made = await call('dm.define', { definition });
                if (!made.ok) unadded.push({ role: definition.role, why: refusalText(made, W.generic) });
            }
        }
        // The things and the money an imported file had (best effort too: the character is made whatever happens here), as more changes of
        // the same reply, so one swipe takes them back with the blocks.
        let notThings = [];
        if (!failure && run.imported) notThings = await addImported(run.imported.file, now, call);
        run.busy = false;
        run.message = failure;
        if (!failure && (unadded.length || notThings.length)) {
            run.created = true;
            const blocks = unadded.length ? fill(W.madeButNot, { name: now.name, list: unadded.map(item => extraName(item.role)).join(', '), why: [...new Set(unadded.map(item => item.why))].join(' '), hint: W.extraHint }) : '';
            const things = notThings.length ? fill(blocks ? W.thingsNotAdded : W.madeButNotThings, { name: now.name, list: notThings.join('; ') }) : '';
            run.finished = [blocks, things].filter(Boolean).join(' ');
            if (isAlive()) redraw();
            return { ok: true };
        }
        if (!failure) { run.created = true; run.handle?.close?.(); return { ok: true }; }
        if (isAlive()) { make.disabled = false; make.textContent = W.create; status.textContent = failure; }
        return { ok: false };
    }

    return { drawReview };
}
