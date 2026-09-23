import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AUTOMATIC_BACKFILL_QUEUE_VERSION,
    automaticBackfillStillRelevant,
    backfillNeedsRequest,
    normalizeAutomaticBackfillRequest,
    npcParticipatesInExchange,
} from '../scan-context.js';

test('backfill eligibility follows the live active roster and rejects stale archives', () => {
    const active = { id: 'npc-a', name: 'Astra', archived: false };
    const archived = { id: 'npc-b', name: 'Mirel', archived: true };
    assert.equal(backfillNeedsRequest(active, [active, archived], ''), true);
    assert.equal(backfillNeedsRequest(archived, [active, archived], ''), false);
    assert.equal(backfillNeedsRequest({ ...active }, [], ''), false);
    assert.equal(backfillNeedsRequest(null, [active], ''), false);
});


test('current-exchange participation uses unique names/aliases/roles without false first-name matches', () => {
    const astra = { id: 'a', name: 'Astra Vale', aliases: ['Registrar Vale'], role: 'guild registrar' };
    const other = { id: 'b', name: 'Astra Karr', aliases: [], role: 'guard' };
    assert.equal(npcParticipatesInExchange(astra, [astra], 'Astra signs the ledger.'), true);
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'Astra signs the ledger.'), false);
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'Registrar Vale signs the ledger.'), true);
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'The guild registrar signs the ledger.'), true);
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'The guild registrar signs the ledger.', { includeRole: false }), false, 'automatic repair can require an explicit name/alias rather than a generic role');
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'The guard leaves.'), false);
    assert.equal(npcParticipatesInExchange(astra, [astra, other], '<World_State>NPCs Present: Astra Vale; Astra Karr</World_State>'), false, 'World State roster mentions alone are not participation');
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'NPCs Present: Astra Vale; Astra Karr'), false, 'plain roster/status lines alone are not participation');
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'NPC Status: Astra Vale | present'), false, 'plain NPC status lines alone are not participation');
    assert.equal(npcParticipatesInExchange(astra, [astra, other], '<details><summary>World State</summary>Astra Vale | present</details>'), false, 'World State details alone are not participation');
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'Astra Vale signs the ledger. World State: Astra Karr | gate watch'), true, 'narrative participation before structured state still counts');
});

test('automatic backfill queue rejects legacy unscoped backlog and preserves only current reasoned requests', () => {
    assert.equal(normalizeAutomaticBackfillRequest({ npcId: 'npc-a', label: 'Astra' }), null, 'pre-versioned persisted queue entries must not survive hydration');
    assert.equal(normalizeAutomaticBackfillRequest({ queueVersion: 0, reason: 'missed-participant', npcId: 'npc-a', label: 'Astra' }), null);
    assert.equal(normalizeAutomaticBackfillRequest({ queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION, reason: 'legacy-cast-sweep', npcId: 'npc-a', label: 'Astra' }), null);
    const normalized = normalizeAutomaticBackfillRequest({
        queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION,
        reason: 'new-admission',
        npcId: 'npc-a',
        label: 'Astra',
        requestedMessageId: 42,
        preserveLiveState: true,
        silent: true,
        attempts: 1,
    });
    assert.equal(normalized?.reason, 'new-admission');
    assert.equal(normalized?.requestedMessageId, 42);
    assert.equal(normalized?.preserveLiveState, true);
});

test('automatic missed-participant repair is revalidated against its owning narrative exchange before dispatch', () => {
    const astra = { id: 'npc-a', name: 'Astra Vale', aliases: [], archived: false };
    const mirel = { id: 'npc-b', name: 'Mirel', aliases: [], archived: false };
    const request = {
        queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION,
        reason: 'missed-participant',
        npcId: astra.id,
        label: astra.name,
        requestedMessageId: 12,
    };
    assert.equal(
        automaticBackfillStillRelevant(request, astra, [astra, mirel], '<World_State>NPCs Present: Astra Vale; Mirel</World_State>'),
        false,
        'structured roster membership alone must not revive an automatic backfill',
    );
    assert.equal(
        automaticBackfillStillRelevant(request, astra, [astra, mirel], 'Astra Vale closes the ledger and answers the player.'),
        true,
        'the owning exchange can still authorize a real omitted-participant repair',
    );
    assert.equal(
        automaticBackfillStillRelevant({ ...request, reason: 'new-admission' }, astra, [astra, mirel], ''),
        true,
        'a current-version new-admission request remains eligible without pretending it is narrative participant repair',
    );
});
