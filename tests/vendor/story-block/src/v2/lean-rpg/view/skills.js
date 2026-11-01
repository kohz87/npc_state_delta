// The Skills view (mockup section 3): a character's skills in place of the Party cards, like the Spend points sheet. Each skill shows
// its name, a rank pill toned by rank, "STAT · Uses", what it does, a four-cell mastery bar (`ss.meter`) and the roll it makes from
// the live sheet ("Rolls with it: d20 +12 = VIT 12 → +6 · Expert +2 · Soul Class II +4"). Empty slots are a dashed line. Rank and
// practice only move through play, so the pencil edits the name and the description and nothing else, in ONE multi-field `dm.set`.
// Every node is built with createElement and textContent.

import { h, iconNode } from '../../view/widgets/dom.js';
import { meter } from '../../view/widgets/meter.js';
import { refusalText } from '../../strings.js';
import { FORMULA, RANK_NAMES, SKILL_SLOTS } from '../names.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { isStandard, statShare } from '../rules.js';
import { statPart } from '../formula.js';

const K = RPG_STRINGS.skills;

/** The tone a rank wears, Novice to Master: the legend pills, the rank pill and the mastery bar all use it. */
export const RANK_TONES = Object.freeze(['neutral', 'info', 'accent', 'good']);

const cap = word => (word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : '');

/** What the mastery bar shows for a skill: 4 cells, rank + 1 of them lit and the next one filling with practice (Master: all four). */
export function masteryOf(skill) {
    const master = skill.rank >= RANK_NAMES.length - 1;
    const value = master ? RANK_NAMES.length : skill.rank + 1 + Math.min(100, Math.max(0, skill.practice)) / 100;
    const next = RANK_NAMES[skill.rank + 1];
    return { value, max: RANK_NAMES.length, tone: RANK_TONES[skill.rank] ?? 'neutral',
        text: master ? K.meterMaster : fill(K.meter, { rank: skill.rankName, practice: skill.practice, next }) };
}

/**
 * The roll a skill makes from the live sheet: d20 + floor(stat / 2) + rank + 2 × Soul Class (Standard: the pair of the stat and half of DEX, halved, in place of floor(stat / 2)). → { total, stat, value, half, rank, bonus } with
 * `stat` the stat's label (null for a skill that names none: the story then picks the stat, so only the rank and class are known).
 */
export function rollOf(skill, character, rules = FORMULA) {
    const entry = character.stats.find(stat => stat.key === skill.stat) ?? null;
    const bonus = rules.classWeight * character.soul;
    if (isStandard(rules) && entry) {
        // The Standard formula: the skill's stat in the main slot with half of DEX (a Mana skill is magic, a Stamina skill physical), halved once.
        const stats = Object.fromEntries(character.stats.map(stat => [stat.key, stat.value]));
        const part = statPart(skill.uses === 'mana' ? 'magic' : 'physical', stats, { skillStat: skill.stat });
        const second = character.stats.find(stat => stat.key === part.second);
        return { total: part.value + skill.rank + bonus, stat: entry.label, value: entry.value, half: part.value, rank: skill.rank, bonus, second: second?.label ?? part.second.toUpperCase(), secondValue: second?.value ?? 0 };
    }
    const half = entry ? statShare(entry.value, rules) : 0;
    return { total: half + skill.rank + bonus, stat: entry?.label ?? null, value: entry?.value ?? 0, half, rank: skill.rank, bonus };
}

/** The record the Party tab keeps for an open Skills view (outside the DOM: the page draws a screen again on every change of the story). */
export const newSkillsSession = character => ({ module: character.module, subject: character.subject, editing: null, start: null, draft: { name: '', about: '' }, busy: false, message: '' });

/**
 * Draws `character`'s skills (a readParty record) into `parent`. Options: `session` (newSkillsSession's record, kept by the caller),
 * `api` ({ command }; without one there are no pencils), `onBack()`, `rules()` (the numbers a roll is made with now: the roll line follows them), `onSaved()` (a save ended: the page draws the view again from the session,
 * since it already drew itself once after the first write and this instance may be gone), `doc`. → { el, session, edit(slot), save(), destroy() }.
 */
export function renderSkills(parent, { character, session = null, api = {}, onBack = () => {}, onSaved = () => {}, rules = () => FORMULA, doc = parent.ownerDocument ?? globalThis.document } = {}) {
    const run = session ?? newSkillsSession(character);
    const block = character.skillsBlock;
    const root = h(doc, 'section', 'rpg-sheet rpg-skills-view ss-glass');
    root.setAttribute('aria-label', fill(K.title, { name: character.name }));
    parent.appendChild(root);
    let alive = true, handles = [], saveButton = null, noteNode = null;

    // The slot being edited changed under the editor (the story renamed it): the editor closes and says so.
    const skillAt = slot => character.skills.find(skill => skill.slot === slot) ?? null;
    if (run.editing !== null) {
        const now = skillAt(run.editing);
        if (!run.busy && (!now || now.name !== run.start?.name || now.about !== run.start?.about)) Object.assign(run, { editing: null, start: null, message: K.changed });
    }

    const clear = () => { for (const handle of handles) handle.destroy?.(); handles = []; root.replaceChildren(); };
    const limit = field => (Number.isSafeInteger(block?.definition?.state?.[field]?.max) ? block.definition.state[field].max : null);
    const words = () => (run.busy ? K.saving : run.message);

    function edit(slot) {
        const skill = skillAt(slot);
        if (!skill || run.busy || typeof api.command !== 'function') return;
        Object.assign(run, { editing: slot, start: { name: skill.name, about: skill.about }, draft: { name: skill.name, about: skill.about }, message: '' });
        draw();
    }
    function cancel() {
        if (run.busy) return;
        Object.assign(run, { editing: null, start: null, message: '' });
        draw();
    }

    // The name and the description go as one `dm.set` with `fields`: one action, all or nothing; nothing else of the skill is sent.
    async function save() {
        const slot = run.editing;
        if (slot === null || run.busy || !alive || typeof api.command !== 'function') return { ok: false };
        const name = run.draft.name.replace(/\s+/g, ' ').trim(), about = run.draft.about.replace(/\s+/g, ' ').trim();
        if (!name) { run.message = K.needName; draw(); return { ok: false }; }
        if (name === run.start.name && about === run.start.about) { cancel(); return { ok: true }; }
        run.busy = true;
        run.message = '';
        if (saveButton) saveButton.disabled = true;
        if (noteNode) noteNode.textContent = words();
        let failure = null;
        try {
            const result = await api.command('dm.set', { module: block.module, fields: { [`skill${slot}`]: name, [`about${slot}`]: about } });
            if (!result?.ok) failure = result ?? { ok: false };
        } catch (error) {
            failure = { ok: false, message: String(error?.message ?? error) };
        }
        run.busy = false;
        if (failure) run.message = refusalText(failure, K.failed);
        else Object.assign(run, { editing: null, start: null, message: '' });
        if (alive) draw();
        onSaved({ ok: !failure });
        return { ok: !failure };
    }

    function pencil(row, skill) {
        const node = h(doc, 'button', 'ss-iconbutton rpg-skill-pencil');
        node.setAttribute('type', 'button');
        node.setAttribute('aria-label', fill(K.edit, { name: skill.name }));
        node.setAttribute('title', fill(K.edit, { name: skill.name }));
        node.setAttribute('data-skill-edit', String(skill.slot));
        const glyph = iconNode(doc, 'ph-pencil-simple');
        if (glyph) node.appendChild(glyph);
        node.addEventListener('click', () => edit(skill.slot));
        row.appendChild(node);
    }

    function editor(row, skill) {
        const form = h(doc, 'div', 'rpg-skill-form');
        const field = (label, node) => {
            const wrap = h(doc, 'label', 'rpg-skill-field');
            wrap.appendChild(h(doc, 'span', 'rpg-skill-field-label', label));
            wrap.appendChild(node);
            form.appendChild(wrap);
            return node;
        };
        const name = h(doc, 'input', 'rpg-skill-input');
        name.setAttribute('type', 'text');
        name.setAttribute('data-skill-field', 'name');
        name.value = run.draft.name;
        if (limit(`skill${skill.slot}`)) name.setAttribute('maxlength', String(limit(`skill${skill.slot}`)));
        const about = h(doc, 'textarea', 'rpg-skill-input');
        about.setAttribute('rows', '3');
        about.setAttribute('data-skill-field', 'about');
        about.value = run.draft.about;
        if (limit(`about${skill.slot}`)) about.setAttribute('maxlength', String(limit(`about${skill.slot}`)));
        field(K.editName, name);
        field(K.editAbout, about);
        name.addEventListener('input', () => { run.draft.name = name.value; });
        about.addEventListener('input', () => { run.draft.about = about.value; });
        form.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault?.(); cancel(); } });
        const actions = h(doc, 'div', 'rpg-card-actions');
        saveButton = h(doc, 'button', 'ss-button ss-button-primary rpg-skill-save', K.save);
        saveButton.setAttribute('type', 'button');
        saveButton.disabled = run.busy;
        saveButton.addEventListener('click', () => { save(); });
        const stop = h(doc, 'button', 'ss-button rpg-skill-cancel', K.cancel);
        stop.setAttribute('type', 'button');
        stop.addEventListener('click', cancel);
        actions.append(saveButton, stop);
        form.appendChild(actions);
        row.appendChild(form);
    }

    function skillRow(list, skill) {
        const roll = rollOf(skill, character, rules()), mastery = masteryOf(skill);
        const row = h(doc, 'article', 'rpg-skill');
        row.setAttribute('data-slot', String(skill.slot));
        const top = h(doc, 'div', 'rpg-skill-top');
        top.appendChild(h(doc, 'p', 'rpg-skill-name', skill.name));
        top.appendChild(h(doc, 'span', `ss-pill rpg-rank rpg-tone-${mastery.tone}`, skill.rankName));
        const uses = skill.stat ? fill(K.usesStat, { stat: roll.stat ?? skill.stat.toUpperCase(), uses: cap(skill.uses ?? 'stamina') }) : '';
        if (uses) top.appendChild(h(doc, 'span', 'rpg-skill-uses', uses));
        if (typeof api.command === 'function' && block) pencil(top, skill);
        row.appendChild(top);
        if (run.editing === skill.slot) { editor(row, skill); list.appendChild(row); return; }
        if (skill.about) row.appendChild(h(doc, 'p', 'rpg-skill-about', skill.about));
        const bar = h(doc, 'div', 'rpg-skill-meter');
        row.appendChild(bar);
        handles.push(meter.render(bar, { label: K.mastery, value: mastery.value, max: mastery.max, segments: mastery.max, tone: mastery.tone, text: mastery.text, icon: 'fa-book-open' }, {}));
        const line = h(doc, 'p', 'rpg-skill-roll');
        const rank = { rank: skill.rankName, n: skill.rank, soul: character.soulName, label: character.soulLabel, bonus: roll.bonus };
        if (roll.stat) {
            line.appendChild(h(doc, 'b', '', fill(K.rolls, { total: roll.total })));
            line.appendChild(doc.createTextNode(' '));
            line.appendChild(h(doc, 'span', '', fill(roll.second ? K.rollsPartsStandard : K.rollsParts, { ...rank, stat: roll.stat, value: roll.value, half: roll.half, second: roll.second, secondValue: roll.secondValue })));
        } else line.appendChild(h(doc, 'span', '', fill(K.rollsNoStat, rank)));
        row.appendChild(line);
        list.appendChild(row);
    }

    function draw() {
        if (!alive) return;
        clear();
        saveButton = null;
        const head = h(doc, 'div', 'rpg-sheet-head');
        head.appendChild(h(doc, 'h3', 'rpg-sheet-name', fill(K.title, { name: character.name })));
        const pills = h(doc, 'div', 'rpg-pills');
        pills.appendChild(h(doc, 'span', 'ss-pill', fill(RPG_STRINGS.party.soul, { label: character.soulLabel, name: character.soulName })));
        pills.appendChild(h(doc, 'span', 'ss-pill rpg-slots', fill(K.slots, { n: character.skills.length, max: SKILL_SLOTS })));
        head.appendChild(pills);
        root.appendChild(head);
        const legend = h(doc, 'div', 'rpg-skill-legend');
        legend.appendChild(h(doc, 'span', '', K.legend));
        RANK_NAMES.forEach((rank, at) => legend.appendChild(h(doc, 'span', `ss-pill rpg-tone-${RANK_TONES[at]}`, fill(K.legendPill, { rank, n: at }))));
        legend.appendChild(h(doc, 'span', '', K.legendEnd));
        root.appendChild(legend);
        const list = h(doc, 'div', 'rpg-skill-list');
        root.appendChild(list);
        for (const skill of character.skills) skillRow(list, skill);
        for (let empty = character.skills.length; empty < SKILL_SLOTS; empty += 1) list.appendChild(h(doc, 'div', 'rpg-skill-empty', fill(K.empty, { name: character.name })));
        const foot = h(doc, 'div', 'rpg-skill-foot');
        const back = h(doc, 'button', 'ss-button ss-button-primary rpg-skills-back', K.back);
        back.setAttribute('type', 'button');
        back.addEventListener('click', () => { if (!run.busy) onBack(); });
        foot.appendChild(back);
        foot.appendChild(h(doc, 'p', 'rpg-skill-note', K.note));
        noteNode = h(doc, 'p', 'rpg-skill-status', words());
        noteNode.setAttribute('role', 'status');
        foot.appendChild(noteNode);
        root.appendChild(foot);
    }

    draw();
    return {
        el: root,
        session: run,
        edit,
        save,
        destroy() { alive = false; clear(); root.remove(); },
    };
}
