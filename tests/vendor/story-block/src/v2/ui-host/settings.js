// Builds the settings overlay and its diagnostics for the page host.
// The current overlay, card log and RPG sections are read when the reader opens or uses them.

import { openSettingsWindow } from '../view/settings/window.js';
import { CORE_FEATURE, GEAR_FEATURE, withHiddenFeatures } from '../features.js';
import { buildReport, caughtSoFar, reportFileName } from '../diagnostics.js';
import { createThemeBridge } from '../view/theme.js';
import { openUiSample } from '../screens/ui-sample.js';

export function createUiSettings({ runtime, doc, registry, store, sdk, settings, version, widgets, liveCtx, tabsControl, blockTemplates, blockWidgets, getRpg, getHudAsked, getCardLog, getOverlay, setOverlay }) {
    // The settings overlay. Its prompt size is what the next ordinary reply would be sent (turn.preview:
    // built on demand, never sent, nothing changed), counted with SillyTavern's tokenizer when the context
    // has one; it is counted again when a feature flips or the story moves while the overlay is open.
    const countTokens = () => {
        const live = liveCtx();
        return typeof live?.getTokenCountAsync === 'function' ? text => live.getTokenCountAsync(text) : null;
    };
    // Settings → Diagnostics (diagnostics.js): the report's parts, read when it is built. SillyTavern's
    // version is the one its page shows (else its /version answer). Each module's `hooks.diagnostics`
    // adds its own section.
    const promptParts = typeof runtime.turn?.previewFit === 'function' ? () => runtime.turn.previewFit()
        : typeof runtime.turn?.preview === 'function' ? () => runtime.turn.preview() : null;
    const stVersion = async () => {
        const shown = doc.querySelector?.('#version_display')?.textContent?.trim();
        if (shown && shown !== 'SillyTavern') return shown;
        const fetcher = (doc.defaultView ?? globalThis).fetch;
        if (typeof fetcher !== 'function') return '';
        const answer = await fetcher('/version');
        const data = answer?.ok ? await answer.json() : null;
        return data?.pkgVersion ? `SillyTavern ${data.pkgVersion}` : '';
    };
    // Story Suite's look (view/theme.js): light or dark from SillyTavern's theme, the reader's panel style
    // and font, on every Story Suite root; SillyTavern's own elements are never touched.
    const theme = createThemeBridge({ doc, settings: () => settings() });
    const sanitizer = globalThis.SillyTavern?.libs?.DOMPurify?.sanitize?.bind(globalThis.SillyTavern.libs.DOMPurify) ?? null;
    const diagnostics = Object.freeze({
        // Settings → Diagnostics → Show the UI sample: every building block, light and dark (screens/ui-sample.js).
        sample: () => {
            getOverlay()?.close?.();
            return openUiSample({ doc, widgets, sanitize: sanitizer });
        },
        report: () => buildReport({
            stVersion,
            hostVersion: version || registry.hostVersion?.() || '',
            modules: () => registry.modules().map(def => ({ id: def.id, name: def.name ?? def.id, version: def.version ?? '' })),
            refusals: () => registry.refusals?.() ?? [],
            features: () => runtime.features?.list?.() ?? [],
            hostSettings: () => settings(),
            settingsOf: id => settings(id),
            promptParts,
            problems: () => runtime.turn?.problems?.() ?? [],
            save: () => ({ failing: store.failing?.(), dirty: store.dirty?.(), suspect: typeof store.suspect === 'function' ? store.suspect() : undefined }),
            calls: () => runtime.callQueue?.stats?.() ?? null,
            caught: caughtSoFar,
            chat: () => liveCtx()?.chat ?? [],
            chatOpen: () => Boolean(liveCtx()?.getCurrentChatId?.() ?? liveCtx()?.chatId),
            hooks: () => registry.hookEntries?.('diagnostics') ?? [],
            cardOffers: () => getCardLog().slice(),
        }),
        fileName: () => reportFileName(),
        // A story Story Block keeps as it is (read-only) can be repaired, only when the reader says so (turn.repair).
        repairActions: () => runtime.turn?.repairActions?.() ?? [],
        repair: id => runtime.turn?.repair?.(id, { confirmed: true }),
    });
    function openSettings(options = null) {
        const fold = typeof options?.fold === 'string' ? options.fold : null;
        const overlay = openSettingsWindow({
            // The status strip's switch is there only while some screen asks for the strip (a pack's, a module's `hud` mount); its stored
            // choice stays, and the strip works as before.
            registry, settings, doc, sdk, features: withHiddenFeatures(runtime.features ?? null, feature => (feature.id === CORE_FEATURE.hud && !getHudAsked()) || feature.id === GEAR_FEATURE), fold, diagnostics,
            promptParts, tabs: tabsControl, theme, blockTemplates, blocks: blockWidgets,
            chatOpen: () => Boolean(liveCtx()?.getCurrentChatId?.() ?? liveCtx()?.chatId),
            ...(getRpg() ? { extraSections: getRpg().settingsSections() } : {}),
            countTokens: countTokens(),
            onClose: () => { setOverlay(null); },
        });
        setOverlay(overlay);
        return overlay;
    }

    return { theme, openSettings };
}
