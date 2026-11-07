// Who is present in the scene: the names that come along to a place, the `+ present` and `- present` changes, and the reader's
// list editor (`scene.present` with `set`). Pure. The place part (place.js) uses `companions` for who came along.

import { cleanName } from '../names.js';
import { STRINGS, fill } from '../../strings.js';
import { MAX_NAME, MAX_PRESENT } from './constants.js';
import { nameList, told } from './shared.js';

const E = STRINGS.editMessages;

// Who came along to a new place: `with` as a name, a comma list or a list of names.
export function companions(ctx, value) {
    const names = [];
    for (const raw of nameList(value).flatMap(item => (typeof item === 'string' ? item.split(',') : [item]))) {
        if (typeof raw !== 'string') ctx.fail('INVALID', 'Say who comes along by name.');
        const name = cleanName(raw);
        if (!name) continue;
        if (name.length > MAX_NAME) ctx.fail('INVALID', `A name is at most ${MAX_NAME} characters.`);
        if (!names.some(other => other.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    if (names.length > MAX_PRESENT) ctx.fail('INVALID', `At most ${MAX_PRESENT} people can be listed as present.`);
    return names;
}

export function changePresent(ctx, { add, remove }) {
    const scene = ctx.draft('scene');
    const index = name => scene.present.findIndex(other => other.toLowerCase() === name.toLowerCase());
    const added = [];
    const removed = [];
    const missing = [];
    // Who arrives is there once: replayed after a reply that took them out was deleted, the add is passed over.
    ctx.unique('scene', '/present');
    for (const raw of nameList(remove)) {
        const name = typeof raw === 'string' ? cleanName(raw) : '';
        if (!name) ctx.fail('INVALID', 'Say who leaves.');
        const at = index(name);
        // The story often says who stays behind after a move, which already left them: nothing to undo.
        if (at < 0 && ctx.cause === 'story') {
            missing.push(name);
            continue;
        }
        if (at < 0) ctx.fail('NOT_FOUND', `${name} is not in the scene.`);
        removed.push(scene.present[at]);
        scene.present.splice(at, 1);
    }
    for (const raw of nameList(add)) {
        const name = typeof raw === 'string' ? cleanName(raw) : '';
        if (!name) ctx.fail('INVALID', 'Say who arrives.');
        if (name.length > MAX_NAME) ctx.fail('INVALID', `A name is at most ${MAX_NAME} characters.`);
        if (index(name) >= 0) continue;   // already here: nothing to change
        scene.present.push(name);
        added.push(name);
    }
    const parts = [];
    if (added.length) parts.push(`${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} here`);
    if (removed.length) parts.push(`${removed.join(', ')} ${removed.length === 1 ? 'leaves' : 'leave'}`);
    const away = missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not here.` : '';
    return {
        summary: parts.length ? `${parts.join('; ')}.` : away || 'No one arrives or leaves.',
        data: { added, removed, present: [...scene.present], ...(missing.length ? { missing } : {}) },
        narrate: told(ctx) && parts.length > 0,
    };
}

// The list editor replaces the whole set of names with one reader command. Existing add/remove
// actions keep their semantics for story lines and module calls.
export function setPresent(ctx, value) {
    if (ctx.cause !== 'ui' || ctx.caller !== null) ctx.fail('REFUSED', E.presentReader);
    if (!Array.isArray(value)) ctx.fail('INVALID', E.presentList);
    const scene = ctx.draft('scene');
    const before = scene.present;
    const present = companions(ctx, value);
    // The names the reader adds are there once: replayed after a reply that took one out was deleted, that add is passed over.
    ctx.unique('scene', '/present');
    scene.present = present;
    return { summary: fill(E.presentSummary, { names: present.join(', ') || E.nobody }),
        data: { added: present.filter(name => !before.includes(name)), removed: before.filter(name => !present.includes(name)), present: [...present] }, narrate: true };
}

/** `+ present Name`, `- present Name` (several names may be separated by commas). */
export function capturePresent(ctx, line) {
    const names = String(line?.name ?? '').split(',').map(cleanName).filter(Boolean);
    if (!names.length) ctx.fail('INVALID', 'A present line needs a name.');
    if (line.op === '+') return changePresent(ctx, { add: names });
    if (line.op === '-') return changePresent(ctx, { remove: names });
    return ctx.fail('INVALID', `"${line.op} present" is not a change the scene understands; use + present or - present.`);
}
