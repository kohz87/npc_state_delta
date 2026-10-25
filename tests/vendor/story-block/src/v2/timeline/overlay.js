// The per-chat rule-settings overlay (contract §8: "saved effective rule settings are restored; current UI settings are not").
// A module names the settings that are rules (`settings.rules`, a list of keys). A save captures their values; a restore sets
// them as the chat's own, in the host's savepoints domain (`ruleSettings`: module id -> key -> value), so they follow the
// line of history (a swipe or delete that takes the restore back takes them with it). `withRuleOverlay` wraps the settings
// function the modules read (`ctx.settings`, `sdk.settings`, views) so a rule key the chat has an overlay for reads the
// chat's value in preference to the global setting; every other key, and every chat that never restored, reads as before.

import { HOST_DOMAIN } from './gate.js';

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * withRuleOverlay(base, { registry, state }) → a settings function like `base` (same `stored` and `set`).
 * `state()` → the head state (or null).
 */
export function withRuleOverlay(base, { registry, state }) {
    let reading = false;
    const settings = id => {
        const values = base(id);
        if (id === undefined || id === null || reading) return values;
        const keys = registry.module?.(id)?.settings?.rules;
        if (!Array.isArray(keys) || !keys.length) return values;
        let overlay = null;
        reading = true;
        try { overlay = state()?.domains?.[HOST_DOMAIN]?.ruleSettings?.[id] ?? null; } catch { overlay = null; } finally { reading = false; }
        if (!isObject(overlay)) return values;
        for (const key of keys) if (typeof key === 'string' && Object.hasOwn(overlay, key)) values[key] = structuredClone(overlay[key]);
        return values;
    };
    return Object.assign(settings, base);
}
