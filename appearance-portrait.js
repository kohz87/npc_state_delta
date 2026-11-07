/* Per-form portrait assets and the resolved-appearance fingerprint: bounded asset normalization and
   the compact identity used to mark a portrait stale when the presentation moves on. A pure part of
   appearance.js (same owner, moved without change); appearance.js keeps the public facade and
   re-exports every public name. Never imports appearance.js. */
import { normalizeName } from './core-mechanics.js';
import { APPEARANCE_FORM_LIMIT, clean, formKey } from './appearance-text.js';
import { resolveNpcAppearance } from './appearance-model.js';

// Per-form portraits are user-owned image assets kept beside the main portrait in
// state.formPortraitAssets[npcId][formKey]. Like the main portrait assets they are never copied
// into checkpoints or the rollback journal, and they are bounded to the appearance-form limit.
export function formPortraitKey(name) { return formKey(name); }

export function normalizeFormPortraitAssets(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const out = {};
    for (const [npcId, forms] of Object.entries(source)) {
        const id = clean(npcId, 160);
        if (!id || ['__proto__', 'constructor', 'prototype'].includes(id) || !forms || typeof forms !== 'object' || Array.isArray(forms)) continue;
        const entries = [];
        for (const [rawKey, portrait] of Object.entries(forms)) {
            if (!portrait || typeof portrait !== 'object' || typeof portrait.dataUrl !== 'string' || !portrait.dataUrl) continue;
            const form = clean(portrait.form || rawKey, 120);
            const key = formKey(form);
            if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || entries.some(([existing]) => existing === key)) continue;
            entries.push([key, { ...portrait, form }]);
            if (entries.length >= APPEARANCE_FORM_LIMIT) break;
        }
        if (entries.length) out[id] = Object.fromEntries(entries);
    }
    return out;
}

export function formPortraitFor(assets = {}, npcId = '', formName = '') {
    const key = formKey(formName);
    if (!key) return null;
    const portrait = assets?.[String(npcId || '')]?.[key];
    return portrait?.dataUrl ? portrait : null;
}

// Compact identity of the resolved current presentation. A portrait records it when attached so
// the dossier can show that the described appearance moved on after the image was made. Version 2
// also covers the explicit apparent age the portrait prompt draws; a recorded version-1 value is
// compared with the version-1 identity, so portraits attached before it are not all marked stale.
export function appearanceFingerprint(npc = {}, { form = '', version = 2 } = {}) {
    const subject = form ? { ...npc, currentForm: form, currentFormUnknown: false } : npc;
    const text = normalizeName(resolveNpcAppearance(subject));
    if (!text) return '';
    const legacy = Number(version) === 1;
    // An apparent age produced only by the automatic birthday carry is not a visual change: compare
    // the reference apparent age it was carried from, so a portrait is not marked stale every year.
    const shown = String(npc?.apparentAge ?? '').trim().match(/^~?(\d{1,3})$/);
    const anchor = npc?.apparentAgeAnchor;
    const carried = shown && anchor && Number.isInteger(anchor.apparent) && anchor.result === Number(shown[1]);
    const apparentAge = legacy ? '' : normalizeName(carried ? `~${anchor.apparent}` : npc?.apparentAge);
    const material = apparentAge ? `${text}|apparent age:${apparentAge}` : text;
    let hash = 0x811c9dc5;
    for (let index = 0; index < material.length; index += 1) {
        hash ^= material.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `a${legacy ? 1 : 2}:${hash.toString(36)}:${material.length}`;
}
