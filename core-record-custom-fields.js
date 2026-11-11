/* NPC State Delta custom-field parsing, value projection and grounded merge. Split from core-record.js without change;
   core-record.js re-exports every name it exported before. */
import { cleanText } from './core-text.js';

// User-defined dossier fields (for example Level or Class), named once in settings for every chat.
export const CUSTOM_FIELD_LIMIT = 6;
const CUSTOM_FIELD_STORED_LIMIT = 12;
const CUSTOM_FIELD_NAME_MAX = 40;
const CUSTOM_FIELD_VALUE_MAX = 60;

export function normalizeCustomFieldNames(value) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
    const names = [];
    for (const item of items) {
        const name = cleanText(String(item ?? '').replace(/["{}:]/g, ' '), CUSTOM_FIELD_NAME_MAX);
        if (name && !names.some(other => other.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    return names.slice(0, CUSTOM_FIELD_LIMIT);
}

export function normalizeCustomFields(raw) {
    const entries = Array.isArray(raw)
        ? raw.map(item => [item?.name ?? item?.field, item?.value])
        : Object.entries(raw && typeof raw === 'object' ? raw : {});
    const out = {};
    for (const [key, value] of entries) {
        const name = cleanText(key, CUSTOM_FIELD_NAME_MAX);
        const text = cleanText(typeof value === 'number' ? String(value) : value, CUSTOM_FIELD_VALUE_MAX);
        if (!name || !text || Object.keys(out).some(other => other.toLowerCase() === name.toLowerCase())) continue;
        out[name] = text;
        if (Object.keys(out).length >= CUSTOM_FIELD_STORED_LIMIT) break;
    }
    return out;
}

// The stored values of the configured fields, keyed by the configured spelling.
export function customFieldValues(npc = {}, names = []) {
    const stored = normalizeCustomFields(npc?.customFields);
    const out = {};
    for (const name of normalizeCustomFieldNames(names)) {
        const key = Object.keys(stored).find(other => other.toLowerCase() === name.toLowerCase());
        if (key) out[name] = stored[key];
    }
    return out;
}

function collapsedText(value) {
    return String(value ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const LEVEL_QUOTE_MIN = 12; // collapsed characters: a few words, so one word cannot pass

// The reason is one string per row, so only the part after the word "Level" (up to another configured
// field's name) counts; its quoted text, or all of it when unquoted, must occur in the source text.
function levelQuoteInText(reason, configured, source) {
    const text = String(reason || '');
    const at = text.search(/\blevel\b/i);
    if (at < 0 || !source) return false;
    let tail = text.slice(at + 5);
    for (const other of configured) {
        if (other.toLowerCase() === 'level') continue;
        // A field marker is the name followed by a colon; a bare substring ("age" in "damage") must not cut a quote.
        const cut = tail.search(new RegExp(`(?<![\\p{L}\\p{N}])${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'iu'));
        if (cut >= 0) tail = tail.slice(0, cut);
    }
    const quoted = [...tail.matchAll(/["\u201c]([^"\u201d]+)["\u201d]/g)].map(match => match[1]);
    return (quoted.length ? quoted : [tail]).some(part => {
        const quote = collapsedText(part);
        return quote.length >= LEVEL_QUOTE_MIN && source.includes(quote);
    });
}

// Keep-by-default: a configured field is set from the scan only when the source text carries the
// value, and an established value changes only with a stated reason. Omission keeps what is stored.
export function mergeCustomFieldValues(existing, incoming, { names = [], reason = '', context = '' } = {}) {
    const configured = normalizeCustomFieldNames(names);
    if (!configured.length) return null;
    const out = normalizeCustomFields(existing);
    const source = collapsedText(context);
    let changed = false;
    for (const [key, value] of Object.entries(normalizeCustomFields(incoming))) {
        const name = configured.find(item => item.toLowerCase() === key.toLowerCase());
        if (!name) continue;
        const storedKey = Object.keys(out).find(other => other.toLowerCase() === name.toLowerCase());
        const prior = storedKey ? out[storedKey] : '';
        if (prior && prior.toLowerCase() === value.toLowerCase()) continue;
        if (prior && !String(reason || '').trim()) continue;
        // Level may be an estimate from a stated rank or a comparison (owner-approved); the text then lacks
        // the value itself, so the reason must carry a quote from the story, written after the word "Level".
        const estimated = name.toLowerCase() === 'level' && levelQuoteInText(reason, configured, source);
        if (source && !estimated && !source.includes(collapsedText(value))) continue;
        if (storedKey && storedKey !== name) delete out[storedKey];
        out[name] = value;
        changed = true;
    }
    return changed ? out : null;
}

// (hosted) The sheet level of an ACTIVE party member, matched by exact name or alias (case-insensitive); null when none.
// `partyLevels` is [{ name, level }] of active members with a whole-number level; Story Block's `party.levels` is read in runtime-hosted.js.
export function sheetLevelOf(npc, partyLevels) {
    if (!Array.isArray(partyLevels) || !partyLevels.length) return null;
    const labels = new Set([npc?.name, ...(Array.isArray(npc?.aliases) ? npc.aliases : [])].map(label => String(label ?? '').trim().toLowerCase()).filter(Boolean));
    const found = partyLevels.find(entry => labels.has(String(entry?.name ?? '').trim().toLowerCase()));
    return Number.isInteger(found?.level) ? found.level : null;
}

// Sets the stored Level of each active party member to the sheet's (the scanner's own Level for them is then not kept).
// Skipped when Level is not a configured field or the dossier's custom fields are locked by hand. Returns [{ id, reason }].
export function applySheetLevels(npcs, partyLevels, names) {
    const level = normalizeCustomFieldNames(names).find(name => name.toLowerCase() === 'level');
    const done = [];
    if (!level || !Array.isArray(partyLevels) || !partyLevels.length) return done;
    for (const npc of npcs || []) {
        const sheet = sheetLevelOf(npc, partyLevels);
        if (sheet === null || (npc.manualProfileFields || []).includes('customFields')) continue;
        const fields = normalizeCustomFields(npc.customFields);
        const key = Object.keys(fields).find(other => other.toLowerCase() === 'level');
        if (key && fields[key] === String(sheet)) continue;
        if (key) delete fields[key];
        npc.customFields = { ...fields, [level]: String(sheet) };
        done.push({ id: npc.id, reason: 'Level: from the party sheet' });
    }
    return done;
}

// (hosted) The scan result without the scanner's Level for people on the party sheet (an npcs[] or profileUpdates[] row whose name or
// aliases, or whose stored dossier's, match an active member). A copy; the result itself is not changed.
export function withoutSheetLevels(scanResult, stored, partyLevels) {
    if (!Array.isArray(partyLevels) || !partyLevels.length) return scanResult;
    const known = new Map((Array.isArray(stored) ? stored : []).map(npc => [npc?.id, npc]));
    const strip = row => {
        const onSheet = sheetLevelOf(row, partyLevels) !== null || sheetLevelOf(known.get(row?.id), partyLevels) !== null;
        if (!onSheet || !row?.customFields) return row;
        const fields = normalizeCustomFields(row.customFields);
        for (const key of Object.keys(fields)) if (key.toLowerCase() === 'level') delete fields[key];
        return { ...row, customFields: fields };
    };
    return { ...scanResult, ...(Array.isArray(scanResult?.npcs) ? { npcs: scanResult.npcs.map(strip) } : {}), ...(Array.isArray(scanResult?.profileUpdates) ? { profileUpdates: scanResult.profileUpdates.map(strip) } : {}) };
}
