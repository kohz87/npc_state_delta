// Settings → RPG (mockup section 6): a page of its own in the rail under Features, shown while the feature `story-block.rpg`
// is on. Six cards:
//   Formula     Standard / Classic (`rpgFormula`): the roll table and the four numbers of the formula in force
//   Rolls       Automatic / Off (`rpgRolls`, ROLLS_SETTING in lean-rpg/names.js)
//   Difficulty  Gentle / Standard / Harsh / Custom (`rpgDifficulty`), the Custom numbers of the formula (`rpgCustom`: Classic's six;
//               `rpgStandard`: Standard's thirteen) and the exact odds for the reader's own character under the numbers chosen, drawn
//               again as they change
//   Combat      the chat's Combat rules block's text (≤1200), saved as an edit of that block's definition, with Reset to the default
//   Planner     the reader's own instructions for the roll planner (`rpgPlannerNote`, ≤400) and the planner's full prompt, read-only
//   Companions  who join: Ask (the default) / Automatically / Off (`rpgJoin`, JOIN_SETTING): what the story's `+ party` line does (join.js)
// The numbers are only *chosen* here: a roll takes the numbers in force when it is planned and records them (rules.js), so
// nothing on this page can change a roll already made. Every node is built with createElement and textContent.

import { h } from '../../view/widgets/dom.js';
import { refusalText } from '../../strings.js';
import { LEAN_RPG_TEMPLATES } from '../templates.js';
import { JOIN_SETTING, ROLLS_SETTING } from '../names.js';
import { joinMode } from '../join.js';
import { packInForce, CUSTOM_SETTING, DIFFICULTIES, DIFFICULTY_SETTING, FORMULA_SETTING, NOTE_MAX, NOTE_SETTING, PRESETS, RULE_RANGES, STANDARD_RANGES, STANDARD_SETTING, STAT_ABOVE, difficultyOf, formulaOf, isStandard, normalizeRules, normalizeStandard, plannerNoteOf, rulesFromSettings } from '../rules.js';
import { CREATION } from '../names.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { COMBAT_MAX, combatBlock, combatDefault, combatTemplate, customOf, oddsView, plannerPrompt, soulLabelFor, withPrompt } from './settings-data.js';
import { SOUL_LABEL } from '../soul.js';
import { oneLine } from '../../../text.js';

const S = RPG_STRINGS.settings;
export const ROLLS_DEFAULT = 'automatic';
// (Classic's Character template gives 3 points with a Soul Class rise: templates.js.)
const CLASSIC_POINTS_PER_SOUL = 3;
/** The setting's key (the rolls piece's ROLLS_SETTING). */
export const ROLLS_KEY = ROLLS_SETTING;
export const SETTINGS_MODULE = 'story-block';
/** The rail entry and page id of the section. */
export const SECTION_ID = 'rpg';

/** The reader's choice: 'automatic' or 'off'. */
export const rollsOf = settings => (settings?.(SETTINGS_MODULE)?.[ROLLS_KEY] === 'off' ? 'off' : ROLLS_DEFAULT);

/** The section record the settings window adds after Features (window.js `extraSections`). `body(pane, ctx)` draws the page. */
export function rpgSection({ featureOn = () => true, ...deps } = {}) {
    return Object.freeze({
        id: SECTION_ID, label: S.title, icon: 'fa-dice-d20', title: S.title, sub: S.sub, after: 'features', visible: () => featureOn(),
        body: (pane, ctx) => renderRpgSettings(pane, { settings: ctx.options.settings, doc: ctx.doc, featureOn, onChange: () => ctx.changed?.(), ...deps }),
    });
}

const NUMBER_FIELDS = Object.freeze([
    Object.freeze({ key: 'foeBase', label: S.foeBase, help: S.foeBaseHelp }),
    Object.freeze({ key: 'classWeight', label: S.classWeight, help: S.classWeightHelp, options: Object.freeze([[1, '×1'], [2, '×2'], [3, '×3']]) }),
    Object.freeze({ key: 'statDivisor', label: S.statDivisor, help: S.statDivisorHelp, options: Object.freeze([[2, S.statHalf], [3, S.statThird], [STAT_ABOVE, S.statAbove]]) }),
    Object.freeze({ key: 'costMargin', label: S.costMargin, help: S.costMarginHelp }),
    Object.freeze({ key: 'decisiveMargin', label: S.decisiveMargin, help: S.decisiveMarginHelp }),
    Object.freeze({ key: 'roundCap', label: S.roundCap, help: S.roundCapHelp }),
]);

// Standard's Custom numbers: the roll's, then creation's.
const STANDARD_FIELDS = Object.freeze([
    Object.freeze({ key: 'foeBase', label: S.foeBase, help: S.foeBaseHelpStandard }),
    Object.freeze({ key: 'foeClassWeight', label: S.foeClassWeight, help: S.foeClassWeightHelp }),
    Object.freeze({ key: 'classWeight', label: S.classWeight, help: S.classWeightHelp, options: Object.freeze([[1, '×1'], [2, '×2'], [3, '×3']]) }),
    Object.freeze({ key: 'costMargin', label: S.costMargin, help: S.costMarginHelp }),
    Object.freeze({ key: 'decisiveMargin', label: S.decisiveMargin, help: S.decisiveMarginHelp }),
    Object.freeze({ key: 'roundCap', label: S.roundCap, help: S.roundCapHelp }),
    Object.freeze({ key: 'quickStartMargin', label: S.quickStartMargin, help: S.quickStartMarginHelp }),
    Object.freeze({ key: 'startStat', label: S.startStat, help: S.startStatHelp }),
    Object.freeze({ key: 'createPoints', label: S.createPoints, help: S.createPointsHelp }),
    Object.freeze({ key: 'createMin', label: S.createMin, help: S.createMinHelp }),
    Object.freeze({ key: 'createMax', label: S.createMax, help: S.createMaxHelp }),
    Object.freeze({ key: 'pointsPerSoul', label: S.pointsPerSoul, help: S.pointsPerSoulHelp }),
    Object.freeze({ key: 'statMax', label: S.statMax, help: S.statMaxHelp }),
]);

const words = (...parts) => parts.join(' ').toLowerCase();
const CARD_WORDS = Object.freeze({
    formula: words(S.formula, S.formulaStandard, S.formulaClassic, S.formulaStandardHelp, S.formulaClassicHelp, S.formulaNote, S.formulaRows.map(row => `${row.type} ${row.what}`).join(' '), Object.values(S.formulaNums).join(' '), S.formulaFootStandard),
    rolls: words(S.rolls, S.rollsHelp, S.automatic, S.off),
    difficulty: words(S.difficulty, S.gentle, S.standard, S.harsh, S.custom, [...NUMBER_FIELDS, ...STANDARD_FIELDS].map(field => `${fill(field.label, { label: SOUL_LABEL })} ${field.help}`).join(' '), S.replayNote),
    combat: words(S.combat, S.combatHelp, S.combatLabel, S.combatReset),
    planner: words(S.planner, S.plannerHelp, S.plannerShow, S.plannerFixed),
    join: words(S.join, S.joinHelp, S.joinAsk, S.joinAuto, S.joinOff),
});

/**
 * Draws the page into `parent`. Options: `settings` (the store: `settings(id)`, `settings.set(id, key, value)`), `doc`,
 * `featureOn()`, `onChange()` (another page draws something that depends on a setting here), `headState()` (the story's head
 * state), `readerName()` (the persona's name), `roleOf(definition)` (what a block is read as), `command(type, payload)` (the
 * host's commands: the Combat rules text is saved with `dm.redefine`, and added with `dm.define`).
 * → { el, filter(text) → count, refresh(), refreshSize(), destroy() }, as a settings page body expects.
 */
export function renderRpgSettings(parent, { settings, doc = parent.ownerDocument ?? globalThis.document, featureOn = () => true, onChange = () => {}, headState = () => null, readerName = () => '', roleOf, command = null, pack = () => null } = {}) {
    const root = h(doc, 'div', 'rpg-set');
    parent.appendChild(root);
    const values = () => settings(SETTINGS_MODULE) ?? {};
    const put = (key, value) => { settings.set(SETTINGS_MODULE, key, value); onChange(); };
    const cards = {};
    let alive = true, combatNote = '', oddsParts = null, previewParts = null, combatShown = null, flushCombat = null;
    // The Combat text's saves go one at a time: `asked` is the text last asked for (until its save is done), `inFlight` the saves so far.
    let asked = null, inFlight = Promise.resolve();
    // The page going out of sight (a tab switch, the window closing) keeps what was typed in the Combat box.
    const hidden = () => { if (doc.visibilityState === 'hidden') flush(); };
    const flush = () => { try { flushCombat?.(); } catch { /* the box is saved when it is next left */ } };
    doc.addEventListener?.('visibilitychange', hidden);
    doc.defaultView?.addEventListener?.('pagehide', flush);

    // ---- small builders
    function card(key, title, help) {
        const node = h(doc, 'section', 'rpg-set-card');
        node.setAttribute('data-card', key);
        node.appendChild(h(doc, 'h4', 'rpg-set-title', title));
        if (help) node.appendChild(h(doc, 'p', 'rpg-set-help', help));
        cards[key] = node;
        root.appendChild(node);
        return node;
    }
    function chips(parent, label, options, value, pick) {
        const row = h(doc, 'div', 'rpg-set-chips');
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', label);
        for (const [id, text] of options) {
            const chip = h(doc, 'button', 'rpg-chip', text);
            chip.setAttribute('type', 'button');
            chip.setAttribute('data-value', id);
            chip.setAttribute('aria-pressed', String(id === value));
            chip.addEventListener('click', () => { if (id !== value) { pick(id); redraw(`[data-card="${parent.getAttribute('data-card')}"] [data-value="${id}"]`); } });
            row.appendChild(chip);
        }
        parent.appendChild(row);
    }
    const field = (parent, label, help) => {
        const wrap = h(doc, 'label', 'rpg-set-num');
        wrap.appendChild(h(doc, 'span', '', label));
        parent.appendChild(wrap);
        return { add: node => { wrap.appendChild(node); wrap.appendChild(h(doc, 'small', '', help)); return node; } };
    };

    // "From the pack: Ersveil" when the story's pack decides the formula or the numbers (the reader has chosen nothing there).
    const packNote = (...which) => {
        const given = pack(), live = packInForce(values(), given);
        return given && which.some(key => live[key]) ? h(doc, 'p', 'rpg-set-help rpg-from-pack', fill(S.fromPack, { name: given.name || given.pack || '' })) : null;
    };

    // ---- The stat formula: which one, how its rolls are made, and its four main numbers
    function drawFormula() {
        const now = formulaOf(values(), pack());
        const rules = rulesFromSettings(values(), pack()), soulLabel = soulLabelFor(headState(), readerName());
        const box = card('formula', S.formula);
        chips(box, S.formula, [['standard', S.formulaStandard], ['classic', S.formulaClassic]], now, value => put(FORMULA_SETTING, value));
        const fromPack = packNote('formula', 'numbers');
        if (fromPack) box.appendChild(fromPack);
        box.appendChild(h(doc, 'p', 'rpg-set-help', now === 'standard' ? S.formulaStandardHelp : S.formulaClassicHelp));
        const table = h(doc, 'table', 'rpg-formula-table');
        table.setAttribute('data-formula', now);
        const body = h(doc, 'tbody');
        for (const row of now === 'standard' ? S.formulaRows : S.formulaClassicRows) {
            const tr = h(doc, 'tr');
            tr.append(h(doc, 'th', '', row.type), h(doc, 'td', '', row.what));
            body.appendChild(tr);
        }
        table.appendChild(body);
        const scroll = h(doc, 'div', 'rpg-formula-scroll');
        scroll.appendChild(table);
        box.appendChild(scroll);
        const standard = isStandard(rules);
        const tiles = standard
            ? [[rules.startStat, S.formulaNums.start], [rules.createPoints, S.formulaNums.points], [rules.pointsPerSoul, fill(S.formulaNums.perSoul, { label: soulLabel })], [fill(S.formulaFoe, { base: rules.foeBase, weight: rules.foeClassWeight }), S.formulaNums.foe]]
            : [[CREATION.start, S.formulaNums.start], [CREATION.budget, S.formulaNums.points], [CLASSIC_POINTS_PER_SOUL, fill(S.formulaNums.perSoul, { label: soulLabel })], [fill(S.formulaFoeClassic, { base: rules.foeBase, weight: rules.classWeight }), S.formulaNums.foe]];
        const nums = h(doc, 'div', 'rpg-formula-nums');
        for (const [value, label] of tiles) {
            const tile = h(doc, 'div', 'rpg-formula-num');
            tile.append(h(doc, 'b', '', String(value)), h(doc, 'span', '', label));
            nums.appendChild(tile);
        }
        box.appendChild(nums);
        box.appendChild(h(doc, 'p', 'rpg-set-help', fill(standard ? S.formulaFootStandard : S.formulaFootClassic, { weight: rules.classWeight, label: soulLabel })));
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.formulaNote));
    }

    // ---- Rolls
    function drawRolls() {
        const box = card('rolls', S.rolls);
        chips(box, S.rolls, [['automatic', S.automatic], ['off', S.off]], rollsOf(settings), value => put(ROLLS_KEY, value));
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.rollsHelp));
    }

    // ---- Companions who join
    function drawJoin() {
        const box = card('join', S.join);
        chips(box, S.join, [['ask', S.joinAsk], ['auto', S.joinAuto], ['off', S.joinOff]], joinMode(values()), value => put(JOIN_SETTING, value));
        box.appendChild(h(doc, 'p', 'rpg-set-help', S.joinHelp));
    }

    // ---- Difficulty and the odds
    function drawDifficulty() {
        const box = card('difficulty', S.difficulty);
        const now = difficultyOf(values());
        // Each formula keeps its own Custom numbers (Classic's six, Standard's thirteen).
        const standard = formulaOf(values(), pack()) === 'standard';
        const customKey = standard ? STANDARD_SETTING : CUSTOM_SETTING, fields = standard ? STANDARD_FIELDS : NUMBER_FIELDS, ranges = standard ? STANDARD_RANGES : RULE_RANGES;
        chips(box, S.difficulty, DIFFICULTIES.map(name => [name, S[name]]), now, value => {
            // A first switch to Custom starts from the numbers in force, so nothing jumps.
            if (value === 'custom' && !values()[customKey]) settings.set(SETTINGS_MODULE, customKey, customOf(values(), pack()));
            put(DIFFICULTY_SETTING, value);
        });
        const numbersFromPack = packNote('numbers');
        if (numbersFromPack) box.appendChild(numbersFromPack);
        if (now === 'custom') {
            const grid = h(doc, 'div', 'rpg-set-nums');
            const custom = customOf(values(), pack());
            const soulLabel = soulLabelFor(headState(), readerName());
            for (const entry of fields) {
                const label = fill(entry.label, { label: soulLabel });
                const range = ranges[entry.key], slot = field(grid, label, entry.help);
                let input;
                if (entry.options) {
                    input = doc.createElement('select');
                    for (const [value, text] of entry.options) {
                        const option = doc.createElement('option');
                        option.value = String(value);
                        option.textContent = text;
                        input.appendChild(option);
                    }
                    input.value = String(custom[entry.key]);
                } else {
                    input = doc.createElement('input');
                    input.setAttribute('type', 'number');
                    input.setAttribute('min', String(range.min));
                    input.setAttribute('max', String(range.max));
                    input.setAttribute('step', '1');
                    input.setAttribute('inputmode', 'numeric');
                    input.value = String(custom[entry.key]);
                }
                input.setAttribute('data-rule', entry.key);
                input.setAttribute('aria-label', label);
                input.className = 'rpg-set-input';
                input.addEventListener('change', () => {
                    const have = customOf(values(), pack()), typed = Number(String(input.value).trim());
                    // A number outside its range is held to it; something that is not a number is put back.
                    // (A choice is one of its options, kept as it is.)
                    const next = entry.options ? (entry.options.some(([value]) => value === typed) ? typed : have[entry.key])
                        : Number.isFinite(typed) && String(input.value).trim() !== '' ? Math.min(range.max, Math.max(range.min, Math.round(typed))) : have[entry.key];
                    input.value = String(next);
                    put(customKey, standard ? normalizeStandard({ ...have, [entry.key]: next }) : normalizeRules({ ...have, [entry.key]: next }));
                    live();
                });
                slot.add(input);
            }
            box.appendChild(grid);
        }
        const odds = h(doc, 'div', 'rpg-odds');
        const title = h(doc, 'b', 'rpg-odds-title'), bar = h(doc, 'div', 'rpg-odds-bar'), legend = h(doc, 'div', 'rpg-odds-legend');
        bar.setAttribute('role', 'img');
        const spans = ['success', 'cost', 'fail'].map(kind => {
            const piece = h(doc, 'span', `rpg-odds-${kind}`);
            bar.appendChild(piece);
            const key = h(doc, 'span', 'rpg-odds-key');
            key.appendChild(h(doc, 'i', `rpg-odds-${kind}`));
            const text = doc.createTextNode('');
            key.appendChild(text);
            legend.appendChild(key);
            return { kind, piece, text };
        });
        odds.append(title, bar, legend);
        const compare = h(doc, 'p', 'rpg-set-help rpg-odds-compare');
        box.append(odds, compare, h(doc, 'p', 'rpg-set-help', S.replayNote));
        oddsParts = { odds, title, bar, spans, compare };
    }
    function drawOdds() {
        const parts = oddsParts;
        if (!parts) return;
        const view = oddsView(headState(), readerName(), rulesFromSettings(values(), pack()));
        parts.odds.hidden = !view;
        parts.compare.hidden = !view;
        if (!view) return;
        parts.title.textContent = view.label;
        parts.bar.setAttribute('aria-label', fill(S.oddsLabel, view.now));
        for (const { kind, piece, text } of parts.spans) {
            piece.style.setProperty('--rpg-odds', String(view.now[kind]));
            text.textContent = fill(S[kind], { n: view.now[kind] });
        }
        parts.compare.textContent = fill(S.compare, { list: view.compare.map(item => fill(S.compareItem, { ...item, name: S[item.name] })).join(' · ') });
    }

    // ---- The Combat rules text
    function drawCombat() {
        const box = card('combat', S.combat, S.combatHelp);
        const block = combatBlock(headState(), { roleOf });
        flushCombat = null;
        combatShown = block ? `${block.module}\n${block.prompt}` : '';
        if (!block) {
            box.appendChild(h(doc, 'p', 'rpg-set-help rpg-combat-none', S.combatNone));
            if (typeof command === 'function') {
                const add = h(doc, 'button', 'ss-button rpg-set-button', S.combatAdd);
                add.setAttribute('type', 'button');
                add.setAttribute('data-act', 'combat-add');
                add.addEventListener('click', async () => {
                    const definition = combatTemplate(LEAN_RPG_TEMPLATES, formulaOf(values(), pack()));
                    const result = definition ? await command('dm.define', { definition }) : null;
                    combatNote = result?.ok ? S.combatAdded : refusalText(result, S.combatFailed, { pinsFull: S.combatPinsFull });
                    if (alive) redraw('[data-act="combat-add"]');
                });
                box.appendChild(add);
            }
        } else {
            const area = doc.createElement('textarea');
            area.className = 'rpg-set-area';
            area.setAttribute('rows', '9');
            area.setAttribute('aria-label', S.combatLabel);
            area.setAttribute('data-field', 'combat');
            area.value = block.prompt;
            const row = h(doc, 'div', 'rpg-set-row');
            const reset = h(doc, 'button', 'ss-button rpg-set-button', S.combatReset);
            reset.setAttribute('type', 'button');
            reset.setAttribute('data-act', 'combat-reset');
            const count = h(doc, 'span', 'rpg-set-count');
            const status = h(doc, 'p', 'rpg-set-help rpg-set-status', combatNote);
            status.setAttribute('role', 'status');
            const tally = () => {
                const n = [...oneLine(area.value)].length;
                count.textContent = fill(S.combatCount, { n, max: COMBAT_MAX });
                count.classList.toggle('rpg-over', n > COMBAT_MAX);
                return n;
            };
            // Saved when the box is left (not on every key: each save is an edit of the block on the latest reply), and when the
            // window closes or the page is hidden while the box still has what was typed (no `change` comes when a box is taken away).
            // A save waits for the one in flight, and what is asked is compared with the last text asked for, not with the block as it
            // stands (which only changes when a save is done), so the last thing the reader did is what is kept.
            async function write(text) {
                let result;
                try {
                    if (text === block.prompt) return;
                    result = await command('dm.redefine', { module: block.module, definition: withPrompt(block.definition, text) });
                } finally { if (asked === text) asked = null; }
                combatNote = result?.ok ? S.combatSaved : refusalText(result, S.combatFailed, { pinsFull: S.combatPinsFull });
                // The box may have been drawn again while the command ran (the story moved): the note goes on the one that is there now.
                const shown = root.querySelector('.rpg-set-status');
                if (shown) shown.textContent = combatNote;
                if (result?.ok) { block.prompt = text; combatShown = `${block.module}\n${text}`; onChange(); }
            }
            function save() {
                const text = oneLine(area.value);
                if (text === (asked ?? block.prompt) || typeof command !== 'function') return inFlight;
                if (tally() > COMBAT_MAX) { combatNote = fill(S.combatTooLong, { max: COMBAT_MAX }); status.textContent = combatNote; return inFlight; }
                asked = text;
                const run = inFlight.then(() => write(text));
                inFlight = run.catch(() => {});
                return run;
            }
            flushCombat = save;
            area.addEventListener('input', tally);
            area.addEventListener('change', save);
            area.addEventListener('focusout', save);
            reset.addEventListener('click', () => { area.value = combatDefault(formulaOf(values(), pack())); tally(); save(); });
            row.append(reset, count);
            box.append(area, row, status);
            tally();
        }
    }

    // ---- The roll planner's note and prompt
    function drawPlanner() {
        const box = card('planner', S.planner, S.plannerHelp);
        const area = doc.createElement('textarea');
        area.className = 'rpg-set-area';
        area.setAttribute('rows', '3');
        area.setAttribute('maxlength', String(NOTE_MAX));
        area.setAttribute('aria-label', S.plannerLabel);
        area.setAttribute('data-field', 'planner');
        area.value = plannerNoteOf(values());
        const count = h(doc, 'span', 'rpg-set-count');
        const row = h(doc, 'div', 'rpg-set-row');
        row.appendChild(count);
        const fold = h(doc, 'details', 'rpg-set-fold');
        fold.appendChild(h(doc, 'summary', '', S.plannerShow));
        const pre = h(doc, 'pre', 'rpg-set-pre');
        fold.append(pre, h(doc, 'p', 'rpg-set-help', S.plannerFixed));
        previewParts = { area, count, pre };
        // Kept as it is typed (a short text, saved with the rest of the settings), so the prompt below is always the real one.
        area.addEventListener('input', () => {
            const text = plannerNoteOf({ [NOTE_SETTING]: area.value });
            put(NOTE_SETTING, text);
            drawPreview();
        });
        box.append(area, row, fold);
        drawPreview();
    }
    function drawPreview() {
        if (!previewParts) return;
        const note = plannerNoteOf(values());
        previewParts.count.textContent = fill(S.plannerCount, { n: [...previewParts.area.value].slice(0, NOTE_MAX).length, max: NOTE_MAX });
        previewParts.pre.textContent = plannerPrompt(headState(), note, { standard: formulaOf(values(), pack()) === 'standard' });
    }

    // ---- drawing
    function draw() {
        for (const node of Object.values(cards)) node.remove();
        for (const key of Object.keys(cards)) delete cards[key];
        drawFormula();
        drawRolls();
        drawDifficulty();
        drawCombat();
        drawPlanner();
        drawJoin();
        live();
        place();
    }
    // The parts that follow the story and the numbers without rebuilding a box the reader may be typing in.
    function live() {
        // (the Stat formula card shows the numbers in force, so it is drawn again in its place when they change)
        const old = cards.formula;
        if (old && !old.hidden) { drawFormula(); root.insertBefore(cards.formula, old); old.remove(); }
        drawOdds();
        drawPreview();
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
            if ((block ? `${block.module}\n${block.prompt}` : '') !== combatShown && !typing()) redraw();
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
