// Data-modules checker, effects part: reward types, the line a List of entries field is worked by (entryEffect) and the
// effects a rule may write (effects). Pure: no state is read. check.js keeps the public path of each export.

import { E, array, entries, named, same, shape, sized } from './shape.js';
import { compatible, expressionType, fieldType, pathType } from '../expressions.js';
import { DM_DESCRIPTORS as D, DM_ENTRY_EFFECTS, DM_LIMITS as L, dmInt, dmObject, dmOwn, dmSlug } from '../schema.js';
import { STRINGS } from '../../strings.js';

export function rewardTypes(reward, path, add) {
    const out = {};
    for (const [key, value] of named(reward.values, L.fields, `${path}.values`, add)) {
        let ranges = [value];
        if (dmOwn(value, 'table') || dmOwn(value, 'binding')) {
            shape(value, D.rangeTable, `${path}.values.${key}`, add);
            const binding = dmOwn(reward.bindings, value.binding) && reward.bindings[value.binding];
            if (binding?.type !== 'enum') add('DM_SCHEMA', `${path}.values.${key}.binding`, 'A range table must select a declared enum binding.');
            if (!dmObject(value.table) || !same(Object.keys(value.table).sort(), array(binding?.values).map(String).sort())) add('DM_SCHEMA', `${path}.values.${key}.table`, 'A range table must cover every enum binding value exactly once.');
            ranges = entries(value.table).map(([, range]) => range);
        }
        for (const [i, range] of ranges.entries()) {
            const at = `${path}.values.${key}${ranges[0] === value ? '' : `.table[${i}]`}`;
            if (!shape(range, D.range, at, add)) continue;
            if (!dmInt(range.min) || !dmInt(range.max) || range.min > range.max) add('DM_BOUNDS', at, 'Reward ranges must have ordered safe integer bounds.');
            if (!D.pick.includes(range.pick)) add('DM_SCHEMA', `${at}.pick`, 'A reward picker is min, max or midpoint.');
        }
        // An invalid range must never let NaN reach the interval checker.
        const valid = ranges.filter(r => dmInt(r?.min) && dmInt(r?.max) && r.min <= r.max);
        out[key] = valid.length ? { type: 'int', min: Math.min(...valid.map(r => r.min)), max: Math.max(...valid.map(r => r.max)) } : { type: 'invalid' };
    }
    return out;
}

// The line a List of entries field is worked by: the labels are the field's sub-fields (each one the sub-field's own type, no wider) and, to change or drop
// one, `at` (a number or a title). An add may leave a sub-field out (it keeps its default); a change names at least one to change.
function entryEffect(effect, env, at, add) {
    const path = Array.isArray(effect.path) && effect.path.length === 1 && typeof effect.path[0] === 'string' ? effect.path : null;
    const field = path && dmOwn(env.state, path[0]) ? env.state[path[0]] : null;
    if (field?.type !== 'entries') { add('DM_SCHEMA', `${at}.path`, STRINGS.blocks.entryPath); return; }
    const labels = env.args ?? {}, subs = field.of ?? {};
    const needsAt = effect.op !== 'entryAdd';
    for (const [key, label] of Object.entries(labels)) {
        if (key === 'at') {
            if (!needsAt || label?.type !== 'text' || !dmInt(label.max, 1, L.entryAt)) add('DM_LABEL', `${at}.labels.at`, STRINGS.blocks.entryAt);
            continue;
        }
        const sub = dmOwn(subs, key) ? subs[key] : null;
        const fits = sub && label?.type === sub.type && (sub.type === 'text' ? label.max <= sub.max
            : sub.type === 'int' ? label.min >= sub.min && label.max <= sub.max : array(label.values).every(value => array(sub.values).includes(value)));
        if (effect.op === 'entryDrop' || !fits) add('DM_LABEL', `${at}.labels.${key}`, STRINGS.blocks.entryLabel);
    }
    if (needsAt && !dmOwn(labels, 'at')) add('DM_LABEL', `${at}.labels.at`, STRINGS.blocks.entryAt);
    const named = Object.keys(labels).filter(key => key !== 'at');
    if (effect.op === 'entrySet' && !named.length) add('DM_LABEL', `${at}.labels`, STRINGS.blocks.entryLabel);
}

export function effects(list, env, path, add, { timer = false, reward = false, plain = false } = {}) {
    if (!sized(list, L.effects, path, add, { list: true })) return;
    list.forEach((effect, i) => {
        const at = `${path}[${i}]`;
        if (D.v11Effects.includes(effect?.op)) { add('DM_SCHEMA', at, `${effect.op} needs data-modules v1.1.`); return; }
        const descriptor = dmOwn(D.effects, effect?.op) && D.effects[effect.op];
        if (!descriptor || !shape(effect, descriptor, at, add)) { if (!descriptor) add('DM_SCHEMA', at, 'Unknown effect; arbitrary commands and patches are not allowed.'); return; }
        if (timer && effect.op !== 'add') add('DM_SCHEMA', at, 'Timer effects must be additive field changes, optionally clamped; no checks, rewards or offers.');
        if (reward && ['reward', 'offer', 'award'].includes(effect.op)) add('DM_SCHEMA', at, 'Reward templates cannot dispatch rewards, offers or awards recursively.');
        if (plain && ['reward', 'offer', 'award'].includes(effect.op)) add('DM_SCHEMA', at, STRINGS.blocks.replyEndPlain);
        if (DM_ENTRY_EFFECTS.includes(effect.op)) {
            if (timer || reward || plain || !env.args) add('DM_SCHEMA', at, STRINGS.blocks.entryKindOnly);
            else entryEffect(effect, env, at, add);
            return;
        }
        if (['set', 'add', 'clamp'].includes(effect.op)) {
            const target = pathType(effect.path, { ...env, writing: true }, `${at}.path`, add, (v, p) => expressionType(v, env, p, add));
            if (effect.op === 'clamp') {
                if (target.type !== 'invalid' && target.type !== 'int') add('DM_SCHEMA', at, 'Only integer fields can be clamped.');
                if (!dmInt(effect.min) || !dmInt(effect.max) || effect.min > effect.max || (target.type === 'int' && (effect.min < target.min || effect.max > target.max))) add('DM_BOUNDS', at, 'Clamp literals must be ordered and inside the target field bounds.');
            } else {
                if (effect.bounds !== undefined && !['reject', 'clamp'].includes(effect.bounds)) add('DM_SCHEMA', `${at}.bounds`, 'bounds must be reject or clamp.');
                if (effect.op === 'add') effect.bounds ??= 'reject';
                if (target.type === 'text') {
                    const argName = Array.isArray(effect.value) && effect.value.length === 2 && effect.value[0] === 'arg' ? effect.value[1]
                        : dmObject(effect.value) && Object.keys(effect.value).length === 1 ? effect.value.arg : null;
                    const arg = typeof argName === 'string' ? env.args?.[argName] : null;
                    const literal = typeof effect.value === 'string' && [...effect.value].length <= target.max
                        && (target.list !== true || !effect.value || effect.value.split(';').length <= 12);
                    const textArg = arg?.type === 'text' && arg.max <= target.max;
                    if (effect.op !== 'set' || !(literal || textArg)) add('DM_SCHEMA', `${at}.value`, E.textEffect);
                    else if (textArg && dmObject(effect.value)) effect.value = ['arg', argName];
                    return;
                }
                let type = expressionType(effect.value, env, `${at}.value`, add);
                if (effect.op === 'add') {
                    if (target.type !== 'invalid' && target.type !== 'int') add('DM_SCHEMA', at, 'add requires an integer target.');
                    if (!['int', 'invalid'].includes(type.type)) add('DM_SCHEMA', `${at}.value`, 'add requires an integer amount.');
                    if (target.type === 'int' && type.type === 'int') {
                        type = { type: 'int', min: target.min + type.min, max: target.max + type.max };
                        if (type.min > L.integer || type.max < -L.integer) add('DM_BOUNDS', at, 'The add has no safe arithmetic result before clamping.');
                        if (effect.bounds === 'clamp') return;
                    }
                }
                if (!compatible(target, type, { overlap: true })) add('DM_BOUNDS', `${at}.value`, 'The value cannot fit the declared target field type or interval.');
            }
        } else if (effect.op === 'reward' || effect.op === 'offer') {
            const template = dmOwn(env.templates, effect.template) && env.templates[effect.template];
            if (!template) { add('DM_SCHEMA', `${at}.template`, 'Unknown local reward template.'); return; }
            if (effect.op === 'offer' && !dmSlug(effect.key)) add('DM_SCHEMA', `${at}.key`, 'An offer key must be a literal bounded safe slug.');
            if (!dmObject(effect.bind)) add('DM_SCHEMA', `${at}.bind`, 'Reward bind must contain every typed binding.');
            const bindings = template.bindings ?? {};
            for (const key of Object.keys(effect.bind ?? {})) if (!dmOwn(bindings, key)) add('DM_SCHEMA', `${at}.bind.${key}`, 'Unknown reward binding.');
            for (const [key, schema] of entries(bindings)) {
                if (!dmOwn(effect.bind, key)) add('DM_SCHEMA', `${at}.bind.${key}`, 'Missing reward binding.');
                else if (!compatible(fieldType(schema), expressionType(effect.bind[key], env, `${at}.bind.${key}`, add))) add('DM_BOUNDS', `${at}.bind.${key}`, 'Every binding value must fit its declared schema.');
            }
        } else if (!dmSlug(effect.offer) || !env.offerKeys.has(effect.offer)) add('DM_SCHEMA', `${at}.offer`, 'award must name a declared local offer key.');
    });
}
