// Data-modules checker, layout part: the block layout keys, the stage-bar fields and the block functions (cards, rules,
// hidden fields). Pure: no state is read. check.js keeps the public path of each export.

import { oneLine } from '../../../text.js';
import { effects } from './effects.js';
import { entries, shape, sized } from './shape.js';
import { conditionType } from '../expressions.js';
import { DM_DESCRIPTORS as D, DM_LIMITS as L, dmInt, dmKindWritesHidden, dmObject, dmOwn, dmSlug } from '../schema.js';
import { STRINGS, fill } from '../../strings.js';

// How the host draws a block: `layout` ("cards", "bars" or "fields"), the `roles` a list of cards reads from one List of entries field (`field`, and the
// sub-fields that are its `title`, `status` and `step`), and the `tones` of the status values. Display only: none of it changes what the story can write.
export function layoutKeys(definition, at, add) {
    const { layout, roles, tones } = definition;
    const state = dmObject(definition.state) ? definition.state : {};
    if (layout !== undefined && !D.layouts.includes(layout)) { add('DM_SCHEMA', `${at}.layout`, STRINGS.blocks.layoutInvalid); return; }
    if (layout === 'bars' && !Object.values(state).every(schema => schema?.type === 'int')) add('DM_SCHEMA', `${at}.layout`, STRINGS.blocks.layoutBarsNumbers);
    if (layout === 'cards' && roles === undefined) add('DM_SCHEMA', `${at}.roles`, STRINGS.blocks.rolesNeeded);
    let status = null;
    if (roles !== undefined) {
        if (layout !== 'cards') add('DM_SCHEMA', `${at}.roles`, STRINGS.blocks.rolesCards);
        if (!shape(roles, { required: ['field', 'title'], optional: ['status', 'step'] }, `${at}.roles`, add)) return;
        const field = typeof roles.field === 'string' && dmOwn(state, roles.field) ? state[roles.field] : null;
        if (field?.type !== 'entries') { add('DM_SCHEMA', `${at}.roles.field`, STRINGS.blocks.rolesField); return; }
        const sub = (key, type) => {
            if (roles[key] === undefined) return null;
            const schema = typeof roles[key] === 'string' && dmOwn(field.of, roles[key]) ? field.of[roles[key]] : null;
            if (schema?.type !== type) add('DM_SCHEMA', `${at}.roles.${key}`, STRINGS.blocks.rolesSub);
            return schema?.type === type ? schema : null;
        };
        sub('title', 'text'); sub('step', 'text');
        status = sub('status', 'enum');
    }
    if (tones !== undefined) {
        if (!dmObject(tones) || !status) { add('DM_SCHEMA', `${at}.tones`, STRINGS.blocks.tonesNeedStatus); return; }
        for (const [value, tone] of Object.entries(tones)) {
            if (!status.values.includes(value) || !D.toneNames.includes(tone)) add('DM_SCHEMA', `${at}.tones.${value}`, STRINGS.blocks.tonesInvalid);
        }
    }
}

// The RPG draws a role block's health, mana, stamina and foe-health fields as stage bars, one cell and one choice for each stage, so
// those fields stay small: at most ten stages counted up from empty (0), whatever else the block holds.
const STAGE_FIELD = /^(health|mana|stamina|hurt[1-4])$/;
export function stageFields(definition, at, add) {
    for (const [key, schema] of entries(definition.state)) {
        if (!STAGE_FIELD.test(key) || !dmObject(schema) || schema.type !== 'int' || !dmInt(schema.min) || !dmInt(schema.max)) continue;
        const top = definition.role === 'character' && schema.scale === 2 && schema.blocks === key && ['health', 'stamina', 'mana'].includes(key) ? L.scaledStages : L.stages;
        if (schema.max - schema.min >= top || schema.max > top) add('DM_BOUNDS', `${at}.state.${key}`, fill(STRINGS.blocks.stagesLimit, { max: top }));
    }
}

// The cards a block draws under the head reply, the rules it settles once at the end of each reply, and the hidden fields only
// a Button may write. All three are declarations: a card is derived from the state, never stored.
export function blockFunctions(definition, env, at, add) {
    if (definition.cards !== undefined) {
        if (definition.scope !== 'chat') add('DM_SCHEMA', `${at}.cards`, STRINGS.blocks.cardsChat);
        if (sized(definition.cards, L.cards, `${at}.cards`, add, { list: true })) {
            const ids = new Set();
            definition.cards.forEach((card, i) => {
                const path = `${at}.cards[${i}]`;
                if (!shape(card, D.card, path, add)) return;
                if (card.type !== undefined && card.type !== 'card') add('DM_SCHEMA', `${path}.type`, STRINGS.blocks.functionType);
                if (card.id !== undefined) {
                    if (!dmSlug(card.id) || ids.has(card.id)) add('DM_SCHEMA', `${path}.id`, 'Card IDs must be unique safe slugs.');
                    ids.add(card.id);
                }
                // A card is asked about the head state alone: no import, no label.
                conditionType(card.when, { ...env, inputs: {} }, `${path}.when`, add);
                if (!D.cardTones.includes(card.tone)) add('DM_SCHEMA', `${path}.tone`, `A card tone is ${D.cardTones.join(', ')}.`);
                const title = typeof card.title === 'string' ? oneLine(card.title) : '';
                if (!title || [...title].length > L.cardTitle) add('DM_BOUNDS', `${path}.title`, STRINGS.blocks.cardTitle);
                else card.title = title;
                const text = typeof card.text === 'string' ? oneLine(card.text) : null;
                if (text === null || [...text].length > L.cardText) add('DM_BOUNDS', `${path}.text`, STRINGS.blocks.cardText);
                else card.text = text;
                if (card.button !== undefined) {
                    const kind = typeof card.button === 'string' && dmOwn(definition.kinds, card.button) ? definition.kinds[card.button] : null;
                    if (!kind || kind.ui !== true || Object.keys(kind.labels ?? {}).length) add('DM_SCHEMA', `${path}.button`, STRINGS.blocks.cardButton);
                }
            });
        }
    }
    if (definition.replyEnd !== undefined && sized(definition.replyEnd, L.replyEnd, `${at}.replyEnd`, add, { list: true })) {
        const ids = new Set();
        definition.replyEnd.forEach((entry, i) => {
            const path = `${at}.replyEnd[${i}]`;
            if (!shape(entry, D.replyEnd, path, add)) return;
            if (entry.type !== undefined && entry.type !== 'reply-end') add('DM_SCHEMA', `${path}.type`, STRINGS.blocks.functionType);
            if (entry.id !== undefined) {
                if (!dmSlug(entry.id) || ids.has(entry.id)) add('DM_SCHEMA', `${path}.id`, 'Reply-end IDs must be unique safe slugs.');
                ids.add(entry.id);
            }
            conditionType(entry.when, env, `${path}.when`, add);
            if (Array.isArray(entry.effects) && !entry.effects.length) add('DM_SCHEMA', `${path}.effects`, 'A reply-end function needs at least one effect.');
            effects(entry.effects, env, `${path}.effects`, add, { plain: true });
        });
    }
    // The narrator cannot set a hidden field: only a Button (the reader's) may write one directly.
    for (const [name, kind] of entries(definition.kinds)) {
        if (dmObject(kind) && kind.ui !== true && dmKindWritesHidden(definition, kind)) add('DM_SCHEMA', `${at}.kinds.${name}`, STRINGS.blocks.hiddenKind);
    }
}
