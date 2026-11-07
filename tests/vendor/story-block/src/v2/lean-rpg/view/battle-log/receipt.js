// The battle log's folded Receipt row: the exact cue text the narrator was told, plus the rule numbers in force.
// It is closed by default and its state is local to the node; every string is written through textContent.

import { words } from './util.js';

const TOLD = 'What the narrator was told:';
const RULES = 'Rules in force:';
const CLOSED = 'Receipt ▸';
const OPEN = 'Receipt ▾';
const integer = value => (Number.isSafeInteger(value) ? value : null);

// `receipt` is a cue string (step 2's `cueOfResult(result, shape)`), or `{ text }` from a reader that wraps it.
function cueOf(model) {
    const input = model?.receipt;
    const text = typeof input === 'string' ? input : typeof input?.text === 'string' ? input.text : '';
    return text.trim() ? text : '';
}

function rulesOf(model) {
    const input = model?.receipt && typeof model.receipt === 'object' ? model.receipt : {};
    const pace = words(input.pace ?? model?.pace, 12);
    const cap = integer(input.cap) ?? integer(model?.cap) ?? integer(input.rules?.roundCap) ?? integer(model?.rules?.roundCap);
    const margin = integer(input.margin) ?? integer(input.decisiveMargin) ?? integer(model?.rules?.decisiveMargin) ?? integer(model?.margin);
    const flow = integer(input.flow) ?? integer(model?.flow);
    const terms = [];
    // A board fight's pace and cap are fixed scaffolding, not limits on the reader's choices.
    if (model?.board !== true && pace) terms.push(`pace ${pace}`);
    if (model?.board !== true && cap !== null) terms.push(`up to ${cap} exchanges`);
    if (margin !== null) terms.push(`decisive margin ${margin}`);
    if (flow) terms.push(`flow ${flow}`);
    return terms.join(' · ');
}

/**
 * A folded Receipt row for `model`, or null when there is no cue text. `model.receipt` is the exact narrator cue;
 * the row also reads `pace`, `cap`, `flow`, `board` and `rules.decisiveMargin` for the numbers in force.
 */
export function buildReceipt(doc, model) {
    const cue = cueOf(model);
    if (!cue) return null;
    const details = doc.createElement('details');
    details.className = 'rpg-bl-receipt';
    const summary = doc.createElement('summary');
    const pre = doc.createElement('pre');
    const rules = rulesOf(model);
    pre.textContent = `${TOLD}\n${cue}${rules ? `\n\n${RULES} ${rules}` : ''}`;
    const setOpen = open => {
        details.open = open;
        pre.hidden = !open;
        summary.textContent = open ? OPEN : CLOSED;
        summary.setAttribute('aria-expanded', String(open));
    };
    pre.hidden = true;
    summary.textContent = CLOSED;
    summary.setAttribute('aria-expanded', 'false');
    summary.addEventListener('click', event => {
        event.preventDefault();
        setOpen(!details.open);
    });
    details.append(summary, pre);
    return details;
}
