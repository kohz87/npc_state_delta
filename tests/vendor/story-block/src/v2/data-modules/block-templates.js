// Reader-owned templates contain definitions only; their values and reply history stay in the chat.
import { byteLength } from '../packs/safety.js';
import { validatePack } from '../packs/validate.js';
import { validateDataModules } from './check.js';
import { DM_LIMITS as L } from './schema.js';
import { STRINGS } from '../strings.js';

const B = STRINGS.blocks;
const copy = value => JSON.parse(JSON.stringify(value));
const rawDefinition = definition => Object.fromEntries(Object.entries(copy(definition ?? {})).filter(([key]) => !['id', 'pack'].includes(key)));
const keyOf = name => String(name ?? '').normalize('NFKC').trim().toLowerCase();

export function createBlockTemplates({ read, save = () => {} }) {
    const entries = () => { const root = read?.(); return Array.isArray(root?.blockTemplates) ? root.blockTemplates : []; };
    const checked = entry => {
        if (!entry || typeof entry.name !== 'string' || !entry.name.trim() || !entry.definition) return null;
        const result = validateDataModules([entry.definition], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'] });
        return result.ok && byteLength(JSON.stringify(entry.definition)) <= L.definitionBytes ? { name: entry.name, definition: copy(entry.definition) } : null;
    };
    return {
        list: () => entries().slice(0, 16).map(checked).filter(Boolean),
        async put(definition, { replace = false } = {}) {
            const raw = rawDefinition(definition), name = raw.name;
            if (byteLength(JSON.stringify(raw)) > L.definitionBytes) return { ok: false, code: 'TOO_LARGE', message: B.templateLarge };
            const result = validateDataModules([raw], { packId: 'chat', capabilities: ['data-modules-v1', 'story-director'] });
            if (!result.ok) return { ok: false, code: result.errors[0].code, message: result.errors[0].message };
            const root = read(), list = entries().slice(), at = list.findIndex(entry => keyOf(entry?.name) === keyOf(name));
            if (at >= 0 && !replace) return { ok: false, code: 'EXISTS', message: B.templateExists };
            if (at < 0 && list.length >= 16) return { ok: false, code: 'FULL', message: B.templatesFull };
            const entry = { name, definition: raw };
            if (at < 0) list.push(entry); else list[at] = entry;
            root.blockTemplates = list;
            await save();
            return { ok: true, replaced: at >= 0 };
        },
        async remove(name) {
            const root = read(), list = entries(), at = list.findIndex(entry => keyOf(entry?.name) === keyOf(name));
            if (at < 0) return { ok: false, message: B.templateMissing };
            root.blockTemplates = list.filter((_, index) => index !== at);
            await save();
            return { ok: true };
        },
    };
}

/** The pack validator writes the new pack-qualified definition id on import. */
export function exportBlockPack(definition) {
    const raw = rawDefinition(definition), id = raw.slug;
    const pack = { id, name: raw.name, version: '1.0.0', requires: { storyBlock: '^2', capabilities: ['data-modules-v1'] }, content: { dataModules: [raw] } };
    if (raw.timers?.length || raw.scope === 'character') pack.requires.capabilities.push('story-director');
    const checked = validatePack(pack);
    if (!checked.ok) return { ok: false, errors: checked.errors };
    return { ok: true, pack, filename: `${id}.pack.json`, text: `${JSON.stringify(pack, null, 2)}\n` };
}
