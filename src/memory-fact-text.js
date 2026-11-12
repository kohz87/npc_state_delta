// Memory facts (design MEMDESIGN2 §2, §9): the fallback sentence of each fact kind and its CLOSED sentence grammar. A fact's typed payload
// expands into a small finite set of allowed sentences (the first is the code's fallback); the model may only pick one of them. Nothing
// else (an extra clause, a swapped role, a changed polarity) is accepted, so every claim is checkable. Pure functions.

export const FACT_KINDS = Object.freeze(['met', 'milestone', 'move', 'gift', 'lieCaught', 'quest', 'fight', 'party']);
export const MAX_SENTENCE = 200;       // Unicode code points of one response sentence
export const MAX_LITERAL = 80;         // a name, title or label placed in a sentence

const AXIS = Object.freeze({
    trust: { up: ['My trust in {P} rose.', 'My trust in {P} grew.'], down: ['My trust in {P} fell.', 'My trust in {P} dropped.'] },
    affection: { up: ['My affection for {P} rose.', 'My affection for {P} grew.'], down: ['My affection for {P} fell.', 'My affection for {P} dropped.'] },
    desire: { up: ['My desire for {P} rose.', 'My desire for {P} grew.'], down: ['My desire for {P} fell.', 'My desire for {P} dropped.'] },
    tension: { up: ['The tension between {P} and me rose.', 'The tension between {P} and me grew.'], down: ['The tension between {P} and me fell.', 'The tension between {P} and me eased.'] },
});
export const AXES = Object.freeze(Object.keys(AXIS));
const QUEST_VERB = Object.freeze({ opened: 'was opened', offered: 'was offered', accepted: 'was accepted', complete: 'was marked complete', failed: 'was marked failed' });

// A literal slot is safe when it is one short line of plain characters with no quote marks of its own: a longer or odd one is not truncated
// into a different fact, the option is simply unavailable.
export function safeLiteral(value, max = MAX_LITERAL) {
    const text = typeof value === 'string' ? value.normalize('NFC').trim() : '';
    if (!text || [...text].length > max) return '';
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029"“”<>`\\]/.test(text)) return '';
    return text;
}

export function playerLabel(value) { return safeLiteral(value, 60) || 'the player'; }

// Bounded, typed payload of one kind (what is stored): null when the kind or an essential value is missing or unsafe.
export function cleanPayload(kind, raw = {}) {
    const p = playerLabel(raw.player);
    if (kind === 'met') {
        const place = safeLiteral(raw.place);
        return { player: p, ...(place ? { place } : {}) };
    }
    if (kind === 'milestone') { const label = safeLiteral(raw.label); return label ? { label } : null; }
    if (kind === 'move') {
        const axes = {};
        for (const axis of AXES) if (raw.axes?.[axis] === '+' || raw.axes?.[axis] === '-') axes[axis] = raw.axes[axis];
        return Object.keys(axes).length ? { player: p, axes } : null;
    }
    if (kind === 'gift') return raw.action === 'gift' || raw.action === 'help' ? { player: p, action: raw.action } : null;
    if (kind === 'lieCaught') { const to = safeLiteral(raw.to); return to ? { to } : null; }
    if (kind === 'quest') { const title = safeLiteral(raw.title); return title && QUEST_VERB[raw.phase] ? { title, phase: raw.phase } : null; }
    if (kind === 'fight') {
        if (raw.side !== 'beside' && raw.side !== 'against') return null;
        return { player: p, side: raw.side, ...(['won', 'lost', 'fled'].includes(raw.result) ? { result: raw.result } : {}) };
    }
    if (kind === 'party') return raw.action === 'join' || raw.action === 'leave' ? { action: raw.action } : null;
    return null;
}

const sub = (template, p) => template.replaceAll('{P}', p);

// Every allowed sentence for a payload, fallback first. Several axes combine in canonical axis order, each clause's direction proven.
export function productions(kind, payload) {
    const p = payload || {};
    if (kind === 'met') return p.place ? [`I first met ${p.player} at ${p.place}.`, `At ${p.place}, I first met ${p.player}.`] : [`I first met ${p.player}.`];
    if (kind === 'milestone') return [`Milestone recorded: “${p.label}”.`];
    if (kind === 'move') {
        const axes = AXES.filter(axis => p.axes?.[axis]);
        if (axes.length === 1) return AXIS[axes[0]][p.axes[axes[0]] === '+' ? 'up' : 'down'].map(text => sub(text, p.player));
        const clause = axis => {
            const text = sub(AXIS[axis][p.axes[axis] === '+' ? 'up' : 'down'][0], p.player);
            return text.slice(0, -1).replace(/^My /, 'my ').replace(/^The /, 'the ');
        };
        const joined = axes.map(clause);
        const last = joined.pop();
        const body = `${joined.length ? `${joined.join(', ')} and ` : ''}${last}`;
        return [`${body.charAt(0).toUpperCase()}${body.slice(1)}.`];
    }
    if (kind === 'gift') return p.action === 'gift' ? [`I received a gift from ${p.player}.`, `${p.player} gave me a gift.`] : [`${p.player} helped me.`, `I was helped by ${p.player}.`];
    if (kind === 'lieCaught') return [`My lie to ${p.to} was caught.`, `I was caught lying to ${p.to}.`];
    if (kind === 'quest') return [`The task “${p.title}” ${QUEST_VERB[p.phase]}.`];
    if (kind === 'fight') {
        const base = p.side === 'beside' ? `I fought beside ${p.player}` : `I fought against ${p.player}`;
        const tail = p.result ? { won: ', and the party won', lost: ', and the party lost', fled: ', and the party fled' }[p.result] : '';
        return [`${base}${tail}.`];
    }
    if (kind === 'party') return [p.action === 'join' ? 'I joined the party.' : 'I left the party.'];
    return [];
}

export function fallbackText(kind, payload) { return productions(kind, payload)[0] || ''; }

// A model sentence is accepted only when, after NFC and nothing else, it equals one allowed production. Raw newlines/controls, markup,
// oversize or a second sentence fail before any whitespace normalisation (they can never equal a production).
export function validPhrasing(kind, payload, sentence) {
    if (typeof sentence !== 'string') return null;
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/.test(sentence)) return null;
    const text = sentence.normalize('NFC');
    if ([...text].length > MAX_SENTENCE) return null;
    return productions(kind, payload).includes(text) ? text : null;
}
