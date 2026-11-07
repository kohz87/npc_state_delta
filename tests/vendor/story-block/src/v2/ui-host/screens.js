// The page's screen registry and the synchronization of module, pack and pinned-block screens.
// The tab list is sent back to the block widgets whenever the presentation changes.

import { TEMPLATES, applyScreenCss } from '../view/render-screen.js';
import { CORE_FEATURE } from '../features.js';
import { mergeTabs } from '../view/tab-merge.js';
import { ROLES_WITHOUT_TAB } from '../lean-rpg/names.js';

export function createScreenSync({ doc, registry, sdk, screens, setSharedTabs }) {
    // ---- screens from the modules and the packs ----------------------------------------------
    // The screen ids each pack gave at the last sync, by pack: a pack that is disabled, removed or no longer has a screen takes
    // those screens and their stylesheets away, and a replaced pack's new stylesheets replace the old ones.
    const packScreenIds = new Map();
    const rpgOn = () => registry.featureOn?.(CORE_FEATURE.leanRpg) === true;
    // The pinned blocks' screens. A block with an RPG role (character, skills, foes, rules) never gets a tab of its own: with the feature on
    // the Party and Fight tabs draw them, with it off they are only data (they stay in Settings → Blocks, and come back to use when it is on).
    const blockPresentation = () => sdk.query('dataModules.presentation', { kind: 'screens', noTab: ROLES_WITHOUT_TAB });
    function syncScreens(pinned = null) {
        const byModule = new Map();
        // Every module with screens, even one whose screens are all off just now (its list is then empty).
        for (const def of registry.modules()) if (Array.isArray(def.screens) && def.screens.length) byModule.set(def.id, []);
        for (const screen of registry.screens()) {
            const { moduleId, ...def } = screen;
            if (!byModule.has(moduleId)) byModule.set(moduleId, []);
            byModule.get(moduleId).push(def);
        }
        for (const [moduleId, list] of byModule) {
            try { screens.addModule(moduleId, list); } catch (error) { console.warn('[Story Suite]', error?.message ?? error); }
        }
        let packScreens = [];
        try { packScreens = sdk.query('packs.content', { kind: 'screens' }) ?? []; } catch { packScreens = []; }
        try {
            for (const { id, title, icon, pack, ...layout } of sdk.query('packs.content', { kind: 'layouts' }) ?? []) {
                if (!packScreens.some(screen => screen.pack === pack && screen.id === id)) packScreens.push({ id, title, icon, mounts: ['tab'], layout, pack });
            }
        } catch { /* older host */ }
        try { packScreens.push(...(pinned ?? blockPresentation() ?? [])); } catch { /* older host */ }
        // Screens that name one `tab` (a pack's, or a block's show.into) become sections of one tab.
        setSharedTabs([...new Map(packScreens.filter(screen => typeof screen?.tab === 'string' && screen.tab).map(screen => [screen.tab, { id: screen.tab, title: screen.tabTitle ?? screen.title ?? screen.tab }])).values()]);
        packScreens = mergeTabs(packScreens);
        const byPack = new Map();
        for (const screen of packScreens) {
            const { pack, ...def } = screen ?? {};
            if (!pack) continue;
            if (!byPack.has(pack)) byPack.set(pack, []);
            byPack.get(pack).push(def);
        }
        for (const [pack, ids] of packScreenIds) {
            if (byPack.has(pack)) continue;
            screens.removePack(pack);
            for (const id of ids) applyScreenCss(doc, { id, css: '' });
            packScreenIds.delete(pack);
        }
        for (const [pack, list] of byPack) {
            const before = packScreenIds.get(pack) ?? [];
            const now = list.map(def => def.id);
            for (const id of before) if (!now.includes(id)) applyScreenCss(doc, { id, css: '' });
            try {
                screens.setPack(pack, list);
                packScreenIds.set(pack, now);
                for (const def of list) applyScreenCss(doc, def, TEMPLATES.scopeCss);
            } catch (error) { console.warn('[Story Suite]', error?.message ?? error); }
        }
    }

    return { rpgOn, blockPresentation, syncScreens };
}
