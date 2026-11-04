// The in-chat block form uses the same controls as Settings; it writes no story state until Save.
import { textField, numberField, selectField } from '../view/form/fields.js';
import { h, iconNode } from '../view/widgets/dom.js';
import { hasIcon } from '../view/icons/index.js';
import { blockKindCount, buildBlock, defaultTone, namesText, partKey } from '../data-modules/block-builder.js';
import { BLOCK_STARTERS } from '../data-modules/block-starters.js';
import { LAYOUTS, TONES, cardRoles, exampleValues, layoutShape, statusTones } from '../data-modules/block-layout.js';
import { fullModuleGrammar } from '../data-modules/grammar.js';
import { DM_LIMITS } from '../data-modules/schema.js';
import { slugify } from '../packs/validate.js';
import { STRINGS, fill } from '../strings.js';

const S = STRINGS.blocks;
const TYPES = [{ value: 'text', label: S.text }, { value: 'number', label: S.number }, { value: 'choice', label: S.choice }, { value: 'list', label: S.list }, { value: 'entries', label: S.entries }];
// (a part of an entry is a text, a number or a choice; never a list or another list of entries)
const PART_TYPES = TYPES.slice(0, 3);
const LAYOUT_NAMES = { cards: S.layoutCards, bars: S.layoutBars, fields: S.layoutFields };
const TONE_NAMES = { active: S.toneActive, done: S.toneDone, failed: S.toneFailed, neutral: S.toneNeutral };
const PART_NAMES = ['Detail', 'Note', 'Extra', 'More', 'Other', 'Piece'];
const COMPARISONS = [{ value: 'eq', label: S.is }, { value: 'ne', label: S.isNot }, { value: 'lt', label: S.below },
    { value: 'gt', label: S.above }, { value: 'le', label: S.atMost }, { value: 'ge', label: S.atLeast }];
const ICONS = ['ph-bookmark-simple', 'ph-scroll', 'ph-heart', 'ph-lightning', 'ph-star', 'ph-sparkle', 'ph-sword', 'ph-skull'].filter(hasIcon);

// `starters`: New block offers the starters. `tabs`: [{ id, title }], the tabs this chat already has (Show in tab). `renderPreview(parent, { definition, values,
// layout })`: how the host draws a block in the new layouts (the preview calls it; without it a plain sketch is drawn).
export function renderBlockEditor(root, { draft, used = [], directorOn = true, onSave, onCancel, starters = false, tabs = [], renderPreview = null, meta = {} }) {
    const doc = root.ownerDocument ?? globalThis.document;
    let controls = [], spots = new Map(), busy = false, alive = true, updateCount = () => {}, renamed = new Map();
    // What the form says beside the layout (where the layout came from, a fall-back line, the starter's fill) lives in `meta`, which the page keeps while the form is redrawn.
    meta.layoutBy ??= draft.layout ? 'stored' : 'shape'; meta.layoutNote ??= ''; meta.starterNote ??= ''; meta.pickedStarter ??= starters ? 'empty' : '';
    meta.layoutAtOpen ??= draft.layout ?? '';
    meta.rolesAuthor ??= false; meta.rolesGuessed ??= false; meta.starterName ??= '';
    let previewHandle = null, paintPreview = () => {};
    const node = (tag, cls = '', text = '', parent = null) => { const out = h(doc, tag, cls, text); parent?.appendChild(out); return out; };
    const button = (parent, label, action, cls = 'ss-button') => {
        const out = node('button', cls, label, parent); out.setAttribute('type', 'button'); out.addEventListener('click', action); return out;
    };
    function control(parent, label, value, field, assign, path, extra = {}) {
        const row = node('label', 'ss-block-control', '', parent);
        node('span', 'ss-block-control-label', label, row);
        const error = node('small', 'ss-block-control-error', '', row); error.setAttribute('role', 'alert');
        const ctx = { doc, field: field.type === 'text' ? { ...field, codepoints: true } : field, value, ariaLabel: label,
            onChange: assign, invalid: message => { error.textContent = message; }, note() {}, ...extra };
        const handle = field.type === 'choice' ? selectField(ctx) : field.type === 'int' ? numberField(ctx) : textField(ctx);
        handle.input.addEventListener('input', () => updateCount());
        handle.input.addEventListener('change', () => updateCount());
        row.insertBefore(handle.el, error);
        controls.push({ handle, assign });
        if (path) spots.set(path, error);
        return handle;
    }
    const collect = () => { for (const entry of controls) entry.assign(entry.handle.get()); };
    const refresh = () => { collect(); draw(); };
    function fieldOptions(numbersOnly = false) {
        return draft.fields.filter(field => !numbersOnly || field.type === 'number')
            .map(field => ({ value: field.key, label: field.name || field.key }));
    }
    function newEffect(type) {
        return { field: fieldOptions(type === 'timer')[0]?.value ?? '', op: type === 'timer' ? 'add' : 'set', value: '' };
    }
    function renameField(field, name) {
        const old = field.key, next = slugify(name).slice(0, 32).replace(/-+$/, '');
        field.name = name;
        if (next === old) return;
        field.key = next;
        if (draft.roles && draft.roles.field === old) draft.roles.field = next;
        for (const fn of draft.functions) {
            if (fn.when?.field === old) fn.when.field = next;
            for (const effect of fn.effects ?? []) if (effect.field === old) effect.field = next;
        }
    }
    // A part of an entry is keyed by one lowercase word of its name; the card roles that name it follow the rename.
    function renamePart(field, part, name) {
        const old = part.key, next = partKey(name);
        part.name = name;
        if (!next || next === old) return;
        part.key = next;
        if (draft.roles?.field === field.key) for (const role of ['title', 'status', 'step']) if (draft.roles[role] === old) draft.roles[role] = next;
    }
    // Changing a field's type to or from a List of entries brings or takes its parts and its most entries.
    function setType(field, type) {
        if (type === 'entries' && field.type !== 'entries') {
            field.of = [{ key: 'title', name: 'Title', type: 'text', max: 60, default: '' }];
            field.max = 30; delete field.default; delete field.min; delete field.values; delete field.names;
        } else if (type !== 'entries' && field.type === 'entries') {
            delete field.of; field.max = type === 'number' ? 10 : 120; field.default = type === 'number' ? 0 : '';
        }
        field.type = type;
    }
    // How the block will be drawn, worked out from the form as it is now (nothing is stored here): the layout (the author's while it still fits the fields, else
    // the shape's suggestion), the card roles for a list of cards, and whether the roles were guessed.
    function resolve() {
        const shape = layoutShape(draft);
        const stored = draft.layout && shape.fits[draft.layout]?.ok ? draft.layout : null;
        const effective = stored ?? shape.suggested;
        const info = effective === 'cards' ? cardRoles(draft) : { roles: null, guessed: false };
        return { shape, effective, ...info, fell: draft.layout && !stored && shape.suggested ? shape.suggested : null };
    }
    const confirmReplace = () => { const win = doc.defaultView ?? globalThis; return typeof win.confirm === 'function' ? win.confirm(S.replaceFields) : true; };
    function applyStarter(item) {
        collect();
        if (draft.fields.length && !confirmReplace()) return;
        const next = item.id === 'empty' ? { fields: [], functions: [], prompt: '', show: { tab: true, card: false, tabName: '', icon: 'ph-bookmark-simple' } } : item.draft();
        if (!draft.name || BLOCK_STARTERS.some(each => each.draft().name === draft.name)) draft.name = next.name ?? '';
        // (every field has a key from its name, as the form's own Add field gives it)
        for (const field of next.fields) field.key ??= slugify(field.name).slice(0, 32).replace(/-+$/, '');
        for (const key of ['fields', 'functions', 'prompt', 'show']) draft[key] = next[key];
        for (const key of ['layout', 'roles', 'tones']) { if (next[key]) draft[key] = next[key]; else delete draft[key]; }
        meta.pickedStarter = item.id; meta.starterName = item.name; meta.rolesAuthor = false;
        meta.layoutBy = item.id === 'empty' ? 'shape' : 'starter'; meta.layoutNote = '';
        meta.starterNote = item.id === 'empty' ? '' : fill(S.starterFilled, { fields: `${next.fields.length} ${next.fields.length === 1 ? 'field' : 'fields'}`,
            layout: LAYOUT_NAMES[next.layout] ?? '', roles: next.roles ? S.starterRoles : '' });
        draw();
    }
    // The parts of one entry in a List of entries: a small form of its own for each (name, kind, its limits), at most eight.
    function paintParts(row, field, index) {
        control(row, S.entriesMaxLabel, field.max ?? 30, { type: 'int', min: 1, max: DM_LIMITS.entriesMax }, value => { if (field.type === 'entries') field.max = value; }, `field:${index}:max`);
        const parts = node('div', 'ss-block-parts', '', row);
        node('h5', 'ss-block-parts-title', S.partsOf, parts);
        for (const [at, part] of field.of.entries()) {
            const spot = `field:${index}:part:${at}`;
            const card = node('div', 'ss-block-part', '', parts);
            const name = control(card, S.partName, part.name, { type: 'text', max: 60 }, value => renamePart(field, part, value), spot);
            name.input.addEventListener('change', refresh);
            const type = control(card, S.fieldTypeLabel, part.type, { type: 'choice', options: PART_TYPES }, value => { part.type = value; }, `${spot}:type`);
            type.input.addEventListener('change', refresh);
            if (part.type === 'number') {
                control(card, S.min, part.min ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { part.min = value; }, `${spot}:min`);
                control(card, S.max, part.max ?? 10, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { part.max = value; }, `${spot}:max`);
                control(card, S.defaultValue, part.default ?? 0, { type: 'int', min: -DM_LIMITS.integer, max: DM_LIMITS.integer }, value => { part.default = value; }, `${spot}:default`);
            } else if (part.type === 'choice') {
                control(card, S.choices, Array.isArray(part.values) ? part.values.join(', ') : part.values ?? '', { type: 'text', max: 500 }, value => { part.values = String(value).split(',').map(each => each.trim()); }, `${spot}:values`);
                control(card, S.defaultValue, part.default ?? '', { type: 'text', max: 240 }, value => { part.default = value; }, `${spot}:default`);
            } else {
                control(card, S.max, part.max ?? 120, { type: 'int', min: 1, max: 240 }, value => { part.max = value; }, `${spot}:max`);
                control(card, S.defaultValue, part.default ?? '', { type: 'text', max: 240 }, value => { part.default = value; }, `${spot}:default`);
            }
            const gone = button(card, S.remove, () => { collect(); field.of.splice(at, 1); draw(); });
            gone.disabled = field.of.length <= 1;
        }
        const add = button(parts, S.addPart, () => {
            collect();
            const taken = new Set(field.of.map(part => part.key));
            const name = PART_NAMES.find(each => !taken.has(partKey(each))) ?? `Part ${String.fromCharCode(97 + field.of.length)}`;
            field.of.push({ key: partKey(name), name, type: 'text', max: 120, default: '' });
            draw();
        });
        add.disabled = field.of.length >= DM_LIMITS.entrySubs;
    }
    function paintEffects(parent, fn, functionIndex) {
        const timer = fn.type === 'timer';
        if (timer && !fieldOptions(true).length) node('p', 'ss-block-hint', S.timerNumber, parent);
        for (const [index, effect] of fn.effects.entries()) {
            const row = node('div', 'ss-block-effect', '', parent);
            control(row, S.effectField, effect.field, { type: 'choice', options: fieldOptions(timer) }, value => { effect.field = value; }, `function:${functionIndex}:effect:${index}:field`);
            control(row, S.effectAction, effect.op, { type: 'choice', options: timer ? [{ value: 'add', label: S.add }]
                : [{ value: 'set', label: S.setTo }, { value: 'add', label: S.add }] }, value => { effect.op = value; }, `function:${functionIndex}:effect:${index}:op`);
            control(row, S.effectValue, effect.value, { type: 'text', max: 240 }, value => { effect.value = value; }, `function:${functionIndex}:effect:${index}:value`);
            button(row, S.remove, () => { collect(); fn.effects.splice(index, 1); draw(); });
        }
        button(parent, S.addStep, () => { collect(); fn.effects.push(newEffect(fn.type)); draw(); });
    }
    async function submit() {
        if (busy || !alive) return;
        collect();
        for (const spot of spots.values()) spot.textContent = '';
        // The layout the form shows is the one saved, except where saving it would only write down what the block already is: the default (plain rows, no key),
        // and an old block with no layout the author has not touched (it keeps its bytes, and is drawn as before).
        const live = resolve();
        const keepsBytes = !meta.layoutAtOpen && draft.slug && meta.layoutBy === 'shape' && !draft.fields.some(field => field.type === 'entries');
        const save = !live.effective ? null : live.effective === meta.layoutAtOpen ? live.effective : live.effective === 'fields' || keepsBytes ? null : live.effective;
        if (save) draft.layout = save; else delete draft.layout;
        if (live.roles) draft.roles = live.roles; else delete draft.roles;
        const result = buildBlock(draft, { used });
        if (!result.ok) {
            const error = result.errors[0], location = error.path ?? '';
            const match = /(?:fields\.(\d+)|state\.([a-z0-9-]+)|functions\.(\d+)|\.show|\.prompt)/.exec(location);
            const kind = /\.kinds\.(?:set|add|drop|change)-([a-z0-9-]+)/.exec(location);
            const partAt = /(?:fields\.(\d+)\.of\.(\d+)|state\.([a-z0-9-]+)\.of\.([a-z]+))/.exec(location);
            const buttonKind = /\.kinds\.button-([a-z0-9-]+)/.exec(location);
            const rule = /\.rules\[(\d+)\]/.exec(location), timer = /\.timers\[(\d+)\]/.exec(location);
            const card = /\.cards\[(\d+)\]/.exec(location), replyEnd = /\.replyEnd\[(\d+)\]/.exec(location);
            const functionIndex = (type, index) => {
                const selected = draft.functions.filter(fn => fn.type === type)[Number(index)];
                return draft.functions.indexOf(selected);
            };
            const partIndex = partAt ? (partAt[1] !== undefined ? [partAt[1], partAt[2]] : (() => {
                const at = draft.fields.findIndex(field => field.key === partAt[3]);
                return [String(at), String(draft.fields[at]?.of?.findIndex(part => part.key === partAt[4]) ?? -1)];
            })()) : null;
            const path = partIndex && partIndex[0] !== '-1' && partIndex[1] !== '-1' ? `field:${partIndex[0]}:part:${partIndex[1]}`
                : /\.(?:layout|roles|tones)(?:\.|\[|$)/.test(location) ? 'layout'
                : match?.[1] !== undefined ? `field:${match[1]}` : match?.[2] ? `field:${draft.fields.findIndex(field => field.key === match[2])}`
                : match?.[3] !== undefined ? `function:${match[3]}` : kind ? `field:${draft.fields.findIndex(field => field.key === kind[1])}`
                    : buttonKind ? `function:${draft.functions.findIndex((fn, index) => fn.type === 'button'
                        && slugify(fn.name || `button-${index + 1}`).slice(0, 32).replace(/-+$/, '') === buttonKind[1])}`
                        : rule ? `function:${functionIndex('rule', rule[1])}` : timer ? `function:${functionIndex('timer', timer[1])}`
                        : card ? `function:${functionIndex('card', card[1])}` : replyEnd ? `function:${functionIndex('reply-end', replyEnd[1])}`
                        : /\.show/.test(location) ? 'show' : /prompt/.test(location) ? 'prompt' : location === 'name' ? 'name' : 'form';
            const part = /\.(min|max|default|values|names|type|every|when|button|tone|title|text|effects)(?:\.|\[|$)/.exec(location)?.[1];
            const effect = /\.(?:effects|then)(?:\.(\d+)|\[(\d+)\])(?:\.(field|op|value))?/.exec(location);
            const effectSpot = effect ? spots.get(`${path}:effect:${effect[1] ?? effect[2]}:${effect[3] ?? 'value'}`) : null;
            (effectSpot ?? spots.get(`${path}:${part}`) ?? spots.get(path) ?? spots.get('form')).textContent = error.message;
            return;
        }
        busy = true;
        let answer;
        try { answer = await onSave(result.definition); } catch (error) { answer = { ok: false, message: String(error?.message ?? error) }; }
        busy = false;
        if (alive && !answer?.ok) spots.get('form').textContent = answer?.message ?? STRINGS.editable.failed;
    }
    // Layout (three chips, one line on where the choice came from, the reason a chip is off), the card roles and status colours of a list of cards, and the preview.
    function paintLayout(form) {
        const now = resolve(), { shape, effective } = now;
        const section = node('section', 'ss-block-layout', '', form);
        node('h4', 'ss-section-label', S.layout, section);
        const chips = node('div', 'ss-block-chips', '', section);
        for (const layout of LAYOUTS) {
            const item = button(chips, LAYOUT_NAMES[layout], () => { collect(); draft.layout = layout; meta.layoutBy = 'chosen'; meta.layoutNote = ''; draw(); },
                `ss-button ss-chip${effective === layout ? ' ss-chip-on' : ''}`);
            item.disabled = !shape.fits[layout].ok;
            item.setAttribute('aria-pressed', String(effective === layout));
        }
        const why = meta.layoutNote || (meta.layoutBy === 'chosen' ? `${S.whyChosen}${shape.why}` : meta.layoutBy === 'starter' ? `${fill(S.whyStarter, { name: meta.starterName })}${shape.why}` : shape.why);
        const line = node('p', 'ss-block-hint ss-block-layout-why', why, section); line.setAttribute('role', 'status');
        if (!shape.suggested) { /* (an empty form: the line above is the only reason) */ } else {
            for (const layout of LAYOUTS) if (!shape.fits[layout].ok) node('p', 'ss-block-hint ss-block-layout-reason', `${LAYOUT_NAMES[layout]}: ${shape.fits[layout].reason}`, section);
        }
        const layoutError = node('small', 'ss-block-control-error', '', section); layoutError.setAttribute('role', 'alert'); spots.set('layout', layoutError);
        if (now.roles) {
            const roles = node('div', 'ss-block-roles', '', section);
            node('h5', 'ss-block-parts-title', S.cardRoles, roles);
            const lists = draft.fields.filter(field => field.type === 'entries' && field.of.some(part => part.type === 'text'));
            const field = lists.find(item => item.key === now.roles.field) ?? lists[0];
            const partsOf = type => field.of.filter(part => part.type === type).map(part => ({ value: part.key, label: part.name || part.key }));
            const set = (key, value) => { draft.roles = { ...(draft.roles ?? now.roles), [key]: value }; meta.rolesAuthor = true; meta.rolesGuessed = false; };
            if (lists.length > 1) {
                const list = control(roles, S.roleList, field.key, { type: 'choice', options: lists.map(item => ({ value: item.key, label: item.name || item.key })) },
                    value => { if (value !== draft.roles?.field) { draft.roles = { field: value }; meta.rolesAuthor = false; } }, 'roles:field');
                list.input.addEventListener('change', refresh);
            }
            const pick = (label, key, options, spot) => {
                const handle = control(roles, label, now.roles[key], { type: 'choice', options }, value => { if (value !== now.roles[key]) set(key, value); }, spot);
                handle.input.addEventListener('change', refresh);
            };
            const none = { value: '', label: S.roleNone };
            pick(S.roleTitle, 'title', partsOf('text'), 'roles:title');
            pick(S.roleStatus, 'status', [none, ...partsOf('choice')], 'roles:status');
            pick(S.roleStep, 'step', [none, ...partsOf('text').filter(option => option.value !== now.roles.title)], 'roles:step');
            if (meta.rolesGuessed) node('small', 'ss-block-hint', S.rolesGuessed, roles);
            const others = field.of.filter(part => ![now.roles.title, now.roles.status, now.roles.step].includes(part.key));
            const description = others.find(part => part.type === 'text'), rest = others.filter(part => part !== description);
            const also = [description ? `${description.name} under the title` : '', rest.length ? `${rest.map(part => part.name).join(', ')} in a small line` : ''].filter(Boolean).join(', and ');
            if (also) node('small', 'ss-block-hint', fill(S.rolesAlso, { text: `${also}.` }), roles);
            const tones = statusTones(draft, now.roles);
            if (tones.length) {
                const colours = node('div', 'ss-block-tones', '', roles);
                node('h5', 'ss-block-parts-title', S.statusColours, colours);
                for (const { value, tone } of tones) {
                    const rowTone = node('div', 'ss-block-tone-row', '', colours);
                    node('span', `ss-pill ss-block-tone ss-block-tone-${tone}`, value, rowTone);
                    const choice = control(rowTone, value, tone, { type: 'choice', options: TONES.map(each => ({ value: each, label: TONE_NAMES[each] })) }, next => {
                        if (next === (draft.tones?.[value] ?? defaultTone(value))) return;
                        if (next === defaultTone(value)) { delete draft.tones?.[value]; if (draft.tones && !Object.keys(draft.tones).length) delete draft.tones; } else (draft.tones ??= {})[value] = next;
                    }, `tone:${value}`);
                    choice.input.addEventListener('change', refresh);
                }
            }
        }
        // (the preview is a child of the form itself, so that it can stay in view below the fields above it)
        const preview = node('section', 'ss-block-preview ss-glass', '', form);
        node('h4', 'ss-section-label', S.preview, preview);
        const body = node('div', 'ss-block-preview-body', '', preview), where = node('small', 'ss-block-hint', '', preview);
        paintPreview = () => {
            try { previewHandle?.destroy?.(); } catch { /* (a preview is only a picture) */ }
            previewHandle = null; body.replaceChildren(); where.textContent = '';
            if (!draft.fields.length) { node('p', 'ss-block-hint', S.previewNothing, body); return; }
            const live = resolve();
            const built = buildBlock({ ...draft, ...(live.effective ? { layout: live.effective } : {}), ...(live.roles ? { roles: live.roles } : {}) }, { used });
            const definition = built.definition;
            if (!definition) { node('p', 'ss-block-hint', S.previewBroken, body); return; }
            const values = exampleValues(definition);
            try { previewHandle = renderPreview ? renderPreview(body, { definition, values, layout: definition.layout ?? 'fields' }) : sketch(body, definition, values); } catch { sketch(body, definition, values); }
            node('small', 'ss-block-hint', S.previewExample, body);
            const show = definition.show;
            where.textContent = !show.tab ? '' : show.into ? fill(S.previewInto, { tab: tabs.find(tab => tab.id === show.into)?.title ?? show.into }) : fill(S.previewOwn, { name: show.tabName });
        };
        paintPreview();
    }
    // The plain sketch of a block in each layout, used until the host hands in its own drawing: cards with a status chip, bars, lines.
    function sketch(parent, definition, values) {
        const wrap = node('div', `ss-block-sketch ss-block-sketch-${definition.layout ?? 'fields'}`, '', parent);
        const roles = definition.roles;
        for (const [key, schema] of Object.entries(definition.state)) {
            if (definition.layout === 'cards' && schema.type === 'entries' && roles?.field === key) {
                const tone = value => definition.tones?.[value] ?? defaultTone(value);
                const done = [];
                for (const entry of values[key]) {
                    const state = roles.status ? entry[roles.status] : null, finished = state !== null && ['done', 'failed'].includes(tone(state));
                    // (a finished card waits for the fold below the active ones)
                    const box = node('div', 'ss-block-sketch-card', '', finished ? null : wrap);
                    const head = node('div', 'ss-block-sketch-head', '', box);
                    node('b', '', entry[roles.title], head);
                    if (state !== null) node('span', `ss-pill ss-block-tone ss-block-tone-${tone(state)}`, state, head);
                    if (roles.step && entry[roles.step]) node('small', 'ss-block-hint', entry[roles.step], box);
                    if (finished) done.push(box);
                }
                if (done.length) {
                    const fold = node('details', 'ss-block-sketch-fold', '', wrap);
                    node('summary', '', fill(S.previewMore, { n: done.length }), fold);
                    for (const card of done) fold.appendChild(card);
                }
            } else if (definition.layout === 'bars' && schema.type === 'int') {
                const line = node('div', 'ss-block-sketch-bar', '', wrap);
                node('span', '', `${schema.label ?? key} ${values[key]}`, line);
                const track = node('span', 'ss-block-sketch-track', '', line);
                const bar = node('span', 'ss-block-sketch-fill', '', track);
                bar.setAttribute('style', `width:${Math.round(100 * (values[key] - schema.min) / Math.max(1, schema.max - schema.min))}%`);
            } else {
                const line = node('div', 'ss-block-sketch-line', '', wrap);
                node('span', 'ss-block-hint', schema.label ?? key, line);
                node('span', '', schema.type === 'entries' ? `${values[key].length}` : String(values[key]), line);
            }
        }
        return null;
    }
    function draw() {
        updateCount = () => {};
        for (const entry of controls) entry.handle.destroy();
        controls = []; spots = new Map(); renamed = new Map();
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
        updateCount = () => {
            collect();
            paintPreview();
            const result = buildBlock(draft, { used });
            const definition = result.definition;
            const n = definition ? [...fullModuleGrammar(definition, `pack.chat/${definition.slug}`)].length : [...draft.prompt].length;
            total.textContent = fill(S.staticCount, { n });
        };
        updateCount();
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
                    renamed.set(fn.name, value);
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
                control(row, S.cardButtonLabel, fn.button ?? '', { type: 'choice', options: [{ value: '', label: S.noButton }, ...buttons] }, value => { const button = renamed.get(value) ?? value; if (button) fn.button = button; else delete fn.button; }, `function:${index}:button`);
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
        const error = node('p', 'ss-block-control-error', '', form); error.setAttribute('role', 'alert'); spots.set('form', error);
        form.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); onCancel(); }
            else if (event.key === 'Enter') { event.preventDefault?.(); event.stopPropagation?.(); submit(); }
        });
    }
    draw();
    return { collect, destroy() { alive = false; for (const entry of controls) entry.handle.destroy(); controls = []; } };
}
