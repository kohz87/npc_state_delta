// The New character wizard's Who step and saved-character import.
export function createWhoStep(ctx) {
    const { api, safe, DEFAULT_CURRENCY, current, draft, put, snap, world, h, doc, W, fill, thingsWord, FILE_LIMITS, RPG_STRINGS,
        parseCharacterFile, sameRun, redraw, withImport, withoutImport, moneyText, button, body, field, input, CREATION, drawSummary,
        LEVEL, levelCap, bandRank, levels, fold } = ctx;
    // ---- Import (the Who step's first row) ----
    const currency = () => safe(() => api?.query?.('inventory.currency'), null) ?? DEFAULT_CURRENCY;
    const importedAdds = () => {
        const file = current().imported?.file;
        return { things: file?.items?.length ?? 0, money: file?.money > 0 ? file.money : 0 };
    };
    // "3 things to the party's bag", or "3 things carried by Ren" only when a party actor of that name will hold them.
    const thingsPhrase = (n, draftNow) => (ownerFor(draftNow) === 'party' ? fill(W.reviewThingsBag, { things: thingsWord(n) }) : fill(W.reviewThings, { things: thingsWord(n), name: draftNow.name }));
    async function importFile(file) {
        const run = current();
        if (!file) return;
        let read;
        if (file.size > FILE_LIMITS.bytes) read = { ok: false, message: RPG_STRINGS.file.tooBig };
        else {
            let text = null;
            try { text = await file.text(); } catch { text = null; }
            read = text === null ? { ok: false, message: fill(RPG_STRINGS.file.unreadable, { name: String(file.name ?? '') }) } : parseCharacterFile(text);
        }
        // The window may have closed, or another run begun, while the file was read.
        if (!sameRun(run)) return;
        if (!read.ok) { run.importError = read.message; redraw(); return; }
        const made = withImport(run.draft, read.file);
        run.draft = made.draft;
        run.imported = { file: read.file, fileName: String(file.name ?? ''), before: made.before };
        run.importError = '';
        redraw();
    }
    function undoImport() {
        const run = current();
        if (!run.imported) return;
        run.draft = withoutImport(run.draft, run.imported.before);
        run.imported = null;
        run.importError = '';
        redraw();
    }
    function drawImport() {
        const run = current();
        if (run.imported) {
            const { file, fileName } = run.imported;
            const box = h(doc, 'div', 'rpg-import-done');
            box.setAttribute('role', 'status');
            box.setAttribute('data-wiz', 'import-done');
            const points = file.points === 0 ? W.importNoPoints : fill(file.points === 1 ? W.importPointsOne : W.importPoints, { n: file.points });
            const skills = file.skills.length === 0 ? W.importNoSkills : fill(file.skills.length === 1 ? W.importSkillsOne : W.importSkills, { n: file.skills.length });
            const adds = importedAdds();
            const list = [adds.things ? thingsPhrase(adds.things, snap()) : '', adds.money ? fill(W.importMoney, { amount: moneyText(adds.money, currency()) }) : ''].filter(Boolean).join(' and ');
            box.appendChild(h(doc, 'span', 'rpg-import-text', [fill(W.importDone, { file: fileName, points, level: file.level ?? 1, skills }),
                list ? fill(W.importAdds, { list }) : '', W.importName].filter(Boolean).join(' ')));
            button(box, W.importUndo, 'ss-button rpg-import-undo', undoImport);
            body.appendChild(box);
            return;
        }
        const row = h(doc, 'div', 'rpg-import');
        row.setAttribute('data-wiz', 'import');
        row.appendChild(h(doc, 'span', 'rpg-import-text', W.importText));
        const input = h(doc, 'input', 'rpg-import-file');
        input.setAttribute('type', 'file');
        input.setAttribute('accept', '.json,application/json');
        input.setAttribute('aria-label', W.importLabel);
        input.hidden = true;
        input.addEventListener('change', () => { const picked = input.files?.[0]; importFile(picked); });
        button(row, W.importButton, 'ss-button rpg-import-pick', () => input.click());
        row.append(input);
        body.appendChild(row);
        if (run.importError) {
            const problem = h(doc, 'p', 'rpg-import-error', run.importError);
            problem.setAttribute('role', 'alert');
            body.appendChild(problem);
        }
    }
    // ---- Who ----
    function drawWho() {
        drawImport();
        const now = world(), form = h(doc, 'div', 'rpg-wiz-form');
        body.appendChild(form);
        const name = field(form, W.name, input(draft().name, CREATION.name), h(doc, 'span', 'rpg-wiz-note', draft().kind === 'you' ? W.nameHint : W.nameHintOther));
        name.setAttribute('data-wiz', 'name');
        name.addEventListener('input', () => { put({ ...draft(), name: name.value }); drawSummary(); });
        // The starting level (the draft's `level`, 1 to the story's level cap, 99 unset): a new character's, a companion's or an imported one's. 1 is the default and is not stored.
        const level = h(doc, 'input', 'rpg-wiz-input rpg-wiz-level');
        level.setAttribute('type', 'number');
        level.setAttribute('min', '1');
        const capNow = () => Math.max(1, Math.min(LEVEL.max, Number.isSafeInteger(safe(levelCap, null)) ? levelCap() : LEVEL.max));
        level.setAttribute('max', String(capNow()));
        level.setAttribute('step', '1');
        level.setAttribute('inputmode', 'numeric');
        level.setAttribute('data-wiz', 'level');
        level.value = String(draft().level ?? 1);
        const levelHelp = h(doc, 'span', 'rpg-wiz-note', '');
        let startNote = null;
        const startText = () => (current().imported ? fill(W.whoNoteImported, { level: snap().level ?? 1 }) : fill(draft().level > 1 ? W.whoNoteSoul : W.whoNote, { level: snap().level ?? 1 }));
        const levelNote = n => { const rank = bandRank(n, safe(levels, {})?.ranks); levelHelp.textContent = fill(W.startingLevelHelp, { rank: rank ? fill(W.startingLevelRank, { name: rank.name, from: rank.from, to: rank.to }) : '' }); };
        levelNote(draft().level ?? 1);
        const setLevel = (typed, settle) => {
            const n = Number(String(typed).trim());
            const next = Number.isFinite(n) && String(typed).trim() !== '' ? Math.min(capNow(), Math.max(1, Math.round(n))) : null;
            if (next === null) { if (settle) level.value = String(draft().level ?? 1); return; }
            if (settle) level.value = String(next);
            const { level: _was, ...rest } = draft();
            put(next > 1 ? { ...rest, level: next } : rest);
            levelNote(next);
            drawSummary();
            if (startNote) startNote.textContent = startText();
        };
        level.addEventListener('input', () => setLevel(level.value, false));
        level.addEventListener('change', () => { setLevel(level.value, true); redraw(); });
        field(form, W.startingLevel, level, levelHelp);
        const kind = h(doc, 'div', 'rpg-wiz-kind');
        kind.appendChild(h(doc, 'div', 'rpg-wiz-field-label', W.is));
        const seg = h(doc, 'div', 'rpg-wiz-seg');
        kind.appendChild(seg);
        form.appendChild(kind);
        const choose = to => {
            const was = draft();
            let next = { ...was, kind: to };
            if (to === 'you' && now.persona) next = { ...next, name: now.persona };
            else if (to === 'companion' && now.persona && fold(was.name) === fold(now.persona)) next = { ...next, name: '' };
            // The persona's description goes with You: into an empty box on You, and out again on a companion while it is still untouched.
            const from = current().about;
            if (to === 'you' && from && !was.about) next = { ...next, about: from };
            else if (to === 'companion' && from && fold(was.about) === fold(from)) next = { ...next, about: '' };
            put(next);
            drawSummary();
            redraw();
        };
        for (const [value, label] of [['you', W.isYou], ['companion', W.isCompanion]]) {
            const node = button(seg, label, `ss-button rpg-wiz-kind-${value}${draft().kind === value ? ' ss-button-primary' : ''}`, () => { if (!node.disabled) choose(value); });
            node.setAttribute('aria-pressed', String(draft().kind === value));
            node.setAttribute('data-kind', value);
            if (value === 'you' && now.hasYou) { node.disabled = true; node.setAttribute('title', W.youTaken); }
        }
        if (now.hasYou) kind.appendChild(h(doc, 'span', 'rpg-wiz-note', W.youTaken));
        const about = h(doc, 'textarea', 'rpg-wiz-input');
        about.setAttribute('rows', '4');
        about.setAttribute('maxlength', String(CREATION.about));
        about.setAttribute('data-wiz', 'about');
        about.value = draft().about;
        const count = h(doc, 'span', 'rpg-wiz-count', fill(W.aboutCount, { n: [...draft().about].length, max: CREATION.about }));
        field(form, W.about, about, count);
        // Where the text came from, while it is still the persona's (a note under the box; typing over it takes the note away).
        const fromPersona = h(doc, 'p', 'rpg-wiz-note rpg-wiz-persona', W.aboutPersona);
        fromPersona.setAttribute('data-wiz', 'persona-note');
        const showPersona = () => { fromPersona.hidden = !(draft().kind === 'you' && current().about && fold(draft().about) === fold(current().about)); };
        showPersona();
        about.addEventListener('input', () => { put({ ...draft(), about: about.value }); count.textContent = fill(W.aboutCount, { n: [...about.value].length, max: CREATION.about }); showPersona(); });
        form.appendChild(fromPersona);
        startNote = h(doc, 'p', 'rpg-wiz-note', startText());
        form.appendChild(startNote);
    }
    // Who holds the things an imported character carries: the party's actor of that name when a party module lists one, else the party's bag
    // (a You always carries in the bag).
    function ownerFor(draftNow) {
        if (draftNow.kind === 'you') return 'party';
        const actors = safe(() => api?.query?.('party.actors'), []);
        const found = (Array.isArray(actors) ? actors : []).find(actor => typeof actor?.id === 'string' && fold(actor.name) === fold(draftNow.name));
        return found?.id ?? 'party';
    }

    return { drawWho, drawImport, currency, importedAdds, thingsPhrase, ownerFor };
}
