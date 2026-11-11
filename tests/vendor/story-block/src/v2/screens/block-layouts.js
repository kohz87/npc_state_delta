// How a block (or a data module's screen) draws its values, by the shape of the data (BLOCKS-UI, USER 4 Nov):
//   * a list of records (an `entries` field read through the block's `roles`): compact cards, a title and a status
//     chip, the description clamped to 2 lines with More, the current step with an icon; the open ones first, the others under "Finished (n)";
//   * a map of numbers (a map field of whole numbers, or several number fields): a header, a row with a value and a bar for each key, highest
//     first; the ones still at their default under "Not known yet (n)"; one pencil column;
//   * a record of fields: a card of label/value lines.
// Pure DOM building from plain data (createElement and textContent only); the editors are the editable widget's, and every change is one dm.set.
import { h, iconNode, humanize } from '../view/widgets/dom.js';
import { editable } from '../view/widgets/editable.js';
import { defaultTone } from '../data-modules/block-builder.js';
import { dmNameOf, dmObject, dmOwn } from '../data-modules/schema.js';
import { ensureLayoutStyles } from '../layout/styles.js';
import { STRINGS, fill } from '../strings.js';

const V = STRINGS.blocks.view;
const TONE_CLASS = { accent: 'accent', active: 'accent', done: 'good', good: 'good', failed: 'bad', bad: 'bad', warn: 'warn', neutral: 'neutral' };

/** The tone of a status value: the block's `tones` entry, else the editor's default (active, done and failed by their name, any other value neutral and open). */
export function statusTone(definition, values, value) {
    const given = definition?.tones?.[value];
    return ['active', 'done', 'failed', 'neutral'].includes(given) ? given : defaultTone(value);
}
const chipTone = tone => TONE_CLASS[tone] ?? 'neutral';
const isOpen = tone => tone === 'active' || tone === 'neutral';

function chip(doc, text, tone) {
    const out = h(doc, 'span', `ss-l-badge ss-l-tone-${chipTone(tone)} ss-b-chip`);
    out.appendChild(h(doc, 'span', 'ss-l-value', text));
    return out;
}

/** The pencil beside a value: the editable widget with no shown value (the caller draws it), its command wrapped so the pencil keeps the focus. */
function pencilFor(env, parent, props, mark) {
    const slot = h(env.doc, 'span', 'ss-b-pen');
    parent.appendChild(slot);
    const run = typeof env.api?.command === 'function' ? async (type, payload) => {
        const focused = slot.contains(env.doc.activeElement);
        const result = await env.api.command(type, payload);
        if (result?.ok && focused) env.after?.(mark);
        return result;
    } : undefined;
    env.handles.push(editable.render(slot, { displayValue: false, ...props }, { command: run }));
    const pencil = slot.querySelector('.ss-w-editable-pencil');
    for (const [name, value] of Object.entries(mark ?? {})) pencil?.setAttribute(`data-block-${name}`, String(value ?? ''));
    return slot;
}

function editorProps(module, field, key, scalar, label, who) {
    const props = { label, command: 'dm.set', payload: { module, field, ...(who ? { who } : {}), ...(key ? { key } : {}) } };
    if (scalar.type === 'int') Object.assign(props, { kind: 'number', min: scalar.min, max: scalar.max });
    else if (scalar.type === 'enum') Object.assign(props, { kind: 'choice', options: scalar.values });
    else if (scalar.type === 'bool') Object.assign(props, { kind: 'choice', options: [true, false] });
    else Object.assign(props, { kind: 'text', maxLength: scalar.max });
    return props;
}

// ---- a list of records -----------------------------------------------------------------------------------------------------------------

/**
 * Cards for records. `items`: [{ id, title, text, step, tone, statusLabel, name, edit }] where `edit` (or null) is the editable's props for the card's pencil.
 * env.memory remembers which descriptions and "Finished" are open across redraws.
 */
export function drawCards(env, parent, items, { key = 'cards' } = {}) {
    const { doc } = env;
    ensureLayoutStyles(doc);
    const open = items.filter(item => isOpen(item.tone)), done = items.filter(item => !isOpen(item.tone));
    const card = item => {
        const li = h(doc, 'li', 'ss-b-quest');
        li.setAttribute('data-quest', item.id);
        li.setAttribute('data-tone', item.tone);
        const head = h(doc, 'div', 'ss-b-q1'); li.appendChild(head);
        head.appendChild(h(doc, 'b', 'ss-b-qt', item.title));
        if (item.statusLabel) head.appendChild(chip(doc, item.statusLabel, item.tone));
        if (item.edit) pencilFor(env, head, item.edit, { quest: item.id });
        const memory = `${key}:${item.id}`;
        let text = null, more = null;
        if (item.text) {
            text = h(doc, 'p', 'ss-b-q2', item.text);
            text.setAttribute('data-open', String(env.memory.get(memory) === true));
            li.appendChild(text);
        }
        const foot = h(doc, 'div', 'ss-b-q3'); li.appendChild(foot);
        if (item.step) {
            const glyph = iconNode(doc, isOpen(item.tone) ? 'ph-map-pin' : 'ph-check-circle', 'ss-w-icon ss-b-stepicon');
            if (glyph) foot.appendChild(glyph);
            foot.appendChild(h(doc, 'span', 'ss-b-step', item.step));
        }
        if (text) {
            more = h(doc, 'button', 'ss-pill ss-pill-outline ss-tap-pill ss-b-more', V.more);
            more.setAttribute('type', 'button');
            const sync = () => {
                const expanded = text.getAttribute('data-open') === 'true';
                more.textContent = expanded ? V.less : V.more;
                more.setAttribute('aria-expanded', String(expanded));
            };
            sync();
            more.addEventListener('click', () => {
                env.memory.set(memory, text.getAttribute('data-open') !== 'true');
                text.setAttribute('data-open', String(env.memory.get(memory)));
                sync();
            });
            // Shown only where the text is cut (measured once drawn); a long text is assumed cut where nothing can be measured.
            const cut = () => {
                if (text.getAttribute('data-open') === 'true') return true;
                return text.clientHeight > 0 ? text.scrollHeight > text.clientHeight + 1 : [...item.text].length > 90;
            };
            more.hidden = !cut();
            foot.appendChild(more);
            const recheck = () => { more.hidden = !cut(); };
            const view = doc.defaultView;
            if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(recheck);
            if (typeof view?.ResizeObserver === 'function') {
                const observer = new view.ResizeObserver(recheck);
                observer.observe(li);
                env.handles.push({ destroy() { observer.disconnect(); } });
            }
        }
        foot.hidden = !item.step && !text;
        return li;
    };
    const root = h(doc, 'div', 'ss-b-quests-root ss-l-root'); parent.appendChild(root);
    if (open.length) {
        const section = h(doc, 'section', 'ss-b-sec'); root.appendChild(section);
        section.appendChild(h(doc, 'h4', 'ss-section-label', fill(V.active, { n: open.length })));
        const list = h(doc, 'ul', 'ss-b-qs'); section.appendChild(list);
        for (const item of open) list.appendChild(card(item));
    }
    if (done.length) {
        const fold = h(doc, 'details', 'ss-b-fold');
        const label = `${key}:finished`;
        if (env.memory.get(label) === true) fold.setAttribute('open', '');
        fold.addEventListener('toggle', () => env.memory.set(label, fold.open === true));
        fold.appendChild(h(doc, 'summary', '', fill(V.finished, { n: done.length })));
        const list = h(doc, 'ul', 'ss-b-qs'); fold.appendChild(list);
        for (const item of done) list.appendChild(card(item));
        root.appendChild(fold);
    }
    if (!open.length && !done.length) root.appendChild(h(doc, 'p', 'ss-b-none', V.nothing));
    return root;
}

// ---- entries (a list of records the block keeps in one field) -------------------------------------------------------------------------

const cap = text => text.charAt(0).toUpperCase() + text.slice(1);
const isNum = sub => sub?.type === 'int' || sub?.type === 'number';
const subLabel = (sub, key) => sub?.label ?? sub?.name ?? cap(humanize(key));
const subText = value => (value === undefined || value === null ? '' : String(value));

/** Whether this field is the entries field the block's roles read. */
export function entriesRoles(definition, field) {
    const roles = definition?.roles;
    const schema = definition?.state?.[field];
    if (!dmObject(roles) || roles.field !== field || !dmObject(schema?.of) || !['cards', 'bars', 'fields'].includes(definition.layout)) return null;
    return roles;
}

export function drawEntries(env, parent, { definition, module, field, list }) {
    const schema = definition.state[field], roles = entriesRoles(definition, field);
    const rows = (Array.isArray(list) ? list : []).filter(dmObject);
    const of = schema.of;
    const statusKey = roles.status && dmOwn(of, roles.status) ? roles.status : null;
    const statusValues = statusKey ? of[statusKey].values ?? of[statusKey].options ?? [] : [];
    const layout = definition.layout;
    if (layout === 'cards') {
        const used = new Set([roles.title, roles.status, roles.step].filter(Boolean));
        const textKey = roles.text && dmOwn(of, roles.text) ? roles.text : Object.keys(of).find(key => !used.has(key) && of[key].type === 'text') ?? null;
        const items = rows.map((row, at) => {
            const value = statusKey ? row[statusKey] : null;
            const tone = statusKey ? statusTone(definition, statusValues.map(item => (dmObject(item) ? item.value : item)), value) : 'active';
            return { id: String(at), title: subText(row[roles.title]) || `#${at + 1}`, text: textKey ? subText(row[textKey]) : '', step: roles.step ? subText(row[roles.step]) : '',
                tone, statusLabel: statusKey ? subText(value) : '', edit: null };
        });
        return drawCards(env, parent, items, { key: `${module}:${field}` });
    }
    const box = h(env.doc, 'ul', 'ss-b-entries'); parent.appendChild(box);
    for (const [at, row] of rows.entries()) {
        const li = h(env.doc, 'li', layout === 'bars' ? 'ss-b-row' : 'ss-b-rec'); box.appendChild(li);
        li.setAttribute('data-entry', String(at));
        li.appendChild(h(env.doc, layout === 'bars' ? 'span' : 'b', layout === 'bars' ? 'ss-b-name' : 'ss-b-rec-title', subText(row[roles.title]) || `#${at + 1}`));
        if (layout === 'bars') {
            const numberKey = (statusKey && isNum(of[statusKey]) ? statusKey : Object.keys(of).find(key => isNum(of[key]))) ?? null;
            if (numberKey) {
                const value = Number(row[numberKey]) || 0, def = of[numberKey], min = Number(def.min ?? 0), max = Number(def.max ?? 100);
                li.appendChild(h(env.doc, 'span', 'ss-b-val', String(value)));
                li.appendChild(barNode(env.doc, value, min, max));
            }
        } else {
            const dl = h(env.doc, 'dl', 'ss-b-lines'); li.appendChild(dl);
            for (const key of Object.keys(of)) {
                if (key === roles.title) continue;
                const line = h(env.doc, 'div', 'ss-b-line'); dl.appendChild(line);
                line.appendChild(h(env.doc, 'dt', '', subLabel(of[key], key)));
                line.appendChild(h(env.doc, 'dd', '', subText(row[key])));
            }
        }
    }
    if (!rows.length) box.appendChild(h(env.doc, 'li', 'ss-b-none', V.nothing));
    return box;
}

// ---- a map of numbers --------------------------------------------------------------------------------------------------------------------

function barNode(doc, value, min, max) {
    const track = h(doc, 'div', 'ss-bar-track');
    const fill = h(doc, 'div', 'ss-bar-fill');
    if (min < 0) {
        track.classList.add('ss-b-track-c');
        track.appendChild(h(doc, 'span', 'ss-b-mid'));
        const reach = Math.min(1, Math.abs(value) / Math.max(Math.abs(min), Math.abs(max), 1)) * 50;
        fill.style.width = `${reach}%`;
        if (value < 0) fill.classList.add('ss-b-neg');
        fill.style.setProperty('--ss-bar-color', value < 0 ? 'var(--ss-bad)' : 'var(--ss-tick)');
    } else {
        const span = max - min;
        track.style.setProperty('--ss-fill', String(span > 0 ? Math.round(Math.min(1, Math.max(0, (value - min) / span)) * 10000) / 10000 : 0));
        fill.style.setProperty('--ss-bar-color', 'var(--ss-accent)');
    }
    track.appendChild(fill);
    return track;
}

const signed = (value, min) => (min < 0 && value > 0 ? `+${value}` : String(value));

const TOP_KNOWN = 3;

/** A signed range's scale, shown once under the first row: the field's own names for its ends and middle, else "−100 … 0 … +100". */
function scaleNode(doc, row) {
    const named = value => (row.names ? dmNameOf({ type: 'int', names: row.names }, value) : null);
    const out = h(doc, 'li', 'ss-rm-scale');
    for (const value of [row.min, 0, row.max]) out.appendChild(h(doc, 'span', '', named(value) ?? (value < 0 ? `\u2212${-value}` : value > 0 ? `+${value}` : '0')));
    return out;
}

/**
 * rows: [{ key, name, value, min, max, def, names, payload, label }] (`payload` is the dm.set payload minus value; null = not editable).
 * The top three known rows (highest first) show; the other known ones and the rows at a default of 0 (or the minimum) fold into one row,
 * "N more known · Not known yet (N)", that opens in place. A signed range (min < 0) runs its bar from a centre line (red below 0, green above) and
 * shows its scale once under the first row. Pencils are hidden until the section's Edit button is pressed (kept in `env.memory` only).
 */
export function drawNumberMap(env, parent, { title, rows, memoryKey }) {
    const { doc } = env;
    const section = h(doc, 'section', 'ss-b-map'); parent.appendChild(section);
    section.setAttribute('data-map', memoryKey);
    const editKey = `${memoryKey}:editing`;
    if (rows.some(row => row.payload)) {
        const head = h(doc, 'div', 'ss-rm-head'); section.appendChild(head);
        if (title) head.appendChild(h(doc, 'h4', 'ss-section-label', title));
        const edit = h(doc, 'button', 'ss-rm-edit-btn ss-tap-pill', V.edited);   // a slim pill (the mockup's), a 44px tap area (size.css)
        edit.setAttribute('type', 'button');
        const reflect = on => { section.classList.toggle('ss-rm-editing', on); edit.setAttribute('aria-pressed', String(on)); };
        reflect(env.memory.get(editKey) === true);
        edit.addEventListener('click', () => { const on = !section.classList.contains('ss-rm-editing'); env.memory.set(editKey, on); reflect(on); });
        head.appendChild(edit);
    } else if (title) section.appendChild(h(doc, 'h4', 'ss-section-label', title));
    // A row is "not known yet" when it sits at a default that means nothing (0 or the minimum); a default of 40 is a value that is known.
    const unknown = row => row.value === row.def && (row.def === 0 || row.def === row.min);
    const known = rows.filter(row => !unknown(row)), rest = rows.filter(unknown);
    section.appendChild(h(doc, 'p', 'ss-b-sub', fill(V.known, { n: known.length, total: rows.length })));
    const box = h(doc, 'div', 'ss-glass ss-b-box'); section.appendChild(box);
    const pencil = (li, row) => {
        if (!row.payload) return;
        const mark = { module: row.payload.module, field: row.payload.field, key: row.payload.key ?? '', who: row.payload.who ?? '' };
        pencilFor(env, li, { kind: 'number', min: row.min, max: row.max, label: row.label ?? row.name, command: 'dm.set', payload: row.payload }, mark);
    };
    const knownRow = (list, row) => {
        const li = h(doc, 'li', 'ss-b-row'); list.appendChild(li);
        li.setAttribute('data-key', row.key);
        li.appendChild(h(doc, 'span', 'ss-b-name', row.name));
        const word = row.names ? dmNameOf({ type: 'int', names: row.names }, row.value) : null;
        const value = h(doc, 'span', `ss-b-val${row.min < 0 && row.value !== 0 ? (row.value < 0 ? ' ss-rm-neg' : ' ss-rm-pos') : ''}`, word ?? signed(row.value, row.min));
        if (word) value.setAttribute('title', String(row.value));
        li.appendChild(value);
        pencil(li, row);
        li.appendChild(barNode(doc, row.value, row.min, row.max));
    };
    const list = h(doc, 'ul', 'ss-b-list'); box.appendChild(list);
    const sorted = known.map((row, at) => ({ row, at })).sort((a, b) => b.row.value - a.row.value || a.at - b.at).map(entry => entry.row);
    sorted.slice(0, TOP_KNOWN).forEach((row, at) => { knownRow(list, row); if (at === 0 && row.min < 0) list.appendChild(scaleNode(doc, row)); });
    const more = sorted.slice(TOP_KNOWN);
    if (more.length || rest.length) {
        const fold = h(doc, 'details', 'ss-b-fold ss-rm-fold');
        const label = `${memoryKey}:unknown`;
        if (env.memory.get(label) === true) fold.setAttribute('open', '');
        fold.addEventListener('toggle', () => env.memory.set(label, fold.open === true));
        fold.appendChild(h(doc, 'summary', '', [more.length ? fill(V.moreKnown, { n: more.length }) : '', rest.length ? fill(V.unknown, { n: rest.length }) : ''].filter(Boolean).join(' \u00b7 ')));
        const inner = h(doc, 'ul', 'ss-b-list'); fold.appendChild(inner);
        for (const row of more) knownRow(inner, row);
        for (const row of rest) {
            const li = h(doc, 'li', 'ss-b-row ss-b-row-plain'); inner.appendChild(li);
            li.setAttribute('data-key', row.key);
            li.appendChild(h(doc, 'span', 'ss-b-name', row.name));
            pencil(li, row);
        }
        box.appendChild(fold);
    }
    return section;
}

/** The rows of a map field (or of number fields listed together) of a definition and the values it holds now. */
export function numberRows({ definition, module, who, values, field, fields, names = {} }) {
    const state = definition.state;
    const cap = text => text.charAt(0).toUpperCase() + text.slice(1);
    const nameOf = (key, fallback) => (typeof names[key] === 'string' && names[key] ? names[key] : cap(fallback));
    if (fields === undefined || field !== undefined) {
        const schema = state[field];
        return schema.keys.map(key => {
            const raw = values?.[field]?.[key];
            const value = Number.isFinite(raw) ? raw : schema.values.default;
            return { key, name: nameOf(key, humanize(key)), value, min: schema.values.min, max: schema.values.max, def: schema.values.default, names: schema.values.names ?? null,
                payload: schema.edit === false || schema.values.edit === false ? null : { module, field, ...(who ? { who } : {}), key } };
        });
    }
    return fields.map(name => {
        const schema = state[name], raw = values?.[name];
        const value = Number.isFinite(raw) ? raw : schema.default;
        return { key: name, name: nameOf(name, schema.label ?? humanize(name)), value, min: schema.min, max: schema.max, def: schema.default, names: schema.names ?? null,
            payload: schema.edit === false ? null : { module, field: name, ...(who ? { who } : {}) } };
    });
}

// ---- a record of fields ------------------------------------------------------------------------------------------------------------------

/** lines: [{ field, label, schema, value, tones?, unit? }]; a choice is a chip when it has tones, else a pill; the pencil edits the field. `tiles`: the lines as small tiles in one row, no pencils. */
export function drawRecordCard(env, parent, { title, lines, module, who, tiles = false }) {
    const { doc } = env;
    const section = h(doc, 'section', 'ss-b-recsec ss-l-root'); parent.appendChild(section);
    if (title) section.appendChild(h(doc, 'h4', 'ss-section-label', title));
    const dl = h(doc, 'dl', `ss-glass ss-b-card${tiles ? ' ss-rm-tiles' : ''}`); section.appendChild(dl);
    for (const line of lines) {
        const row = h(doc, 'div', 'ss-b-line'); dl.appendChild(row);
        row.setAttribute('data-field', line.field);
        row.appendChild(h(doc, 'dt', '', line.label));
        const dd = h(doc, 'dd', ''); row.appendChild(dd);
        const { schema, value } = line;
        if (schema.type === 'enum') {
            const tone = line.tones?.[value];
            // As a tile a choice is a plain word (an amber one for a warn tone) and a short code like a rank letter a round badge: no pill.
            if (tiles) dd.appendChild(h(doc, 'span', tone === 'warn' ? 'ss-rm-warn' : schema.values.every(item => String(item).length <= 2) ? 'ss-rm-badge' : '', String(value)));
            else if (tone) dd.appendChild(chip(doc, String(value), tone));
            else dd.appendChild(h(doc, 'span', 'ss-pill ss-pill-soft', String(value)));
        } else if (schema.type === 'bool') dd.textContent = value ? 'Yes' : 'No';
        else if (schema.type === 'int') dd.textContent = [dmNameOf(schema, value) ?? String(value), line.unit].filter(Boolean).join(' ');
        else dd.textContent = String(value ?? '');
        if (tiles) continue;   // (a tile has no pencil; the block's own Edit changes the field)
        const edit = h(doc, 'dd', 'ss-b-pen-cell'); row.appendChild(edit);
        if (schema.edit !== false) pencilFor(env, edit, editorProps(module, line.field, null, schema, line.label, who), { module, field: line.field, key: '', who: who ?? '' });
    }
    return section;
}

/**
 * The block editor's preview (BLOCKEDIT hands it in as `renderPreview`): draws `values` of `definition` in `layout` (cards, bars or fields) with no editors.
 * → { destroy() }.
 */
export function renderBlockPreview(parent, { definition, values, layout }) {
    const doc = parent.ownerDocument ?? globalThis.document;
    const env = { doc, api: null, handles: [], memory: new Map(), after: () => {} };
    const shown = { ...definition, layout };
    drawShapes(env, parent, { definition: shown, module: definition?.id ?? '', who: null, values: values ?? {}, preview: true });
    return { destroy() { for (const handle of env.handles) handle.destroy?.(); env.handles = []; } };
}

/** The int fields a `bars` block draws together as one map of numbers (a number with display names stays a row of its own: it is edited as a choice). */
export const barFields = definition => (definition?.layout === 'bars' ? Object.entries(definition.state ?? {}).filter(([, schema]) => schema.type === 'int' && !schema.names).map(([field]) => field) : []);

/**
 * The shapes of a block that are not plain rows, for the editor's preview: an entries field with roles is drawn through them in any layout, `bars` adds the maps
 * of numbers and the int fields together as bars, `fields` the scalar fields as one record card. (The tab draws the same shapes, with editors, in screens/blocks.js.)
 */
export function drawShapes(env, parent, { definition, module, who, values, preview = false }) {
    // (a preview has no editors: a row with no payload and a field with edit off draw no pencil)
    const rowsOf = args => numberRows(args).map(row => (preview ? { ...row, payload: null } : row));
    const state = definition?.state ?? {}, layout = definition?.layout ?? 'fields';
    const title = text => { const spaced = String(text).replace(/[-_]+/g, ' '); return spaced.charAt(0).toUpperCase() + spaced.slice(1); };
    for (const [field, schema] of Object.entries(state)) if (schema.type === 'entries' && entriesRoles(definition, field)) drawEntries(env, parent, { definition, module, field, list: values?.[field] });
    if (layout === 'cards') {
        // (entries only)
    } else if (layout === 'bars') {
        for (const [field, schema] of Object.entries(state)) {
            if (schema.type === 'map' && schema.values?.type === 'int') drawNumberMap(env, parent, { title: title(schema.label ?? field), memoryKey: `${module}:${who ?? ''}:${field}`, rows: rowsOf({ definition, module, who, values, field }) });
        }
        const fields = barFields(definition);
        if (fields.length) drawNumberMap(env, parent, { title: '', memoryKey: `${module}:${who ?? ''}:fields`, rows: rowsOf({ definition, module, who, values, fields }) });
    } else {
        const lines = Object.entries(state).filter(([, schema]) => schema.type !== 'entries' && schema.type !== 'map')
            .map(([field, schema]) => ({ field, label: schema.label ?? title(field), schema: preview ? { ...schema, edit: false } : schema, value: values?.[field] ?? schema.default }));
        if (lines.length) drawRecordCard(env, parent, { title: '', lines, module, who });
    }
}
