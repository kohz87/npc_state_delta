// The data modules' story and reader actions (extracted from data-modules/part.js): guessing
// a missing kind, foe levels, skill lines and the guarded `dm.act` evaluation.
import { dmOwn, dmKindWritesHidden } from '../schema.js';
import { dataModuleHash } from '../check.js';
import { copy, refuse, DataModuleError, createEvaluation, parseLabels, orList, atPath } from '../interpreter.js';
import { activeDefinition, inputsOf, instanceOf, resolveActor } from '../adapters.js';
import { hashJson } from '../../replay.js';
import { fold, readSheet } from '../../lean-rpg/read.js';
import { LEAN_RPG_FEATURE } from '../../lean-rpg/names.js';
import { XP_RATE, scaleXp, xpRateFrom } from '../../lean-rpg/levels.js';
import { averageLevel, bandOfRank, foeRandom, foeLevelCap, levelOf, partyLevels, pickLevel } from '../../lean-rpg/foes.js';
import { SKILL_SLOTS_MAX } from '../../skill-slots.js';
import { B, rpg, draftOf, stateOf, pairKey, subjectsOf, instancePath, prefixImports } from './shared.js';
import { skillCapacity } from './skills.js';
import { namedChanges } from './prompt.js';

const PRACTICE_KIND = new RegExp(`^practice-[1-${SKILL_SLOTS_MAX}]$`, 'u');

export function createAct(deps) {
    const { dependency, guard, finish, growSkills, skillRoute, skillRoom, skillWant, settings } = deps;
    // A story line with no `kind:` (a model often leaves it out, or puts a label like `letter: F` where `kind: promote` belongs): when exactly
    // one kind of this module, written with the line's op, accepts the line's labels as they are, that is its kind; with none or several
    // the line is refused as before (kind must be …), never guessed. → the line's labels, with `kind` added when it was found.
    function withKind(definition, line) {
        const labels = line.labels ?? {};
        if (dmOwn(labels, 'kind')) return labels;
        const fits = Object.keys(definition.kinds).filter(name => {
            if (definition.kinds[name].op !== line.op) return false;
            try { parseLabels(definition, definition.kinds[name], { ...labels, kind: name }, { text: true }); return true; } catch (error) {
                if (error instanceof DataModuleError) return false;
                throw error;
            }
        });
        return fits.length === 1 ? { ...labels, kind: fits[0] } : labels;
    }
    // A Foes block of the Levels rules (its set-slot kind has a `level` label): a line that gives a level keeps it; one that gives a rank gets a level drawn inside that
    // rank's band (the `rpg.rank` query names the ranks); one that gives neither gets a level within ±2 of the party's average. The draw is from the reply's seed, so a
    // swipe draws anew and a Re-read keeps it. `rank` is not a label of the kind: it is taken out of the line here.
    function foeLevelLabels(labels, kind, prefix, ctx, module) {
        if (!kind.labels?.level || !/^set-slot-\d$/u.test(labels.kind)) return labels;
        const { rank, ...rest } = labels;
        // A group already on the block, named again with no level and no rank, keeps the level it has: it is not drawn anew (a swipe would otherwise move a fight's foes).
        const have = prefix.domains?.dataModules?.instances?.[module]?.chat?.fields;
        const known = !dmOwn(rest, 'level') && !(typeof rank === 'string' && rank.trim()) && typeof rest.name === 'string' && have
            ? [1, 2, 3, 4].find(n => typeof have[`foe${n}`] === 'string' && have[`count${n}`] > 0 && fold(have[`foe${n}`]) === fold(rest.name) && Number.isSafeInteger(have[`level${n}`])) : undefined;
        if (known !== undefined) return { ...rest, level: String(have[`level${known}`]) };
        // A level or rank above one band (10 levels) over the party's highest level is held down to it.
        const levels = partyLevels(readSheet({ domains: { dataModules: prefix.domains?.dataModules } })), cap = foeLevelCap(levels);
        if (dmOwn(rest, 'level')) { const given = levelOf(rest.level); return given === null ? rest : { ...rest, level: String(Math.min(given, cap)) }; }
        const band = typeof rank === 'string' && rank.trim() ? bandOfRank(rank, level => ctx.query('rpg.rank', { level })) : null;
        const ask = band ? { from: Math.min(band.from, cap), to: Math.min(band.to, cap) } : {};
        return { ...rest, level: String(Math.min(cap, pickLevel(ask, averageLevel(levels), foeRandom(Math.floor(ctx.rng() * 4294967296) >>> 0, 0)))) };
    }
    function act(ctx, payload, line = null, call = {}) {
        if (ctx.caller !== null) refuse('REFUSED', '', 'A data action cannot be called by another module.');
        const prefix = stateOf(ctx), module = deps.resolveModule(prefix, line?.name ?? payload.module);
        let definition = activeDefinition(prefix, module);
        call.label = definition?.name ?? module;
        if (!definition) refuse('DM_SCHEMA', '', 'Unsupported or damaged pin.');
        dependency(definition, prefix);
        // A learn line for a Skills block made before the extra slots that would be refused for lack of a slot (every slot it has is full) while the character's level has
        // opened one it lacks: the block is extended first (growSkills). Any other line leaves the block as it is. A Re-read grows it only when the reply, as it stands, holds
        // the grown pin (the live reply did). A learn line that names a slot the block lacks, with a free one below, goes to the free one.
        const shown = definition;
        let grown = null, redirect = null;
        if (line && definition.role === 'skills') {
            const named = withKind(definition, line), fields = instanceOf(prefix, module)?.fields;
            if (fields && /^learn-[1-8]$/u.test(String(named.kind ?? ''))) {
                const probe = skillRoute(fields, named.kind, { name: String(named.name ?? '') }, line.text, skillRoom(prefix, definition, fields));
                const standing = ctx.standing ? activeDefinition({ domains: { dataModules: ctx.standing.domains?.dataModules } }, module) : null;
                // (the guard re-asks the conditions an action answered on the block as it was before; the new slots are empty by construction, so a grown action records none)
                if (probe?.full && skillCapacity(definition) < Math.min(SKILL_SLOTS_MAX, skillWant(prefix, fields)) && (!ctx.standing || (standing && skillCapacity(standing) > skillCapacity(definition)))) {
                    grown = growSkills(ctx, prefix, draftOf(ctx), module);
                    if (grown) definition = grown;
                } else if (probe?.slot && !dmOwn(definition.kinds, named.kind)
                    // (a Re-read redirects only to a slot the reply, as it stands, holds that skill in: a line that was refused then stays refused)
                    && (!ctx.standing || fold(deps.standingBlock(ctx, String(fields.who ?? ''))?.fields?.[`skill${probe.slot}`] ?? '') === fold(String(named.name ?? '')))) redirect = probe.kind;
            }
        }
        let given = line ? withKind(definition, line) : { ...payload.labels, kind: payload.kind, ...(payload.who !== undefined ? { who: payload.who } : {}) };
        if (redirect) given = { ...given, kind: redirect };
        const kind = dmOwn(definition.kinds, given.kind) && definition.kinds[given.kind];
        // A foe group the narrator sets may give `level: N` or `rank: <name>`, or neither: then its level is drawn from the reply's seed (see foeLevelLabels).
        const labels = kind && line && definition.role === 'foes' ? foeLevelLabels(given, kind, prefix, ctx, module) : given;
        if (!kind) refuse('DM_LABEL', 'kind', `kind must be ${orList(Object.keys(shown.kinds))}`);
        if (line ? line.op !== kind.op : ctx.cause !== 'ui' || !kind.ui) refuse('REFUSED', '', line ? `${labels.kind} is written with ${kind.op}, not ${line.op}` : `${labels.kind} is a story line; a screen may only use kinds that allow it`);
        if (line && dmKindWritesHidden(definition, kind)) refuse('REFUSED', '', B.hiddenLine);
        // Practice comes only from rolled skill uses: on a reply captured under that rule (turn.js marks it, `ctx.carrier.practiceRule`; an older reply has no mark
        // and keeps its practice lines on a Re-read, an edit, a rebuild and a reload) the narrator's practice line changes nothing.
        if (ctx.cause === 'story' && definition.role === 'skills' && PRACTICE_KIND.test(labels.kind) && ctx.carrier?.practiceRule === 'rolls') refuse('REFUSED', '', 'Practice comes from rolled skill uses.');
        const args = parseLabels(definition, kind, labels, { text: Boolean(line) });
        // The XP rate (lean-rpg/levels.js): the narrator's XP line for a character is multiplied by the rate in force (the RPG on), which the line's record keeps
        // (`xpRate`, only when it is not 100) so a later change of the setting never moves it; a line recorded without it is 100.
        let xpRate = XP_RATE.default;
        if (ctx.cause === 'story' && definition.role === 'character' && ctx.feature?.(LEAN_RPG_FEATURE) === true) {
            try { xpRate = xpRateFrom(settings()); } catch { xpRate = XP_RATE.default; }
            if (xpRate !== XP_RATE.default) for (const effect of kind.effects ?? []) {
                if (effect?.op === 'add' && Array.isArray(effect.path) && effect.path[0] === 'xp' && Array.isArray(effect.value) && effect.value[0] === 'arg' && Number.isSafeInteger(args[effect.value[1]])) args[effect.value[1]] = scaleXp(args[effect.value[1]], xpRate);
            }
        }
        const subject = definition.scope === 'chat' ? 'chat' : resolveActor(prefix, labels.who, subjectsOf(prefix, module));
        const active = prefix.domains.dataModules.active[module], draft = draftOf(ctx);
        const instance = atPath(draft, instancePath(module, subject)), inputs = inputsOf(prefix, definition);
        // (a line that works a List of entries is told apart by everything it says: two quests in one reply are two lines, the same line twice is one)
        const entryLine = kind.effects?.some(effect => ['entryAdd', 'entrySet', 'entryDrop'].includes(effect?.op));
        const claim = `dm:${pairKey(ctx.source)}:${module}:${labels.kind}:${subject}:${hashJson(entryLine ? args : kind.oncePerReply.map(key => args[key]))}`;
        if (!ctx.claim(claim)) refuse('CLAIMED', '', `${labels.kind} was already applied for this in this reply`);
        const listKey = `${module}:${subject}`, listsKept = draft.perReply[pairKey(ctx.source)]?.lists ?? {};
        const evaluation = createEvaluation(definition, instance, { inputs, source: ctx.source, cursor: ctx.cursor(), subject, lists: copy(listsKept[listKey] ?? {}) });
        const fieldsBefore = copy(instance.fields);
        evaluation.timers();
        // A foe group the narrator sets by a name already on a slot of the same Foes block (the pre-call may have opened this very fight, lean-rpg/open.js)
        // is that group: the slot is updated (count and class), never a second slot with the same name; its health stays as it is.
        const route = definition.role === 'skills' && line ? skillRoute(instance.fields, labels.kind, args, line.text, skillRoom(prefix, definition, instance.fields)) : null;
        if (route?.refuse) refuse('DM_CONDITION', '', route.refuse);
        const same = definition.role === 'foes' && /^set-slot-\d$/u.test(labels.kind) && typeof args.name === 'string'
            ? [1, 2, 3, 4].find(n => typeof instance.fields[`foe${n}`] === 'string' && instance.fields[`count${n}`] > 0 && fold(instance.fields[`foe${n}`]) === fold(args.name)) : undefined;
        if (same !== undefined) evaluation.effects([{ op: 'set', path: [`foe${same}`], value: ['arg', 'name'] }, { op: 'set', path: [`count${same}`], value: ['arg', 'count'] }, { op: 'set', path: [kind.labels.level ? `level${same}` : `class${same}`], value: ['arg', kind.labels.level ? 'level' : 'class'] }], { arg: args });
        else if (route?.update) evaluation.effects(['about', 'stat', 'uses'].map(key => ({ op: 'set', path: [`${key}${route.slot}`], value: ['arg', key] })), { arg: args });
        else {
            const run = route ? definition.kinds[route.kind] : kind;
            if (!evaluation.condition(['kind', route?.kind ?? labels.kind], run.when, { arg: args })) refuse('DM_CONDITION', '', run.refusal ?? 'Kind condition is not met.');
            evaluation.effects(run.effects, { arg: args });
        }
        evaluation.rules();
        const result = evaluation.finish();
        const changes = namedChanges(definition, fieldsBefore, instance.fields);
        const recorded = guard(ctx, prefix, { kind: 'dm.act', module, hash: active.hash, generation: active.generation, subject,
            reads: result.reads.map(read => read.path), imports: prefixImports(definition),
            actor: subject !== 'chat', decision: { args, inputs, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), conds: grown ? [] : result.conds, ...(xpRate !== XP_RATE.default ? { xpRate } : {}), ...(grown ? { grown: dataModuleHash(grown) } : {}) } });
        // The concrete outcome kept beside the inputs (and past the receipts' display data): which line, for whom, what was frozen, what was limited.
        const outcome = { kind: labels.kind, ...(route ? { skill: { slot: route.slot, name: route.update ? route.name : instance.fields[`skill${route.slot}`] } } : {}), subject, decisions: result.decisions.map(({ source: _source, cursor: _cursor, ...rest }) => rest), notes: result.notes, ...(result.fired.length ? { rules: result.fired } : {}) };
        // A story line that writes a character's XP: what the character had before it is kept for the reply (see finish), so that a won fight, whose XP is
        // given by code, can put back what the narrator added in that reply.
        const xpFrom = ctx.cause === 'story' && definition.role === 'character' && kind.effects.some(effect => Array.isArray(effect?.path) && effect.path[0] === 'xp')
            ? { [module]: Object.fromEntries(['xp', 'level', 'soul', 'points'].filter(key => Number.isSafeInteger(fieldsBefore[key])).map(key => [key, fieldsBefore[key]])) } : null;
        // A story line that practises a skill (`practice-N`, after skillRoute): what the slot held before it is kept for the reply, so that the practice the
        // reply's rolls give by code can put back what the narrator added for the same skill.
        const practiceFrom = ctx.cause === 'story' && route && route.kind.startsWith('practice-')
            ? { [module]: { [route.slot]: Object.fromEntries(['practice', 'rank'].filter(key => Number.isSafeInteger(fieldsBefore[`${key}${route.slot}`])).map(key => [key, fieldsBefore[`${key}${route.slot}`]])) } } : null;
        const answer = finish(ctx, prefix, draft, recorded, { pin: Boolean(grown), visits: result.visits, notes: result.notes, result: outcome, xpFrom, practiceFrom, listsFrom: Object.keys(result.lists).length ? { ...listsKept, [listKey]: result.lists } : null, summary: `${definition.name}: ${route ? `${route.kind} (${route.update ? route.name : instance.fields[`skill${route.slot}`]})` : kind.title ?? labels.kind}${changes.length ? ` (${changes.join(', ')})` : ''}.` });
        if (ctx.cause === 'ui') answer.data.edit = true;
        return answer;
    }
    return { withKind, foeLevelLabels, act };
}
