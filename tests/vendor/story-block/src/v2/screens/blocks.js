// The Blocks page and the shared view for a block's tab or Home card.
import { h, shell } from '../view/widgets/dom.js';
import { editable } from '../view/widgets/editable.js';
import { renderBlockEditor } from './blocks-editor.js';
import { editableBlockDraft } from '../data-modules/block-builder.js';
import { exportBlockPack } from '../data-modules/block-templates.js';
import { saveTextFile } from '../view/download.js';
import { STRINGS, fill } from '../strings.js';
import { BASE_CSS } from './style.js';

const S = STRINGS.blocks;
export const BLOCKS_SCREEN_ID = 'story-block/blocks';
export const BLOCKS_WIDGET = 'story-block.blocks';
export const BLOCK_WIDGET = 'story-block.block';
export const BLOCK_CARDS_WIDGET = 'story-block.block-cards';

export const blocksScreen = Object.freeze({ id: BLOCKS_SCREEN_ID, title: S.title, icon: 'fa-cubes',
    mounts: Object.freeze(['screen']), template: `<ss-widget name="${BLOCKS_WIDGET}"></ss-widget>`, css: BASE_CSS });

export function createBlockWidgets({ templates, directorOn = () => true, navigate = () => {} } = {}) {
    const shared = { mode: 'list', draft: null, module: null };
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
            button(doc, menu, S.editFields, () => { if (!open(row, move)) status.textContent = S.unsupportedEdit; });
            button(doc, menu, S.saveTemplate, async () => {
                let result = await templates?.put?.(definition);
                if (result?.code === 'EXISTS' && confirm(doc, S.confirmReplace)) result = await templates.put(definition, { replace: true });
                status.textContent = result?.ok ? S.templateSaved : result?.message ?? STRINGS.editable.failed;
            });
        }
        button(doc, menu, S.exportPack, () => {
            const result = exportBlockPack(definition);
            if (!result.ok) { status.textContent = result.errors?.[0]?.message ?? S.exportFailed; return; }
            try { saveTextFile(doc, result.text, result.filename, 'application/json;charset=utf-8'); }
            catch { status.textContent = S.exportFailed; }
        });
        if (row.packId === 'chat') button(doc, menu, S.removeBlock, async () => {
            if (!confirm(doc, S.confirmRemove)) return;
            const result = await api.command?.('dm.remove', { module: row.module });
            if (!result?.ok) status.textContent = result?.message ?? STRINGS.editable.failed;
        });
        const subjects = definition.scope === 'chat' ? [{ values: view.chat ?? {}, who: null }]
            : (row.subjects ?? []).map((who, index) => ({ who, values: view.characters?.[index] ?? {},
                name: row.actors?.find(actor => actor.id === who)?.name ?? who }));
        for (const { values, who, name } of subjects) {
            if (who !== null) root.appendChild(h(doc, 'h4', 'ss-block-subject', name));
            for (const [field, schema] of Object.entries(definition.state)) {
                const scalar = schema.type === 'map' ? schema.values : schema;
                for (const key of schema.type === 'map' ? schema.keys : [null]) {
                    const line = h(doc, 'div', 'ss-block-value'); root.appendChild(line);
                    const label = [schema.label ?? field, key].filter(Boolean).join(' · ');
                    line.appendChild(h(doc, 'span', 'ss-block-value-name', label));
                    const slot = h(doc, 'span', 'ss-block-value-slot'); line.appendChild(slot);
                    const raw = key === null ? values[field] : values[field]?.[key];
                    const props = { value: raw, label, command: schema.edit === false ? '' : 'dm.set',
                        payload: { module: row.module, field, ...(who === null ? {} : { who }), ...(key === null ? {} : { key }) } };
                    if (scalar.type === 'int') Object.assign(props, { kind: 'number', min: scalar.min, max: scalar.max, displayMeter: true });
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
                    if (!result?.ok) status.textContent = result?.message ?? STRINGS.editable.failed;
                });
            }
        }
        return root;
    }

    function widget(mode) {
        return { props: mode === 'single' ? { module: { type: 'string', default: '' } } : {}, primary: null, validate: () => [],
            render(el, props, api) {
                return shell(el, 'div', `blocks-${mode}`, ({ doc, root }) => {
                    let handles = [], editor = null, current = props, alive = true;
                    const clear = () => { for (const handle of handles) handle.destroy(); handles = []; editor?.collect(); editor?.destroy(); editor = null; root.replaceChildren(); };
                    function draw() {
                        if (!alive) return;
                        clear();
                        root.classList.toggle('ss-glass', mode === 'list' && shared.mode !== 'editor');
                        const presented = rowsOf(api), rows = presented.filter(row => row.packId === 'chat');
                        if (mode === 'single') {
                            const row = presented.find(entry => entry.module === current.module);
                            if (row) card(doc, root, row, api, handles, { move: true });
                        } else if (mode === 'cards') {
                            const shown = presented.filter(entry => entry.pinnedDefinition.show?.card);
                            el.hidden = shown.length === 0;
                            for (const row of shown) card(doc, root, row, api, handles, { move: true });
                        } else if (shared.mode === 'editor' && shared.draft) {
                            editor = renderBlockEditor(root, { draft: shared.draft, used: rows.map(row => row.module), directorOn: directorOn(),
                                onCancel: () => { shared.mode = 'list'; shared.draft = null; tell(); },
                                onSave: async definition => {
                                    const result = await api.command?.(shared.module ? 'dm.redefine' : 'dm.define',
                                        shared.module ? { module: shared.module, definition } : { definition });
                                    if (result?.ok) { shared.mode = 'list'; shared.draft = null; shared.module = null; tell(); }
                                    return result;
                                } });
                        } else {
                            const head = h(doc, 'div', 'ss-block-page-head'); root.appendChild(head);
                            head.appendChild(h(doc, 'h3', 'ss-section-label', S.custom));
                            const chooserToggle = button(doc, head, S.newBlock, () => {
                                shared.mode = shared.mode === 'chooser' ? 'list' : 'chooser';
                                tell();
                                root.querySelector(shared.mode === 'chooser' ? '.ss-block-chooser button' : '.ss-block-new')?.focus?.();
                            }, 'ss-button ss-button-primary ss-block-new');
                            chooserToggle.setAttribute('aria-haspopup', 'true');
                            chooserToggle.setAttribute('aria-expanded', String(shared.mode === 'chooser'));
                            if (shared.mode === 'chooser') {
                                const chooser = h(doc, 'div', 'ss-block-chooser ss-glass-strong'); head.appendChild(chooser);
                                chooser.addEventListener('keydown', event => {
                                    if (event.key === 'Escape') {
                                        event.preventDefault?.(); event.stopPropagation?.(); shared.mode = 'list'; tell();
                                        root.querySelector('.ss-block-new')?.focus?.();
                                    }
                                });
                                const status = h(doc, 'p', 'ss-block-status'); status.setAttribute('role', 'status');
                                button(doc, chooser, S.emptyBlock, () => open(null, false));
                                for (const entry of templates?.list?.() ?? []) button(doc, chooser, fill(S.templateCounts, { name: entry.name,
                                    fields: Object.keys(entry.definition.state ?? {}).length,
                                    buttons: Object.values(entry.definition.kinds ?? {}).filter(kind => kind.ui).length,
                                    rules: entry.definition.rules?.length ?? 0, timers: entry.definition.timers?.length ?? 0 }), () => {
                                    const draft = editableBlockDraft(entry.definition);
                                    if (!draft) { status.textContent = S.unsupportedEdit; return; }
                                    shared.draft = draft; delete shared.draft.slug;
                                    shared.module = null; shared.mode = 'editor'; tell();
                                });
                                button(doc, chooser, S.cancel, () => { shared.mode = 'list'; tell(); });
                                chooser.appendChild(status);
                            }
                            if (!rows.length) root.appendChild(h(doc, 'p', 'ss-block-empty', S.empty));
                            else for (const row of rows) card(doc, root, row, api, handles);
                        }
                    }
                    listeners.add(draw); draw();
                    return { update(next) { current = next; draw(); }, destroy() { alive = false; listeners.delete(draw); clear(); } };
                });
            } };
    }
    return {
        widgets: { [BLOCKS_WIDGET]: widget('list'), [BLOCK_WIDGET]: widget('single'), [BLOCK_CARDS_WIDGET]: widget('cards') },
        reset() { shared.mode = 'list'; shared.draft = null; shared.module = null; tell(); },
    };
}
