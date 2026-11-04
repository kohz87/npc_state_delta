// What the block editor knows about how a block can be drawn: which of the three layouts (List of cards, Numbers with bars, Card of fields) fit the shape
// of the fields, which one to suggest and why, which parts of a List of entries play the card roles, and example values for the preview. Pure functions over
// the editor's draft (block-builder.js); nothing here is stored except what the author picks.
import { fill, STRINGS } from '../strings.js';
import { defaultTone } from './block-builder.js';

const B = STRINGS.blocks;
export const LAYOUTS = Object.freeze(['cards', 'bars', 'fields']);
export const TONES = Object.freeze(['active', 'done', 'failed', 'neutral']);

const entriesOf = draft => (Array.isArray(draft?.fields) ? draft.fields.filter(field => field?.type === 'entries') : []);
const list = names => (names.length > 3 ? `${names.slice(0, 3).join(', ')}, …` : names.join(', '));

/**
 * → { fits: { cards, bars, fields }: { ok, reason }, suggested: 'cards'|'bars'|'fields'|null, why }. A layout that does not fit says why in `reason`.
 * The suggestion: a List of entries with a text part → cards; every field a number → bars; anything else → fields.
 */
export function layoutShape(draft) {
    const fields = Array.isArray(draft?.fields) ? draft.fields : [];
    const lists = entriesOf(draft), titled = lists.filter(field => (field.of ?? []).some(part => part.type === 'text'));
    const others = fields.filter(field => field.type !== 'number');
    const empty = !fields.length;
    const fits = {
        cards: titled.length ? { ok: true, reason: '' } : { ok: false, reason: empty ? B.layoutEmpty : lists.length ? B.layoutCardsTitle : B.layoutCardsNeed },
        bars: !empty && !others.length ? { ok: true, reason: '' } : { ok: false, reason: empty ? B.layoutEmpty : fill(B.layoutBarsNot, { names: list(others.map(field => field.name || field.key)) }) },
        fields: empty ? { ok: false, reason: B.layoutEmpty } : { ok: true, reason: '' },
    };
    const suggested = empty ? null : fits.cards.ok ? 'cards' : fits.bars.ok ? 'bars' : 'fields';
    const why = !suggested ? B.layoutEmpty : suggested === 'cards' ? fill(B.whyCards, { name: titled[0].name || titled[0].key })
        : suggested === 'bars' ? fill(B.whyBars, { n: fields.length }) : fill(B.whyFields, { n: fields.length });
    return { fits, suggested, why };
}

// The part names that play a role when the author has not said: Quest, Title or Name → title; the choice → status; Step, Next or Stage → step.
const TITLE_NAMES = /^(title|quest|name|task|goal)\b/i, STEP_NAMES = /(step|next|stage)/i;

/**
 * The card roles for a draft that shows a List of entries as cards: the author's own pick where it still fits the field's parts, else a guess from the
 * names. `step: ''` is the author's "None" and stays. → { roles, guessed } with roles { field, title, status?, step? } or null when there is no list to draw.
 */
export function cardRoles(draft) {
    const lists = entriesOf(draft).filter(field => (field.of ?? []).some(part => part.type === 'text'));
    if (!lists.length) return { roles: null, guessed: false };
    const given = draft.roles ?? {};
    const field = lists.find(item => item.key === given.field) ?? lists[0];
    const parts = field.of ?? [], texts = parts.filter(part => part.type === 'text'), choices = parts.filter(part => part.type === 'choice');
    const own = given.field === field.key;
    const has = (key, type) => parts.some(part => part.key === key && part.type === type);
    let guessed = false;
    // (a role the author set stays while its part is still there and of the right kind; "None" (an empty string) stays too)
    const keep = (key, type, guess, { none = false } = {}) => {
        if (own && none && key === '') return '';
        if (own && has(key, type)) return key;
        guessed = true;
        return guess;
    };
    const title = keep(given.title, 'text', (texts.find(part => TITLE_NAMES.test(part.name)) ?? texts[0]).key);
    const status = keep(given.status, 'choice', choices[0]?.key ?? '', { none: true });
    const step = keep(given.step, 'text', texts.find(part => part.key !== title && STEP_NAMES.test(part.name))?.key ?? '', { none: true });
    return { roles: { field: field.key, title, status, step }, guessed };
}

/** The status values of the roles' choice part, each with the tone it has now (the author's, else the default). */
export function statusTones(draft, roles) {
    const field = entriesOf(draft).find(item => item.key === roles?.field);
    const part = (field?.of ?? []).find(item => item.key === roles?.status && item.type === 'choice');
    const values = Array.isArray(part?.values) ? part.values : String(part?.values ?? '').split(',').map(value => value.trim()).filter(Boolean);
    return values.map(value => ({ value, tone: draft.tones?.[value] ?? defaultTone(value) }));
}

/**
 * Example values for the preview of a built definition (a new block has no data): two entries for a List of entries (the first two status values, so the
 * Finished fold has something), the middle of a number's range, the field's name for a text.
 */
export function exampleValues(definition) {
    const out = {};
    for (const [key, schema] of Object.entries(definition?.state ?? {})) {
        if (schema.type === 'entries') {
            const status = schema.of[definition.roles?.status];
            out[key] = [0, 1].map(at => Object.fromEntries(Object.entries(schema.of).map(([part, sub]) => [part,
                sub.type === 'int' ? Math.round((sub.min + sub.max) / 2) : sub.type === 'enum' ? (sub === status ? sub.values[Math.min(at, sub.values.length - 1)] : sub.values[0])
                    : `${sub.label ?? part} ${at + 1}`])));
        } else out[key] = schema.type === 'int' ? Math.round((schema.min + schema.max) / 2) : schema.type === 'enum' ? schema.default : schema.type === 'bool' ? schema.default : schema.label ?? key;
    }
    return out;
}
