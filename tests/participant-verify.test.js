// `verify({ checkpoint, hash })`: the checks of `prepare` with nothing installed, written, minted or recorded. The host's nearest-checkpoint
// fallback asks it of each candidate; it must give the answer `prepare` would give, and leave the participant exactly as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashJson } from '../src/storysuite-participant/hash.js';
import { keep, makeDelta, npc } from './helpers/p24-port.js';

const LINE = 'lg_lineone1';
const lined = { npcs: [npc('npc_a', 'Mira')], timeline: { v: 1, lineage: LINE } };

async function started(options = {}) {
    const r = makeDelta({ state: lined, ...options });
    await r.delta.hydrate();
    return r;
}
const snapshot = r => JSON.stringify([hashJson(r.live.state), r.delta.index(), [...r.vault.docs.keys()].sort(), [...r.vault.indexes.keys()].sort(), r.writes]);

test('verify accepts a good checkpoint of this line and changes nothing', async () => {
    const r = await started();
    const cp = await keep(r.vault, LINE, { npcs: [npc('npc_a', 'Mira')] });
    const before = snapshot(r);
    const out = await r.delta.participant.verify({ checkpoint: cp.id, hash: cp.hash });
    assert.deepEqual(out, { ok: true, checkpoint: cp.id, hash: cp.hash });
    assert.equal(snapshot(r), before, 'no state, index, vault or write changed');
});

test('verify gives the failure prepare gives: missing, wrong hash, another line, malformed input', async () => {
    const r = await started();
    const good = await keep(r.vault, LINE, { npcs: [] });
    const other = await keep(r.vault, 'lg_othrline', { npcs: [] });
    const cases = [
        ['missing', { checkpoint: 'nk_gone0001', hash: good.hash }, 'SNAPSHOT_UNAVAILABLE'],
        ['wrong hash', { checkpoint: good.id, hash: 'f'.repeat(64) }, 'CONFLICT'],
        ['another line', { checkpoint: other.id, hash: other.hash }, 'CONFLICT'],
    ];
    for (const [name, input, code] of cases) {
        const before = snapshot(r);
        const verified = await r.delta.participant.verify(input);
        assert.equal(verified.code, code, name);
        assert.equal(snapshot(r), before, `${name}: nothing changed`);
        const prepared = await r.delta.participant.prepare({ return: `rt_${name.replace(/\W/g, '')}`, ...input });
        assert.equal(prepared.code, verified.code, `${name}: prepare agrees`);
    }
    assert.equal((await r.delta.participant.verify({ checkpoint: 5 })).code, 'INVALID');
    assert.equal((await r.delta.participant.verify(null)).code, 'INVALID');
});

test('verify on a branch with no line yet mints, writes and records nothing; a populated one is still held to its line', async () => {
    const empty = makeDelta({ state: { npcs: [] } });
    const cp = await keep(empty.vault, 'lg_fromjrnl', { npcs: [npc('npc_a', 'Mira')] });
    const before = snapshot(empty);
    assert.equal((await empty.delta.participant.verify({ checkpoint: cp.id, hash: cp.hash })).ok, true, 'it would be adopted');
    assert.equal(snapshot(empty), before);
    assert.equal(empty.writes.timeline + empty.writes.install, 0);
    assert.equal(empty.delta.index(), null, 'no session was made');

    const full = makeDelta({ state: { npcs: [npc('npc_a', 'Mira')] } });
    const cp2 = await keep(full.vault, 'lg_fromjrnl', { npcs: [] });
    assert.equal((await full.delta.participant.verify({ checkpoint: cp2.id, hash: cp2.hash })).code, 'CONFLICT');
    assert.equal(full.writes.timeline + full.writes.install, 0);
});

test('verify says retryably when the chat is not loaded yet, and writes nothing', async () => {
    const r = makeDelta({ state: lined, extra: { ready: () => false, load: async () => {}, loading: () => false } });
    const cp = await keep(r.vault, LINE, { npcs: [] });
    const out = await r.delta.participant.verify({ checkpoint: cp.id, hash: cp.hash });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'FAILED');
    assert.equal(r.writes.timeline + r.writes.install, 0);
});
