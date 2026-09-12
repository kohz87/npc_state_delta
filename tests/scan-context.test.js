import test from 'node:test';
import assert from 'node:assert/strict';
import { backfillNeedsRequest } from '../scan-context.js';

test('backfill eligibility follows the live active roster and rejects stale archives', () => {
    const active = { id: 'npc-a', name: 'Astra', archived: false };
    const archived = { id: 'npc-b', name: 'Mirel', archived: true };
    assert.equal(backfillNeedsRequest(active, [active, archived], ''), true);
    assert.equal(backfillNeedsRequest(archived, [active, archived], ''), false);
    assert.equal(backfillNeedsRequest({ ...active }, [], ''), false);
    assert.equal(backfillNeedsRequest(null, [active], ''), false);
});
