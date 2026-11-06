// The block editor's sections: name and Show as, starters, fields and entries, functions and effects, and the
// footer (extracted from screens/blocks-editor.js; editor.js calls this part).

import { iconNode } from '../../view/widgets/dom.js';
import { blockKindCount, buildBlock, namesText } from '../../data-modules/block-builder.js';
import { statusTones } from '../../data-modules/block-layout.js';
import { BLOCK_STARTERS } from '../../data-modules/block-starters.js';
import { fullModuleGrammar } from '../../data-modules/grammar.js';
import { DM_LIMITS } from '../../data-modules/schema.js';
import { fill } from '../../strings.js';
import { S, TYPES, LAYOUT_NAMES, COMPARISONS, ICONS } from './constants.js';

export function createDrawPart({ doc, node, button, control, collect, refresh, draft, meta, root, state, resolve, onCancel, submit,
    used, fieldOptions, newEffect, renameField, renamePart, setType, paintParts, paintEffects, paintLayout, paintPreview, starters, directorOn, tabs, applyStarter, draw }) {
    function draw() {
        state.updateCount = () => {};
        for (const entry of state.controls) entry.handle.destroy();
        state.controls = []; state.spots = new Map(); state.renamed = new Map();
        root.replaceChildren();
        const form = node('section', 'ss-block-editor ss-glass', '', root);
        node('h3', 'ss-section-label', S.editBlock, form);
        // A layout that no longer fits the fields falls back to the one their shape suggests, with one line saying so; saving is never blocked.
        {
            const now = resolve();
            if (draft.layout && !now.shape.fits[draft.layout]?.ok) {
                draft.layout = now.fell ?? undefined;
                if (now.fell) { meta.layoutNote = fill(S.layoutFell, { name: LAYOUT_NAMES[now.fell] }); meta.layoutBy = 'shape'; }
            }
            if (now.roles) draft.roles = now.roles; else delete draft.roles;
            if (now.roles && !meta.rolesAuthor && now.guessed) meta.rolesGuessed = true;
            if (!now.roles) meta.rolesGuessed = false;
            if (draft.tones) {
                const status = now.roles ? statusTones(draft, now.roles).map(each => each.value) : [];
                for (const value of Object.keys(draft.tones)) if (!status.includes(value)) delete draft.tones[value];
                if (!Object.keys(draft.tones).length) delete draft.tones;
            }
        }
        if (starters) {
            const section = node('section', 'ss-block-starters', '', form);
            node('h4', 'ss-section-label', S.startFrom, section);
            const row = node('div', 'ss-block-starter-row', '', section);
            for (const item of [{ id: 'empty', name: S.starterEmpty, about: S.starterEmptyAbout }, ...BLOCK_STARTERS]) {
                const pick = button(row, '', () => applyStarter(item), `ss-button ss-block-starter${meta.pickedStarter === item.id ? ' ss-block-starter-on' : ''}`);
                node('b', '', item.name, pick); node('small', 'ss-block-hint', item.about, pick);
                pick.setAttribute('aria-pressed', String(meta.pickedStarter === item.id));
            }
            if (meta.starterNote) { const note = node('p', 'ss-block-hint', meta.starterNote, section); note.setAttribute('role', 'status'); }
        }
        control(form, S.name, draft.name, { type: 'text', max: 60 }, value => { draft.name = value; }, 'name');
        const show = node('section', 'ss-block-show', '', form);
        node('h4', 'ss-section-label', S.showAs, show);
        const group = node('div', 'ss-block-chips', '', show);
        for (const [label, tab, card] of [[S.ownTab, true, false], [S.card, false, true], [S.both, true, true], [S.hidden, false, false]]) {
            const selected = draft.show.tab === tab && draft.show.card === card;
            const item = button(group, label, () => { collect(); draft.show.tab = tab; draft.show.card = card; draw(); }, `ss-button ss-chip${selected ? ' ss-chip-on' : ''}`);
            item.setAttribute('aria-pressed', String(draft.show.tab === tab && draft.show.card === card));
        }
        // Show in tab: its own tab, or a tab this chat already has (then the block is one more section of it, under its own heading).
        const joinable = tabs.filter(tab => tab?.id);
        if (joinable.length || draft.show.into) {
            const options = [{ value: '', label: S.showOwnTab }, ...joinable.map(tab => ({ value: tab.id, label: tab.title || tab.id }))];
            if (draft.show.into && !options.some(option => option.value === draft.show.into)) options.push({ value: draft.show.into, label: draft.show.into });
            const into = control(show, S.showInTab, draft.show.tab ? draft.show.into ?? '' : '', { type: 'choice', options },
                value => { if (!draft.show.tab) return; if (value) draft.show.into = value; else delete draft.show.into; }, 'show-into', { disabled: !draft.show.tab });
            into.input.addEventListener('change', refresh);
            node('small', 'ss-block-hint', draft.show.tab ? (draft.show.into ? S.showIntoHint : '') : S.showNeedsTab, show);
        }
        if (draft.show.tab && draft.show.into) control(show, S.showHeading, draft.show.tabName, { type: 'text', max: 24 }, value => { draft.show.tabName = value; }, 'show');
        else {
            control(show, S.tabName, draft.show.tabName, { type: 'text', max: 24 }, value => { draft.show.tabName = value; }, 'show');
            const icons = node('div', 'ss-block-icons', '', show); icons.setAttribute('aria-label', S.icon);
            for (const icon of ICONS) {
                const pick = button(icons, '', () => { collect(); draft.show.icon = icon; draw(); }, 'ss-iconbutton');
                pick.setAttribute('aria-label', S.icons[icon]); pick.setAttribute('aria-pressed', String(draft.show.icon === icon));
                const glyph = iconNode(doc, icon); if (glyph) pick.appendChild(glyph);
            }
        }
        const fields = node('section', 'ss-block-fields-editor', '', form);
        node('h4', 'ss-section-label', S.fields, fields);
        const kindCount = node('p', 'ss-block-kind-count', fill(S.kindCount, { n: blockKindCount(draft) }), fields);
        kindCount.setAttribute('aria-live', 'polite');
        const limitError = node('p', 'ss-block-control-error', '', fields); limitError.setAttribute('role', 'alert');
        const hasKindRoom = () => {
            if (blockKindCount(draft) < DM_LIMITS.kinds) return true;
            limitError.textContent = S.kindLimit;
            return false;
        };
        for (const [index, field] of draft.fields.entries()) {
            const row = node('div', `ss-block-field-editor ss-glass${field.type === 'entries' ? ' ss-block-field-wide' : ''}`, '', fields);
            const fieldName = control(row, S.fieldNameLabel, field.name, { type: 'text', max: 60 }, value => renameField(field, value), `field:${index}`);
            fieldName.input.addEventListener('change', refresh);
            const type = control(row, S.fieldTypeLabel, field.type, { type: 'choice', options: TYPES }, value => { setType(field, value); }, `field:${index}:type`);
            type.input.addEventListener('change', refresh);
            if (field.type === 'entries') paintParts(row, field, index);
            else if (field.type === 'number') {
                control(row, S.min, field.min ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { field.min = value; }, `field:${index}:min`);
                control(row, S.max, field.max ?? 10, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { if (field.type !== 'entries') field.max = value; }, `field:${index}:max`);
                control(row, S.defaultValue, field.default ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { field.default = value; }, `field:${index}:default`);
                // Optional display names ("1 = I"): shown instead of the number; the number is what is kept.
                control(row, S.names, typeof field.names === 'string' ? field.names : namesText(field.names), { type: 'text', multiline: true, max: 1500 }, value => { field.names = value; }, `field:${index}:names`);
                node('small', 'ss-block-hint', S.namesHelp, row);
            } else if (field.type === 'choice') {
                control(row, S.choices, Array.isArray(field.values) ? field.values.join(', ') : field.values ?? '', { type: 'text', max: 500 }, value => { field.values = String(value).split(',').map(part => part.trim()); }, `field:${index}:values`);
                control(row, S.defaultValue, field.default ?? '', { type: 'text', max: 240 }, value => { field.default = value; }, `field:${index}:default`);
            } else {
                if (field.type === 'text') control(row, S.max, field.max ?? 120, { type: 'int', min: 1, max: 240 }, value => { if (field.type !== 'entries') field.max = value; }, `field:${index}:max`);
                control(row, S.defaultValue, field.default ?? '', { type: 'text', max: 240 }, value => { field.default = value; }, `field:${index}:default`);
            }
            if (field.prompt === false) node('small', 'ss-block-hint', S.hiddenField, row);
            const actions = node('div', 'ss-block-field-actions', '', row);
            const up = button(actions, S.up, () => { collect(); [draft.fields[index - 1], draft.fields[index]] = [draft.fields[index], draft.fields[index - 1]]; draw(); }); up.disabled = index === 0;
            const down = button(actions, S.down, () => { collect(); [draft.fields[index + 1], draft.fields[index]] = [draft.fields[index], draft.fields[index + 1]]; draw(); }); down.disabled = index === draft.fields.length - 1;
            button(actions, S.remove, () => { collect(); draft.fields.splice(index, 1); draw(); });
        }
        button(fields, S.addField, () => { collect(); if (!hasKindRoom()) return;
            let n = draft.fields.length + 1; while (draft.fields.some(field => field.key === `field-${n}`)) n++;
            draft.fields.push({ key: `field-${n}`, name: fill(S.newFieldName, { n }), type: 'text', max: 120, default: '' }); draw(); });
        paintLayout(form);
        const purpose = node('section', 'ss-block-purpose', '', form);
        const prompt = control(purpose, S.purpose, draft.prompt, { type: 'text', multiline: true, max: DM_LIMITS.prompt }, value => { draft.prompt = value; }, 'prompt');
        const total = node('small', 'ss-block-static-count', '', purpose);
        state.updateCount = () => {
            collect();
            paintPreview();
            const result = buildBlock(draft, { used });
            const definition = result.definition;
            const n = definition ? [...fullModuleGrammar(definition, `pack.chat/${definition.slug}`)].length : [...draft.prompt].length;
            total.textContent = fill(S.staticCount, { n });
        };
        state.updateCount();
        const functions = node('section', 'ss-block-functions', '', form);
        node('h4', 'ss-section-label', S.functions, functions);
        const actions = node('div', 'ss-block-function-actions', '', functions);
        for (const [type, label] of [['button', S.addButton], ['rule', S.addRule], ['timer', S.addTimer]]) {
            const add = button(actions, label, () => { collect(); if (type === 'button' && !hasKindRoom()) return;
                const n = draft.functions.length + 1;
                const kind = type === 'button' ? S.button : type === 'rule' ? S.rule : S.timer;
                draft.functions.push({ type, name: fill(S.newFunctionName, { type: kind, n }), ...(type === 'rule' ? { when: { field: draft.fields[0]?.key ?? '', op: 'eq', value: '' } } : {}),
                    ...(type === 'timer' ? { every: 60 } : {}), effects: [newEffect(type)] }); draw(); });
            add.disabled = draft.functions.length >= 8 || (type === 'timer' && !directorOn);
        }
        if (!directorOn) node('p', 'ss-block-hint', S.timerNeeds, functions);
        const whenControls = (row, fn, index) => {
            control(row, S.whenField, fn.when.field, { type: 'choice', options: fieldOptions() }, value => { fn.when.field = value; }, null);
            control(row, S.comparison, fn.when.op, { type: 'choice', options: COMPARISONS }, value => { fn.when.op = value; }, null);
            control(row, S.whenValue, fn.when.value, { type: 'text', max: 240 }, value => { fn.when.value = value; }, `function:${index}:when`);
        };
        const KINDS = { button: S.button, rule: S.rule, timer: S.timer, card: S.cardKind, 'reply-end': S.replyEnd };
        for (const [index, fn] of draft.functions.entries()) {
            const row = node('div', 'ss-block-function ss-glass', '', functions);
            node('span', 'ss-pill', KINDS[fn.type] ?? S.timer, row);
            // (a card names the button it runs, so a button's new name goes to the cards that run it: now, and for a card form read after it)
            const named = control(row, S.functionName, fn.name, { type: 'text', max: 60 }, value => {
                if (fn.type === 'button' && fn.name !== value) {
                    state.renamed.set(fn.name, value);
                    for (const other of draft.functions) if (other.type === 'card' && other.button === fn.name) other.button = value;
                }
                fn.name = value;
            }, `function:${index}`);
            if (fn.type === 'button') named.input.addEventListener('change', refresh);
            if (fn.type === 'rule') whenControls(row, fn, index);
            else if (fn.type === 'timer') control(row, S.every, fn.every, { type: 'int', min: 1, max: 525600 }, value => { fn.every = value; }, `function:${index}:every`);
            else if (fn.type === 'card') {
                whenControls(row, fn, index);
                control(row, S.cardTone, fn.tone ?? 'info', { type: 'choice', options: ['info', 'warn', 'end'].map(value => ({ value, label: S.tones[value] })) }, value => { fn.tone = value; }, `function:${index}:tone`);
                control(row, S.cardTitleLabel, fn.title ?? '', { type: 'text', max: 60 }, value => { fn.title = value; }, `function:${index}:title`);
                control(row, S.cardTextLabel, fn.text ?? '', { type: 'text', max: 240 }, value => { fn.text = value; }, `function:${index}:text`);
                const buttons = draft.functions.filter(other => other.type === 'button').map(other => ({ value: other.name, label: other.name }));
                control(row, S.cardButtonLabel, fn.button ?? '', { type: 'choice', options: [{ value: '', label: S.noButton }, ...buttons] }, value => { const button = state.renamed.get(value) ?? value; if (button) fn.button = button; else delete fn.button; }, `function:${index}:button`);
            } else if (fn.type === 'reply-end') {
                if (fn.when) {
                    whenControls(row, fn, index);
                    button(row, S.always, () => { collect(); delete fn.when; draw(); });
                } else button(row, S.addCondition, () => { collect(); fn.when = { field: draft.fields[0]?.key ?? '', op: 'eq', value: '' }; draw(); });
            }
            if (fn.type !== 'card') paintEffects(row, fn, index);
            button(row, S.remove, () => { collect(); draft.functions.splice(index, 1); draw(); });
        }
        const footer = node('div', 'ss-block-editor-actions', '', form);
        button(footer, S.save, submit, 'ss-button ss-button-primary');
        button(footer, S.cancel, () => onCancel());
        node('small', 'ss-block-hint', S.savedWithReply, form);
        const error = node('p', 'ss-block-control-error', '', form); error.setAttribute('role', 'alert'); state.spots.set('form', error);
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); onCancel(); }
            else if (event.key === 'Enter') { event.preventDefault?.(); event.stopPropagation?.(); submit(); }
        });
    }
    return { draw };
}
