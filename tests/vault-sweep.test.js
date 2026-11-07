// Old dossier checkpoint clean-up (vault-sweep.js): a dry-run plan counts storage, protects every referenced checkpoint, keeps files inside the
// 30-day grace, and refuses deletion when the reference scan is incomplete. The sweep is one-shot and removes only the planned candidates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KEEP_NEWER_THAN_MS, createVaultSweep } from '../src/storysuite-participant/vault-sweep.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

function fakeVault(files = []) {
    const calls = [];
    return {
        files,
        calls,
        listError: null,
        removeError: null,
        refuse: new Set(),
        async list() {
            if (this.listError) throw this.listError;
            return this.files;
        },
        async remove(id) {
            calls.push(id);
            if (this.removeError && this.removeError.has(id)) throw new Error(`could not remove ${id}`);
            if (this.refuse.has(id)) return false;
            return true;
        },
    };
}

const file = (id, ageMs, size = 1024) => ({ id, size, modifiedAt: NOW - ageMs });

test('plan is a dry run: it lists only unreferenced checkpoint files strictly older than the 30-day grace', async () => {
    const vault = fakeVault([
        file('nk_free0001', 31 * DAY, 2048),
        file('nk_free0002', 30 * DAY + 1, 512),
        file('nk_young001', 30 * DAY, 4096),
        file('nk_young002', 29 * DAY, 8192),
    ]);
    const sweep = createVaultSweep({ vault, now: () => NOW });

    const plan = await sweep.plan({ referenced: [], complete: true });

    assert.equal(plan.ok, true);
    assert.equal(plan.complete, true);
    assert.equal(plan.canSweep, true);
    assert.deepEqual(plan.candidates.map(item => item.id), ['nk_free0001', 'nk_free0002']);
    assert.equal(plan.count, 2);
    assert.equal(plan.bytes, 2560);
    assert.equal(plan.totalFiles, 4);
    assert.equal(plan.totalBytes, 2048 + 512 + 4096 + 8192);
    assert.equal(plan.keepNewerThanMs, DEFAULT_KEEP_NEWER_THAN_MS);
    assert.deepEqual(vault.calls, [], 'a plan never deletes');
});

test('a checkpoint referenced only by another chat, a lineage index or a save point is never a candidate', async () => {
    const vault = fakeVault([
        file('nk_chat0001', 60 * DAY),
        file('nk_index001', 60 * DAY),
        file('nk_save0001', 60 * DAY),
        file('nk_free0001', 60 * DAY),
    ]);
    const referenced = {
        chats: ['nk_chat0001'],
        lineageIndexes: {
            acks: ['nk_index001'],
            prepared: [],
            returns: [],
            selected: null,
            base: null,
        },
        savePoints: [{ checkpoint: 'nk_save0001' }],
    };
    const sweep = createVaultSweep({ vault, now: () => NOW });

    const plan = await sweep.plan({ referenced, complete: true });
    assert.deepEqual(plan.candidates.map(item => item.id), ['nk_free0001']);

    const result = await sweep.sweep();
    assert.deepEqual(result.deleted, ['nk_free0001']);
    assert.deepEqual(vault.calls, ['nk_free0001']);
});

test('the default grace is 30 days and the boundary is strict; a caller may request a different grace', async () => {
    assert.equal(DEFAULT_KEEP_NEWER_THAN_MS, 30 * DAY);
    const vault = fakeVault([
        file('nk_at30days', 30 * DAY),
        file('nk_older001', 30 * DAY + 1),
        file('nk_at10000s', 10_000),
        file('nk_older100', 10_001),
    ]);
    const sweep = createVaultSweep({ vault, now: () => NOW });

    const defaultPlan = await sweep.plan({ referenced: [], complete: true });
    assert.deepEqual(defaultPlan.candidates.map(item => item.id), ['nk_older001']);

    const shortPlan = await sweep.plan({ referenced: [], complete: true, keepNewerThanMs: 10_000 });
    assert.deepEqual(shortPlan.candidates.map(item => item.id), ['nk_older001', 'nk_at30days', 'nk_older100']);
});

test('an incomplete reference scan disables clean-up, reports storage totals, and sweep deletes nothing', async () => {
    const vault = fakeVault([file('nk_free0001', 60 * DAY, 1234), file('nk_free0002', 60 * DAY, 2345)]);
    const sweep = createVaultSweep({ vault, now: () => NOW });

    const plan = await sweep.plan({ referenced: [], complete: false });
    assert.equal(plan.ok, false);
    assert.equal(plan.complete, false);
    assert.equal(plan.canSweep, false);
    assert.equal(plan.code, 'INCOMPLETE');
    assert.equal(plan.totalFiles, 2);
    assert.equal(plan.totalBytes, 3579);
    assert.deepEqual(plan.candidates, []);

    const result = await sweep.sweep();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INCOMPLETE');
    assert.deepEqual(result.deleted ?? [], []);
    assert.deepEqual(vault.calls, []);
});

test('a complete plan without a verified reference set refuses to delete', async () => {
    const vault = fakeVault([file('nk_orphan01', 60 * DAY)]);
    const sweep = createVaultSweep({ vault, now: () => NOW });

    const plan = await sweep.plan({ complete: true });
    assert.equal(plan.code, 'REFERENCES_REQUIRED');
    assert.deepEqual(plan.candidates, []);
    assert.equal((await sweep.sweep()).code, 'REFERENCES_REQUIRED');
    assert.deepEqual(vault.calls, []);
});

test('sweep executes exactly the last complete plan once and reports its count and size', async () => {
    const vault = fakeVault([
        file('nk_free0001', 45 * DAY, 700),
        file('nk_free0002', 40 * DAY, 300),
        file('nk_young001', 1 * DAY, 900),
    ]);
    const sweep = createVaultSweep({ vault, now: () => NOW });
    await sweep.plan({ referenced: [], complete: true });

    const first = await sweep.sweep();
    assert.equal(first.ok, true);
    assert.deepEqual(first.deleted, ['nk_free0001', 'nk_free0002']);
    assert.equal(first.count, 2);
    assert.equal(first.bytes, 1000);
    assert.deepEqual(vault.calls, ['nk_free0001', 'nk_free0002']);

    const second = await sweep.sweep();
    assert.equal(second.code, 'NO_COMPLETE_PLAN');
    assert.deepEqual(second.deleted ?? [], []);
    assert.deepEqual(vault.calls, ['nk_free0001', 'nk_free0002'], 'the plan is consumed');
});

test('a newer check replaces an older plan, so stale candidates are not deleted', async () => {
    const vault = fakeVault([file('nk_first001', 60 * DAY)]);
    const sweep = createVaultSweep({ vault, now: () => NOW });
    await sweep.plan({ referenced: [], complete: true });
    vault.files = [file('nk_second01', 60 * DAY)];

    await sweep.plan({ referenced: [], complete: true });
    const result = await sweep.sweep();
    assert.deepEqual(result.deleted, ['nk_second01']);
    assert.deepEqual(vault.calls, ['nk_second01']);
});

test('an unreadable vault or malformed file list refuses clean-up instead of guessing', async () => {
    const unreadable = fakeVault();
    unreadable.listError = new Error('offline');
    const first = createVaultSweep({ vault: unreadable, now: () => NOW });
    const firstPlan = await first.plan({ referenced: [], complete: true });
    assert.equal(firstPlan.code, 'VAULT_UNREADABLE');
    assert.equal((await first.sweep()).code, 'VAULT_UNREADABLE');
    assert.deepEqual(unreadable.calls, []);

    const malformed = fakeVault();
    malformed.list = async () => ({ nope: true });
    const second = createVaultSweep({ vault: malformed, now: () => NOW });
    assert.equal((await second.plan({ referenced: [], complete: true })).code, 'VAULT_UNREADABLE');
    assert.equal((await second.sweep()).code, 'VAULT_UNREADABLE');
});

test('invalid ids and timestamps are ignored, duplicate listings keep the youngest proof, and a failed removal is reported', async () => {
    const vault = fakeVault([
        { id: '../../old.json', size: 999, modifiedAt: NOW - 60 * DAY },
        { id: 'nk_notold01', size: 50, modifiedAt: 'not a date' },
        file('nk_dupe0001', 60 * DAY, 100),
        file('nk_dupe0001', 5 * DAY, 100),
    ]);
    const sweep = createVaultSweep({ vault, now: () => NOW });

    const plan = await sweep.plan({ referenced: [], complete: true });
    assert.deepEqual(plan.candidates.map(item => item.id), []);
    assert.equal(plan.totalFiles, 2, 'only checkpoint-shaped ids are listed');

    const thirdVault = fakeVault([
        file('nk_remove01', 60 * DAY, 200),
        file('nk_remove02', 60 * DAY, 300),
        file('nk_okay0001', 60 * DAY, 400),
    ]);
    thirdVault.removeError = new Set(['nk_remove01']);
    thirdVault.refuse.add('nk_remove02');
    const third = createVaultSweep({ vault: thirdVault, now: () => NOW });
    await third.plan({ referenced: [], complete: true });
    const result = await third.sweep();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PARTIAL_REMOVAL');
    assert.deepEqual(result.deleted, ['nk_okay0001']);
    assert.deepEqual(result.skipped, ['nk_remove02']);
    assert.deepEqual(result.failed.map(item => item.id), ['nk_remove01']);
});
