// The shared view for a block's tab or Home card, and the Blocks page of Settings (the page lives in
// screens/blocks/page.js; view/settings/blocks.js puts it in the settings window). The game view has no Blocks tab.
import { h, shell } from '../view/widgets/dom.js';
import { editable } from '../view/widgets/editable.js';
import { editableBlockDraft, uniqueBlockSlug } from '../data-modules/block-builder.js';
import { dmNameOf } from '../data-modules/schema.js';
import { exportBlockPack } from '../data-modules/block-templates.js';
import { saveTextFile } from '../view/download.js';
import { STRINGS, fill, refusalText } from '../strings.js';
import { barFields, drawEntries, drawNumberMap, entriesRoles, numberRows } from './block-layouts.js';
import { createBlocksPage } from './blocks/page.js';
import { S } from './blocks/shared.js';

export const BLOCK_WIDGET = 'story-block.block';
export const BLOCK_CARDS_WIDGET = 'story-block.block-cards';

const fullyNamed = scalar => {
    const count = scalar.max - scalar.min + 1;
    return count >= 1 && count <= 32 && Array.from({ length: count }, (_, at) => dmNameOf(scalar, scalar.min + at)).every(name => name !== null);
};


// (`loadRpgTemplates` reads the list the first time the chooser needs it; a test hands in its own)
// (`rpgFormula()` is the stat formula the chat plays on, 'standard' or 'classic': a Standard chat is offered the Standard templates. A loader may
// hand back one list, or `{ classic, standard }`.)
// `tabs()`: the tabs this chat has, [{ id, title }], for Show in tab (empty until the host can merge a block into a tab). `renderPreview(parent, { definition,
// values, layout })`: the host's drawing of a block in the new layouts, used by the editor's preview (a plain sketch without it).
export function createBlockWidgets({ templates, directorOn = () => true, leanRpgOn = () => false, navigate = () => {}, rpgFormula = () => 'standard', tabs = () => [], renderPreview = null,
    loadRpgTemplates = () => import('../lean-rpg/templates.js').then(loaded => ({ classic: loaded.LEAN_RPG_TEMPLATES, standard: loaded.STANDARD_TEMPLATES })) } = {}) {
    const shared = { mode: 'list', draft: null, module: null, note: '', meta: {}, starters: false };
    // The RPG templates are read (a dynamic import) only when the feature is on and the chooser is open.
    const rpg = { templates: null, loading: false };
    const loadRpg = () => {
        if (rpg.templates || rpg.loading) return;
        rpg.loading = true;
        Promise.resolve().then(loadRpgTemplates).then(list => { rpg.templates = list ?? []; tell(); }, () => { rpg.templates = []; });
    };
    const listeners = new Set();
    const tell = () => { for (const listener of [...listeners]) listener(); };
    const ask = (api, name, args) => { try { return api?.query?.(name, args); } catch { return null; } };
    // Every pinned chat block is listed (a block defined without `show` still needs its card and Remove); a pack module
    // only when it asks to be shown. `show` decides the tab and the Home card, not the Blocks list.
    const rowsOf = api => (ask(api, 'dataModules.setup') ?? []).filter(row => row.pinned && row.pinnedDefinition
        && (row.packId === 'chat' || row.pinnedDefinition.show));
    const confirm = (doc, text) => {
        const win = doc.defaultView ?? globalThis;
        return typeof win.confirm === 'function' && win.confirm(text);
    };
    const newDraft = () => ({ name: '', fields: [], functions: [], prompt: '', show: { tab: true, card: false, tabName: '', icon: 'ph-bookmark-simple' } });
    const open = (row, move) => {
        const draft = row ? editableBlockDraft(row.pinnedDefinition) : newDraft();
        if (!draft) return false;
        shared.draft = draft;
        shared.module = row?.module ?? null;
        shared.meta = {}; shared.starters = !row;
        shared.mode = 'editor';
        tell();
        if (move) navigate();
        return true;
    };
    const button = (doc, parent, text, fn, cls = 'ss-button') => {
        const out = h(doc, 'button', cls, text); out.setAttribute('type', 'button'); out.addEventListener('click', fn); parent.appendChild(out); return out;
    };

    function card(doc, parent, row, api, handles, { move = false } = {}) {
        const definition = row.pinnedDefinition, view = ask(api, 'dataModules.view', { module: row.module }) ?? {};
        const root = h(doc, 'section', 'ss-block-card ss-glass'); parent.appendChild(root);
        root.setAttribute('data-block-card', row.module); root.setAttribute('tabindex', '-1');
        const head = h(doc, 'div', 'ss-block-card-head'); root.appendChild(head);
        head.appendChild(h(doc, 'h3', '', definition.name));
        const menu = h(doc, 'div', 'ss-block-menu ss-glass-strong'); menu.hidden = true;
        const toggle = button(doc, head, '⋯', () => { menu.hidden = !menu.hidden; }, 'ss-iconbutton');
        toggle.setAttribute('aria-label', S.menu); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-haspopup', 'true');
        toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', String(!menu.hidden)));
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault?.(); menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus?.(); }
        });
        head.appendChild(menu);
        const status = h(doc, 'p', 'ss-block-status'); status.setAttribute('role', 'status'); root.appendChild(status);
        if (row.packId === 'chat') {
            button(doc, menu, S.editFields, () => { if (!open(row, move)) status.textContent = definition.role ? S.madeFromTemplate : S.unsupportedEdit; });
            button(doc, menu, S.saveTemplate, async () => {
                let result = await templates?.put?.(definition);
                if (result?.code === 'EXISTS' && confirm(doc, S.confirmReplace)) result = await templates.put(definition, { replace: true });
                status.textContent = result?.ok ? S.templateSaved : result?.message ?? STRINGS.editable.failed;
            });
        }
        button(doc, menu, S.exportPack, async () => {
            const result = await exportBlockPack(definition);
            if (!result.ok) { status.textContent = result.errors?.[0]?.message ?? S.exportFailed; return; }
            try { saveTextFile(doc, result.text, result.filename, 'application/json;charset=utf-8'); }
            catch { status.textContent = S.exportFailed; }
        });
        if (row.packId === 'chat') button(doc, menu, S.removeBlock, async () => {
            if (!confirm(doc, S.confirmRemove)) return;
            const result = await api.command?.('dm.remove', { module: row.module });
            if (!result?.ok) status.textContent = refusalText(result, STRINGS.editable.failed);
        });
        const subjects = definition.scope === 'chat' ? [{ values: view.chat ?? {}, who: null }]
            : (row.subjects ?? []).map((who, index) => ({ who, values: view.characters?.[index] ?? {},
                name: row.actors?.find(actor => actor.id === who)?.name ?? who }));
        const memory = (shared.memory ??= new Map());
        for (const { values, who, name } of subjects) {
            if (who !== null) root.appendChild(h(doc, 'h4', 'ss-block-subject', name));
            // The shapes that read better than rows: entries read through the block's roles, maps of numbers.
            const screenOf = () => parent.closest?.('[data-ss-screen]') ?? doc;
            const env = { doc, api, handles, memory, after: mark => {
                [...screenOf().querySelectorAll('.ss-w-editable-pencil')].find(node => Object.entries(mark ?? {}).every(([part, value]) => node.getAttribute(`data-block-${part}`) === String(value ?? '')))?.focus?.();
            } };
            // Plain fields are the record card (a small card, label and value in two columns, a pencil at the end of each line); a block whose own
            // layout is cards or bars keeps loose rows.
            let rec = null, barsDrawn = false;
            const recordHost = () => (['cards', 'bars'].includes(definition.layout) ? root : (rec ??= root.appendChild(h(doc, 'div', 'ss-glass ss-b-plain'))));
            for (const [field, schema] of Object.entries(definition.state)) {
                if (schema.type === 'entries' || (schema.type === 'map' && schema.values.type === 'int')) rec = null;
                if (schema.type === 'entries') {
                    if (entriesRoles(definition, field)) drawEntries(env, root, { definition, module: row.module, field, list: values[field] });
                    else {
                        // A List of entries without roles as plain rows: one row for each entry, its parts in the order of the list's definition.
                        const list = Array.isArray(values[field]) ? values[field] : [];
                        const line = h(doc, 'div', 'ss-block-value'); root.appendChild(line);
                        line.appendChild(h(doc, 'span', 'ss-block-value-name', `${schema.label ?? field} (${list.length})`));
                        const slot = h(doc, 'span', 'ss-block-value-slot'); line.appendChild(slot);
                        for (const entry of list) slot.appendChild(h(doc, 'div', 'ss-block-value-shown', Object.keys(schema.of).map(part => String(entry?.[part] ?? '')).filter(Boolean).join(' · ')));
                    }
                    continue;
                }
                if (schema.type === 'int' && barFields(definition).includes(field)) {
                    // A bars block draws its number fields together as one map of numbers (the first one stands for all).
                    if (!barsDrawn) {
                        barsDrawn = true;
                        drawNumberMap(env, root, { title: '', memoryKey: `${row.module}:${who ?? ''}:fields`, rows: numberRows({ definition, module: row.module, who, values, fields: barFields(definition) }) });
                    }
                    continue;
                }
                if (schema.type === 'map' && schema.values.type === 'int') {
                    const title = schema.label ?? field.replace(/[-_]+/g, ' ');
                    drawNumberMap(env, root, { title: title.charAt(0).toUpperCase() + title.slice(1), memoryKey: `${row.module}:${who ?? ''}:${field}`,
                        rows: numberRows({ definition, module: row.module, who, values, field }) });
                    continue;
                }
                const scalar = schema.type === 'map' ? schema.values : schema;
                for (const key of schema.type === 'map' ? schema.keys : [null]) {
                    const line = h(doc, 'div', 'ss-block-value'); recordHost().appendChild(line);
                    const label = [schema.label ?? field, key].filter(Boolean).join(' · ');
                    line.appendChild(h(doc, 'span', 'ss-block-value-name', label));
                    const slot = h(doc, 'span', 'ss-block-value-slot'); line.appendChild(slot);
                    const raw = key === null ? values[field] : values[field]?.[key];
                    const props = { value: raw, label, command: schema.edit === false ? '' : 'dm.set',
                        payload: { module: row.module, field, ...(who === null ? {} : { who }), ...(key === null ? {} : { key }) } };
                    if (scalar.type === 'int' && scalar.names) {
                        // A number with display names shows its name (else the number); stored, it stays the number.
                        Object.assign(props, fullyNamed(scalar)
                            ? { kind: 'choice', options: Array.from({ length: scalar.max - scalar.min + 1 }, (_, at) => ({ value: scalar.min + at, label: scalar.names[String(scalar.min + at)] })) }
                            : { kind: 'number', min: scalar.min, max: scalar.max }, { displayValue: false });
                        const named = h(doc, 'span', 'ss-block-value-shown', dmNameOf(scalar, raw) ?? String(raw ?? ''));
                        named.setAttribute('title', `${raw}/${scalar.max}`);
                        line.insertBefore(named, slot);
                    } else if (scalar.type === 'int') Object.assign(props, { kind: 'number', min: scalar.min, max: scalar.max, displayMeter: true });
                    else if (scalar.type === 'enum') Object.assign(props, { kind: 'choice', options: scalar.values, displayPill: true });
                    else if (scalar.type === 'bool') Object.assign(props, { kind: 'choice', options: [true, false] });
                    else if (scalar.list === true) {
                        const values = String(raw ?? '').split(';').map(value => value.trim()).filter(Boolean);
                        Object.assign(props, { kind: 'list', maxLength: scalar.max, value: values, displayChips: true });
                    }
                    else Object.assign(props, { kind: 'text', maxLength: scalar.max });
                    const screen = parent.closest?.('[data-ss-screen]') ?? doc;
                    const run = typeof api.command === 'function' ? async (type, payload) => {
                        const focused = slot.contains(doc.activeElement);
                        const result = await api.command(type, payload);
                        if (result?.ok && focused && (!doc.activeElement || doc.activeElement === doc.body || slot.contains(doc.activeElement))) {
                            const pencil = [...screen.querySelectorAll('.ss-w-editable-pencil')].find(node => node.getAttribute('data-block-module') === row.module
                                && node.getAttribute('data-block-field') === field && node.getAttribute('data-block-key') === String(key ?? '')
                                && node.getAttribute('data-block-who') === String(who ?? ''));
                            pencil?.focus?.();
                        }
                        return result;
                    } : undefined;
                    handles.push(editable.render(slot, props, { command: run }));
                    const pencil = slot.querySelector('.ss-w-editable-pencil');
                    pencil?.setAttribute('data-block-module', row.module);
                    pencil?.setAttribute('data-block-field', field);
                    pencil?.setAttribute('data-block-key', String(key ?? ''));
                    pencil?.setAttribute('data-block-who', String(who ?? ''));
                }
            }
            const actions = h(doc, 'div', 'ss-block-actions'); root.appendChild(actions);
            // Only kinds that need no labels become buttons here; a kind that asks for values is used from the pack's own screens.
            for (const [kind, def] of Object.entries(definition.kinds).filter(([, value]) => value.ui && !Object.keys(value.labels ?? {}).length)) {
                button(doc, actions, def.title ?? kind, async () => {
                    const result = await api.command?.('dm.act', { module: row.module, kind, ...(who === null ? {} : { who }) });
                    if (!result?.ok) status.textContent = refusalText(result, STRINGS.editable.failed);
                });
            }
        }
        return root;
    }

    // An RPG template is a hand-written definition: it is made as it is, under a name and slug of its own when the chat has one already.
    async function addFromTemplate(api, rows, entry, status) {
        const definition = JSON.parse(JSON.stringify(entry.definition));
        delete definition.id; delete definition.pack;
        const used = rows.map(row => row.module), base = uniqueBlockSlug(definition.name, []), slug = uniqueBlockSlug(definition.name, used);
        if (!slug) { status.textContent = S.blockName; return; }
        const suffix = slug === base ? '' : ` ${/-(\d+)$/.exec(slug)?.[1] ?? ''}`.trimEnd();
        definition.slug = slug;
        if (suffix) {
            definition.name = `${[...definition.name].slice(0, 60 - suffix.length).join('')}${suffix}`;
            if (definition.show?.tabName) definition.show.tabName = `${[...definition.show.tabName].slice(0, 24 - suffix.length).join('')}${suffix}`;
        }
        const result = await api.command?.('dm.define', { definition });
        if (!result?.ok) { status.textContent = refusalText(result, STRINGS.editable.failed); return; }
        shared.mode = 'list'; shared.draft = null; shared.module = null; shared.note = fill(S.templateAdded, { name: definition.name });
        tell();
    }

    function widget(mode) {
        return { props: mode === 'single' ? { module: { type: 'string', default: '' } } : {}, primary: null, validate: () => [],
            render(el, props, api) {
                return shell(el, 'div', `blocks-${mode}`, ({ doc, root }) => {
                    let handles = [], current = props, alive = true;
                    const clear = () => { for (const handle of handles) handle.destroy(); handles = []; root.replaceChildren(); };
                    function draw() {
                        if (!alive) return;
                        clear();
                        const presented = rowsOf(api);
                        if (mode === 'single') {
                            const row = presented.find(entry => entry.module === current.module);
                            if (row) card(doc, root, row, api, handles, { move: true });
                        } else {
                            const shown = presented.filter(entry => entry.pinnedDefinition.show?.card);
                            el.hidden = shown.length === 0;
                            for (const row of shown) card(doc, root, row, api, handles, { move: true });
                        }
                    }
                    listeners.add(draw); draw();
                    return { update(next) { current = next; draw(); }, destroy() { alive = false; listeners.delete(draw); clear(); } };
                });
            } };
    }


    const page = createBlocksPage({
        shared, tell, templates, rpgState: rpg, loadRpg, open, leanRpgOn, rpgFormula, directorOn, tabs, renderPreview,
        addFromTemplate, button, rowsOf, confirm, listeners,
    });

    return {
        widgets: { [BLOCK_WIDGET]: widget('single'), [BLOCK_CARDS_WIDGET]: widget('cards') },
        page,
        reset() { shared.mode = 'list'; shared.draft = null; shared.module = null; shared.note = ''; tell(); },
    };
}
