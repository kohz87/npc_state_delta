// The Diagnostics section's body (UI stage, step 3g): the last page on the form engine's look, in place of the Diagnostics fold. Cards:
//
// * Report: the plain-text report a reader copies or saves for a bug report (diagnostics.js builds it from what the settings host gives:
//   `diagnostics.report()`), shown as it will be shared, with Copy (the clipboard; else the text is selected for copying by hand), Save (a
//   .txt download), Refresh and, when the page offers one, "Show the UI sample". The report holds no API keys, tokens, addresses or chat
//   text (diagnostics.js scrubs it; tests/v2/diagnostics-scrub.test.js and the page's own test keep that). It is built when the page is
//   first shown, and again on Refresh, Copy and Save, not while the window opens.
// * What modules place here with `settings.place: 'diagnostics'`: their own folds (Story Block's Events: debug information that can spoil
//   the story, so folded until opened) and the settings of a module whose whole settings are placed here (its card, a fold too).
//
// Fold keys keep working: `story-suite-diagnostics` (the Report card), `<module id>/<fold id>` (an own fold placed here, opened),
// `<module id>` (a module placed here, opened).
//
// Built with createElement and textContent only: the report and module text are never markup.

import { DIAGNOSTICS_FOLD, DIAGNOSTICS_TEXT } from '../../host-ui.js';
import { fill } from '../../strings.js';
import { newId, sectionBlock } from '../form/fields.js';
import { matchesSearch } from '../form/schema.js';
import { createModuleCard } from './modules.js';
import { showAndFocus } from '../scroll.js';

const h = (doc, tag, className = '', text = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== '' && text !== null && text !== undefined) node.textContent = String(text);
    return node;
};

/** The Diagnostics body: `(pane, ctx) → { filter, refresh, show, destroy, has, open }` (bodies.js). */
export function diagnosticsBody(pane, ctx) {
    const { doc } = ctx;
    const { registry, settings, sdk = null, diagnostics = null } = ctx.options;
    const T = DIAGNOSTICS_TEXT;
    const root = h(doc, 'div', 'ss-diagnostics');
    pane.appendChild(root);
    const defs = typeof registry?.settingsDefs === 'function' ? registry.settingsDefs() : [];
    const modules = new Map((typeof registry?.modules === 'function' ? registry.modules() : []).map(def => [def.id, def]));
    const hasReport = Boolean(diagnostics && typeof diagnostics.report === 'function');

    // ---- the report
    let report = null;
    if (hasReport) {
        const card = sectionBlock(doc, { title: T.title, hint: T.hint, id: newId('diagnostics') });
        card.el.classList.add('ss-diagnostics-card');
        card.el.dataset.fold = DIAGNOSTICS_FOLD;
        card.title.tabIndex = -1;
        const text = h(doc, 'pre', 'story-suite-diagnostics-report');
        text.tabIndex = 0;
        text.setAttribute('aria-label', T.reportLabel);
        const status = h(doc, 'span', 'story-suite-diagnostics-status ss-diagnostics-status');
        status.setAttribute('role', 'status');
        const actions = h(doc, 'div', 'story-suite-diagnostics-actions ss-diagnostics-actions');
        const action = (className, icon, label, primary = false) => {
            const node = h(doc, 'button', `ss-button${primary ? ' ss-button-primary' : ''} ${className}`);
            node.type = 'button';
            const glyph = h(doc, 'i', `fa-solid ${icon}`);
            glyph.setAttribute('aria-hidden', 'true');
            node.append(glyph, h(doc, 'span', '', label));
            actions.appendChild(node);
            return node;
        };
        const copy = action('story-suite-diagnostics-copy', 'fa-copy', T.copy, true);
        const save = action('story-suite-diagnostics-save', 'fa-download', T.save);
        const again = action('story-suite-diagnostics-refresh', 'fa-rotate', T.refresh);
        // The UI sample (screens/ui-sample.js): every building block of Story Suite's look, light and dark.
        if (typeof diagnostics.sample === 'function') {
            const sample = action('story-suite-diagnostics-sample', 'fa-swatchbook', T.sample);
            sample.title = T.sampleTitle;
            sample.addEventListener('click', () => { try { diagnostics.sample(); } catch (error) { status.textContent = fill(T.sampleFailed, { why: error?.message ?? error }); } });
        }
        actions.appendChild(status);
        card.body.append(h(doc, 'p', 'ss-card-help', T.help), text, actions);
        let run = 0;
        let built = false;
        const build = async () => {
            const mine = ++run;
            built = true;
            text.textContent = T.building;
            let value;
            try { value = String(await diagnostics.report()); } catch (error) {
                value = fill(T.failed, { why: error?.message ?? error });
            }
            if (mine === run) text.textContent = value;
            return value;
        };
        const selectReport = () => {
            const win = doc.defaultView ?? globalThis;
            const range = doc.createRange?.();
            const selection = win.getSelection?.();
            if (!range || !selection) return;
            range.selectNodeContents(text);
            selection.removeAllRanges();
            selection.addRange(range);
        };
        copy.addEventListener('click', async () => {
            const value = await build();
            const clipboard = (doc.defaultView ?? globalThis).navigator?.clipboard;
            try {
                if (typeof clipboard?.writeText !== 'function') throw new Error('no clipboard');
                await clipboard.writeText(value);
                status.textContent = T.copied;
            } catch {
                selectReport();
                status.textContent = T.copyFailed;
            }
        });
        save.addEventListener('click', async () => {
            const value = await build();
            const name = typeof diagnostics.fileName === 'function' ? diagnostics.fileName() : 'story-suite-diagnostics.txt';
            try {
                const win = doc.defaultView ?? globalThis;
                const blob = new win.Blob([value], { type: 'text/plain;charset=utf-8' });
                const url = win.URL.createObjectURL(blob);
                const link = h(doc, 'a');
                link.href = url;
                link.download = name;
                link.hidden = true;
                doc.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => win.URL.revokeObjectURL(url), 1000);
                status.textContent = fill(T.saved, { name });
            } catch (error) {
                status.textContent = fill(T.saveFailed, { why: error?.message ?? error });
            }
        });
        again.addEventListener('click', () => { status.textContent = ''; build(); });
        root.appendChild(card.el);
        report = { card, build, built: () => built, text };
    }

    // ---- what modules place here: their own folds, and a module whose settings are placed here
    const env = { ...ctx.options, doc, openState: ctx.openState, changed: () => ctx.changed?.(), open: key => ctx.open?.(key) };
    const placedFolds = [];
    for (const def of defs) {
        for (const item of def.folds ?? []) {
            if (item.place !== 'diagnostics') continue;
            const key = `${def.moduleId}/${item.id}`;
            const wasOpen = ctx.openState?.get(key) === true;
            const card = sectionBlock(doc, { title: item.title, hint: item.hint, id: newId(`diag-${def.moduleId}-${item.id}`), collapsible: true, open: wasOpen });
            card.el.classList.add('ss-diagnostics-fold', 'ss-section-fold');
            card.el.classList.toggle('ss-section-fold-open', wasOpen);
            card.el.dataset.fold = key;
            const panelApi = Object.freeze({ get: k => settings(def.moduleId)[k], set: (k, v) => settings.set(def.moduleId, k, v), values: () => settings(def.moduleId), sdk });
            try { item.render(card.body, panelApi); } catch (error) {
                card.body.replaceChildren(h(doc, 'p', 'story-suite-muted', `This part of ${def.name}'s settings could not be shown: ${error?.message ?? error}`));
            }
            card.el.addEventListener('toggle', () => {
                card.el.classList.toggle('ss-section-fold-open', card.el.open === true);
                ctx.openState?.set(key, card.el.open === true);
            });
            placedFolds.push({ key, title: item.title, hint: item.hint ?? '', module: def.name ?? def.moduleId, card });
            root.appendChild(card.el);
        }
    }
    const placedModules = [];
    for (const def of defs) {
        if (def.place !== 'diagnostics') continue;
        const mod = modules.get(def.moduleId) ?? { id: def.moduleId, name: def.name };
        const entry = createModuleCard(env, mod, def, { placed: 'diagnostics', collapsible: true });
        placedModules.push(entry);
        root.appendChild(entry.el);
    }

    const reportHit = text => matchesSearch('diagnostics.report', { label: `${T.title} ${T.copy} ${T.save} ${T.sample}`, help: T.help }, T.title, text);
    return {
        filter(text) {
            const query = String(text ?? '').trim();
            let shown = 0;
            if (report) {
                const hit = !query || reportHit(text);
                report.card.setHidden(!hit);
                if (query && hit) shown += 1;
            }
            for (const fold of placedFolds) {
                const hit = !query || matchesSearch(fold.key, { label: fold.title, help: fold.hint }, fold.module, text);
                fold.card.setHidden(!hit);
                if (query && hit) shown += 1;
            }
            for (const entry of placedModules) {
                shown += entry.filter(text);
                if (!query && entry.restore) entry.restore();
            }
            return shown;
        },
        refresh() {
            for (const entry of placedModules) entry.refresh();
        },
        // The page is shown: the report is built the first time.
        show() {
            if (report && !report.built()) report.build();
        },
        destroy() {
            for (const entry of placedModules) entry.destroy();
            root.remove();
        },
        has(key) {
            if (report && key === DIAGNOSTICS_FOLD) return true;
            if (placedFolds.some(fold => fold.key === key)) return true;
            return placedModules.some(entry => entry.has(key));
        },
        open(key) {
            if (key === DIAGNOSTICS_FOLD) {
                report?.build?.();
                return showAndFocus(report?.card.title);
            }
            const fold = placedFolds.find(item => item.key === key);
            if (fold) {
                fold.card.el.open = true;
                fold.card.el.classList.add('ss-section-fold-open');
                ctx.openState?.set(key, true);
                return showAndFocus(fold.card.el.querySelector('summary'));
            }
            const entry = placedModules.find(item => item.has(key));
            return entry ? entry.open(key) : false;
        },
    };
}
