// The runtime's start helpers (moved out of runtime.js unchanged): the initial state with the packs'
// start applied, a packs part over extension settings, and Story Block's currency fallback.

import { CORE_MODULE_ID } from '../domains/index.js';
import { WALLET_KEY } from '../domains/money.js';
import { applyStart, createPacksPart } from '../packs/index.js';
import { newId } from '../sdk.js';

/**
 * Settings where Story Block's `currency` (and `currencyShort`, `currencyPlural`, `coins`) fall back to
 * `suggest()` → { name, short, plural?, coins? } | null when the reader has not set them: the reader's
 * coins win, then the pack's (only with the pack's currency: a currency the reader named keeps no pack
 * coins), then none. Same interface as createSettings().
 */
export function withPackCurrency(base, suggest) {
    const settings = id => {
        const values = base(id);
        if (id !== CORE_MODULE_ID) return values;
        const stored = base.stored(id);
        if (Object.hasOwn(stored, 'currency') && String(stored.currency ?? '').trim()) return values;
        let offer = null;
        try { offer = suggest(); } catch { offer = null; }
        if (offer && typeof offer.name === 'string' && offer.name.trim()) {
            values.currency = offer.name.trim();
            if (!Object.hasOwn(stored, 'currencyShort') || !String(stored.currencyShort ?? '').trim()) values.currencyShort = String(offer.short ?? '');
            if (!Object.hasOwn(stored, 'currencyPlural') || !String(stored.currencyPlural ?? '').trim()) values.currencyPlural = String(offer.plural ?? '');
            const ownCoins = Array.isArray(stored.coins) && stored.coins.length > 0;
            if (!ownCoins && Array.isArray(offer.coins) && offer.coins.length) values.coins = structuredClone(offer.coins);
        }
        return values;
    };
    settings.stored = base.stored;
    settings.set = base.set;
    return settings;
}

/** The initial State: the registry's, with each `start` hook's merged pack start applied. */
export function initialWithStart(registry, { id = newId } = {}) {
    let state = registry.initialState();
    for (const hook of registry.hooks('start')) {
        let start = null;
        try { start = hook(); } catch (error) {
            console.warn('[Story Suite] a pack start could not be read', error);
            continue;
        }
        if (!start || !Array.isArray(start.packs) || !start.packs.length) continue;
        try { state = applyStart(state, start, { id, coin: WALLET_KEY }); } catch (error) {
            console.warn('[Story Suite] a pack start could not be applied', error);
        }
    }
    return state;
}

/** A packs part over `ctx.extensionSettings.storySuite` (the testkit's; index.js uses the live one). */
export function packsFor(ctx, options = {}) {
    return createPacksPart({
        settings: {
            read() {
                const root = ctx.extensionSettings ?? (ctx.extensionSettings = {});
                if (!root.storySuite || typeof root.storySuite !== 'object') root.storySuite = {};
                return root.storySuite;
            },
            save: () => ctx.saveSettingsDebounced?.(),
        },
        ...options,
    });
}
