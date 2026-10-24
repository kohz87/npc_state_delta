// The timeline participant (src/storysuite-participant/, contract §8): identity, checkpoints, the callbacks, confirmed deaths, the vault.
// Pure over a memory port and a memory vault; the host-level tests are in storysuite-participant-host.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NP_ID, buildCheckpoint, checkpointIdOf, checkpointProblem, createParticipant, hydrateIdentity, memoryVault, resolveIdentity } from '../src/storysuite-participant/index.js';
import { hashJson, sha256 } from '../src/storysuite-participant/hash.js';
import { fileVault } from '../src/storysuite-participant/vault.js';
import { isTerminalNpcDeath } from '../terminal-lifecycle.js';

const npc = (id, name, extra = {}) => ({ id, name, aliases: [], archived: false, present: true, lifeState: 'alive', trust: 3, ...extra });
const freshState = () => ({
    npcs: [npc('npc_mira', 'Mira', { aliases: ['The Weaver'] }), npc('npc_tom', 'Old Tom')],
    socialGraph: { edges: [{ a: 'npc_mira', b: 'npc_tom', kind: 'friends' }] },
    checkpoints: [{ messageId: 3, snapshot: { npcs: [] } }], lineage: [{ id: 1 }], turn: 4,
});

function setup({ state = freshState(), chatKey = 'chat:avatar.png:one' } = {}) {
    const live = { state, installs: 0, chatKey };
    const port = {
        chatKey: () => live.chatKey,
        readState: () => structuredClone(live.state),
        installState: async next => { live.installs += 1; live.state = structuredClone(next); },
    };
    const vault = memoryVault();
    let tick = 1000;
    const made = createParticipant({ port, vault, now: () => (tick += 1) });
    return { live, port, vault, ...made };
}

test('the hash is the platform\'s SHA-256 of the normalized JSON, and a checkpoint is named by it', () => {
    for (const text of ['', 'abc', 'a'.repeat(64), 'é☃🙂'.repeat(30)]) assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
    assert.equal(hashJson({ b: 1, a: [2, { d: 1, c: 2 }] }), sha256('{"a":[2,{"c":2,"d":1}],"b":1}'));
    const hash = sha256('x');
    assert.match(checkpointIdOf(hash), /^nk_[0-9a-z]{8}$/);
    assert.equal(checkpointIdOf(hash), checkpointIdOf(hash));
});

test('identity: every dossier gets one np_, in dossier order, stable through a rename and an alias change; the ids are chat-bound and never reused', () => {
    const state = freshState();
    const first = hydrateIdentity(null, state.npcs, { chatKey: 'chat:a' });
    assert.equal(first.assigned.length, 2);
    assert.ok(first.assigned.every(id => NP_ID.test(id)));
    const mira = first.identity.byKey.npc_mira;
    // A rename and a new alias change nothing about the pair.
    state.npcs[0].name = 'Mira of the Marsh';
    state.npcs[0].aliases.push('Marsh-Mira');
    const again = hydrateIdentity(first.identity, state.npcs, { chatKey: 'chat:a', reserved: first.reserved });
    assert.equal(again.changed, false);
    assert.equal(again.identity.byKey.npc_mira, mira);
    // Another chat issues other ids for the same dossiers.
    assert.notEqual(hydrateIdentity(null, freshState().npcs, { chatKey: 'chat:b' }).identity.byKey.npc_mira, mira);
    // A deleted dossier's pair is archived; a new dossier of the same key later gets a new id, never the old.
    const gone = hydrateIdentity(first.identity, [state.npcs[1]], { chatKey: 'chat:a', reserved: first.reserved });
    assert.deepEqual(gone.archived, [mira]);
    assert.equal(gone.identity.map[mira].archived, true);
    const back = hydrateIdentity(gone.identity, state.npcs, { chatKey: 'chat:a', reserved: gone.reserved });
    assert.notEqual(back.identity.byKey.npc_mira, mira);
    assert.equal(back.identity.map[mira].archived, true);
});

test('npc.identity: by id the active dossier\'s { id, nativeKey, name }; by name, alias or key only when one dossier answers; null for the rest, nothing created', () => {
    const state = freshState();
    state.npcs.push(npc('npc_wren_2', 'Wren'), npc('npc_wren', 'Wren'));
    const { identity } = hydrateIdentity(null, state.npcs, { chatKey: 'chat:a' });
    const ask = args => resolveIdentity(identity, state.npcs, args);
    const mira = identity.byKey.npc_mira;
    assert.deepEqual(ask({ id: mira }), { id: mira, nativeKey: 'npc_mira', name: 'Mira' });
    assert.deepEqual(ask({ name: 'the weaver' }), { id: mira, nativeKey: 'npc_mira', name: 'Mira' }, 'an alias, any case');
    assert.equal(ask({ name: 'MIRA' }).id, mira);
    assert.equal(ask({ name: 'npc_tom' }).id, identity.byKey.npc_tom, 'the native key');
    assert.equal(ask({ name: 'Wren' }), null, 'two dossiers answer to it: ambiguous');
    assert.equal(ask({ name: 'Nobody' }), null);
    assert.equal(ask({ id: 'np_zzzzzzzz' }), null);
    assert.equal(ask({ id: 'npc_mira' }), null, 'a native key is not an np_ id');
    assert.equal(ask({ id: mira, name: 'Mira' }), null, 'exactly one selector');
    assert.equal(ask({}), null);
    assert.equal(ask(null), null);
    assert.equal(ask({ id: 5 }), null);
    assert.equal(ask({ name: '   ' }), null);
    // A renamed person is found by the new name and still by the id.
    state.npcs[0].name = 'Mira Vane';
    assert.equal(ask({ id: mira }).name, 'Mira Vane');
    assert.equal(ask({ name: 'mira vane' }).id, mira);
    // The 80-character name cap.
    state.npcs[1].name = 'x'.repeat(200);
    assert.equal(ask({ id: identity.byKey.npc_tom }).name.length, 80);
    // Archived pairs do not resolve.
    const archived = hydrateIdentity(identity, state.npcs.slice(1), { chatKey: 'chat:a' }).identity;
    assert.equal(resolveIdentity(archived, state.npcs.slice(1), { id: mira }), null);
});

test('a checkpoint is the whole native state with the identity map and the applied deaths, named by its hash; altered bytes are named', () => {
    const { identity } = hydrateIdentity(null, freshState().npcs, { chatKey: 'chat:a' });
    const built = buildCheckpoint({ chatKey: 'chat:a', state: freshState(), identity, applied: { ev_one: { nativeKey: 'npc_tom', at: 5 } }, cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    assert.deepEqual(Object.keys(built.doc), ['schema', 'kind', 'chatKey', 'cursor', 'headHash', 'state', 'identity', 'applied']);
    assert.equal(built.doc.state.socialGraph.edges.length, 1, 'the relationship map');
    assert.equal(built.doc.state.checkpoints.length, 1, 'its own history');
    assert.equal(checkpointProblem(built.doc, built.hash), '');
    const altered = structuredClone(built.doc);
    altered.state.npcs[0].trust = 99;
    assert.match(checkpointProblem(altered, built.hash), /do not hash/);
    assert.match(checkpointProblem({ ...built.doc, schema: 9 }, built.hash), /newer/);
    assert.match(checkpointProblem({ ...built.doc, kind: 'other' }, built.hash), /not a native checkpoint/);
    assert.match(checkpointProblem(null, built.hash), /not a native/);
    // The same native state at the same head is the same checkpoint; another head is another.
    assert.equal(buildCheckpoint({ chatKey: 'chat:a', state: freshState(), identity, applied: { ev_one: { nativeKey: 'npc_tom', at: 5 } }, cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) }).id, built.id);
    assert.notEqual(buildCheckpoint({ chatKey: 'chat:a', state: freshState(), identity, applied: {}, cursor: { sid: 'sr_1' }, headHash: 'b'.repeat(64) }).id, built.id);
});

test('checkpoint -> prepare -> activate: state, map and deaths come back together, once; the same calls again change nothing', async () => {
    const { participant, live, hydrate } = setup();
    await hydrate();
    const saved = await participant.checkpoint({ cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    assert.deepEqual([saved.ok, saved.schema, /^nk_/.test(saved.checkpoint)], [true, 1, true]);
    // The story moves on natively: a rename, a new person, a changed relationship.
    live.state.npcs[0].name = 'Someone Else';
    live.state.npcs.push(npc('npc_new', 'Newcomer'));
    live.state.socialGraph.edges.push({ a: 'npc_mira', b: 'npc_new', kind: 'rivals' });
    await hydrate();
    const dead = await participant.checkpoint({ cursor: { sid: 'sr_2' }, headHash: 'b'.repeat(64) });
    assert.notEqual(dead.checkpoint, saved.checkpoint);
    const prepared = await participant.prepare({ return: 'rt_00000001', checkpoint: saved.checkpoint, hash: saved.hash });
    assert.deepEqual([prepared.ok, prepared.hash], [true, saved.hash]);
    assert.equal(live.installs, 0, 'prepare shows nothing');
    assert.deepEqual(await participant.status({ return: 'rt_00000001' }), { ok: true, checkpoint: saved.checkpoint, hash: saved.hash, status: 'prepared' });
    assert.deepEqual(await participant.prepare({ return: 'rt_00000001', checkpoint: saved.checkpoint, hash: saved.hash }), prepared, 'the same prepare answers the same');
    const activated = await participant.activate({ return: 'rt_00000001', prepared: prepared.prepared });
    assert.deepEqual(activated, { ok: true, checkpoint: saved.checkpoint, hash: saved.hash });
    assert.deepEqual([live.installs, live.state.npcs.map(item => item.name), live.state.socialGraph.edges.length], [1, ['Mira', 'Old Tom'], 1]);
    assert.deepEqual(await participant.activate({ return: 'rt_00000001', prepared: prepared.prepared }), activated, 'idempotent');
    assert.equal(live.installs, 1);
    assert.equal((await participant.status({ return: 'rt_00000001' })).status, 'active');
});

test('the np_ map goes back with the dossiers; ids the dead timeline issued stay reserved, inactive, and are not issued again', async () => {
    const { participant, live, hydrate, queries, identity } = setup();
    await hydrate();
    const mira = identity().byKey.npc_mira;
    const saved = await participant.checkpoint({});
    live.state.npcs.push(npc('npc_new', 'Newcomer'));
    await hydrate();
    const newcomer = identity().byKey.npc_new;
    assert.ok(newcomer);
    assert.equal(queries['npc.identity'](null, { id: newcomer }).nativeKey, 'npc_new');
    const prepared = await participant.prepare({ return: 'rt_00000002', checkpoint: saved.checkpoint, hash: saved.hash });
    await participant.activate({ return: 'rt_00000002', prepared: prepared.prepared });
    assert.equal(queries['npc.identity'](null, { id: mira }).nativeKey, 'npc_mira');
    assert.equal(queries['npc.identity'](null, { id: newcomer }), null, 'the dead timeline\'s id resolves through nothing');
    // The same person admitted again gets a different id: the old one is reserved.
    live.state.npcs.push(npc('npc_new', 'Newcomer'));
    await hydrate();
    assert.notEqual(identity().byKey.npc_new, newcomer);
});

test('prepare refuses what it cannot stand behind: gone bytes, other bytes, another chat, a newer schema; a return keeps its checkpoint; abort frees it', async () => {
    const { participant, vault, hydrate, live } = setup();
    await hydrate();
    const saved = await participant.checkpoint({});
    vault.lose(saved.checkpoint);
    assert.equal((await participant.prepare({ return: 'rt_a', checkpoint: saved.checkpoint, hash: saved.hash })).code, 'SNAPSHOT_UNAVAILABLE');
    const again = await participant.checkpoint({});
    assert.equal(again.checkpoint, saved.checkpoint, 'the same state is the same checkpoint again');
    assert.equal((await participant.prepare({ return: 'rt_a', checkpoint: again.checkpoint, hash: 'f'.repeat(64) })).code, 'CONFLICT');
    assert.equal((await participant.prepare({ return: 'rt_a' })).code, 'INVALID');
    const ok = await participant.prepare({ return: 'rt_a', checkpoint: again.checkpoint, hash: again.hash });
    assert.equal(ok.ok, true);
    live.state.npcs[0].trust = 9;
    const other = await participant.checkpoint({});
    assert.equal((await participant.prepare({ return: 'rt_a', checkpoint: other.checkpoint, hash: other.hash })).code, 'CONFLICT', 'a return is for one checkpoint');
    assert.deepEqual(await participant.abort({ return: 'rt_a', prepared: ok.prepared }), { ok: true, aborted: true });
    assert.equal((await participant.status({ return: 'rt_a' })).status, 'aborted');
    assert.equal((await participant.activate({ return: 'rt_a', prepared: ok.prepared })).code, 'NOT_FOUND', 'an aborted preparation is gone');
    assert.deepEqual(await participant.abort({ return: 'rt_a', prepared: ok.prepared }), { ok: true, aborted: true }, 'abort is idempotent');
    assert.equal((await participant.prepare({ return: 'rt_a', checkpoint: other.checkpoint, hash: other.hash })).ok, true, 'and the return may be prepared again');
    assert.equal((await participant.status({ return: 'rt_zzz' })).code, 'NOT_FOUND');
    assert.equal((await participant.activate({ return: 'rt_a', prepared: 'pn_zzzzzzzz' })).code, 'NOT_FOUND');
    // Another chat's checkpoint is not this chat's.
    const foreign = buildCheckpoint({ chatKey: 'chat:elsewhere', state: freshState(), identity: null, applied: {} });
    await vault.put(foreign.id, foreign.doc);
    assert.equal((await participant.prepare({ return: 'rt_b', checkpoint: foreign.id, hash: foreign.hash })).code, 'CONFLICT');
    const future = buildCheckpoint({ chatKey: 'chat:avatar.png:one', state: freshState(), identity: null, applied: {} });
    future.doc.schema = 7;
    await vault.put('nk_future01', future.doc);
    assert.equal((await participant.prepare({ return: 'rt_c', checkpoint: 'nk_future01', hash: hashJson(future.doc) })).code, 'SNAPSHOT_UNAVAILABLE');
});

test('a committed return is not aborted; activate fails whole when the bytes are gone or the install throws, and can be tried again', async () => {
    const { participant, vault, hydrate, live, port } = setup();
    await hydrate();
    const saved = await participant.checkpoint({});
    live.state.npcs[0].trust = 9;
    const prepared = await participant.prepare({ return: 'rt_d', checkpoint: saved.checkpoint, hash: saved.hash });
    vault.lose(saved.checkpoint);
    assert.equal((await participant.activate({ return: 'rt_d', prepared: prepared.prepared })).code, 'SNAPSHOT_UNAVAILABLE');
    assert.equal(live.state.npcs[0].trust, 9, 'nothing was installed');
    const flaky = { ...port, installState: async () => { throw new Error('disk full'); } };
    const second = createParticipant({ port: flaky, vault: memoryVault() });
    await second.hydrate();
    const cp = await second.participant.checkpoint({});
    const pr = await second.participant.prepare({ return: 'rt_e', checkpoint: cp.checkpoint, hash: cp.hash });
    const failed = await second.participant.activate({ return: 'rt_e', prepared: pr.prepared });
    assert.deepEqual([failed.ok, failed.code], [false, 'FAILED']);
    assert.equal((await second.participant.status({ return: 'rt_e' })).status, 'prepared', 'still prepared: it can be tried again');
    // Once committed, it finishes; it is not aborted.
    const sound = setup();
    await sound.hydrate();
    const ck = await sound.participant.checkpoint({});
    const pp = await sound.participant.prepare({ return: 'rt_f', checkpoint: ck.checkpoint, hash: ck.hash });
    await sound.participant.activate({ return: 'rt_f', prepared: pp.prepared });
    assert.equal((await sound.participant.abort({ return: 'rt_f', prepared: pp.prepared })).code, 'REFUSED');
});

test('a confirmed death: the dossier is dead and terminal, the event is applied once, the same event returns its prior ack, another meaning conflicts', async () => {
    const { participant, live, hydrate, index } = setup();
    await hydrate();
    const input = { event: 'ev_death001', nativeKey: 'npc_tom', kind: 'confirmed-death' };
    const ack = await participant.applyEvent(input);
    assert.deepEqual([ack.ok, ack.event, ack.ack, /^nk_/.test(ack.checkpoint)], [true, 'ev_death001', true, true]);
    const tom = live.state.npcs.find(item => item.id === 'npc_tom');
    assert.equal(isTerminalNpcDeath(tom), true);
    assert.deepEqual([tom.lifeState, tom.lifeStateCertainty, tom.present, tom.archived], ['deceased', 'explicit', false, true]);
    assert.match(tom.lifeStateReason, /Confirmed dead by the rules \(event ev_death001\)/);
    assert.equal(isTerminalNpcDeath(live.state.npcs[0]), false, 'nobody else');
    const installs = live.installs;
    assert.deepEqual(await participant.applyEvent(input), ack, 'the same event again is the same ack');
    assert.equal(live.installs, installs, 'and applies nothing again');
    assert.equal((await participant.applyEvent({ ...input, nativeKey: 'npc_mira' })).code, 'CONFLICT');
    assert.equal((await participant.applyEvent({ event: 'ev_death002', nativeKey: 'npc_nobody', kind: 'confirmed-death' })).code, 'NOT_FOUND', 'an unknown native key holds the death');
    assert.equal((await participant.applyEvent({ ...input, event: 'ev_x', kind: 'resurrection' })).code, 'INVALID');
    assert.equal((await participant.applyEvent({ event: '', nativeKey: 'npc_tom', kind: 'confirmed-death' })).code, 'INVALID');
    assert.deepEqual(Object.keys(index().applied), ['ev_death001']);
    // The ack's checkpoint holds the death and the applied id, so a restore to it brings both back.
    live.state.npcs.find(item => item.id === 'npc_tom').lifeState = 'alive';   // a lost install
    live.state.npcs.find(item => item.id === 'npc_tom').lifeStateCertainty = '';
    live.state.npcs.find(item => item.id === 'npc_tom').archiveReason = '';
    assert.deepEqual(await participant.applyEvent(input), ack);
    assert.equal(isTerminalNpcDeath(live.state.npcs.find(item => item.id === 'npc_tom')), true, 'a delivery whose install was lost is finished');
});

test('every callback is one at a time and answers a failure envelope, never a throw: a vault that cannot write is a FAILED', async () => {
    const { participant, vault, hydrate } = setup();
    await hydrate();
    vault.fail.add('put');
    const out = await participant.checkpoint({});
    assert.deepEqual([out.ok, out.code], [false, 'FAILED']);
    vault.fail.clear();
    // Calls started together finish in order.
    const order = [];
    await Promise.all([1, 2, 3].map(n => participant.checkpoint({ headHash: String(n).repeat(64).slice(0, 64) }).then(() => order.push(n))));
    assert.deepEqual(order, [1, 2, 3]);
});

test('the file vault writes SillyTavern\'s user files and reads them back; a checkpoint is written once', async () => {
    const files = new Map();
    const calls = [];
    const fetchFn = async (url, options = {}) => {
        calls.push(url);
        if (url === '/api/files/upload') {
            const { name, data } = JSON.parse(options.body);
            files.set(name, Buffer.from(data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${name}` }) };
        }
        const name = url.split('/').pop();
        return files.has(name) ? { ok: true, status: 200, text: async () => files.get(name) } : { ok: false, status: 404 };
    };
    const vault = fileVault({ fetchFn, headers: { 'X-Test': '1' } });
    assert.equal(await vault.get('nk_00000001'), null);
    await vault.put('nk_00000001', { a: 1, é: '☃' });
    assert.deepEqual(await vault.get('nk_00000001'), { a: 1, é: '☃' });
    const uploads = calls.filter(url => url === '/api/files/upload').length;
    await vault.put('nk_00000001', { a: 1, é: '☃' });
    assert.equal(calls.filter(url => url === '/api/files/upload').length, uploads, 'not written twice');
    assert.equal(await vault.getIndex('chat:x'), null);
    await vault.putIndex('chat:x', { v: 1, n: 2 });
    assert.deepEqual(await vault.getIndex('chat:x'), { v: 1, n: 2 });
    assert.deepEqual([...files.keys()].filter(name => name.startsWith('npc-state-delta-')).length, 2);
    const refusing = fileVault({ fetchFn: async () => ({ ok: false, status: 500 }) });
    await assert.rejects(() => refusing.putIndex('chat:x', {}));
});
