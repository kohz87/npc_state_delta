// Small helpers shared by the scene and inventory domains. Pure.

// The party, or an actor ID (`ac_` + 8 base36, as check.js's RECORD_ID).
export const OWNER_RE = /^(?:party|ac_[0-9a-z]{8})$/;

export const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const clone = value => JSON.parse(JSON.stringify(value));

/** A change line's label, looked up case-insensitively under any of `names`; null when absent. */
export function labelOf(line, ...names) {
    const labels = line?.labels ?? {};
    for (const name of names) {
        for (const key of Object.keys(labels)) {
            if (key.trim().toLowerCase() === name) return String(labels[key] ?? '').trim();
        }
    }
    return null;
}

/** "2", "x2", "2×" → 2; anything else → null. */
export function parseCount(text) {
    const m = /^[x×]?\s*(\d{1,6})\s*[x×]?$/i.exec(String(text ?? '').trim());
    return m ? Number(m[1]) : null;
}

/**
 * A fresh `<prefix>_<8 base36>` ID drawn from the receipt's rng, so a handler stays
 * deterministic (§3.2: ctx.rng is the only randomness). `taken(id)` says an ID is in use.
 */
export function newId(ctx, prefix, taken) {
    for (let attempt = 0; attempt < 64; attempt += 1) {
        let id = `${prefix}_`;
        for (let i = 0; i < 8; i += 1) id += Math.floor(ctx.rng() * 36).toString(36);
        if (!taken(id)) return id;
    }
    return ctx.fail('FAILED', 'No free ID could be found for a new record.');
}

/** An owner's display name: "the party", an actor's name from the party domain, or the ID. */
export function ownerName(state, owner) {
    if (owner === 'party') return 'the party';
    const name = state?.domains?.party?.actors?.[owner]?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : owner;
}

/** The same, read through a handler ctx (the party domain may not exist). */
export function ownerNameIn(ctx, owner) {
    if (owner === 'party') return 'the party';
    let party = null;
    try {
        party = ctx.read('party');
    } catch {
        party = null;
    }
    return ownerName({ domains: { party } }, owner);
}

// "the party" starts a sentence as "The party"; names and IDs are left as they are.
export const capitalize = text => (text.startsWith('the ') ? `T${text.slice(1)}` : text);
