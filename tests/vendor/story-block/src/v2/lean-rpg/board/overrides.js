// Keeps reader-edited skill flags as reply-owned, add-only entries.
// Defaults stay in flags.js; this domain stores only explicit choices and can replay a middle delete.
// The command reads the current sheet and writes the editing reply's own keyed entry.

import { CORE_FEATURE } from '../../features.js';
import { fold, readSheet } from '../read.js';
import { BOARD_SKILL, BOARD_SKILL_CARRY } from '../names.js';
import { skillKey } from './flags.js';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const flagsValid = value => object(value) && Object.keys(value).length === 3 && ['target', 'area', 'defence'].every(key => typeof value[key] === 'boolean');

/** Latest explicit choices for each skill, derived from the entries that survived replay. */
export function boardFlags(state) {
    const entries = Object.values(state?.domains?.dataModules?.boardFlags ?? {}).flatMap(group => Object.values(object(group) ? group : {}))
        .filter(entry => object(entry) && typeof entry.key === 'string' && flagsValid(entry.flags));
    entries.sort((a, b) => a.rev - b.rev || String(a.id).localeCompare(String(b.id)));
    return Object.fromEntries(entries.map(entry => [entry.key, entry.flags]));
}

// Writes `flags` as the editing reply's own entry for `key`, pruning older replies' entries for that key.
function writeEntry(ctx, key, flags) {
    const sid = ctx.reply.sid, id = ctx.id('edit');
    const domain = ctx.draft('dataModules');
    domain.boardFlags ??= {};
    // A newer reply may prune older entries for this skill; replay ignores a remove already gone.
    for (const [owner, group] of Object.entries(domain.boardFlags)) {
        if (owner === sid) continue;
        for (const [entryId, entry] of Object.entries(group)) if (entry.key === key) delete group[entryId];
        if (!Object.keys(group).length) delete domain.boardFlags[owner];
    }
    domain.boardFlags[sid] ??= {};
    domain.boardFlags[sid][id] = { id, key, flags: { ...flags }, rev: ctx.rev };
}

const find = (ctx, payload, name) => {
    const actor = readSheet({ domains: { dataModules: ctx.read('dataModules') } }).characters.find(entry => entry.module === payload.module);
    const skill = actor?.skills.find(entry => entry.slot === payload.slot && fold(entry.name) === fold(name));
    return { actor, skill };
};

export function createBoardPart() {
    const edit = Object.assign((ctx, payload) => {
        if (ctx.cause !== 'ui' || !ctx.reply?.sid) ctx.fail('REFUSED', 'Only the reader can edit a skill.');
        if (!flagsValid(payload?.flags)) ctx.fail('INVALID', 'Choose the three skill flags.');
        const { actor, skill } = find(ctx, payload, payload.name);
        if (!skill) ctx.fail('REFUSED', 'That skill is no longer on the sheet.');
        writeEntry(ctx, skillKey(actor.module, skill), payload.flags);
        return { summary: 'Skill choices saved.', narrate: false };
    }, { feature: CORE_FEATURE.fightBoard });
    // A rename keeps the reader's explicit flags even while the board is off (no feature gate): it moves an
    // existing entry from the old name to the new one and never makes flags from defaults.
    const carry = (ctx, payload) => {
        if (ctx.cause !== 'ui' || !ctx.reply?.sid) ctx.fail('REFUSED', 'Only the reader can edit a skill.');
        if (typeof payload?.from !== 'string' || typeof payload?.name !== 'string' || !Number.isSafeInteger(payload?.slot)) ctx.fail('INVALID', 'Name the skill and its new name.');
        const { actor, skill } = find(ctx, payload, payload.name);
        if (!skill) ctx.fail('REFUSED', 'That skill is no longer on the sheet.');
        const old = boardFlags({ domains: { dataModules: ctx.read('dataModules') } })[skillKey(actor.module, { slot: payload.slot, name: payload.from })];
        if (!old) return { summary: 'No skill choices to carry.', narrate: false };
        writeEntry(ctx, skillKey(actor.module, skill), old);
        return { summary: 'Skill choices carried.', narrate: false };
    };
    return { commands: { [BOARD_SKILL]: edit, [BOARD_SKILL_CARRY]: carry } };
}
