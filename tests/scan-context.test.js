import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillNeedsRequest, npcParticipatesInExchange } from '../scan-context.js';

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
    assert.equal(npcParticipatesInExchange(astra, [astra, other], 'The guard leaves.'), false);
});
