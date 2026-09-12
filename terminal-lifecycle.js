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

export function manualLifeStateRecord(npc = {}, requested = 'unknown', now = Date.now()) {
    const next = structuredClone(npc || {});
    const choice = ['alive', 'unknown', 'deceased'].includes(requested) ? requested : 'unknown';
    if (choice === 'deceased') {
        next.lifeState = 'deceased';
        next.lifeStateCertainty = 'explicit';
        next.lifeStateReason = 'Manually marked deceased by the user in the dossier editor.';
        next.present = false;
        next.worldActive = false;
        next.archived = true;
        next.archiveReason = 'deceased';
        next.archivedAt = Number(now) || Date.now();
        next.archiveSourceMessageId = null;
        return next;
    }

    next.lifeState = choice;
    next.lifeStateCertainty = choice === 'alive' ? 'explicit' : '';
    next.lifeStateReason = choice === 'alive'
        ? 'Manually confirmed alive by the user in the dossier editor.'
        : '';
    if (String(next.archiveReason || '').trim().toLowerCase() === 'deceased') {
        next.archived = false;
        next.archiveReason = '';
        next.archivedAt = null;
        next.archiveSourceMessageId = null;
    }
    return next;
}
