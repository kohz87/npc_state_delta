// The "Check" card under a reply: one line per checked attempt, from result.js results. createElement and textContent only.

import { PRACTICE, RANK_NAMES } from '../names.js';
import { RPG_STRINGS } from '../strings.js';
import { fold } from '../read.js';

const OUTCOME = Object.freeze({ success: ['ok', 'Success'], cost: ['cost', 'Success at a cost'], fail: ['fail', 'Fail'] });

const el = (doc, tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
};

const signed = value => (value < 0 ? `− ${Math.abs(value)}` : `+ ${value}`);

function lineNode(doc, result) {
    const line = el(doc, 'div', 'rpg-check-line');
    const who = el(doc, 'span', 'rpg-check-who');
    who.append(el(doc, 'span', 'rpg-check-name', result.who), doc.createTextNode(' · '), el(doc, 'span', 'rpg-check-what', result.what));
    if (result.utility) who.append(doc.createTextNode(' '), el(doc, 'span', 'rpg-check-util', 'utility'));
    const rank = result.rankName ?? RANK_NAMES[result.rank] ?? `Rank ${result.rank}`;
    const detail = result.skill || result.practice?.skill ? `(${String(result.stat).toUpperCase()}, ${rank})` : `(${String(result.stat).toUpperCase()}, no skill)`;
    who.append(doc.createTextNode(' '), el(doc, 'span', 'rpg-check-muted', detail), doc.createTextNode(' · '), el(doc, 'span', 'rpg-check-difficulty', result.difficulty));

    const bonus = Number.isFinite(result.bonus) ? result.bonus : (result.statBonus ?? 0) + (result.rank ?? 0) + (result.classBonus ?? 0);
    const numbers = el(doc, 'span', 'rpg-check-num', `d20 ${result.die} ${signed(bonus)} = ${result.total} vs ${result.dc}`);
    const [tone, word] = OUTCOME[result.outcome] ?? OUTCOME.fail;
    const row = el(doc, 'span', 'rpg-check-result');
    row.appendChild(el(doc, 'span', `rpg-check-pill rpg-check-${tone}`, word));
    if (result.practice?.skill) {
        const n = Number.isInteger(result.practice.n) ? result.practice.n : 1;
        const gained = Number.isFinite(result.practiceGained) ? result.practiceGained : PRACTICE.perUse * n;
        row.append(doc.createTextNode(' '), el(doc, 'span', 'rpg-check-gain', `${result.practice.skill} +${gained} practice`));
    }
    line.append(who, numbers, row);
    return line;
}

const glyph = (doc, name) => {
    const node = el(doc, 'i', `fa-solid ${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
};

// One small pill per roll for the folded header: "<stat or skill> · <result word>", the roller's name first when it is not the reader's character.
function summaryPill(doc, result, reader) {
    const [tone, word] = OUTCOME[result.outcome] ?? OUTCOME.fail;
    const what = result.skill?.name || result.practice?.skill || String(result.stat).toUpperCase();
    const own = Boolean(reader) && fold(result.who) === fold(reader);
    const text = `${own ? '' : `${result.who} · `}${what} · ${word}`;
    const pill = el(doc, 'span', `rpg-check-chip rpg-check-chip-${tone}`, text);
    pill.setAttribute('title', text);
    return pill;
}

/**
 * The Check card for a list of result.js results. Options: `folded`, `onFold(folded)`, `reader` (the reader's character name).
 * Its top is a header button like the fight log's; folded, the header shows one pill per roll.
 */
export function buildCheckCard(doc, results = [], { folded = false, onFold = () => {}, reader = '' } = {}) {
    const list = Array.isArray(results) ? results : [];
    const root = el(doc, 'div', 'rpg-check rpg-check-card');
    root.setAttribute('data-variant', 'card');
    const head = el(doc, 'button', 'rpg-bl-head rpg-check-head');
    head.setAttribute('type', 'button');
    const chevron = glyph(doc, 'fa-chevron-up');
    chevron.classList.add('rpg-bl-chevron');
    const sum = el(doc, 'span', 'rpg-check-sum');
    for (const result of list) sum.appendChild(summaryPill(doc, result, reader));
    head.append(glyph(doc, 'fa-dice-d20'), el(doc, 'b', 'rpg-check-h', 'Check'), sum, chevron);
    const body = el(doc, 'div', 'rpg-bl-body rpg-check-body');
    root.append(head, body);
    for (const result of list) body.appendChild(lineNode(doc, result));
    const setFold = on => {
        body.hidden = on;
        sum.hidden = !on;
        root.classList.toggle('rpg-bl-folded', on);
        head.setAttribute('aria-expanded', String(!on));
        head.setAttribute('title', on ? RPG_STRINGS.battle.unfoldChecks : RPG_STRINGS.battle.foldChecks);
        chevron.className = `fa-solid ${on ? 'fa-chevron-down' : 'fa-chevron-up'} rpg-bl-chevron`;
    };
    setFold(folded);
    head.addEventListener('click', () => {
        const on = !body.hidden;
        setFold(on);
        onFold(on);
    });
    return root;
}
