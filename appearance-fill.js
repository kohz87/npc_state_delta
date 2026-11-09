/* Appearance fill (role: appearance-fill). When a NEW person is met, the targeted Refresh may fill the BLANK look fields
   (overallAppearance, appearance) with details that fit what the story has said, because stories rarely state hair, eyes or build.
   This file owns three things only: who qualifies (blank, alive, not archived, no named forms), the one prompt line, and the
   name of the merge option that lets this one call seed those blank fields without quoted evidence. Nothing is stored for it:
   the filled text is an ordinary value, so a later explicit story line replaces it through the normal refine gate (the refine
   rule keeps recorded details and the gate asks the new clause to be grounded; an invented value is never asked to be). Pure. */

const blank = value => !String(value ?? '').trim();

/** The blank look fields a fill may write for this record, or [] when none/ineligible (dead, archived, named forms in use). */
export function blankLookFields(npc = {}) {
    if (!npc || typeof npc !== 'object' || npc.archived) return [];
    const life = String(npc.lifeState || '').toLowerCase();
    if (life === 'deceased' || life === 'dead') return [];
    if ((Array.isArray(npc.appearanceForms) && npc.appearanceForms.length) || !blank(npc.currentForm) || npc.currentFormUnknown) return [];
    if (Array.isArray(npc.manualProfileFields) && npc.manualProfileFields.includes('appearance')) return [];
    return [blank(npc.overallAppearance) && 'overallAppearance', blank(npc.appearance) && blank(npc.unclassifiedAppearance) && 'appearance'].filter(Boolean);
}

/** The Refresh prompt's tail line for a fill call, or '' (static rules stay untouched; the line exists only on this call). */
export function fillLooksLine(npc = {}) {
    const fields = blankLookFields(npc);
    if (!fields.length) return '';
    return `\nFILL LOOKS: ${fields.join(', ')} ${fields.length > 1 ? 'are' : 'is'} blank because the story never described this person. Only for ${fields.length > 1 ? 'those fields' : 'that field'}, write a short plausible look that fits what the story and dossier say (kind and its own features, age, role, region, setting); no quoted evidence needed. Never contradict or repeat anything stated; invent nothing else.`;
}

export const FILL_MERGE_OPTION = 'fillBlankAppearance';
