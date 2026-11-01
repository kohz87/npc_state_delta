// The New character wizard (mockup section 4): Story Block's own dialog (`width: 'wide'`) with four steps, Who · Stats · Skills ·
// Review, and a summary row of the character so far on top of each. It is opened from the Party tab ("+ New character", and
// "Create your character" when there is none, and the Home card and the first-send dialog, start.js). `open(prefill, { onEnd })` opens it with a
// companion's name, about, Soul Class and best stat filled in (the card under a reply that asks to add someone, join.js), and `onEnd(created)`
// hears whether Create made the character or the dialog was closed without.
//   Who     the name and who they are (the persona's name and description by default, for You), You or A companion (one You to a story)
//   Stats   the Spend points view's steppers and radar, under the creation budget (names.js CREATION)
//   Skills  skill sets (built in, and a pack's `content.rpg.skillSets`) and up to five rows: name, what it does, Stat, Uses,
//           Starts at (Novice; Adept for at most one skill). Rank and practice are never typed.
//   Review  everything; Create makes the Character block and the Skills block with ONE `dm.define` each, the wizard's values
//           written as the new definitions' field defaults (wizard-data.js buildDefinitions): no `dm.set`, so a skill's rank stays a
//           field only play can move, and the reply's budget is spent twice. If the second define fails the first block is removed
//           again: nothing is left half made. When the chat has no Combat rules block and/or no Foes block, Create also defines the missing
//           ones from the stock templates (one more define each, after the character, so one swipe takes everything back); if they do not
//           fit (the block limit, the reply's actions) or one is refused, the character stays and the dialog says which block was not added.
//   Import  the Who step starts with "Start from a saved character … Import file…" (charfile.js): a good file fills the stats, the unspent points,
//           the Soul Class and the skills with their ranks (the Stats and Skills steps show them and keep the usual rules; the ranks stay the
//           file's), and never the name, You or a companion, or who they are. Undo import puts back what was there. Create then also adds, as more
//           changes of the same reply, the things the file had (`inventory.add`, one for each, to the character's owner) and its money
//           (`wallet.set`, the purse plus the file's); whatever cannot be added is named in the window and the character is still made.
// The draft lives here, in the wizard's session (the dialog's own draft is not used); each step is a widget of this file drawing from
// it, so Back and Next keep what was typed. Every node is built with createElement and textContent.

import { DM_LIMITS } from '../../data-modules/schema.js';
import { h, shell } from '../../view/widgets/dom.js';
import { radar } from '../../view/widgets/radar.js';
import { stepper } from '../../view/widgets/stepper.js';
import { refusalText } from '../../strings.js';
import { DEFAULT_CURRENCY } from '../../domains/money.js';
import { FILE_LIMITS, moneyText, parseCharacterFile, skillLine, thingsWord } from '../charfile.js';
import { CREATION, RANK_NAMES, SKILL_SLOTS, STATS, USES } from '../names.js';
import { fold } from '../read.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { readParty } from './party-data.js';
import { joinDraft } from '../join.js';
import { growthOf } from '../blocks.js';
import { growthText } from './party-data.js';
import { WIZARD_STEPS, actionsFree, blockNames, buildDefinitions, draftCreation, extraDefinitions, extraName, extrasPlan, hasRoom, mayStartAdept, newDraft, newSoul, pointsLeft, problemsOf, rankOf, readDraft, setLine, skillSetsOf,
    START_RANKS, startStats, statBounds, statsLine, withImport, withoutImport, withSet, withSkill, withSkillPatch, withoutSkill } from './wizard-data.js';

const W = RPG_STRINGS.wizard;
// What the characters the wizard makes call their Soul Class (the Character template's own label and names).
const soulWords = newSoul();
export const WIZARD_SCREEN_ID = 'story-block/new-character';
export const WIZARD_WIDGET = 'rpg.wizard';

const cap = word => (word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : '');

/** The wizard's dialog: four steps, each one the wizard widget drawing that step. */
export function createWizardScreen() {
    const template = step => `<ss-widget name="${WIZARD_WIDGET}" data-props='{"step":"${step}"}'></ss-widget>`;
    return Object.freeze({
        id: WIZARD_SCREEN_ID, title: W.title, icon: 'fa-user-plus', mounts: Object.freeze(['dialog']), width: 'wide',
        template: template(WIZARD_STEPS[0]),
        steps: Object.freeze(WIZARD_STEPS.map(id => Object.freeze({ id, title: W.steps[id], template: template(id) }))),
    });
}

// What the story has now that the wizard needs: the persona's name, the characters' names, whether one is already you, room for two blocks.
function worldOf(state, persona, roleOf, replyKey = '') {
    const party = readParty(state, { own: persona, roleOf });
    const free = actionsFree(state, replyKey);
    return { persona, names: party.map(character => character.name), hasYou: party.some(character => character.own), room: hasRoom(state), free, extras: extrasPlan(state, { roleOf, free }),
        used: Object.keys(state?.domains?.dataModules?.active ?? {}) };
}

const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };

/**
 * The wizard. `deps`: `headState()` (the head state or null), `readerName()` (the persona's name), `roleOf(definition)`, `openDialog(id,
 * { draft, onClose })` (the host's dialog mount; without it there is no way to open), `replyKey()` (the head reply's key in the blocks' per-reply
 * count, `${sid}/${swipeKey}`: Create asks the reply for three block actions before it starts), `readerAbout()` (the active persona's description,
 * which a You starts with as Who they are). → { screen, widget, open(prefill?, { onEnd }?), session(), destroy() }.
 * `open()` opens the dialog on a fresh draft; the session is dropped when the dialog closes. `prefill` is { name, about, soul, best }: a companion
 * the story brought in (join.js joinDraft); `onEnd(created)` is told once when the dialog closes, `created` true when Create made the character.
 */
export function createWizard({ headState = () => null, readerName = () => '', readerAbout = () => '', roleOf, openDialog = null, replyKey = () => '', rules = () => null, packNote = () => '' } = {}) {
    let session = null;
    const world = () => worldOf(headState(), String(readerName() ?? '').replace(/\s+/g, ' ').trim(), roleOf, safe(replyKey, ''));
    // The persona's description as Who they are starts: one line, the first 240 characters (whole characters), '' when there is none.
    const personaAbout = () => [...String(safe(readerAbout, '') ?? '').replace(/\s+/g, ' ').trim()].slice(0, CREATION.about).join('');
    const fresh = (prefill = null) => {
        const now = world(), about = personaAbout();
        // (`rules`: the numbers in force now; a Standard chat starts every stat low and has more to spend, joins use formula.js companionStats.)
        const numbers = safe(rules, null);
        const draft = prefill ? joinDraft(prefill, numbers) : { ...newDraft({ persona: now.persona, hasYou: now.hasYou, rules: numbers }) };
        // Only a You starts with the persona's description, and only into an empty box: a companion starts empty.
        if (!prefill && draft.kind === 'you' && about) draft.about = about;
        return { draft, handle: null, busy: false, message: '', created: false, finished: '', about: prefill ? '' : about, onEnd: null, imported: null, importError: '', pendingSet: null };
    };
    const current = () => { session ??= fresh(); return session; };

    function open(prefill = null, { onEnd = null } = {}) {
        if (typeof openDialog !== 'function' || session?.handle?.isOpen?.()) return null;
        const own = fresh(prefill && typeof prefill === 'object' ? prefill : null);
        own.onEnd = typeof onEnd === 'function' ? onEnd : null;
        session = own;
        const handle = openDialog(WIZARD_SCREEN_ID, { draft: {}, onClose: () => {
            if (session === own) session = null;
            const end = own.onEnd;
            own.onEnd = null;
            try { end?.(own.created); } catch { /* the caller's follow-up never breaks closing */ }
        } });
        if (!handle) { if (session === own) session = null; return null; }
        own.handle = handle;
        return handle;
    }

    const widget = {
        props: {}, primary: null, validate: () => [],
        render: (el, props, api) => shell(el, 'section', 'rpg-wizard', ({ doc, root }) => {
            const step = WIZARD_STEPS.includes(props?.step) ? props.step : WIZARD_STEPS[0];
            let handles = [], alive = true, steppers = [], radarHandle = null;
            const summary = h(doc, 'section', 'rpg-wiz-sum'), body = h(doc, 'div', `rpg-wiz-body rpg-wiz-${step}`);
            summary.setAttribute('aria-label', W.summaryLabel);
            root.append(summary, body);

            const draft = () => current().draft;
            const put = next => { current().draft = next; };
            const snap = () => readDraft(draft());
            const kindWord = kind => (kind === 'you' ? W.you : W.companion);
            const button = (parent, text, cls, fn) => {
                const node = h(doc, 'button', cls, text);
                node.setAttribute('type', 'button');
                node.addEventListener('click', fn);
                parent.appendChild(node);
                return node;
            };
            // A labelled control; `after` nodes (a hint, a count) go under it inside the label.
            const field = (parent, label, node, ...after) => {
                const wrap = h(doc, 'label', 'rpg-wiz-field');
                wrap.appendChild(h(doc, 'span', 'rpg-wiz-field-label', label));
                wrap.appendChild(node);
                for (const extra of after) wrap.appendChild(extra);
                parent.appendChild(wrap);
                return node;
            };
            const input = (value, max, label) => {
                const node = h(doc, 'input', 'rpg-wiz-input');
                node.setAttribute('type', 'text');
                node.setAttribute('maxlength', String(max));
                if (label) node.setAttribute('aria-label', label);
                node.value = value;
                return node;
            };
            const select = (options, value, label) => {
                const node = h(doc, 'select', 'rpg-wiz-input');
                if (label) node.setAttribute('aria-label', label);
                for (const option of options) {
                    const item = h(doc, 'option', '', option.label);
                    item.setAttribute('value', String(option.value));
                    if (option.disabled) item.setAttribute('disabled', 'disabled');
                    if (String(option.value) === String(value)) item.setAttribute('selected', 'selected');
                    node.appendChild(item);
                }
                node.value = String(value);
                return node;
            };

            // ---- the summary row: who, stats and skills so far, and the pill ----
            function drawSummary() {
                if (!alive) return;
                const now = snap();
                summary.replaceChildren();
                const who = h(doc, 'div', 'rpg-wiz-who');
                who.appendChild(h(doc, 'span', 'rpg-wiz-ava', [...now.name][0]?.toUpperCase() ?? '?'));
                const k = h(doc, 'div', 'rpg-wiz-k');
                k.appendChild(h(doc, 'span', 'rpg-wiz-name', now.name || W.title));
                k.appendChild(h(doc, 'small', 'rpg-wiz-sub', `${kindWord(now.kind)} · ${fill(W.soulFrom, { label: soulWords.label, name: soulWords.word(now.soul ?? 1) })}`));
                who.appendChild(k);
                summary.appendChild(who);
                const part = (label, text) => {
                    const node = h(doc, 'div', 'rpg-wiz-k');
                    node.appendChild(h(doc, 'small', '', label));
                    node.appendChild(h(doc, 'span', '', text));
                    summary.appendChild(node);
                };
                part(W.statsHead, statsLine(now));
                part(W.skillsHead, now.skills.filter(skill => skill.name).map(skill => (Number.isSafeInteger(skill.rank) ? skillLine({ name: skill.name, rank: skill.rank }) : skill.name)).join(', ') || W.noSkills);
                const left = pointsLeft(now), count = now.skills.length;
                const pill = h(doc, 'span', 'ss-pill rpg-wiz-push', step === 'who' || step === 'stats' ? fill(W.pointsLeft, { n: left })
                    : fill(count === 1 ? W.skillCountOne : W.skillCount, { n: count, max: SKILL_SLOTS }));
                pill.setAttribute('role', 'status');
                summary.appendChild(pill);
            }

            const clear = () => { for (const handle of handles) handle.destroy?.(); handles = []; steppers = []; radarHandle = null; body.replaceChildren(); };

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
                if (!alive || session !== run) return;
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
                    box.appendChild(h(doc, 'span', 'rpg-import-text', [fill(W.importDone, { file: fileName, points, label: soulWords.label, soul: soulWords.word(file.soul), skills }),
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
                form.appendChild(h(doc, 'p', 'rpg-wiz-note', current().imported ? fill(W.whoNoteImported, { label: soulWords.label, name: soulWords.word(snap().soul ?? 1) })
                    : draft().soul > 1 ? fill(W.whoNoteSoul, { label: soulWords.label, name: soulWords.word(snap().soul) }) : fill(W.whoNote, { label: soulWords.label, first: soulWords.word(1) })));
            }

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
                const words = { ...creation, label: soulWords.label };
                actions.appendChild(h(doc, 'p', 'rpg-sheet-note', now.from ? fill(standard ? W.statsNoteImportStandard : W.statsNoteImport, { ...words, n: now.from.points }) : fill(standard ? W.statsNoteStandard : W.statsNote, words)));
                const fromPack = standard ? safe(packNote, '') : '';
                if (fromPack) actions.appendChild(h(doc, 'p', 'rpg-sheet-note rpg-wiz-pack', fill(RPG_STRINGS.settings.fromPack, { name: fromPack })));
                card.appendChild(actions);
                // Standard: Health, Stamina and Mana grow with VIT, AGI and INT, and luck with LUK; the line follows the steppers.
                growthNode = standard ? h(doc, 'p', 'rpg-wiz-growth', growth(now)) : null;
                if (growthNode) { growthNode.setAttribute('data-wiz', 'growth'); card.appendChild(growthNode); }
                body.appendChild(card);
            }

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
                body.appendChild(h(doc, 'p', 'rpg-wiz-p', fill(W.skillsIntro, { max: SKILL_SLOTS })));
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
                const rows = h(doc, 'div', 'rpg-wiz-rows');
                body.appendChild(rows);
                const head = h(doc, 'div', 'rpg-wiz-row rpg-wiz-headrow');
                for (const label of [W.colSkill, W.colAbout, W.colStat, W.colUses, W.colStart, '']) head.appendChild(h(doc, 'span', 'rpg-wiz-colhead', label));
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
                    start.addEventListener('change', () => { patch({ start: Number(start.value) }); redraw(); });
                    row.append(name, about, stat, uses, start);
                    const remove = button(row, '', 'rpg-wiz-x', () => { put(withoutSkill(draft(), at)); drawSummary(); redraw(); });
                    remove.setAttribute('aria-label', fill(W.remove, { name: label }));
                    remove.appendChild(h(doc, 'span', '', '×'));
                    rows.appendChild(row);
                });
                const left = SKILL_SLOTS - now.skills.length;
                const add = h(doc, 'div', 'rpg-wiz-add');
                const addButton = button(add, W.add, 'ss-button rpg-wiz-add-button', () => { put(withSkill(draft())); drawSummary(); redraw(); });
                addButton.disabled = left <= 0;
                add.appendChild(h(doc, 'p', 'rpg-wiz-note', `${left <= 0 ? W.slotsFull : left === 1 ? W.slotLeft : fill(W.slotsLeft, { n: left })} ${draftCreation(now).standard ? W.skillsNoteStandard : W.skillsNote}`));
                body.appendChild(add);
            }

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
                list.appendChild(h(doc, 'p', 'rpg-wiz-note', current().imported ? fill(W.reviewStartImported, { label: soulWords.label, name: soulWords.word(now.soul ?? 1) })
                    : now.soul > 1 ? fill(W.reviewStartSoul, { label: soulWords.label, name: soulWords.word(now.soul) }) : fill(W.reviewStart, { label: soulWords.label, first: soulWords.word(1) })));
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

            // Who holds the things an imported character carries: the party's actor of that name when a party module lists one, else the party's bag
            // (a You always carries in the bag).
            function ownerFor(draftNow) {
                if (draftNow.kind === 'you') return 'party';
                const actors = safe(() => api?.query?.('party.actors'), []);
                const found = (Array.isArray(actors) ? actors : []).find(actor => typeof actor?.id === 'string' && fold(actor.name) === fold(draftNow.name));
                return found?.id ?? 'party';
            }
            // Adds what an imported file had besides the character: one `inventory.add` for each thing (the carry limit and the rest of the inventory's
            // rules apply), then the purse raised by the file's money. → the things that could not be added, in plain words ([] when all were).
            async function addImported(file, draftNow, call) {
                const owner = ownerFor(draftNow), failed = [];
                for (const item of file.items ?? []) {
                    const added = await call('inventory.add', { name: item.name, qty: item.qty, owner, ...(item.note ? { note: item.note } : {}),
                        ...(item.kind ? { kind: item.kind } : {}), ...(item.rarity ? { rarity: item.rarity } : {}) });
                    if (!added.ok) failed.push(fill(W.notAdded, { what: `${item.name}${item.qty === 1 ? '' : ` ×${item.qty}`}`, why: refusalText(added, W.generic) }));
                }
                if (file.money > 0) {
                    const purse = safe(() => api?.query?.('inventory.wallet', { owner: 'party' }), null)?.coin;
                    const set = await call('wallet.set', { owner: 'party', amount: (Number.isSafeInteger(purse) ? purse : 0) + file.money });
                    if (!set.ok) failed.push(fill(W.moneyNotAdded, { why: refusalText(set, W.generic) }));
                }
                return failed;
            }

            // Create: two defines, the Character first; if the second fails the first is taken back, so nothing is left half made.
            async function create(make, status) {
                const run = current();
                if (run.busy || !alive) return { ok: false };
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
                const definitions = buildDefinitions(now, { used: where.used });
                let failure = '';
                const first = await call('dm.define', { definition: definitions.character });
                if (!first.ok) failure = fill(W.failedFirst, { why: refusalText(first, W.generic) });
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
                    for (const definition of extraDefinitions(where.extras.add, { used, formula: draftCreation(now).standard ? 'standard' : 'classic' })) {
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
                    if (alive) redraw();
                    return { ok: true };
                }
                if (!failure) { run.created = true; run.handle?.close?.(); return { ok: true }; }
                if (alive) { make.disabled = false; make.textContent = W.create; status.textContent = failure; }
                return { ok: false };
            }

            function redraw() {
                if (!alive) return;
                drawSummary();
                clear();
                if (step === 'who') drawWho();
                else if (step === 'stats') drawStats();
                else if (step === 'skills') drawSkills();
                else drawReview();
            }

            drawSummary();
            redraw();
            return {
                update() {},
                destroy() { alive = false; clear(); },
            };
        }),
    };

    return { screen: createWizardScreen(), widget, open, session: () => session, destroy() { try { session?.handle?.close?.(); } catch { /* already closed */ } session = null; } };
}
