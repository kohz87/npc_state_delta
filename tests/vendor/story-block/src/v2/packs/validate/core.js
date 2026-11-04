// Story Suite v2: the pack validator's shared helpers (moved out of packs/validate.js unchanged; validate.js re-exports the public ones):
// the host version a pack is checked against, the slug rule, the shape tests and the failure helper every check uses, and the
// reader of a pack's record lists.

import { RECORD_LIMITS, LIMITS, SLUG } from '../limits.js';
import { oneLine } from '../../../text.js';
import { templateShape, MAX_LOOP_DEPTH } from '../../view/template/index.js';
import { MAX_JSON_DEPTH } from '../../view/template/json.js';

export const HOST_VERSION = '2.22.5';

/** A slug for a display name: "Iron Sword (old)" → "iron-sword-old". */
export function slugify(name) {
    return String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, RECORD_LIMITS.slug).replace(/-+$/, '');
}

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isInt = (value, min = 0) => Number.isInteger(value) && value >= min;
export const fullId = (packId, slug) => `pack.${packId}/${slug}`;

export function fail(code, path, message) {
    return { ok: false, errors: [{ code, path, message }] };
}

// One content list: every record an object, a unique slug, the record's own check.
// `slugField`: the record's own slug field (`slug`, or `id` for events, races and talents);
// `named`: the record needs a name (always for `slug` records); `autoSlug(record)`: the slug of a
// record without a name (routes) when it gives none.
export function records(list, kind, { add, packId, check, slugField = 'slug', named = slugField === 'slug', autoSlug = null }) {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
        add('BAD_CONTENT', `content.${kind}`, `content.${kind} must be a list.`);
        return [];
    }
    const out = [];
    const seen = new Set();
    list.forEach((record, index) => {
        const path = `content.${kind}[${index}]`;
        if (!isObject(record)) return add('BAD_RECORD', path, `${path} must be an object.`);
        const label = typeof record.name === 'string' ? `"${record.name}"` : path;
        if (named) {
            if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > LIMITS.name) return add('BAD_RECORD', `${path}.name`, `${path} needs a name of 1 to ${LIMITS.name} characters.`);
        }
        const given = record[slugField];
        let slug;
        if (given !== undefined || (!named && !autoSlug)) {
            if (typeof given !== 'string' || !SLUG.test(given)) return add('BAD_RECORD', `${path}.${slugField}`, `${label}: ${slugField} must be lowercase letters, digits and dashes (like "iron-sword").`);
            slug = given;
        } else if (!named) {
            slug = autoSlug(record);
            if (!slug) return add('BAD_RECORD', path, `${label}: give a "${slugField}".`);
        } else {
            slug = slugify(record.name);
            if (!slug) return add('BAD_RECORD', `${path}.name`, `${label}: the name needs at least one letter or digit, or give a "slug".`);
        }
        if (seen.has(slug)) return add('DUPLICATE', path, `${label}: two ${kind} share the slug "${slug}".`);
        seen.add(slug);
        const normalized = check(record, path, label);
        if (normalized) out.push({ ...normalized, id: fullId(packId, slug), slug, pack: packId });
    });
    return out;
}

// Records whose fields another part owns (creatures, quests …): any plain data, kept as is.
export function openRecord(record) {
    const { slug: _slug, id: _id, pack: _pack, ...rest } = record;
    return { ...rest, name: oneLine(record.name, LIMITS.name) };
}

export const isText = (value, max) => typeof value === 'string' && value.length <= max;
export const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// What is wrong with a template's shape for a pack (B-b5b-robust-r2-2, r2-3), or ''.
export function shapeProblem(template) {
    const shape = templateShape(template);
    if (shape.loops > MAX_LOOP_DEPTH) return `nests loops (data-each) ${shape.loops} deep; at most ${MAX_LOOP_DEPTH} are allowed`;
    if (shape.deepJson) return `has data-props or data-payload nested more than ${MAX_JSON_DEPTH} deep`;
    return '';
}
