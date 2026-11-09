// Data-modules checker, validate part: validateDataModules, the entry point that checks a pack's definitions, catalog and
// capabilities. Pure: no state is read. check.js keeps the public path of each export.

import { oneLine } from '../../../text.js';
import { effects, rewardTypes } from './effects.js';
import { collectOffers, imports } from './imports.js';
import { blockFunctions, layoutKeys, stageFields } from './layout.js';
import { migrations } from './migration.js';
import { dataModuleDefaults } from './names.js';
import { presentation } from './screens.js';
import { array, copy, defId, distinct, entries, named, normalizedKeys, scalar, shape, sized } from './shape.js';
import { conditionType, fieldType } from '../expressions.js';
import { fullModuleGrammar } from '../grammar.js';
import { DATA_MODULES_CAPABILITY, DM_DESCRIPTORS as D, DM_LIMITS as L, dmInt, dmObject, dmOwn, dmSlug } from '../schema.js';
import { ROLES } from '../../lean-rpg/names.js';
import { LIMITS as PACK_LIMITS, TAB_ID } from '../../packs/limits.js';
import { byteLength, checkPlain } from '../../packs/safety.js';
import { STRINGS } from '../../strings.js';
import { hasIcon } from '../../view/icons/index.js';
import { isTypedSkills } from '../../skill-slots.js';

/** Checked definitions plus an optional catalog for imports from other packs. No state is read. */
export function validateDataModules(value, { packId, capabilities = [], definitions = [] } = {}) {
    const errors = [];
    const add = (code, path, message) => { if (errors.length < L.errors) errors.push({ code, path, message }); };
    if (!dmSlug(packId)) return { ok: false, errors: [{ code: 'DM_SCHEMA', path: 'id', message: 'Data definitions require a valid pack ID.' }] };
    // Include the envelope depth even when Studio invokes the definition checker directly.
    const plain = checkPlain({ content: { dataModules: value } });
    if (plain.length) return { ok: false, errors: plain };
    if (!Array.isArray(value)) return { ok: false, errors: [{ code: 'DM_SCHEMA', path: 'content.dataModules', message: 'dataModules must be a list of definitions.' }] };
    if (value.length > L.definitions) add('DM_BUDGET', 'content.dataModules', `A pack permits at most ${L.definitions} data modules.`);
    if (!array(capabilities).includes(DATA_MODULES_CAPABILITY)) add('DM_SCHEMA', 'requires.capabilities', `content.dataModules requires ${DATA_MODULES_CAPABILITY}.`);
    const normalized = [];
    const seen = new Set();
    value.forEach((given, i) => {
        const at = `content.dataModules[${i}]`;
        if (!shape(given, D.definition, at, add)) return;
        normalizedKeys(given, at, add);
        if (!dmSlug(given.slug)) add('DM_SCHEMA', `${at}.slug`, 'A module slug must be safe lowercase text of at most 40 characters.');
        if (seen.has(given.slug)) add('DM_SCHEMA', `${at}.slug`, 'Module slugs must be unique within a pack.');
        seen.add(given.slug);
        if (typeof given.name !== 'string' || !given.name.trim() || [...given.name].length > PACK_LIMITS.name || /[\r\n\u0000-\u001f\u007f]/.test(given.name)) add('DM_SCHEMA', `${at}.name`, `A module name must be one line of 1 to ${PACK_LIMITS.name} safe characters.`);
        if (given.schema !== 1) add('DM_SCHEMA', `${at}.schema`, 'Only data module schema 1 is supported.');
        if (!dmInt(given.stateVersion, 1, Number.MAX_SAFE_INTEGER)) add('DM_SCHEMA', `${at}.stateVersion`, 'stateVersion must be a positive safe integer.');
        if (!D.scope.includes(given.scope)) add('DM_SCHEMA', `${at}.scope`, 'scope must be chat or character.');
        const definition = { ...copy(D.defaults), ...copy(given), id: defId(packId, given.slug), pack: packId };
        if (definition.prompt !== undefined) {
            if (typeof definition.prompt !== 'string' || [...definition.prompt].length > L.prompt) add('DM_BOUNDS', `${at}.prompt`, STRINGS.blocks.promptLimit);
            else definition.prompt = oneLine(definition.prompt);
        }
        if (definition.role !== undefined && !ROLES.includes(definition.role)) add('DM_SCHEMA', `${at}.role`, STRINGS.blocks.roleInvalid);
        else if (definition.role !== undefined && definition.scope === 'character') add('DM_SCHEMA', `${at}.role`, STRINGS.blocks.roleChat);
        if (definition.show !== undefined) {
            const show = definition.show;
            if (!dmObject(show) || Object.keys(show).some(key => !['tab', 'card', 'tabName', 'icon', 'into'].includes(key))
                || typeof show.tab !== 'boolean' || typeof show.card !== 'boolean'
                || (show.into !== undefined && (typeof show.into !== 'string' || !TAB_ID.test(show.into) || show.tab !== true))
                || typeof show.tabName !== 'string' || !show.tabName.trim() || [...show.tabName].length > 24 || !hasIcon(show.icon)) add('DM_SCHEMA', `${at}.show`, STRINGS.blocks.showOptions);
            else show.tabName = oneLine(show.tabName);
        }
        if (byteLength(JSON.stringify(definition)) > L.definitionBytes) add('DM_BUDGET', at, `A definition must fit ${L.definitionBytes} UTF-8 JSON bytes.`);
        const typedSkills = definition.role === 'skills' && isTypedSkills(definition.state);
        for (const [key, schema] of named(definition.state, definition.role === 'skills' ? (typedSkills ? L.skillsFields : L.skillsLegacyFields) : L.fields, `${at}.state`, add)) {
            scalar(schema, `${at}.state.${key}`, add);
            if (schema?.scale !== undefined && (definition.role !== 'character' || !['health', 'stamina', 'mana'].includes(key) || schema.blocks !== key)) add('DM_SCHEMA', `${at}.state.${key}.scale`, STRINGS.blocks.scaleKey);
        }
        if (['health', 'stamina', 'mana'].some(key => definition.state?.[key]?.scale === 2)
            && !['health', 'stamina', 'mana'].every(key => definition.state?.[key]?.scale === 2 && definition.state[key].blocks === key)) add('DM_SCHEMA', `${at}.state`, 'A scaled character needs all three scaled bars.');
        layoutKeys(definition, at, add);
        if (definition.role !== undefined) stageFields(definition, at, add);
        imports(definition, at, add); // forms first, linking before expression analysis below
        migrations(definition, at, add);
        normalized.push(definition);
    });
    if (errors.length) return { ok: false, errors };
    // Catalog entries are checked normalized definitions. They never become content in this pack.
    const catalog = new Map(array(definitions).map(def => [def.id, def]));
    for (const definition of normalized) catalog.set(definition.id, definition);
    for (const [i, definition] of normalized.entries()) {
        const at = `content.dataModules[${i}]`;
        const inputs = {};
        for (const [alias, entry] of entries(definition.imports)) {
            if (!dmObject(entry)) continue;
            entry.args ??= {};
            inputs[alias] = {};
            if (entry.query === 'director.time' && array(entry.projection).includes('minutes')) inputs[alias].minutes = { type: 'int', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };
            if (entry.query !== 'dataModules.public') continue;
            const target = catalog.get(entry.args?.module);
            const exported = dmOwn(target?.exports, entry.args?.export) && target.exports[entry.args.export];
            if (!target || !exported) { add('DM_SCHEMA', `${at}.imports.${alias}.args`, 'Unknown data module/export; supply checked dependency definitions when importing another pack.'); continue; }
            if (target.scope === 'character' && !entry.args?.who) add('DM_SCHEMA', `${at}.imports.${alias}.args.who`, 'A character export requires an explicit canonical subject.');
            if (target.scope === 'chat' && entry.args?.who !== undefined) add('DM_SCHEMA', `${at}.imports.${alias}.args.who`, 'A chat export has no character subject.');
            for (const field of array(entry.projection)) {
                if (!array(exported.fields).includes(field) || !dmOwn(target.state, field)) add('DM_SCHEMA', `${at}.imports.${alias}.projection`, 'Projection must select fields of the named public export.');
                else inputs[alias][field] = target.state[field].type === 'map' ? { type: 'map' } : fieldType(target.state[field]);
            }
        }
        const env = { state: definition.state, inputs, templates: definition.rewards, offerKeys: collectOffers(definition) };
        for (const [name, reward] of named(definition.rewards, L.templates, `${at}.rewards`, add)) {
            const path = `${at}.rewards.${name}`;
            if (!shape(reward, D.reward, path, add)) continue;
            for (const [key, schema] of named(reward.bindings, L.fields, `${path}.bindings`, add)) scalar(schema, `${path}.bindings.${key}`, add, { label: true });
            const rewardEnv = { ...env, bindings: reward.bindings, rewards: rewardTypes(reward, path, add) };
            if (reward.when !== undefined) conditionType(reward.when, rewardEnv, `${path}.when`, add);
            reward.when ??= true;
            effects(reward.effects, rewardEnv, `${path}.effects`, add, { reward: true });
        }
        for (const [name, kind] of named(definition.kinds, definition.role === 'skills' && isTypedSkills(definition.state) ? L.skillsKinds : L.kinds, `${at}.kinds`, add)) {
            const path = `${at}.kinds.${name}`;
            if (!shape(kind, D.kind, path, add)) continue;
            if (kind.check !== undefined) add('DM_SCHEMA', `${path}.check`, 'SD checks inside a dm root need data-modules v1.1; this definition needs data-modules v1.1.');
            if (!D.ops.includes(kind.op)) add('DM_SCHEMA', `${path}.op`, `A kind op must be ${D.ops.join(', ')}.`);
            if (kind.ui !== undefined && typeof kind.ui !== 'boolean') add('DM_SCHEMA', `${path}.ui`, 'ui must be a boolean.');
            if (kind.title !== undefined) {
                if (typeof kind.title !== 'string' || !oneLine(kind.title) || [...kind.title].length > 60) add('DM_SCHEMA', `${path}.title`, STRINGS.blocks.labelLimit);
                else kind.title = oneLine(kind.title);
            }
            if (kind.refusal !== undefined && (typeof kind.refusal !== 'string' || !kind.refusal.trim() || kind.refusal.length > L.text || /[\u0000-\u001f\u007f]/.test(kind.refusal))) add('DM_SCHEMA', `${path}.refusal`, `A refusal is bounded safe text of at most ${L.text} characters.`);
            for (const [key, schema] of named(kind.labels, L.fields, `${path}.labels`, add, { label: true })) {
                if (['kind', 'who'].includes(key)) add('DM_LABEL', `${path}.labels.${key}`, 'kind and who are host-reserved labels.');
                scalar(schema, `${path}.labels.${key}`, add, { label: true });
            }
            const claims = kind.oncePerReply ?? [];
            if (!Array.isArray(claims) || new Set(claims).size !== claims.length || claims.some(key => !dmOwn(kind.labels, key) || kind.labels[key]?.type !== 'enum')) add('DM_LABEL', `${path}.oncePerReply`, 'oncePerReply must list distinct declared enum labels.');
            const kindEnv = { ...env, args: kind.labels };
            if (kind.when !== undefined) conditionType(kind.when, kindEnv, `${path}.when`, add);
            effects(kind.effects, kindEnv, `${path}.effects`, add);
            kind.oncePerReply = claims;
            kind.when ??= true;
            kind.ui ??= false;
        }
        blockFunctions(definition, env, at, add);
        if (!errors.length && (definition.prompt !== undefined || definition.show !== undefined || packId === 'chat')) {
            const lines = fullModuleGrammar(definition, definition.id);
            if ([...lines].length > L.staticCharacters) add('DM_BUDGET', `${at}.prompt`, STRINGS.blocks.staticLimit);
        }
        const ids = new Set();
        if (sized(definition.rules, L.rules, `${at}.rules`, add, { list: true })) definition.rules.forEach((rule, j) => {
            const path = `${at}.rules[${j}]`;
            if (!shape(rule, D.rule, path, add)) return;
            if (!dmSlug(rule.id) || ids.has(rule.id)) add('DM_SCHEMA', `${path}.id`, 'Rule IDs must be unique safe slugs.');
            ids.add(rule.id);
            conditionType(rule.when, env, `${path}.when`, add);
            effects(rule.then, env, `${path}.then`, add);
        });
        ids.clear();
        if (sized(definition.timers, L.timers, `${at}.timers`, add, { list: true })) definition.timers.forEach((timer, j) => {
            const path = `${at}.timers[${j}]`;
            if (!shape(timer, D.timer, path, add)) return;
            if (!dmSlug(timer.id) || ids.has(timer.id)) add('DM_SCHEMA', `${path}.id`, 'Timer IDs must be unique safe slugs.');
            ids.add(timer.id);
            const clock = dmOwn(definition.imports, timer.clock) && definition.imports[timer.clock];
            if (!clock || clock.query !== 'director.time' || clock.mode !== 'prefix' || !array(clock.projection).includes('minutes')) add('DM_SCHEMA', `${path}.clock`, 'A timer clock must be a declared prefix SD minute import.');
            if (!dmInt(timer.every, 1, L.elapsedMinutes)) add('DM_BOUNDS', `${path}.every`, `every must be 1 to ${L.elapsedMinutes} minutes.`);
            effects(timer.effects, { ...env, timer: { every: dmInt(timer.every, 1) ? timer.every : 1 } }, `${path}.effects`, add, { timer: true });
        });
        for (const [key, exported] of named(definition.exports, L.fields, `${at}.exports`, add)) {
            const path = `${at}.exports.${key}`;
            if (!shape(exported, D.export, path, add)) continue;
            if (!Array.isArray(exported.fields) || !exported.fields.length || new Set(exported.fields).size !== exported.fields.length || exported.fields.some(field => !dmOwn(definition.state, field))) add('DM_SCHEMA', `${path}.fields`, 'An export lists distinct declared fields only.');
        }
        presentation(definition, at, add);
        if (byteLength(JSON.stringify(definition)) > L.definitionBytes) add('DM_BUDGET', at, `A normalized definition must fit ${L.definitionBytes} UTF-8 JSON bytes.`);
        // Only form-valid schemas can have defaults calculated.
        if (!errors.length) {
            const instance = { fields: dataModuleDefaults(definition.state), timers: {}, offers: {}, settled: {} };
            if (byteLength(JSON.stringify(instance)) > L.instanceBytes) add('DM_BUDGET', `${at}.state`, `Default instance exceeds ${L.instanceBytes} UTF-8 JSON bytes.`);
        }
    }
    // Bounded DFS over the checked catalog. Cross-pack cycles use the same algorithm.
    const visiting = new Set(), visited = new Set();
    const visit = definition => {
        if (visiting.has(definition.id)) { add('DM_SCHEMA', 'content.dataModules', `Public data module imports form a cycle at ${definition.id}.`); return; }
        if (visited.has(definition.id)) return;
        visiting.add(definition.id);
        for (const [, entry] of entries(definition.imports)) {
            const target = entry?.query === 'dataModules.public' && catalog.get(entry.args?.module);
            if (target) visit(target);
        }
        visiting.delete(definition.id);
        visited.add(definition.id);
    };
    normalized.forEach(visit);
    return errors.length ? { ok: false, errors } : { ok: true, definitions: normalized };
}
