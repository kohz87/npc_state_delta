// Settings -> Blocks: the page's list, Show as controls, row menu and template chooser (extracted from
// screens/blocks.js; createBlockWidgets returns this page). The card view and editor stay shared.

import { h } from '../../view/widgets/dom.js';
import { selectField } from '../../view/form/fields.js';
import { editableBlockDraft } from '../../data-modules/block-builder.js';
import { exportBlockPack } from '../../data-modules/block-templates.js';
import { saveTextFile } from '../../view/download.js';
import { STRINGS, fill, refusalText } from '../../strings.js';
import { ROLES_WITHOUT_TAB } from '../../lean-rpg/names.js';
import { renderBlockEditor } from '../blocks-editor.js';
import { S, P, plural, showValue, metaOf } from './shared.js';

export function createBlocksPage({ shared, tell, templates, rpgState, loadRpg, open, leanRpgOn, directorOn, tabs, renderPreview, addFromTemplate, button, rowsOf, confirm, listeners }) {
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
            definition.show = { tab: value === 'tab' || value === 'both', card: value === 'card' || value === 'both', tabName: was.tabName, icon: was.icon,
                // (a block that joins another tab keeps doing so while it has a tab at all)
                ...(was.into && (value === 'tab' || value === 'both') ? { into: was.into } : {}) };
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
            button(doc, menu, S.exportPack, async () => {
                closeMenu();
                const result = await exportBlockPack(definition);
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
                shared.module = null; shared.meta = {}; shared.starters = false; shared.mode = 'editor'; tell();
            });
            let rpg = [];
            if (leanRpgOn()) {
                loadRpg();
                const loaded = rpgState.templates ?? [];
                rpg = Array.isArray(loaded) ? loaded : (loaded.standard ?? []);
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
                let joinable = [];
                try { joinable = tabs() ?? []; } catch { joinable = []; }
                editor = renderBlockEditor(root, { draft: shared.draft, used: rows.map(row => row.module), directorOn: directorOn(),
                    starters: shared.starters, meta: shared.meta, renderPreview, tabs: joinable,
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

    return page;
}
