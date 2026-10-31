// The three stage bars (Health, Mana, Stamina) drawn the same on a Party card and on the Spend points sheet: an
// `ss.meter` with one cell per stage, the stage word on the right and a tone by stage (good near full, warn in the
// middle, bad near empty). A tap on a bar opens the existing inline edit (`ss.editable`, a choice of the stage words)
// for that field, saved through `dm.set` like any other pencil.

import { h } from '../../view/widgets/dom.js';
import { editable } from '../../view/widgets/editable.js';
import { meter } from '../../view/widgets/meter.js';
import { RPG_STRINGS, fill } from '../strings.js';
import { BARS, stageWord } from './party-data.js';

const ICONS = Object.freeze({ health: 'fa-heart', mana: 'fa-droplet', stamina: 'fa-person-running' });

/** The `dm.set` payload for one of a character's fields. */
export const fieldPayload = (character, field) => ({ module: character.module, field, ...(character.subject ? { who: character.subject } : {}) });

/** The `dm.set` payload for several of a character's fields at once (`fields`: { name: value }). */
export const fieldsPayload = (character, fields) => ({ module: character.module, fields, ...(character.subject ? { who: character.subject } : {}) });

/**
 * Draws the three bars of `character` (a readParty record) into `parent`, pushing each widget handle on `handles`.
 * `api.command` (when there is one) makes the bars editable; a field the block locks (`edit: false`) stays read-only.
 */
export function drawStageBars(doc, parent, character, { api, handles }) {
    const box = h(doc, 'div', 'rpg-bars');
    parent.appendChild(box);
    for (const key of BARS) {
        const bar = character.bars[key], schema = character.definition.state?.[key], label = schema?.label ?? RPG_STRINGS.bars[key];
        const row = h(doc, 'div', 'rpg-bar'), slot = h(doc, 'div', 'rpg-bar-meter'), edit = h(doc, 'div', 'rpg-bar-edit');
        row.setAttribute('data-bar', key);
        row.append(slot, edit);
        box.appendChild(row);
        handles.push(meter.render(slot, { label, value: bar.value, max: bar.max, tone: bar.tone, text: bar.word, segments: bar.max, icon: ICONS[key] }, {}));
        if (typeof api?.command !== 'function' || schema?.edit === false) continue;
        const options = Array.from({ length: bar.max + 1 }, (_, value) => ({ value, label: stageWord(key, schema, value) }));
        handles.push(editable.render(edit, { value: bar.value, kind: 'choice', options, label, displayValue: false, command: 'dm.set', payload: fieldPayload(character, key) }, { command: api.command }));
        const pencil = edit.querySelector('.ss-w-editable-pencil');
        pencil?.setAttribute('data-bar-edit', key);
        pencil?.setAttribute('title', fill(RPG_STRINGS.party.editBar, { label }));
    }
    return box;
}
