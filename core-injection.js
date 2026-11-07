/* NPC State Delta prompt injection assembly: buildInjection over the selected/relevant cast and
   optional reference blocks. Selection/budget and block-rendering helpers live in
   core-injection-selection.js and core-injection-parts.js; core-mechanics.js re-exports every name
   it exported before. Never imports core-mechanics.js or core.js. */
import { cleanText } from './core-text.js';
import { DEFAULT_BEHAVIOR_CRITERIA } from './core-prompts.js';
import { APPROX_CHARS_PER_TOKEN, INJECTION_CAP_BASE_TOKENS, DEFAULT_INJECTION_BUDGET_TOKENS, normalizeInjectionBudgetTokens, selectRelevantNpcs } from './core-injection-selection.js';
import { clauseBoundedInjection, compactInjectionBehaviorRubric, injectionEssentialBlock, injectionOptionalFields, lowPlayerStanding, referenceBlock, truncateInjectionText } from './core-injection-parts.js';

export { buildBehaviorGuidance, scoreNpcRelevance, selectRelevantNpcs, DEFAULT_INJECTION_BUDGET_TOKENS, MIN_INJECTION_BUDGET_TOKENS, MAX_INJECTION_BUDGET_TOKENS, normalizeInjectionBudgetTokens, estimateInjectionTokens } from './core-injection-selection.js';

export function buildInjection(npcs, text, turn = 0, limit = 3, behaviorCriteria = DEFAULT_BEHAVIOR_CRITERIA, budgetTokens = DEFAULT_INJECTION_BUDGET_TOKENS, socialGraph = null, { includeAppearance = false, namedNpcIds = [], customFieldNames = [], sceneDeferred = false, awayNotes = null, gearLines = null } = {}) {
    const named = new Set(Array.isArray(namedNpcIds) ? namedNpcIds : []);
    const calledIn = npc => !npc?.present && named.has(npc?.id);
    const present = (npcs || []).filter(npc => (Boolean(npc?.present) || calledIn(npc)) && !npc?.archived);
    let relevant = selectRelevantNpcs(present, text, turn, limit, socialGraph, npcs || []);
    const budget = normalizeInjectionBudgetTokens(budgetTokens);
    const budgetChars = budget * APPROX_CHARS_PER_TOKEN;
    if (!relevant.length) {
        const references = referenceBlock(npcs || [], text, new Set(), customFieldNames);
        return references ? truncateInjectionText(['NPC STATE DELTA DOSSIER. Treat these as established story facts; never mention the dossier.', references].join('\n'), budgetChars) : '';
    }
    const headerFor = () => [
        'NPC STATE DELTA DOSSIER. Only confirmed-present NPCs; established facts; never mention it or any numeric value.',
        'Personality sets identity; behavior profile, speech and mannerisms shape response and expression; goals, duties, morals, bonds and CURRENT mood/status decide behavior. Keep each Speech\'s wording, cadence and habits; do not flatten distinct voices.',
        'Player relationship only biases openness and attention; high scores never mean obedience, clinginess, jealousy, tsundere behavior or cruelty to others. Mood or player-specific behavior is not identity; durable identity changes gradually unless a time skip.',
        relevant.some(lowPlayerStanding) && 'LOW SCORES: the player is not special to them; no obligation, fixation or "only them" thinking.',
        relevant.some(calledIn) && 'Exception: NPCs marked "named by player" are not yet confirmed on-screen; use their dossier if they appear.',
    ].filter(Boolean).join('\n');

    let header = headerFor();

    // Identity and agency are structural, not optional enrichment. Drop lower-ranked NPCs before
    // sacrificing the top NPC's personality/voice/mannerisms or non-player goals and bonds.
    // Section caps grow with the budget above the 1800-token base, so raising the
    // budget lets a rich dossier arrive whole; tight budgets still shrink them below.
    const capScale = Math.min(3.6, Math.max(1, budget / INJECTION_CAP_BASE_TOKENS));
    let behaviorCap = Math.round(Math.min(320, 160 * capScale));
    let identityCap = Math.round(Math.min(2200, 620 * capScale));
    let agencyCap = Math.round(Math.min(900, 300 * capScale));
    let stateCap = Math.round(Math.min(400, 180 * capScale));
    // A key person who just came back (Story Director's key people) brings a short "while away" summary, once, with
    // their block; it counts in the budget like the block. Without notes the text is exactly as before.
    const awayNote = npc => {
        const note = awayNotes && typeof awayNotes === 'object' ? cleanText(awayNotes[npc.id], 400) : '';
        return note ? `; ${note}` : '';
    };
    // A pack cast member's signature gear line (Story Block's packs.castGear), as given, at the end of their block; none, nothing.
    const gearNote = npc => {
        const line = gearLines && typeof gearLines === 'object' ? cleanText(gearLines[npc.id], 300) : '';
        return line ? `; ${line}` : '';
    };
    const renderEssentials = () => relevant.map(npc => {
        const block = injectionEssentialBlock(npc, behaviorCap, identityCap, agencyCap, stateCap, customFieldNames, sceneDeferred) + awayNote(npc) + gearNote(npc);
        return calledIn(npc) ? block.replace(`- ${npc.name}: `, `- ${npc.name} (named by player): `) : block;
    });
    while (relevant.length > 1 && (header.length + 1 + renderEssentials().join('\n').length) > budgetChars) {
        relevant = relevant.slice(0, -1);
    }
    header = headerFor();
    let essentialBlocks = renderEssentials();
    while ((header.length + 1 + essentialBlocks.join('\n').length) > budgetChars
        && (behaviorCap > 80 || identityCap > 260 || agencyCap > 140 || stateCap > 100)) {
        behaviorCap = Math.max(80, behaviorCap - 20);
        identityCap = Math.max(260, identityCap - 50);
        agencyCap = Math.max(140, agencyCap - 30);
        stateCap = Math.max(100, stateCap - 20);
        essentialBlocks = renderEssentials();
    }

    let lines = [header, ...essentialBlocks];
    let currentLength = lines.join('\n').length;
    if (currentLength > budgetChars) {
        // The minimum-budget last resort keeps the priority order: header -> identity/agency ->
        // relationship expression. Because every identity field is compacted independently,
        // this no longer silently starves Speech/Mannerisms behind a long Personality field.
        return truncateInjectionText(lines.join('\n'), budgetChars);
    }

    // Relationship rubric is useful, but subordinate to the actual NPC. Stock wording is compiled
    // to a tiny semantic rubric; custom user criteria are retained only as space permits.
    const rubricAllowance = Math.min(600, Math.max(100, Math.floor(budgetChars * 0.08)));
    const rubricText = compactInjectionBehaviorRubric(behaviorCriteria, rubricAllowance);
    if (rubricText) {
        const fullRubric = `RELATIONSHIP-TO-BEHAVIOR RUBRIC: ${rubricText}`;
        const room = budgetChars - currentLength - 1;
        if (room >= 90) {
            lines.push(truncateInjectionText(fullRubric, room));
            currentLength = lines.join('\n').length;
        }
    }

    // Mentioned and deceased references outrank optional enrichment but never the injected cast's
    // essentials; NPCs dropped from the cast for budget may still get their one line.
    const referenceText = (() => {
        const block = referenceBlock(npcs || [], text, new Set(relevant.map(npc => npc.id)), customFieldNames);
        const room = budgetChars - currentLength - 1;
        return block && room >= 80 ? truncateInjectionText(block, room) : '';
    })();
    if (referenceText) currentLength += referenceText.length + 1;

    // Optional continuity then fills remaining room round-robin so one verbose dossier cannot
    // starve another. Relationship summary is deliberately late: live identity/state already won priority.
    // Resolved appearance uses the same optional budget as other continuity. It must not
    // shrink the essential identity/agency budget or be spliced ahead of characterization.
    const optionalByNpc = relevant.map(npc => injectionOptionalFields(npc, includeAppearance, sceneDeferred));
    const enriched = essentialBlocks.slice();
    const maxPriority = Math.max(0, ...optionalByNpc.map(fields => fields.length));
    for (let priority = 0; priority < maxPriority; priority++) {
        // Appearance variants are placed in two passes: every NPC first gets its most compact
        // anatomy (physical features, or a clause-bounded cut), then full appearances replace them
        // while room remains, so one long outfit cannot crowd out another NPC's anatomy.
        const chosen = relevant.map(() => '');
        for (let i = 0; i < relevant.length; i++) {
            const field = optionalByNpc[i][priority];
            if (!field) continue;
            const variants = Array.isArray(field) ? field : [field];
            const compact = variants[variants.length - 1];
            let pick = (currentLength + 2 + compact.length) <= budgetChars ? compact : '';
            if (!pick && Array.isArray(field)) pick = clauseBoundedInjection(compact, budgetChars - currentLength - 2);
            if (!pick) continue;
            chosen[i] = pick;
            currentLength += pick.length + 2;
        }
        for (let i = 0; i < relevant.length; i++) {
            const field = optionalByNpc[i][priority];
            if (!Array.isArray(field) || !chosen[i]) continue;
            const upgrade = field.find(variant => variant.length > chosen[i].length && (currentLength - chosen[i].length + variant.length) <= budgetChars);
            if (!upgrade) continue;
            currentLength += upgrade.length - chosen[i].length;
            chosen[i] = upgrade;
        }
        for (let i = 0; i < relevant.length; i++) {
            if (chosen[i]) enriched[i] += `; ${chosen[i]}`;
        }
    }

    // Rebuild with enriched NPC lines while preserving rubric placement.
    const rubricLine = lines.find(line => line.startsWith('RELATIONSHIP-TO-BEHAVIOR RUBRIC:')) || '';
    const finalLines = [header, ...enriched, referenceText, rubricLine].filter(Boolean);
    return truncateInjectionText(finalLines.join('\n'), budgetChars);
}
