// The shared view for a block's tab or Home card, and the Blocks page of Settings (`page`: the list of this story's blocks, the editor
// and the template chooser; view/settings/blocks.js puts it in the settings window). The game view has no Blocks tab.
import { h, shell } from '../view/widgets/dom.js';
import { editable } from '../view/widgets/editable.js';
import { renderBlockEditor } from './blocks-editor.js';
import { selectField } from '../view/form/fields.js';
import { editableBlockDraft, uniqueBlockSlug } from '../data-modules/block-builder.js';
import { dmNameOf } from '../data-modules/schema.js';
import { exportBlockPack } from '../data-modules/block-templates.js';
import { saveTextFile } from '../view/download.js';
import { STRINGS, fill, refusalText } from '../strings.js';
import { ROLES_WITHOUT_TAB } from '../lean-rpg/names.js';

const S = STRINGS.blocks;
const P = S.page;
export const BLOCK_WIDGET = 'story-block.block';
export const BLOCK_CARDS_WIDGET = 'story-block.block-cards';

// Whole values min..max all named (a choice can list them): else the number is typed and shown by its name where it has one.
const plural = (n, word) => `${n} ${n === 1 ? word.one : word.other}`;
// Where a block shows now, as the Show as choice names it (a block with no `show` has no tab and no card).
const showValue = show => (show?.tab && show.card ? 'both' : show?.tab ? 'tab' : show?.card ? 'card' : 'hidden');

const fullyNamed = scalar => {
    const count = scalar.max - scalar.min + 1;
    return count >= 1 && count <= 32 && Array.from({ length: count }, (_, at) => dmNameOf(scalar, scalar.min + at)).every(name => name !== null);
};

// (`loadRpgTemplates` reads the list the first time the chooser needs it; a test hands in its own)
// (`rpgFormula()` is the stat formula the chat plays on, 'standard' or 'classic': a Standard chat is offered the Standard templates. A loader may
// hand back one list, or `{ classic, standard }`.)
export function createBlockWidgets({ templates, directorOn = () => true, leanRpgOn = () => false, navigate = () => {}, rpgFormula = () => 'standard',
    loadRpgTemplates = () => import('../lean-rpg/templates.js').then(loaded => ({ classic: loaded.LEAN_RPG_TEMPLATES, standard: loaded.STANDARD_TEMPLATES })) } = {}) {
    const shared = { mode: 'list', draft: null, module: null, note: '' };
    // The RPG templates are read (a dynamic import) only when the feature is on and the chooser is open.
    let rpgTemplates = null, rpgLoading = false;
    const loadRpg = () => {
        if (rpgTemplates || rpgLoading) return;
        rpgLoading = true;
        Promise.resolve().then(loadRpgTemplates).then(list => { rpgTemplates = list ?? []; tell(); }, () => { rpgTemplates = []; });
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
        button(doc, menu, S.exportPack, () => {
            const result = exportBlockPack(definition);
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

    // ---- Settings → Blocks: the page's content. `api` is the sdk (query, command); `chatOpen()` says whether a story is open.
    // → { refresh(), filter(text), destroy() }. The state (list, template chooser, editor and its draft) is shared with the cards' "Edit fields".
    function page({ doc, parent, api, chatOpen = () => true }) {
        const root = h(doc, 'div', 'ss-blocks-page'); parent.appendChild(root);
        let editor = null, selects = [], message = '', alive = true, query = '', openMenu = null;
        const clear = () => {
            editor?.collect(); editor?.destroy(); editor = null;
            for (const select of selects) select.destroy();
            selects = []; openMenu = null; root.replaceChildren();
        };
        const closeMenu = () => {
            if (!openMenu) return;
            openMenu.menu.hidden = true; openMenu.toggle.setAttribute('aria-expanded', 'false'); openMenu = null;
        };
        const onClick = event => { if (openMenu && !openMenu.wrap.contains(event.target)) closeMenu(); };
        doc.addEventListener?.('click', onClick);
        const say = text => { message = text; draw(); };

        async function setShow(row, value) {
            const definition = JSON.parse(JSON.stringify(row.pinnedDefinition));
            delete definition.id; delete definition.pack;
            const was = definition.show ?? { tabName: [...definition.name].slice(0, 24).join(''), icon: 'ph-bookmark-simple' };
            definition.show = { tab: value === 'tab' || value === 'both', card: value === 'card' || value === 'both', tabName: was.tabName, icon: was.icon };
            const result = await api.command?.('dm.redefine', { module: row.module, definition });
            say(result?.ok ? fill(P.shownAs, { name: definition.name, how: P.show[value] }) : refusalText(result, STRINGS.editable.failed));
        }

        function rowNode(list, row) {
            const definition = row.pinnedDefinition, managed = ROLES_WITHOUT_TAB.includes(definition.role), rpgOn = leanRpgOn();
            const item = h(doc, 'li', 'ss-blockrow ss-glass'); item.setAttribute('data-block-row', row.module);
            const main = h(doc, 'div', 'ss-blockrow-main'); item.appendChild(main);
            const title = h(doc, 'div', 'ss-blockrow-title'); main.appendChild(title);
            title.appendChild(h(doc, 'b', 'ss-blockrow-name', definition.name));
            if (definition.role) title.appendChild(h(doc, 'span', 'ss-pill ss-blockrow-role', `${P.rpg} · ${P.roles[definition.role] ?? definition.role}`));
            main.appendChild(h(doc, 'small', 'ss-blockrow-meta', metaOf(definition, managed, rpgOn)));
            const show = h(doc, 'label', 'ss-blockrow-show'); item.appendChild(show);
            show.appendChild(h(doc, 'span', 'ss-blockrow-show-label', P.showAs));
            const options = managed ? [{ value: 'rpg', label: (rpgOn ? P.rpgOption : P.rpgIdleOption)[definition.role] }]
                : ['tab', 'card', 'both', 'hidden'].map(value => ({ value, label: P.show[value] }));
            const select = selectField({ doc, field: { type: 'choice', options }, value: managed ? 'rpg' : showValue(definition.show),
                ariaLabel: fill(P.showAsFor, { name: definition.name }), disabled: managed, onChange: value => setShow(row, value) });
            selects.push(select); show.appendChild(select.el);
            const actions = h(doc, 'div', 'ss-blockrow-actions'); item.appendChild(actions);
            const edit = button(doc, actions, P.edit, () => {
                closeMenu(); message = '';
                if (!open(row, false)) say(definition.role ? S.madeFromTemplate : S.unsupportedEdit);
            }); edit.setAttribute('aria-label', fill(P.editFor, { name: definition.name }));
            const wrap = h(doc, 'div', 'ss-blockrow-more'); actions.appendChild(wrap);
            const menu = h(doc, 'div', 'ss-block-menu ss-glass-strong'); menu.hidden = true;
            const toggle = button(doc, wrap, '⋯', () => {
                const was = menu.hidden; closeMenu();
                if (was) { menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); openMenu = { menu, toggle, wrap }; }
            }, 'ss-iconbutton');
            toggle.setAttribute('aria-label', fill(P.menuFor, { name: definition.name })); toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-haspopup', 'true');
            wrap.appendChild(menu);
            // Escape closes an open menu first (from the button or from inside it); the settings window stays.
            wrap.addEventListener('keydown', event => {
                if (event.key === 'Escape' && !menu.hidden) { event.preventDefault?.(); event.stopPropagation?.(); closeMenu(); toggle.focus?.(); }
            });
            button(doc, menu, S.saveTemplate, async () => {
                closeMenu();
                let result = await templates?.put?.(definition);
                if (result?.code === 'EXISTS' && confirm(doc, S.confirmReplace)) result = await templates.put(definition, { replace: true });
                say(result?.ok ? S.templateSaved : result?.message ?? STRINGS.editable.failed);
            });
            button(doc, menu, S.exportPack, () => {
                closeMenu();
                const result = exportBlockPack(definition);
                if (!result.ok) { say(result.errors?.[0]?.message ?? S.exportFailed); return; }
                try { saveTextFile(doc, result.text, result.filename, 'application/json;charset=utf-8'); }
                catch { say(S.exportFailed); }
            });
            button(doc, menu, S.removeBlock, async () => {
                closeMenu();
                if (!confirm(doc, S.confirmRemove)) return;
                const result = await api.command?.('dm.remove', { module: row.module });
                say(result?.ok ? fill(P.removed, { name: definition.name }) : refusalText(result, STRINGS.editable.failed));
            });
            list.appendChild(item);
        }

        function chooserNode(parent, rows) {
            const chooser = h(doc, 'div', 'ss-block-chooser ss-glass-strong'); parent.appendChild(chooser);
            const status = h(doc, 'p', 'ss-block-status'); status.setAttribute('role', 'status');
            // (one word per count: "1 field, 1 button", never "1 buttons")
            const counts = entry => fill(S.templateCounts, { name: entry.name, fields: plural(Object.keys(entry.definition.state ?? {}).length, P.fields),
                buttons: plural(Object.values(entry.definition.kinds ?? {}).filter(kind => kind.ui).length, P.buttons),
                rules: plural(entry.definition.rules?.length ?? 0, P.rules), timers: plural(entry.definition.timers?.length ?? 0, P.timers) });
            const saved = templates?.list?.() ?? [];
            for (const entry of saved) button(doc, chooser, counts(entry), () => {
                const draft = editableBlockDraft(entry.definition);
                if (!draft) { status.textContent = S.unsupportedEdit; return; }
                shared.draft = draft; delete shared.draft.slug;
                shared.module = null; shared.mode = 'editor'; tell();
            });
            let rpg = [];
            if (leanRpgOn()) {
                loadRpg();
                const loaded = rpgTemplates ?? [];
                rpg = Array.isArray(loaded) ? loaded : (loaded[rpgFormula() === 'classic' ? 'classic' : 'standard'] ?? loaded.classic ?? []);
            }
            if (rpg.length) {
                chooser.appendChild(h(doc, 'h4', 'ss-block-chooser-heading', S.leanRpg));
                for (const entry of rpg) button(doc, chooser, counts(entry), () => addFromTemplate(api, rows, entry, status));
            }
            if (!saved.length && !rpg.length) chooser.appendChild(h(doc, 'p', 'ss-block-hint', P.noTemplates));
            button(doc, chooser, S.cancel, () => { shared.mode = 'list'; tell(); });
            chooser.appendChild(status);
            return chooser;
        }

        function draw() {
            if (!alive) return;
            const inChooser = Boolean(doc.activeElement?.closest?.('.ss-block-chooser')) && root.contains(doc.activeElement);
            clear();
            if (!chatOpen()) { root.appendChild(h(doc, 'p', 'ss-blocks-empty', P.noChat)); return; }
            const rows = rowsOf(api).filter(row => row.packId === 'chat');
            if (shared.mode === 'editor' && shared.draft) {
                editor = renderBlockEditor(root, { draft: shared.draft, used: rows.map(row => row.module), directorOn: directorOn(),
                    onCancel: () => { shared.mode = 'list'; shared.draft = null; shared.module = null; tell(); },
                    onSave: async definition => {
                        const result = await api.command?.(shared.module ? 'dm.redefine' : 'dm.define',
                            shared.module ? { module: shared.module, definition } : { definition });
                        if (result?.ok) { shared.mode = 'list'; shared.draft = null; shared.module = null; tell(); }
                        return result;
                    } });
                return;
            }
            const head = h(doc, 'div', 'ss-blocks-head'); root.appendChild(head);
            const actions = h(doc, 'div', 'ss-blocks-actions'); head.appendChild(actions);
            button(doc, actions, S.newBlock, () => { message = ''; shared.mode = 'list'; open(null, false); }, 'ss-button ss-button-primary ss-blocks-new');
            const from = button(doc, actions, P.fromTemplate, () => {
                message = '';
                shared.mode = shared.mode === 'chooser' ? 'list' : 'chooser'; tell();
                root.querySelector(shared.mode === 'chooser' ? '.ss-block-chooser button' : '.ss-blocks-from')?.focus?.();
            }, 'ss-button ss-blocks-from');
            from.setAttribute('aria-haspopup', 'true'); from.setAttribute('aria-expanded', String(shared.mode === 'chooser'));
            // Escape closes the chooser first (from its buttons or from From a template); the settings window stays.
            actions.addEventListener('keydown', event => {
                if (event.key === 'Escape' && shared.mode === 'chooser') {
                    event.preventDefault?.(); event.stopPropagation?.(); shared.mode = 'list'; tell();
                    root.querySelector('.ss-blocks-from')?.focus?.();
                }
            });
            if (shared.mode === 'chooser') {
                chooserNode(actions, rows);
                // (the RPG templates arrive after the chooser opens and the page is drawn again: the focus stays in the chooser)
                if (inChooser) root.querySelector('.ss-block-chooser button')?.focus?.();
            }
            const listed = rows.filter(row => !ROLES_WITHOUT_TAB.includes(row.pinnedDefinition.role));
            const tabs = listed.filter(row => row.pinnedDefinition.show?.tab).length, cards = listed.filter(row => row.pinnedDefinition.show?.card).length;
            const where = [tabs ? plural(tabs, P.tab) : '', cards ? plural(cards, P.card) : ''].filter(Boolean).join(', ') || P.nothingShown;
            if (rows.length) head.appendChild(h(doc, 'p', 'ss-blocks-count', fill(P.count, { blocks: plural(rows.length, P.block), where })));
            if (shared.note) { message = shared.note; shared.note = ''; }
            const status = h(doc, 'p', 'ss-block-status', message); status.setAttribute('role', 'status'); root.appendChild(status);
            if (!rows.length) root.appendChild(h(doc, 'p', 'ss-blocks-empty', P.none));
            else { const list = h(doc, 'ul', 'ss-blockrows'); root.appendChild(list); for (const row of rows) rowNode(list, row); }
            root.appendChild(h(doc, 'p', 'ss-block-hint ss-blocks-note', P.note));
            applyFilter();
        }
        // Search: the page is found by its words or by a block's name, role and where it shows; the blocks that do not match are left out.
        const wordsOf = text => String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        function applyFilter() {
            const items = [...root.querySelectorAll('.ss-blockrow')], words = wordsOf(query);
            if (!words.length) { for (const item of items) item.hidden = false; return items.length; }
            const own = `${S.title} ${P.sub} ${S.newBlock} ${P.fromTemplate}`.toLowerCase();
            const ownMatch = words.every(word => own.includes(word));
            let found = 0;
            for (const item of items) {
                item.hidden = !(ownMatch || words.every(word => (item.querySelector('.ss-blockrow-main')?.textContent ?? '').toLowerCase().includes(word)));
                if (!item.hidden) found += 1;
            }
            return ownMatch ? items.length || 1 : found;
        }
        listeners.add(draw); draw();
        return {
            refresh: draw,
            filter(text) {
                query = String(text ?? '').trim();
                if (!chatOpen()) return query && 'blocks belong to a story'.includes(query.toLowerCase()) ? 1 : 0;
                if (shared.mode === 'editor') return 0;
                return applyFilter();
            },
            destroy() { alive = false; listeners.delete(draw); doc.removeEventListener?.('click', onClick); clear(); root.remove(); },
        };
    }

    // The words under a block's name: how many fields, buttons and rules it has, and where it shows.
    function metaOf(definition, managed, rpgOn = true) {
        if (managed) return (rpgOn ? P.rpgShown : P.rpgIdle)[definition.role];
        const buttons = Object.values(definition.kinds ?? {}).filter(kind => kind.ui).length, rules = definition.rules?.length ?? 0, timers = definition.timers?.length ?? 0;
        const show = definition.show, shown = [];
        if (show?.tab) shown.push(fill(P.whereTab, { name: show.tabName, icon: String(S.icons[show.icon] ?? '').toLowerCase() || show.icon }));
        if (show?.card) shown.push(P.whereCard);
        return [plural(Object.keys(definition.state ?? {}).length, P.fields), buttons ? plural(buttons, P.buttons) : '', rules ? plural(rules, P.rules) : '',
            timers ? plural(timers, P.timers) : '', shown.join(', ') || P.whereHidden].filter(Boolean).join(' · ');
    }

    return {
        widgets: { [BLOCK_WIDGET]: widget('single'), [BLOCK_CARDS_WIDGET]: widget('cards') },
        page,
        reset() { shared.mode = 'list'; shared.draft = null; shared.module = null; shared.note = ''; tell(); },
    };
}
