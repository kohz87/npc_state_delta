// Settings for the public sdk: a schema value coerced as its field allows, and the settings object over
// extension_settings.storySuite. It copies what it stores and never keeps module state.

import { normalizeField } from '../registry.js';
import { cutAt } from '../../text.js';
import { profileName } from '../model-call.js';
import { isObject } from './shared.js';
import { HOST_SETTINGS_DEFAULTS, HOST_SETTINGS_SCHEMA, SETTING_LIST_ROWS, SETTING_TEXT_MAX } from './constants.js';

/**
 * A value as `field` (a settings schema entry) allows it: text is text, cut at `max` characters
 * (SETTING_TEXT_MAX when the field sets none), never inside a character; a whole number is kept inside
 * min/max (null when it is not one); a choice must be one of its options (null when not); a profile is a
 * Connection Manager profile's name, trimmed and cut at 100 ('' for the chat's connection); a list is at
 * most SETTING_LIST_ROWS rows of records, each holding its `of` fields as they allow them (other keys
 * dropped). Other types pass unchanged.
 */
export function settingValue(field, value) {
    if (!field) return value;
    const f = normalizeField(field);
    if (f.type === 'text') {
        if (value === undefined || value === null) return '';
        const text = typeof value === 'string' ? value : String(value);
        const max = Number.isInteger(f.max) && f.max >= 0 ? f.max : SETTING_TEXT_MAX;
        return text.length > max ? cutAt(text, max) : text;
    }
    if (f.type === 'list') {
        if (!Array.isArray(value)) return [];
        const of = isObject(f.of) ? Object.entries(f.of) : [];
        return value.slice(0, SETTING_LIST_ROWS).filter(isObject)
            .map(row => Object.fromEntries(of.map(([key, sub]) => [key, settingValue(sub, row[key])])));
    }
    if (f.type === 'int') {
        const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
        if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return null;
        let out = Math.round(n);
        if (Number.isInteger(f.min)) out = Math.max(f.min, out);
        if (Number.isInteger(f.max)) out = Math.min(f.max, out);
        return out;
    }
    // A Connection Manager profile's name, trimmed and cut at 100; '' (or 'chat') is the chat's connection.
    if (f.type === 'profile') return profileName(typeof value === 'string' ? value : '');
    if (f.type === 'bool') return Boolean(value);
    if (f.type === 'choice' && Array.isArray(f.options) && f.options.length) {
        const options = (f.options ?? []).map(option => String(option && typeof option === 'object' ? option.value : option));
        return options.includes(String(value)) ? String(value) : null;
    }
    return value;
}

/**
 * Settings under `root().storySuite` (`root`: () => SillyTavern's extension_settings):
 * `settings(id)` → the module's values over its defaults (a plain copy); `settings()` → the
 * host's ({ tailBudget, maxChangeLines }). `settings.set(id, key, value)` stores one value (id null:
 * the host's) as its schema field allows it (settingValue: text cut at `max`, numbers inside min/max;
 * a value the field cannot take is not stored) and calls `save` (saveSettingsDebounced). Returns the
 * value stored, or undefined. `settings.stored(id)` is the stored object itself.
 */
export function createSettings({ root, registry, save = () => {} }) {
    function bucket() {
        const es = root?.();
        if (!isObject(es)) return { host: {}, modules: {} };
        if (!isObject(es.storySuite)) es.storySuite = {};
        if (!isObject(es.storySuite.modules)) es.storySuite.modules = {};
        if (!isObject(es.storySuite.host)) es.storySuite.host = {};
        return es.storySuite;
    }
    function stored(id) {
        const all = bucket();
        if (id === undefined || id === null) return all.host;
        if (!isObject(all.modules[id])) all.modules[id] = {};
        return all.modules[id];
    }
    function settings(id) {
        const defaults = id === undefined || id === null ? HOST_SETTINGS_DEFAULTS : registry.module(id)?.settings?.defaults ?? {};
        return structuredClone({ ...defaults, ...stored(id) });
    }
    settings.stored = stored;
    const fieldOf = (id, key) => {
        const schema = id === undefined || id === null ? HOST_SETTINGS_SCHEMA : registry.module(id)?.settings?.schema;
        return schema && Object.hasOwn(schema, key) ? schema[key] : null;
    };
    settings.set = (id, key, value) => {
        const next = settingValue(fieldOf(id, key), value);
        if (next === null && value !== null) return undefined;
        stored(id)[key] = structuredClone(next);
        save();
        return next;
    };
    return settings;
}
