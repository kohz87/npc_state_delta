// The New character wizard (mockup section 4): Story Block's own dialog (`width: 'wide'`) with four steps, Who · Stats · Skills ·
// Review, and a summary row of the character so far on top of each. It is opened from the Party tab ("+ New character", and
// "Create your character" when there is none).
//   Who     the name (the persona's by default), You or A companion (one You to a story), who they are (the AI reads it)
//   Stats   the Spend points view's steppers and radar, under the creation budget (names.js CREATION)
//   Skills  skill sets (built in, and a pack's `content.rpg.skillSets`) and up to five rows: name, what it does, Stat, Uses,
//           Starts at (Novice; Adept for at most one skill). Rank and practice are never typed.
//   Review  everything; Create makes the Character block and the Skills block with ONE `dm.define` each, the wizard's values
//           written as the new definitions' field defaults (wizard-data.js buildDefinitions): no `dm.set`, so a skill's rank stays a
//           field only play can move, and the reply's budget is spent twice. If the second define fails the first block is removed
//           again: nothing is left half made.
// The draft lives here, in the wizard's session (the dialog's own draft is not used); each step is a widget of this file drawing from
// it, so Back and Next keep what was typed. Every node is built with createElement and textContent.

import { h, shell } from '../../view/widgets/dom.js';
import { radar } from '../../view/widgets/radar.js';
import { stepper } from '../../view/widgets/stepper.js';
import { refusalText } from '../../strings.js';
import { CREATION, RANK_NAMES, SKILL_SLOTS, STATS, USES } from '../names.js';
import { fold } from '../read.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { readParty } from './party-data.js';
import { WIZARD_STEPS, actionsFree, blockNames, buildDefinitions, hasRoom, mayStartAdept, newDraft, pointsLeft, problemsOf, readDraft, setLine, skillSetsOf,
    START_RANKS, statsLine, withSet, withSkill, withSkillPatch, withoutSkill } from './wizard-data.js';

const W = RPG_STRINGS.wizard;
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
    return { persona, names: party.map(character => character.name), hasYou: party.some(character => character.own), room: hasRoom(state), free: actionsFree(state, replyKey),
        used: Object.keys(state?.domains?.dataModules?.active ?? {}) };
}

const safe = (fn, fallback) => { try { return fn() ?? fallback; } catch { return fallback; } };

/**
 * The wizard. `deps`: `headState()` (the head state or null), `readerName()` (the persona's name), `roleOf(definition)`, `openDialog(id,
 * { draft, onClose })` (the host's dialog mount; without it there is no way to open), `replyKey()` (the head reply's key in the blocks' per-reply
 * count, `${sid}/${swipeKey}`: Create asks the reply for three block actions before it starts). → { screen, widget, open(), session(), destroy() }.
 * `open()` opens the dialog on a fresh draft; the session is dropped when the dialog closes.
 */
export function createWizard({ headState = () => null, readerName = () => '', roleOf, openDialog = null, replyKey = () => '' } = {}) {
    let session = null;
    const world = () => worldOf(headState(), String(readerName() ?? '').replace(/\s+/g, ' ').trim(), roleOf, safe(replyKey, ''));
    const fresh = () => {
        const now = world();
        return { draft: newDraft({ persona: now.persona, hasYou: now.hasYou }), handle: null, busy: false, message: '' };
    };
    const current = () => { session ??= fresh(); return session; };

    function open() {
        if (typeof openDialog !== 'function' || session?.handle?.isOpen?.()) return null;
        const own = fresh();
        session = own;
        const handle = openDialog(WIZARD_SCREEN_ID, { draft: {}, onClose: () => { if (session === own) session = null; } });
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
                k.appendChild(h(doc, 'small', 'rpg-wiz-sub', `${kindWord(now.kind)} · ${W.soulOne}`));
                who.appendChild(k);
                summary.appendChild(who);
                const part = (label, text) => {
                    const node = h(doc, 'div', 'rpg-wiz-k');
                    node.appendChild(h(doc, 'small', '', label));
                    node.appendChild(h(doc, 'span', '', text));
                    summary.appendChild(node);
                };
                part(W.statsHead, statsLine(now));
                part(W.skillsHead, now.skills.filter(skill => skill.name).map(skill => skill.name).join(', ') || W.noSkills);
                const left = pointsLeft(now), count = now.skills.length;
                const pill = h(doc, 'span', 'ss-pill rpg-wiz-push', step === 'who' || step === 'stats' ? fill(W.pointsLeft, { n: left })
                    : fill(count === 1 ? W.skillCountOne : W.skillCount, { n: count, max: SKILL_SLOTS }));
                pill.setAttribute('role', 'status');
                summary.appendChild(pill);
            }

            const clear = () => { for (const handle of handles) handle.destroy?.(); handles = []; steppers = []; radarHandle = null; body.replaceChildren(); };

            // ---- Who ----
            function drawWho() {
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
                about.addEventListener('input', () => { put({ ...draft(), about: about.value }); count.textContent = fill(W.aboutCount, { n: [...about.value].length, max: CREATION.about }); });
                form.appendChild(h(doc, 'p', 'rpg-wiz-note', W.whoNote));
            }

            // ---- Stats ----
            const axes = now => STATS.map(stat => ({ label: stat.toUpperCase(), value: now.stats[stat], max: 20, before: CREATION.start }));
            function refreshStats() {
                const now = snap(), left = pointsLeft(now);
                STATS.forEach((stat, at) => steppers[at]?.update({ name: stat, value: now.stats[stat], min: CREATION.min, max: CREATION.max, budget: left, label: stat.toUpperCase(), budgetLabel: RPG_STRINGS.sheet.budgetLabel }));
                radarHandle?.update({ axes: axes(now), max: 20, label: fill(W.radar, { name: now.name || W.title }), tone: 'accent' });
                drawSummary();
            }
            function drawStats() {
                const now = snap(), left = pointsLeft(now);
                const sheet = h(doc, 'div', 'rpg-sheet-body rpg-wiz-stats');
                const grid = h(doc, 'div', 'rpg-steppers');
                sheet.appendChild(grid);
                for (const stat of STATS) {
                    const slot = h(doc, 'div', 'rpg-stat-step');
                    slot.setAttribute('data-stat', stat);
                    grid.appendChild(slot);
                    const handle = stepper.render(slot, { name: stat, value: now.stats[stat], min: CREATION.min, max: CREATION.max, budget: left, label: stat.toUpperCase(), budgetLabel: RPG_STRINGS.sheet.budgetLabel },
                        { onDraft: (name, value) => { if (STATS.includes(name) && Number.isSafeInteger(value)) put({ ...draft(), stats: { ...snap().stats, [name]: value } }); refreshStats(); } });
                    handles.push(handle);
                    steppers.push(handle);
                }
                const chart = h(doc, 'div', 'rpg-radar');
                radarHandle = radar.render(chart, { axes: axes(now), max: 20, label: fill(W.radar, { name: now.name || W.title }), tone: 'accent' }, {});
                handles.push(radarHandle);
                sheet.appendChild(chart);
                body.appendChild(sheet);
                const actions = h(doc, 'div', 'rpg-actions');
                button(actions, W.statsReset, 'ss-button rpg-wiz-reset', () => { put({ ...draft(), stats: Object.fromEntries(STATS.map(stat => [stat, CREATION.start])) }); redraw(); });
                actions.appendChild(h(doc, 'p', 'rpg-sheet-note', fill(W.statsNote, CREATION)));
                body.appendChild(actions);
            }

            // ---- Skills ----
            function drawSkills() {
                const now = snap(), sets = skillSetsOf({
                    packSets: safe(() => api?.query?.('packs.content', { kind: 'rpg' }), []),
                    packNames: Object.fromEntries(safe(() => api?.query?.('packs.list'), []).map(pack => [pack.id, pack.name])),
                });
                body.appendChild(h(doc, 'p', 'rpg-wiz-p', fill(W.skillsIntro, { max: SKILL_SLOTS })));
                body.appendChild(h(doc, 'h3', 'rpg-wiz-h', W.templates));
                const grid = h(doc, 'div', 'rpg-wiz-grid');
                body.appendChild(grid);
                for (const set of sets) {
                    const used = draft().set === set.id;
                    const card = button(grid, '', 'rpg-wiz-card', () => { put(withSet(draft(), set)); drawSummary(); redraw(); });
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
                    const stat = select(STATS.map(key => ({ value: key, label: key.toUpperCase() })), skill.stat, fill(W.skillStat, { name: label }));
                    stat.setAttribute('data-field', 'stat');
                    const uses = select(USES.map(key => ({ value: key, label: W[key] })), skill.uses, fill(W.skillUses, { name: label }));
                    uses.setAttribute('data-field', 'uses');
                    const start = select(START_RANKS.map(rank => ({ value: rank, label: RANK_NAMES[rank], disabled: rank === 1 && !mayStartAdept(draft(), at) })), skill.start, fill(W.skillStart, { name: label }));
                    start.setAttribute('data-field', 'start');
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
                add.appendChild(h(doc, 'p', 'rpg-wiz-note', `${left <= 0 ? W.slotsFull : left === 1 ? W.slotLeft : fill(W.slotsLeft, { n: left })} ${W.skillsNote}`));
                body.appendChild(add);
            }

            // ---- Review ----
            function drawReview() {
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
                for (const skill of now.skills) skills.appendChild(h(doc, 'li', '', `${skill.name || '—'} · ${skill.stat.toUpperCase()} · ${W[skill.uses]} · ${W.startsAt} ${RANK_NAMES[skill.start]}`));
                if (!now.skills.length) skills.appendChild(h(doc, 'li', '', W.noSkills));
                list.appendChild(skills);
                list.appendChild(h(doc, 'p', 'rpg-wiz-note', W.reviewStart));
                const left = Math.max(0, pointsLeft(now));
                if (left > 0) list.appendChild(h(doc, 'p', 'rpg-wiz-note', fill(left === 1 ? W.reviewLeftOne : W.reviewLeft, { n: left })));
                list.appendChild(h(doc, 'p', 'rpg-wiz-note', fill(W.reviewBlocks, { character: names.character, skills: names.skills })));
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
                run.busy = false;
                run.message = failure;
                if (!failure) { run.handle?.close?.(); return { ok: true }; }
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
