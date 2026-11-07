// Story Suite v2: the command bus's replay-guard side: finding a module's `hooks.replayGuard`, asking it about a
// stored block on the state before that block, and the mark that says whose guards a checkpoint was made under.
// commands.js keeps createCommandBus and attaches these to the store.

import { clone, deepFreeze, frozenCopy } from '../ops.js';
import { hashJson } from '../replay.js';
import { rpgLib } from '../rpg-lazy.js';
import { isRecord } from './shared.js';

export function createGuards({ registry, findQuery }) {
    // The module's own `hooks.replayGuard`, whatever its features say: replaying a chat must not depend on
    // what the reader turned off since.
    function guardHook(moduleId) {
        for (const def of registry.modules?.() ?? []) if (def?.id === moduleId) return typeof def.hooks?.replayGuard === 'function' ? def.hooks.replayGuard : null;
        return null;
    }

    // The context a guard is asked in on replay (REPLAY.md "Guards are pure"): the state before its block and what it recorded,
    // nothing else. `query` answers only the queries its owner module declares as replay-safe (`replayQueries: [names]`: they
    // depend on the state and their arguments alone, not on settings, the clock or other messages); anything else, and
    // `receipts()` (the chat after the block is not part of what it was recorded over), throws, which fails the guard closed.
    // What a guard needs from outside (a setting, a currency rule) is read when the block is planned and handed to
    // `ctx.replayGuard(guard, recorded)`, and comes back from the record.
    // `story.evidence` is the host's own and is always allowed: it reads the state's pins and the proof of the blocks that applied
    // before the block (the prefix), and nothing else (docs/v2/EVIDENCE.md).
    function replayQuery(owner, name) {
        if (name === 'story.evidence') return findQuery(name);
        for (const def of registry.modules?.() ?? []) {
            if (def?.id === owner && typeof def.queries?.[name] === 'function' && Array.isArray(def.replayQueries) && def.replayQueries.includes(name)) return def.queries[name];
        }
        return null;
    }
    function replayTools(owner, state) {
        const tools = Object.freeze({
            reply: null,
            query(name, args) {
                const fn = replayQuery(owner, name);
                if (!fn) throw new Error(`"${name}" is not a query a guard may ask on replay: ${owner} lists the ones that depend on the state alone in replayQueries; anything else it needs it records`);
                return frozenCopy(fn(state, deepFreeze(clone(args)), tools));
            },
            receipts() {
                throw new Error('a guard does not see receipts on replay: only the state before its block and what it recorded');
            },
        });
        return tools;
    }

    // What the store asks on replay: `hooks.replayGuard({ state, query, hash }, { guard, source, block,
    // operation, recorded, payload: { saved, current } })` of the guard's owner, on the state before the block. { ok: true } or { ok: false,
    // reason }; no hook, a throw, a promise or a malformed answer is { ok: false } (fails closed).
    function replayGuardCheck(state, info) {
        const owner = info?.guard?.owner;
        const hook = typeof owner === 'string' ? guardHook(owner) : null;
        if (!hook) return { ok: false, reason: `${owner} has no replayGuard hook to check it` };
        // A module that is held back (dormant, or the restore barrier is up) is not asked: its blocks stay off
        // until it is ready, and are asked again then (the store looks again when the mark changes).
        if (registry.held?.(owner) === true) return { ok: false, reason: `${owner} is not ready` };
        let answer;
        try {
            const tools = replayTools(owner, state);
            const view = Object.freeze({ state, query: tools.query, hash: hashJson });
            answer = hook(view, deepFreeze(clone({ guard: info.guard, source: info.source, block: info.block, operation: info.operation, recorded: info.recorded ?? null, payload: info.payload ?? null })));
        } catch (error) {
            // The store records thrown guards even when this is a tentative plan that will not be stored.
            throw error;
        }
        if (answer && typeof answer.then === 'function') {
            answer.then(null, () => {});
            return { ok: false, reason: `${owner}'s replayGuard did not answer at once` };
        }
        if (isRecord(answer) && answer.ok === true) return { ok: true };
        if (isRecord(answer) && answer.ok === false && typeof answer.reason === 'string' && answer.reason) return { ok: false, reason: answer.reason };
        return { ok: false, reason: `${owner}'s replayGuard gave an answer that is neither { ok: true } nor { ok: false, reason }` };
    }

    // Changes when a module with a guard hook registers, goes, or turns ready or dormant: the store looks again at
    // its guarded blocks.
    // A checkpoint over guarded blocks keeps the mark it was made under (store.js chain): a different owner set, or a new
    // version of an owner (its guard code may answer otherwise), makes it fail and the prefix replays with the guards asked.
    // (the host's own hook, `hostOwned`, answers from the story alone, whoever is ready: it is no owner whose readiness changes an answer)
    // (The RPG's code is loaded on demand, rpg-lazy.js: while it is missing the stand-in's guard answers for none of its blocks, so a checkpoint made then must not be trusted
    // once the code is there, nor the other way round: the mark says `rpg:missing` while it is; loaded, the mark is what it always was, so the checkpoints of a chat stay trusted.)
    const guardMark = () => `${(registry.modules?.() ?? [])
        .filter(def => typeof def?.hooks?.replayGuard === 'function' && def.hooks.replayGuard.hostOwned !== true && registry.held?.(def.id) !== true).map(def => `${def.id}@${def.version ?? ''}`).join(',')}${rpgLib() ? '' : ';rpg:missing'}`;

    return { guardHook, replayGuardCheck, guardMark };
}
