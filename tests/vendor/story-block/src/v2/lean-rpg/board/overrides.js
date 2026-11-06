// Keeps reader-edited skill flags as reply-owned, add-only entries.
// Defaults stay in flags.js; this domain stores only explicit choices and can replay a middle delete.
// The command reads the current sheet and writes the editing reply's own keyed entry.

import { CORE_FEATURE } from '../../features.js';
import { fold, readSheet } from '../read.js';
import { BOARD_SKILL } from '../names.js';
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

export function createBoardPart() {
    const edit = Object.assign((ctx, payload) => {
        if (ctx.cause !== 'ui' || !ctx.reply?.sid) ctx.fail('REFUSED', 'Only the reader can edit a skill.');
        if (!flagsValid(payload?.flags)) ctx.fail('INVALID', 'Choose the three skill flags.');
        const actor = readSheet({ domains: { dataModules: ctx.read('dataModules') } }).characters.find(entry => entry.module === payload.module);
        const skill = actor?.skills.find(entry => entry.slot === payload.slot && fold(entry.name) === fold(payload.name));
        if (!skill) ctx.fail('REFUSED', 'That skill is no longer on the sheet.');
        const key = skillKey(actor.module, skill), sid = ctx.reply.sid, id = ctx.id('edit');
        const domain = ctx.draft('dataModules');
        domain.boardFlags ??= {};
        // A newer reply may prune older entries for this skill; replay ignores a remove already gone.
        for (const [owner, group] of Object.entries(domain.boardFlags)) {
            if (owner === sid) continue;
            for (const [entryId, entry] of Object.entries(group)) if (entry.key === key) delete group[entryId];
            if (!Object.keys(group).length) delete domain.boardFlags[owner];
        }
        domain.boardFlags[sid] ??= {};
        domain.boardFlags[sid][id] = { id, key, flags: { ...payload.flags }, rev: ctx.rev };
        return { summary: 'Skill choices saved.', narrate: false };
    }, { feature: CORE_FEATURE.fightBoard });
    return { commands: { [BOARD_SKILL]: edit } };
}
