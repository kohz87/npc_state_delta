/* NPC State Delta terminal lifecycle helpers. */
import { normalizeLifeState } from './core-mechanics.js';

export function isTerminalNpcDeath(npc = {}) {
    return npc?.archiveReason === 'deceased'
        || (normalizeLifeState(npc?.lifeState) === 'deceased'
            && String(npc?.lifeStateCertainty || '').trim().toLowerCase() === 'explicit');
}

export function normalizeTerminalNpc(npc = {}) {
    const next = { ...npc };
    if (next.archiveReason === 'deceased') {
        next.archived = true;
        next.lifeState = 'deceased';
        next.lifeStateCertainty = 'explicit';
    }
    if (isTerminalNpcDeath(next)) {
        next.present = false;
        next.worldActive = false;
    }
    return next;
}

export function protectTerminalNpc(previous = {}, candidate = {}) {
    if (!isTerminalNpcDeath(previous)) return normalizeTerminalNpc(candidate);
    const deathArchived = previous.archiveReason === 'deceased';
    const next = {
        ...candidate,
        lifeState: 'deceased',
        lifeStateCertainty: 'explicit',
        lifeStateReason: previous.lifeStateReason || candidate.lifeStateReason || '',
        archived: deathArchived ? true : Boolean(previous.archived),
        archiveReason: deathArchived ? 'deceased' : String(previous.archiveReason || ''),
        archivedAt: previous.archivedAt ?? null,
        archiveSourceMessageId: previous.archiveSourceMessageId ?? null,
        present: false,
        worldActive: false,
    };

    // Post-death narration may recover durable facts, but it cannot advance live state or the
    // dead NPC's relationship as though they participated in a later scene.
    for (const field of [
        'mood', 'location', 'goal', 'status',
        'relationship', 'relationshipProgress', 'relationshipMilestones',
        'relationshipEventHistory', 'lastRelationshipChange', 'relationshipSummary',
        'seenCount', 'lastSeenTurn', 'lastWorldActiveTurn',
    ]) {
        if (Object.prototype.hasOwnProperty.call(previous, field)) next[field] = structuredClone(previous[field]);
    }
    return normalizeTerminalNpc(next);
}
