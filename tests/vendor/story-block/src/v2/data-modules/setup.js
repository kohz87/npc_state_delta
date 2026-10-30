// The Data modules card of Setup (Settings → Tabs & Packs, below Packs): the reader's explicit choice of which data
// modules this chat uses. Everything here is read-only until a button is pressed twice: "Enable for this chat" opens
// a preview of the exact hashes, subjects and clock baseline and writes nothing; its second button sends `dm.pin` with
// the hashes that were displayed, so a changed library answers STALE. Cancel and inspect write nothing. No narrator
// line or pack install enables a module.
//
// Pack-written text (names, versions, reasons) goes in through textContent only. `api`: { query(name, args),
// command(type, payload) } or { sdk }. Returns { refresh() }.
import { button, el, plural } from '../../ui/dom.js';
import { DM_LIMITS as L } from './schema.js';
import { kindExample, referenceOf } from './grammar.js';
import { STRINGS } from '../strings.js';
import { editable } from '../view/widgets/editable.js';

const boundsOf = schema => schema.type === 'int' ? `${schema.min} to ${schema.max}, starts at ${schema.default}`
    : schema.type === 'bool' ? `true or false, starts ${schema.default}`
        : schema.type === 'enum' ? `${schema.values.join(', ')}; starts ${schema.default}`
            : schema.type === 'text' ? `text up to ${schema.max}; starts "${schema.default}"`
                : `${schema.keys.join(', ')}, each ${boundsOf(schema.values)}`;

/** The facts a reader needs before enabling a module, as plain lines: fields, lines, rewards, needs, screens, budgets. */
export function describe(row) {
    const definition = row.definition, reference = referenceOf([row.module], row.module);
    const needs = [...new Set([...(definition.scope === 'character' || Object.values(definition.imports).some(entry => ['director.time', 'checks.policy'].includes(entry.query)) ? ['Story Director'] : []),
        ...Object.values(definition.imports).filter(entry => entry.query === 'dataModules.public').map(entry => `data module ${entry.args.module}`)])];
    return {
        fields: Object.entries(definition.state).map(([name, schema]) => `${name}: ${boundsOf(schema)}${schema.edit === false ? STRINGS.editMessages.lockedSuffix : ''}`),
        lines: Object.keys(definition.kinds).map(name => kindExample(definition, name, reference)),
        rewards: Object.entries(definition.rewards).map(([name, reward]) => `${name}: ${Object.entries(reward.values).map(([value, range]) => range.table ? `${value} by ${range.binding}` : `${value} ${range.min} to ${range.max} (${range.pick})`).join(', ')}`),
        checks: Object.entries(definition.kinds).filter(([, kind]) => kind.check).map(([name, kind]) => `${name}: ${kind.check.skill}/${kind.check.stat} DC ${kind.check.dc}`),
        timers: definition.timers.map(timer => `${timer.id}: every ${timer.every} minute${timer.every === 1 ? '' : 's'} of story time`),
        needs,
        screens: definition.screens.map(screen => screen.title ?? screen.id),
        budgets: `${L.rootVisits} evaluation steps per action, ${L.replyRoots} actions per reply, ${L.subjects} characters, ${L.pins} modules per chat`,
    };
}

export function renderDataModules(root, api = {}) {
    const doc = root.ownerDocument ?? globalThis.document;
    const sdk = api.sdk ?? api;
    const ask = (name, args) => { try { return sdk.query?.(name, args); } catch { return null; } };
    const run = (type, payload) => sdk.command?.(type, payload);
    const make = (tag, className = '', text = '', parent = null) => { const node = el(tag, className, text, doc); parent?.appendChild(node); return node; };
    let shown = '';
    let notes = {};
    let previewing = '';
    const chosen = new Map();
    let editors = [];

    const valueOf = (view, entry) => {
        const values = entry.who === undefined ? view?.chat : view?.characters?.[entry.index];
        return entry.key === null ? values?.[entry.field] : values?.[entry.field]?.[entry.key];
    };
    const signatureOf = rows => JSON.stringify(rows.map(row => [row.module, row.hash, row.status, row.reason,
        row.subjects, row.actors, row.baseline, row.pinnedDefinition,
        row.pinned ? ask('dataModules.view', { module: row.module }) : null]));
    async function editField(type, payload) {
        const result = await run(type, payload);
        if (result?.ok) {
            const views = new Map();
            for (const entry of editors) {
                if (!views.has(entry.module)) views.set(entry.module, ask('dataModules.view', { module: entry.module }));
                entry.props.value = valueOf(views.get(entry.module), entry);
                if (entry.props.kind === 'list') entry.props.value = String(entry.props.value ?? '').split(';').map(value => value.trim()).filter(Boolean);
                entry.handle.update(entry.props);
            }
            shown = signatureOf(ask('dataModules.setup') ?? []);
        }
        return result;
    }

    const list = (parent, title, items) => {
        if (!items.length) return;
        make('span', 'ss-dm-label', title, parent);
        const ul = make('ul', 'ss-dm-list', '', parent);
        for (const item of items) make('li', '', item, ul);
    };

    function preview(row, type, card) {
        previewing = `${row.module}/${type}`;
        const subjects = [...(chosen.get(row.module) ?? [])];
        const box = make('div', 'ss-dm-preview', '', card);
        box.setAttribute('role', 'group');
        make('p', 'ss-dm-sub', type === 'dm.migrate' ? `Migrate ${row.definition.name} to ${row.packVersion}?` : type === 'dm.attach' ? `Attach ${subjects.length ? plural(subjects.length, 'character') : 'no one yet'} to ${row.definition.name}?` : `Enable ${row.definition.name} for this chat?`, box);
        const facts = [`Definition ${row.hash}`, `Pack ${row.packId} ${row.packVersion} (${row.packHash})`];
        if (type === 'dm.pin' && row.definition.scope === 'character') facts.push(subjects.length ? `Characters: ${subjects.join(', ')}` : 'Characters: none yet (attach them afterwards)');
        for (const [alias, value] of Object.entries(row.baseline ?? {})) facts.push(`Starts from ${alias}: ${value === null ? 'not set yet; the first set value becomes the baseline' : JSON.stringify(value)}`);
        if (row.additions) facts.push(`New fields: ${JSON.stringify(row.additions)}`);
        facts.push('Nothing is applied backwards; the choice is saved with the latest reply.');
        const ul = make('ul', 'ss-dm-list', '', box);
        for (const fact of facts) make('li', '', fact, ul);
        const apply = button('ss-button ss-button-primary ss-dm-confirm', { text: type === 'dm.migrate' ? 'Migrate' : type === 'dm.attach' ? 'Attach' : 'Enable' });
        const cancel = button('ss-button ss-dm-cancel', { text: 'Cancel' });
        cancel.addEventListener('click', () => { previewing = ''; draw(true); });
        apply.addEventListener('click', async () => {
            apply.disabled = true;
            const payload = { module: row.module, hash: row.hash, packHash: row.packHash, subjects };
            const results = type === 'dm.attach' && subjects.length ? await Promise.all(subjects.map(who => run(type, { module: row.module, who }))) : [await run(type, type === 'dm.attach' ? { module: row.module } : payload)];
            const text = results.map(result => (result?.ok ? result.receipt?.summary || 'Done.' : `${result?.code ?? 'REFUSED'}: ${result?.message ?? 'Not applied.'}`)).join(' ');
            notes = { [row.module]: text };
            previewing = '';
            chosen.delete(row.module);
            draw(true);
        });
        box.append(apply, cancel);
    }

    function card(row) {
        const definition = row.definition, facts = describe(row);
        const item = make('li', 'ss-listcard-row ss-dm-row');
        item.dataset.module = row.module;
        make('span', 'ss-listcard-title', row.packId === 'chat' ? definition.name : `${definition.name} · ${row.packId} ${row.packVersion}`, item);
        make('span', 'ss-listcard-sub ss-dm-status', `${row.status}${row.reason ? `: ${row.reason}` : ''} · ${definition.scope === 'chat' ? 'one shared set of fields' : 'one set per attached character'}`, item);
        if (row.origin) make('span', 'ss-listcard-sub', row.packId === 'chat' ? row.origin : `From ${row.origin}`, item);
        const details = make('details', 'ss-dm-details', '', item);
        make('summary', '', 'What it does', details);
        list(details, 'Fields', facts.fields);
        list(details, 'Lines the story writes', facts.lines);
        list(details, 'Rewards (the number is set by the module)', facts.rewards);
        list(details, 'Checks', facts.checks);
        list(details, 'Timers', facts.timers);
        list(details, 'Needs', facts.needs);
        list(details, 'Screens', facts.screens);
        make('span', 'ss-dm-sub', `Limits: ${facts.budgets}.`, details);
        const active = row.pinnedDefinition;
        const view = row.pinned && active ? ask('dataModules.view', { module: row.module }) : null;
        if (view) {
            const subjects = active.scope === 'chat' ? [{}] : (row.subjects ?? []).map((who, index) => ({ who, index,
                name: row.actors.find(actor => actor.id === who)?.name ?? who }));
            const fields = make('div', 'ss-dm-fields', '', item);
            make('span', 'ss-dm-label', STRINGS.editMessages.fields, fields);
            for (const subject of subjects) for (const [field, schema] of Object.entries(active.state)) {
                if (schema.edit === false) continue;
                const scalar = schema.type === 'map' ? schema.values : schema;
                for (const key of schema.type === 'map' ? schema.keys : [null]) {
                    const label = [subject.name, schema.label ?? field, key].filter(Boolean).join(' · ');
                    const line = make('div', 'ss-dm-field', '', fields);
                    make('span', '', `${label}: `, line);
                    const slot = make('span', '', '', line);
                    const entry = { module: row.module, field, key, ...subject };
                    const props = { value: valueOf(view, entry), label,
                        command: 'dm.set', payload: { module: row.module, field, ...(key === null ? {} : { key }), ...(subject.who ? { who: subject.who } : {}) } };
                    if (scalar.type === 'int') Object.assign(props, { kind: 'number', min: scalar.min, max: scalar.max });
                    else if (scalar.type === 'enum') Object.assign(props, { kind: 'choice', options: scalar.values });
                    else if (scalar.type === 'bool') Object.assign(props, { kind: 'choice', options: [true, false] });
                    else if (scalar.type === 'text') Object.assign(props, scalar.list === true
                        ? { kind: 'list', maxLength: scalar.max, value: String(props.value ?? '').split(';').map(value => value.trim()).filter(Boolean) }
                        : { kind: 'text', maxLength: scalar.max });
                    const handle = editable.render(slot, props, { command: typeof sdk.command === 'function' ? editField : undefined });
                    editors.push({ ...entry, props, handle });
                }
            }
        }
        const bar = make('div', 'ss-dm-actions', '', item);
        if (row.pinned && definition.scope === 'character') {
            for (const actor of row.actors) {
                const label = make('label', 'ss-dm-actor', '', bar);
                const box = doc.createElement('input');
                box.type = 'checkbox';
                box.disabled = row.subjects.includes(actor.id);
                box.checked = box.disabled;
                box.addEventListener('change', () => {
                    const set = chosen.get(row.module) ?? new Set();
                    if (box.checked) set.add(actor.id); else set.delete(actor.id);
                    chosen.set(row.module, set);
                });
                label.append(box, doc.createTextNode(` ${actor.name}`));
            }
        } else if (!row.pinned && definition.scope === 'character') {
            for (const actor of row.actors) {
                const label = make('label', 'ss-dm-actor', '', bar);
                const box = doc.createElement('input');
                box.type = 'checkbox';
                box.addEventListener('change', () => {
                    const set = chosen.get(row.module) ?? new Set();
                    if (box.checked) set.add(actor.id); else set.delete(actor.id);
                    chosen.set(row.module, set);
                });
                label.append(box, doc.createTextNode(` ${actor.name}`));
            }
        }
        const actions = [];
        if (!row.pinned && row.available !== false) actions.push(['Enable for this chat', 'dm.pin']);
        if (row.status === 'Migration available') actions.push(['Migrate', 'dm.migrate']);
        if (row.pinned && definition.scope === 'character' && row.status !== 'Unsupported' && row.status !== 'Waiting') actions.push(['Attach selected characters', 'dm.attach']);
        for (const [title, type] of actions) {
            const go = button('ss-button ss-dm-action', { text: title });
            go.addEventListener('click', () => { item.querySelector('.ss-dm-preview')?.remove(); preview(row, type, item); });
            bar.appendChild(go);
        }
        if (notes[row.module]) make('p', 'ss-dm-result', notes[row.module], item);
        if (previewing.startsWith(`${row.module}/`)) preview(row, previewing.slice(row.module.length + 1), item);
        return item;
    }

    function draw(force = false) {
        const rows = ask('dataModules.setup') ?? [];
        const signature = signatureOf(rows);
        if (!force && signature === shown) return rows.length;
        shown = signature;
        for (const editor of editors) editor.handle.destroy();
        editors = [];
        root.replaceChildren();
        if (!rows.length) { make('p', 'ss-dm-empty', 'No data modules are installed or enabled for this chat.', root); return 0; }
        const ul = make('ul', 'ss-listcard-list ss-dm-list-rows', '', root);
        for (const row of rows) ul.appendChild(card(row));
        return rows.length;
    }

    draw(true);
    return { refresh: () => draw(false), count: () => (ask('dataModules.setup') ?? []).length,
        destroy() { for (const editor of editors) editor.handle.destroy(); editors = []; } };
}
