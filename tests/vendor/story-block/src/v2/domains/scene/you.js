// {{user}}'s look (`~ you rank: … | wearing: … | condition: …`, and the `scene.you` command): their Rank when a pack gives one,
// what they wear and how they are. Descriptive only; the story's line or a reader's edit sets the parts. Pure.

import { isPlainObject } from '../common.js';
import { lineBody } from '../../capture.js';
import { cutPoints, flatten } from '../../extras.js';
import { YOU_CHARS, YOU_PARTS } from './constants.js';
import { HAS_WORD } from './shared.js';

// The Rank's label the first enabled pack that declares one gives ('' when no pack does: this story has no Rank).
export function rankLabelIn(query) {
    try {
        const found = query('packs.youRank', {});
        return typeof found?.label === 'string' ? found.label : '';
    } catch { return ''; }
}

/**
 * `scene.you({ rank?, wearing?, condition? })`: {{user}}'s standing, what they wear and how they are, from the reader (the pencils on Home) or a
 * module, never the story (it writes `~ you`). A part that is given replaces that part, '' clears it; a part left out stays.
 */
export function setYou(ctx, payload = {}) {
    if (ctx.cause === 'story') ctx.fail('REFUSED', 'The story writes your look with a ~ you line.');
    const parts = {};
    for (const part of YOU_PARTS) {
        const value = payload?.[part];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') ctx.fail('INVALID', `Your ${part} must be text.`);
        parts[part] = youText(value);
    }
    if (!Object.keys(parts).length) ctx.fail('INVALID', 'Say what you wear or how you are.');
    return changeYou(ctx, parts);
}

// Puts the given parts into the scene: a part that differs replaces that part only (one op each, so a replay after an earlier
// reply was deleted keeps the other part as the replies still there left it). Nothing differs: nothing is written.
function changeYou(ctx, parts, { dropRank = false } = {}) {
    // Rank comes from a pack: a story with none has no Rank, so a call that names it is refused (nothing saved). A story's line keeps
    // its other parts (`dropRank`): only the rank is left out, with one plain Problem.
    let problem = '';
    if (parts.rank !== undefined && !rankLabelIn(ctx.query)) {
        problem = 'This story has no rank, so "rank" was not used (a pack can give your character one).';
        if (!dropRank || Object.keys(parts).length < 2) ctx.fail('INVALID', problem);
        parts = { ...parts };
        delete parts.rank;
    }
    const scene = ctx.draft('scene');
    const held = isPlainObject(scene.you) ? scene.you : null;
    const now = part => (typeof held?.[part] === 'string' ? held[part] : '');
    const next = held ? { ...held } : { rank: '', wearing: '', condition: '' };
    const said = [];
    for (const part of YOU_PARTS) {
        if (parts[part] === undefined || parts[part] === now(part)) continue;
        next[part] = parts[part];
        said.push(parts[part] ? `${part} ${parts[part]}` : `${part} cleared`);
    }
    const data = part => parts[part] === undefined ? now(part) : parts[part];
    const told = problem ? { problem } : {};
    if (!said.length) return { summary: 'Your look stays.', data: { rank: now('rank'), wearing: now('wearing'), condition: now('condition'), same: true }, narrate: false, ...told };
    scene.you = next;
    return { summary: `Your look: ${said.join('; ')}.`, data: { rank: data('rank'), wearing: data('wearing'), condition: data('condition') }, narrate: false, ...told };
}

/**
 * `~ you rank: F-rank, Adventurer Guild | wearing: oilskin coat, boots | condition: tired and cold` (or `+ you`): {{user}}'s
 * standing, what they wear and how they are,
 * descriptive only (no mechanics read it). Either part alone is fine and the other stays; an empty one clears its part. Kept as
 * `scene.you = { rank, wearing, condition }`, each part written on its own, and `you` is one of the scene's `scratch` fields, so a
 * later reply's write replays after the reply that first wrote one is deleted (SPEC §2.2).
 */
export function captureYou(ctx, line) {
    if (line?.op !== '~' && line?.op !== '+') {
        ctx.fail('INVALID', `"${line?.op} you" is not a change the scene understands; use ~ you rank: … | wearing: … | condition: ….`);
    }
    const fallback = `~ you ${[`${line?.name ?? ''}${line?.text ? ` - ${line.text}` : ''}`, ...Object.entries(line?.labels ?? {}).map(([label, value]) => `${label}: ${value}`)].join(' | ')}`;
    const parts = youParts(line?.raw ?? fallback);
    if (!Object.keys(parts).length) ctx.fail('INVALID', 'The you line names no part of your look (write "~ you rank: F-rank | wearing: a grey coat | condition: tired").');
    return changeYou(ctx, parts, { dropRank: true });
}

// A part of {{user}}'s look as stored: plain words on one line (markdown, tags and invisible characters gone), cut by code
// points; '' (which clears the part) when it holds no word.
export function youText(raw) {
    const text = flatten(lineBody(`~ you ${raw ?? ''}`).replace(/<[^>]*>?/g, ' ').replace(/[<>]/g, ' '));
    return HAS_WORD.test(text) ? cutPoints(text, YOU_CHARS) : '';
}

// The words a change line may call each part.
const YOU_LABELS = Object.freeze({ rank: 'rank', standing: 'rank', wearing: 'wearing', wear: 'wearing', wears: 'wearing', worn: 'wearing', outfit: 'wearing', clothes: 'wearing', clothing: 'wearing', condition: 'condition', state: 'condition' });

/**
 * The parts a `~ you` line gives: `{ rank?, wearing?, condition? }` from "rank: … | wearing: … | condition: …" (any of them is fine; a part
 * with no words is '', which clears it). A piece after a `|` with no label of its own goes on the part before it; one with a
 * label that is not a part ("mood: glad") is not used.
 */
export function youParts(raw) {
    const found = {};
    let last = null;
    for (const piece of lineBody(String(raw ?? '')).split('|')) {
        const named = /^\s*(\p{L}+)\s*:\s*([\s\S]*)$/u.exec(piece);
        const part = named ? YOU_LABELS[named[1].toLowerCase()] : null;
        if (part) {
            found[part] = named[2];
            last = part;
        } else if (named) last = null;   // a label that is not one of the parts: not used, and not part of the one before
        else if (last && piece.trim()) found[last] = `${found[last].trimEnd()}, ${piece.trim()}`;
    }
    for (const part of Object.keys(found)) found[part] = youText(found[part]);
    return found;
}

/**
 * The one-line ask while Wearing or Condition is still empty (and the feature is on): write the empty parts on this reply, from what the
 * narrator already knows. The Rank is asked only when a pack gives a rank word (`rankLabel`) and it is empty. '' once both are set, so
 * the tail is then the same as without the note. It only asks for empty parts: nothing the reader set is ever overwritten.
 */
export function youNote(you, rankLabel = '') {
    const empty = part => !(typeof you?.[part] === 'string' && you[part]);
    const wanted = ['wearing', 'condition'].filter(empty);
    if (!wanted.length) return '';
    if (rankLabel && empty('rank')) wanted.unshift('rank');
    return `Your look is not set yet: on this reply write ~ you ${wanted.map(part => `${part}: …`).join(' | ')} for {{user}}, from the persona and what they carry.`;
}
