// Dice display: a Dice block's roll lines drawn as one card per roll, with the check that
// the model used the dice Story Block rolled for it. Ported from Megumin Suite's dice card
// (GPL-3.0): the die face, the reel and its deterministic decoys are its.
//
// The text stays the state: parseDice reads it on every render, and anything it will not
// read as roll lines (prose, a half-filled template, a cut-off block) goes to the plain
// display, so nothing the model wrote is lost to the cards.
//
// Honesty line, under the cards (from checkRolls against the rolls that were handed over):
// - rolls handed and every one used as given  -> quiet "Rolled by Story Block · 12, 5"
// - rolls handed and something does not match -> a visible warning listing each problem,
//   and the affected cards marked (class plus a text flag, never colour alone)
// - `rolls` null/undefined (older reply, dice off, runtime does not know) -> nothing: the
//   card cannot tell a model that cheated from a reply nobody rolled for, so it says nothing
//   rather than casting doubt on every old reply
// - `rolls` an empty array (the runtime knows nothing was handed over for this reply) ->
//   a muted "Rolls not verified", because then the numbers are the model's own.

import { formatRolls, parseDice, checkRolls } from '../../dice.js';
import { blockName, el, emptyText, plural, renderEmpty, renderFrame } from '../dom.js';
import { appendInline, plainTextOf, render as renderPlain } from './plain.js';

const REEL_DECOYS = 5;

// Which blocks have already spun, per uiKey. Refreshes land on every chat event and rebuild
// the pane; a die that re-rolled each time would look like it was being re-rolled. So the
// reel plays once for a given block text under a given key (card and sidebar each get one),
// and every later render shows the resting number. Bounded: it only has to outlive a few
// refreshes of the newest reply.
const spun = new Set();
const SPUN_LIMIT = 200;

function firstSpin(uiKey, text) {
    const key = `${String(uiKey ?? 'default')}\u0000${text}`;
    if (spun.has(key)) return false;
    spun.add(key);
    if (spun.size > SPUN_LIMIT) spun.delete(spun.values().next().value);
    return true;
}

function prefersReducedMotion() {
    try {
        return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    } catch {
        return false;
    }
}

/**
 * The numbers the reel spins past before it lands. Derived from the roll rather than drawn
 * at random, so the render is testable and the same roll always looks the same. Stepping
 * by 7 visits every face of every supported die (7 shares no factor with 4..100) without
 * repeating within five steps; the real number itself is skipped so the strip never
 * appears to land early (only a d4, with three other faces, has to cycle back round).
 */
export function reelDecoys(roll, sides = 20, n = REEL_DECOYS) {
    const faces = Math.max(2, Number(sides) || 20);
    const out = [];
    let value = roll;
    for (let guard = 0; out.length < n && guard < n * 4; guard++) {
        value = ((value - 1 + 7) % faces) + 1;
        if (value !== roll) out.push(value);
    }
    return out;
}

function signed(mod) {
    // U+2212 rather than a hyphen: it lines up with "+" and reads as "minus".
    return mod < 0 ? `− ${Math.abs(mod)}` : `+ ${mod}`;
}

// The die face. At rest it is the number on its own. Animated, it is a strip of decoys
// with the real number last behind a one-row window, and the strip's RESTING position
// already shows that last row: the keyframes only supply a `from`. If the animation never
// runs (reduced motion, a stylesheet that failed to load) the rolled number still shows.
function dieFace(roll, animate) {
    const face = el('div', 'story-block-dice-face');
    if (animate) {
        const decoys = reelDecoys(roll.roll, roll.sides);
        const reel = el('div', 'story-block-dice-reel');
        // The strip reads as "8 15 2 9 16 3" to a screen reader; the number is said once below.
        reel.setAttribute('aria-hidden', 'true');
        const strip = el('div', 'story-block-dice-strip');
        strip.style.setProperty('--sb-dice-decoys', String(decoys.length));
        for (const value of decoys) strip.appendChild(el('span', 'story-block-dice-decoy', value));
        strip.appendChild(el('span', 'story-block-dice-landed', roll.roll));
        reel.appendChild(strip);
        face.append(reel, el('span', 'story-block-dice-roll story-block-dice-sr', roll.roll));
    } else {
        face.appendChild(el('span', 'story-block-dice-roll', roll.roll));
    }
    face.appendChild(el('span', 'story-block-dice-die', `d${roll.sides}`));
    return face;
}

const FLAG_TEXT = {
    invented: 'Not a rolled number',
    order: 'Used out of order',
};

function rollCard(roll, { animate, problems }) {
    // (0.9.6) A roll that is not the die handed for its place shows what that die gives: the
    // outcome is code's, not the model's verdict.
    const expected = problems.find(problem => problem.expected)?.expected ?? null;
    const outcome = expected ? expected.outcome : roll.outcome;
    const card = el('li', `story-block-dice-card is-${outcome}`);
    card.dataset.outcome = outcome;
    if (expected) card.dataset.storyOutcome = roll.outcome;
    if (animate) card.classList.add('is-animated');
    if (problems.length) {
        card.classList.add('is-flagged');
        card.dataset.problems = problems.map(problem => problem.kind).join(' ');
    }

    card.appendChild(dieFace(roll, animate));

    const body = el('div', 'story-block-dice-body');
    if (roll.attempt) body.appendChild(appendInline(el('div', 'story-block-dice-attempt'), roll.attempt));

    const sum = el('div', 'story-block-dice-sum');
    sum.appendChild(el('span', 'story-block-dice-total', roll.total));
    // The breakdown only when there is one: "15 (12 + 3)" helps, "12 (12)" is noise.
    if (roll.mod) sum.appendChild(el('span', 'story-block-dice-mod', `(${roll.roll} ${signed(roll.mod)})`));
    sum.appendChild(el('span', 'story-block-dice-vs', 'vs'));
    sum.appendChild(el('span', 'story-block-dice-dc', `DC ${roll.dc}`));
    body.appendChild(sum);

    if (roll.note) body.appendChild(appendInline(el('div', 'story-block-dice-note'), roll.note));
    if (!roll.sumOk) {
        const why = roll.mod ? `${roll.roll} ${signed(roll.mod)} is ${roll.roll + roll.mod}, not ${roll.total}` : `rolled ${roll.roll}, written as ${roll.total}`;
        body.appendChild(warningLine('story-block-dice-sum-warning', `Doesn't add up: ${why}`));
    }
    // A sum problem already has its own line above; the others say what is wrong here.
    for (const problem of problems) {
        if (FLAG_TEXT[problem.kind]) body.appendChild(warningLine('story-block-dice-flag', FLAG_TEXT[problem.kind]));
    }
    if (expected) {
        const sum = roll.mod ? `${expected.roll} ${signed(roll.mod)} = ${expected.total}` : `${expected.roll}`;
        body.appendChild(el('div', 'story-block-dice-true', `The die said ${expected.roll}: ${sum} vs DC ${roll.dc} → ${expected.label} (the story told ${roll.label})`));
    }
    card.appendChild(body);

    card.appendChild(el('span', `story-block-dice-pill is-${outcome}`, expected ? expected.label : roll.label));
    return card;
}

function warningLine(className, text) {
    const line = el('div', className);
    const glyph = el('i', 'fa-solid fa-triangle-exclamation');
    glyph.setAttribute('aria-hidden', 'true');
    line.append(glyph, el('span', '', text));
    return line;
}

function honestyLine(check, rolls) {
    if (check.checked && check.ok) {
        const line = el('div', 'story-block-dice-honesty is-ok');
        const glyph = el('i', 'fa-solid fa-dice');
        glyph.setAttribute('aria-hidden', 'true');
        line.append(glyph, el('span', '', `Rolled by Story Block · ${formatRolls(rolls)}`));
        return line;
    }
    if (check.checked) {
        // role="note", not "alert": the pane is rebuilt on every chat event, and an alert
        // would be announced again each time.
        const box = el('div', 'story-block-dice-honesty is-mismatch');
        box.setAttribute('role', 'note');
        const head = el('div', 'story-block-dice-honesty-head');
        const glyph = el('i', 'fa-solid fa-triangle-exclamation');
        glyph.setAttribute('aria-hidden', 'true');
        head.append(glyph, el('span', '', 'These rolls don\'t match the dice Story Block rolled'));
        const list = el('ul', 'story-block-dice-problems');
        for (const problem of check.problems) {
            // "Roll 2: 9 was used out of order", but not "Roll 4: roll 4 was not handed over".
            const own = new RegExp(`^roll ${problem.index + 1}\\b`, 'i').test(problem.text);
            const line = own ? problem.text.replace(/^r/, 'R') : `Roll ${problem.index + 1}: ${problem.text}`;
            const item = el('li', 'story-block-dice-problem', line);
            item.dataset.kind = problem.kind;
            list.appendChild(item);
        }
        box.append(head, list, el('div', 'story-block-dice-handed', `Story Block rolled: ${formatRolls(rolls)}`));
        return box;
    }
    if (Array.isArray(rolls) && !rolls.length) {
        return el('div', 'story-block-dice-honesty is-unverified', 'Rolls not verified: Story Block handed over no dice for this reply');
    }
    return null;
}

export function render(pane, {
    def,
    state,
    rolls = null,
    error = null,
    truncated = false,
    onEdit = null,
    uiKey = null,
    animate = false,
} = {}) {
    const text = plainTextOf(state).replace(/\r\n?/g, '\n').trim();
    // A cut-off block is where a line parser is confidently wrong: "→ 1" may be the start
    // of "→ 17", and the check would then accuse the model. Cut-off text shows as text.
    const parsed = text && !truncated ? parseDice(text) : null;
    if (text && !parsed) {
        pane.classList.remove('story-block-display-dice');
        renderPlain(pane, { def, state, error, truncated, onEdit });
        return;
    }
    pane.classList.remove('story-block-display-plain');

    renderFrame(pane, {
        def, error, truncated, onEdit,
        display: 'dice',
        summary: parsed ? plural(parsed.rolls.length, 'roll') : '',
    });
    if (!parsed) {
        renderEmpty(pane, emptyText(def, state));
        return;
    }

    const handed = Array.isArray(rolls) ? rolls : null;
    const check = checkRolls(parsed, handed);
    const problemsAt = index => (check.checked ? check.problems.filter(problem => problem.index === index) : []);
    const spin = Boolean(animate) && !prefersReducedMotion() && firstSpin(uiKey ?? def?.id, text);

    const body = el('div', 'story-block-display-body story-block-dice');
    const list = el('ol', 'story-block-dice-list');
    list.setAttribute('aria-label', blockName(def));
    parsed.rolls.forEach((roll, index) => list.appendChild(rollCard(roll, { animate: spin, problems: problemsAt(index) })));
    body.appendChild(list);

    const honesty = honestyLine(check, handed);
    if (honesty) body.appendChild(honesty);
    pane.appendChild(body);
}
