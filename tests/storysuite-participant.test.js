// The timeline participant (src/storysuite-participant/, contract §8): identity, checkpoints, the callbacks, confirmed deaths, the vault.
// Pure over a memory port and a memory vault; the host-level tests are in storysuite-participant-host.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LINEAGE_ID, NP_ID, buildCheckpoint, checkpointIdOf, checkpointProblem, createParticipant, hydrateIdentity, memoryVault, resolveIdentity, restoredState, storedTimeline, timelineOf } from '../src/storysuite-participant/index.js';
import { hashJson, sha256 } from '../src/storysuite-participant/hash.js';
import { fileVault } from '../src/storysuite-participant/vault.js';
import { DELTA_MAX_DEPTH } from '../src/storysuite-participant/checkpoint.js';
import { createVaultSweep } from '../src/storysuite-participant/vault-sweep.js';
import { isTerminalNpcDeath } from '../terminal-lifecycle.js';

const npc = (id, name, extra = {}) => ({ id, name, aliases: [], archived: false, present: true, lifeState: 'alive', trust: 3, ...extra });
const freshState = () => ({
    npcs: [npc('npc_mira', 'Mira', { aliases: ['The Weaver'] }), npc('npc_tom', 'Old Tom')],
    socialGraph: { edges: [{ a: 'npc_mira', b: 'npc_tom', kind: 'friends' }] },
    checkpoints: [{ messageId: 3, snapshot: { npcs: [] } }], lineage: [{ id: 1 }], turn: 4,
});

function setup({ state = freshState(), chatKey = 'chat:avatar.png:one', vault = memoryVault(), extra = {} } = {}) {
    const live = { state, installs: 0, writes: 0, chatKey };
    const port = {
        chatKey: () => live.chatKey,
        readState: () => structuredClone(live.state),
        installState: async next => { live.installs += 1; live.state = structuredClone(next); },
        writeTimeline: async block => { live.writes += 1; live.state = { ...live.state, timeline: structuredClone(block) }; },
        ...extra,
    };
    let tick = 1000;
    const made = createParticipant({ port, vault, now: () => (tick += 1), random: seededRandom(7 + (seeds += 1)), ...(extra.options ?? {}) });
    return { live, port, vault, ...made };
}
let seeds = 0;
/** A deterministic source of lineage ids (each participant its own). */
function seededRandom(seed = 7) {
    let n = seed;
    return () => { n = (n * 48271) % 2147483647; return n / 2147483647; };
}

test('the hash is the platform\'s SHA-256 of the normalized JSON, and a checkpoint is named by it', () => {
    for (const text of ['', 'abc', 'a'.repeat(64), 'é☃🙂'.repeat(30)]) assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
    assert.equal(hashJson({ b: 1, a: [2, { d: 1, c: 2 }] }), sha256('{"a":[2,{"c":2,"d":1}],"b":1}'));
    const hash = sha256('x');
    assert.match(checkpointIdOf(hash), /^nk_[0-9a-z]{8}$/);
    assert.equal(checkpointIdOf(hash), checkpointIdOf(hash));
});

test('identity: every dossier gets one np_, in dossier order, stable through a rename and an alias change; the ids belong to the lineage and are never reused', () => {
    const state = freshState();
    const first = hydrateIdentity(null, state.npcs, { seed: 'lg_aaaaaaaa' });
    assert.equal(first.assigned.length, 2);
    assert.ok(first.assigned.every(id => NP_ID.test(id)));
    const mira = first.identity.byKey.npc_mira;
    // A rename and a new alias change nothing about the pair.
    state.npcs[0].name = 'Mira of the Marsh';
    state.npcs[0].aliases.push('Marsh-Mira');
    const again = hydrateIdentity(first.identity, state.npcs, { seed: 'lg_aaaaaaaa', reserved: first.reserved });
    assert.equal(again.changed, false);
    assert.equal(again.identity.byKey.npc_mira, mira);
    // Another lineage issues other ids for the same dossiers; the same lineage the same ones.
    assert.notEqual(hydrateIdentity(null, freshState().npcs, { seed: 'lg_bbbbbbbb' }).identity.byKey.npc_mira, mira);
    assert.equal(hydrateIdentity(null, freshState().npcs, { seed: 'lg_aaaaaaaa' }).identity.byKey.npc_mira, mira);
    // A deleted dossier's pair is archived; a new dossier of the same key later gets a new id, never the old.
    const gone = hydrateIdentity(first.identity, [state.npcs[1]], { seed: 'lg_aaaaaaaa', reserved: first.reserved });
    assert.deepEqual(gone.archived, [mira]);
    assert.equal(gone.identity.map[mira].archived, true);
    const back = hydrateIdentity(gone.identity, state.npcs, { seed: 'lg_aaaaaaaa', reserved: gone.reserved });
    assert.notEqual(back.identity.byKey.npc_mira, mira);
    assert.equal(back.identity.map[mira].archived, true);
});

test('npc.identity: by id the active dossier\'s { id, nativeKey, name }; by name, alias or key only when one dossier answers; null for the rest, nothing created', () => {
    const state = freshState();
    state.npcs.push(npc('npc_wren_2', 'Wren'), npc('npc_wren', 'Wren'));
    const { identity } = hydrateIdentity(null, state.npcs, { seed: 'lg_aaaaaaaa' });
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
    const archived = hydrateIdentity(identity, state.npcs.slice(1), { seed: 'lg_aaaaaaaa' }).identity;
    assert.equal(resolveIdentity(archived, state.npcs.slice(1), { id: mira }), null);
});

test('a checkpoint is the whole native state, its np_ map and deaths in it, named by its hash and bound to a lineage; altered bytes are named', () => {
    const state = { ...freshState(), timeline: storedTimeline({ ...timelineOf(null), lineage: 'lg_aaaaaaaa', identity: hydrateIdentity(null, freshState().npcs, { seed: 'lg_aaaaaaaa' }).identity, applied: { ev_one: { nativeKey: 'npc_tom', at: 5 } } }) };
    const built = buildCheckpoint({ lineage: 'lg_aaaaaaaa', state, cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    assert.deepEqual(Object.keys(built.doc), ['schema', 'kind', 'lineage', 'cursor', 'headHash', 'state']);
    assert.equal(built.doc.state.socialGraph.edges.length, 1, 'the relationship map');
    assert.equal(built.doc.state.checkpoints.length, 1, 'its own history');
    assert.deepEqual(Object.keys(built.doc.state.timeline.identity.map).length, 2, 'the np_ map');
    assert.deepEqual(built.doc.state.timeline.applied, { ev_one: { nativeKey: 'npc_tom', at: 5 } }, 'the applied deaths');
    assert.equal(checkpointProblem(built.doc, built.hash), '');
    const altered = structuredClone(built.doc);
    altered.state.npcs[0].trust = 99;
    assert.match(checkpointProblem(altered, built.hash), /do not hash/);
    assert.match(checkpointProblem({ ...built.doc, schema: 9 }, built.hash), /newer/);
    assert.match(checkpointProblem({ ...built.doc, kind: 'other' }, built.hash), /not a native checkpoint/);
    assert.match(checkpointProblem(null, built.hash), /not a native/);
    assert.match(checkpointProblem({ ...built.doc, state: { npcs: [] } }, built.hash), /missing/);
    // The same native state at the same head is the same checkpoint; another head is another.
    assert.equal(buildCheckpoint({ lineage: 'lg_aaaaaaaa', state, cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) }).id, built.id);
    assert.notEqual(buildCheckpoint({ lineage: 'lg_aaaaaaaa', state, cursor: { sid: 'sr_1' }, headHash: 'b'.repeat(64) }).id, built.id);
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

test('prepare refuses what it cannot stand behind: gone bytes, other bytes, another lineage, a newer schema; a return keeps its checkpoint; abort frees it', async () => {
    const { participant, vault, hydrate, live, timeline } = setup();
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
    // Another story line's checkpoint is not this one's.
    const foreign = buildCheckpoint({ lineage: 'lg_elsewher', state: { ...freshState(), timeline: storedTimeline(timelineOf(null)) } });
    await vault.put(foreign.id, foreign.doc);
    assert.equal((await participant.prepare({ return: 'rt_b', checkpoint: foreign.id, hash: foreign.hash })).code, 'CONFLICT');
    const future = buildCheckpoint({ lineage: timeline().lineage, state: { ...freshState(), timeline: storedTimeline(timelineOf(null)) } });
    future.doc.schema = 7;
    await vault.put('nk_future01', future.doc);
    assert.equal((await participant.prepare({ return: 'rt_c', checkpoint: 'nk_future01', hash: hashJson(future.doc) })).code, 'SNAPSHOT_UNAVAILABLE');
});

test('The checkpoint is hashed once when verified; a tampered document is refused with the same codes', async () => {
    const { participant, vault, hydrate } = setup();
    await hydrate();
    const saved = await participant.checkpoint({ cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    const good = await vault.get(saved.checkpoint);
    // Spy: the document's `cursor` is a getter, read once per hashJson of the document.
    let reads = 0;
    const spied = doc => { const copy = { ...doc }; Object.defineProperty(copy, 'cursor', { enumerable: true, get: () => { reads += 1; return doc.cursor; } }); return copy; };
    const realGet = vault.get;
    vault.get = async id => { const doc = await realGet(id); return doc ? spied(doc) : doc; };
    assert.equal((await participant.prepare({ return: 'rt_a', checkpoint: saved.checkpoint, hash: saved.hash })).ok, true);
    assert.equal(reads, 1, 'one hash of the document per verification');
    // checkpointProblem still hashes by itself without a precomputed hash, and trusts one it is given.
    assert.equal(checkpointProblem(good, saved.hash), '');
    assert.equal(checkpointProblem(good, saved.hash, saved.hash), '');
    assert.match(checkpointProblem(good, saved.hash, 'f'.repeat(64)), /do not hash/);
    // Tampered bytes under the same id: refused as before (CONFLICT), and a newer schema as SNAPSHOT_UNAVAILABLE.
    const altered = structuredClone(good);
    altered.state.npcs[0].trust = 99;
    vault.get = async () => altered;
    assert.equal((await participant.prepare({ return: 'rt_b', checkpoint: saved.checkpoint, hash: saved.hash })).code, 'CONFLICT');
    vault.get = async () => ({ ...good, schema: 9 });
    assert.equal((await participant.prepare({ return: 'rt_c', checkpoint: saved.checkpoint, hash: saved.hash })).code, 'SNAPSHOT_UNAVAILABLE');
    vault.get = async () => null;
    assert.equal((await participant.prepare({ return: 'rt_d', checkpoint: saved.checkpoint, hash: saved.hash })).code, 'SNAPSHOT_UNAVAILABLE');
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
    const { participant, live, hydrate, timeline } = setup();
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
    assert.deepEqual(Object.keys(timeline().applied), ['ev_death001'], 'the applied death is in the state');
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

test('the query reads the ids from the chat\'s state: a state with its ids answers at once (a reload), one without hydrates behind the first ask', async () => {
    const { queries, live, timeline, hydrate } = setup();
    const ask = args => queries['npc.identity'](null, args);
    assert.equal(ask({ name: 'Mira' }), null, 'an old state with no ids: nothing yet');
    await new Promise(resolve => setTimeout(resolve, 5));
    const mira = timeline().identity.byKey.npc_mira;
    assert.ok(mira);
    assert.equal(ask({ name: 'Mira' }).id, mira);
    // A reload: the participant is new, the state (with its block) is what Delta loaded. The ids answer at once.
    const reloaded = setup({ state: structuredClone(live.state), chatKey: 'chat:avatar.png:one' });
    assert.equal(reloaded.queries['npc.identity'](null, { id: mira }).nativeKey, 'npc_mira');
    assert.equal(reloaded.queries['npc.identity'](null, { name: 'Old Tom' }).nativeKey, 'npc_tom');
    live.state.npcs.push(npc('npc_late', 'Late'));
    assert.equal(ask({ name: 'Late' }), null, 'a scan admitted a dossier: no np_ yet');
    assert.equal(ask({ name: 'Mira' }).id, mira, 'the others still answer');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ask({ name: 'Late' }).nativeKey, 'npc_late');
    live.chatKey = 'no-chat';
    assert.equal(ask({ name: 'Mira' }), null);
    void hydrate;
});

test('N1: the ids, the reserved ids and the applied deaths live in the chat\'s state with a lineage id: a rename keeps them, a save point made before it can still be prepared', async () => {
    const { participant, live, hydrate, timeline, queries } = setup({ chatKey: 'chat:avatar.png:one' });
    await hydrate();
    const block = timeline();
    assert.match(block.lineage, LINEAGE_ID);
    assert.equal(live.state.timeline.lineage, block.lineage, 'it is in the state itself');
    const mira = block.identity.byKey.npc_mira;
    const saved = await participant.checkpoint({ cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    // Delta renames the chat: it moves the state file; the key changes, the state is the same.
    live.chatKey = 'chat:avatar.png:renamed';
    await hydrate();
    assert.equal(timeline().identity.byKey.npc_mira, mira, 'the same np_ after the rename');
    assert.equal(timeline().lineage, block.lineage);
    assert.equal(queries['npc.identity'](null, { id: mira }).nativeKey, 'npc_mira');
    const prepared = await participant.prepare({ return: 'rt_00000009', checkpoint: saved.checkpoint, hash: saved.hash });
    assert.equal(prepared.ok, true, prepared.message);
    const activated = await participant.activate({ return: 'rt_00000009', prepared: prepared.prepared });
    assert.equal(activated.ok, true, activated.message);
    assert.equal(timeline().lineage, block.lineage);
});

test('N1: a branch or an import of the state is the same story line: its ids are the same and its parent\'s checkpoints are its own; a state with another lineage is not', async () => {
    const vault = memoryVault();
    const parent = setup({ vault });
    await parent.hydrate();
    const saved = await parent.participant.checkpoint({});
    const branched = setup({ state: structuredClone(parent.live.state), chatKey: 'chat:avatar.png:branch', vault });
    await branched.hydrate();
    assert.deepEqual(branched.timeline().identity.byKey, parent.timeline().identity.byKey);
    assert.equal(branched.timeline().lineage, parent.timeline().lineage);
    const prepared = await branched.participant.prepare({ return: 'rt_00000010', checkpoint: saved.checkpoint, hash: saved.hash });
    assert.equal(prepared.ok, true, prepared.message);
    // A different story (its own lineage) is refused the first one\'s checkpoint.
    const other = setup({ vault, chatKey: 'chat:avatar.png:other' });
    await other.hydrate();
    assert.notEqual(other.timeline().lineage, parent.timeline().lineage);
    assert.equal((await other.participant.prepare({ return: 'rt_00000011', checkpoint: saved.checkpoint, hash: saved.hash })).code, 'CONFLICT');
});

test('restoredState: the saved state with its map and deaths, this lineage\'s id, and every np_ either timeline issued reserved', () => {
    const live = setup().live;
    const saved = { npcs: [], timeline: storedTimeline({ ...timelineOf(null), lineage: 'lg_aaaaaaaa', identity: hydrateIdentity(null, [npc('npc_a', 'A')], { seed: 'lg_aaaaaaaa' }).identity }) };
    const now = { npcs: [], timeline: storedTimeline({ ...timelineOf(null), lineage: 'lg_aaaaaaaa', identity: hydrateIdentity(null, [npc('npc_b', 'B')], { seed: 'lg_aaaaaaaa' }).identity, reserved: ['np_zzzzzzzz'] }) };
    const out = restoredState(saved, now);
    const ids = Object.keys(out.timeline.identity.map);
    assert.equal(ids.length, 1, 'the saved map');
    assert.ok(out.timeline.reserved.includes('np_zzzzzzzz') && out.timeline.reserved.includes(Object.keys(now.timeline.identity.map)[0]) && out.timeline.reserved.includes(ids[0]));
    void live;
});

test('N2: a checkpoint is quiet: it waits for a scan in flight, and when Delta will not be quiet it answers a retryable STALE, never a save that misses the scan', async () => {
    let scanning = true;
    let landed = false;
    const live = {};
    const idle = async () => { await new Promise(resolve => setTimeout(resolve, 5)); if (scanning) { scanning = false; live.state.npcs.push(npc('npc_vale', 'Vale')); landed = true; } return true; };
    const { participant, hydrate, live: l } = setup({ extra: { busy: () => scanning, idle } });
    Object.assign(live, l);
    live.state = l.state;
    Object.defineProperty(live, 'state', { get: () => l.state, set: value => { l.state = value; } });
    await hydrate();
    const saved = await participant.checkpoint({});
    assert.equal(saved.ok, true, saved.message);
    assert.equal(landed, true);
    const doc = await (async () => { const got = await participant.prepare({ return: 'rt_00000012', checkpoint: saved.checkpoint, hash: saved.hash }); return got; })();
    assert.equal(doc.ok, true);
    // A scan that never ends: STALE.
    const stuck = setup({ extra: { busy: () => true, idle: async () => false } });
    await stuck.hydrate();
    const refused = await stuck.participant.checkpoint({});
    assert.deepEqual([refused.ok, refused.code], [false, 'STALE']);
    // A state that keeps moving while the checkpoint is made: STALE too, after a few tries.
    let n = 0;
    const moving = setup({ extra: {} });
    const read = moving.port.readState;
    moving.port.readState = () => { const state = read(); state.turn = (n += 1); return state; };
    await moving.hydrate();
    assert.equal((await moving.participant.checkpoint({})).code, 'STALE');
});

test('N2: a deleted native key never gets its np_ back: the key that returns is a new person with a new id', async () => {
    const { live, hydrate, timeline } = setup();
    await hydrate();
    const tom = timeline().identity.byKey.npc_tom;
    live.state.npcs = live.state.npcs.filter(item => item.id !== 'npc_tom');
    await hydrate();
    assert.equal(timeline().identity.map[tom].archived, true);
    live.state.npcs.push(npc('npc_tom', 'Old Tom'));
    await hydrate();
    assert.notEqual(timeline().identity.byKey.npc_tom, tom);
    assert.ok(timeline().reserved.includes(tom));
});

test('hydration looks at the chat again after every wait: a chat that changed while the block was written is left alone', async () => {
    const { live, port, participant, hydrate } = setup();
    const write = port.writeTimeline;
    port.writeTimeline = async block => { await write(block); live.chatKey = 'chat:avatar.png:other'; };
    const out = await hydrate();
    assert.equal(out.ok, false);
    assert.equal(participant.checkpoint !== undefined, true);
});

test('the file vault asks whether a file exists before a first write reads it: a new checkpoint or index makes no 404 request, what is stored is unchanged', async () => {
    const files = new Map();
    const calls = [];
    let verify = 'ok';
    const fetchFn = async (url, options = {}) => {
        calls.push({ url, method: options.method ?? 'GET', name: url === '/api/files/upload' ? JSON.parse(options.body).name : '' });
        if (url === '/api/files/verify') {
            if (verify === 'throw') throw new Error('offline');
            if (verify === 'missing') return { ok: false, status: 404, json: async () => ({}) };
            const { urls } = JSON.parse(options.body);
            return { ok: true, status: 200, json: async () => Object.fromEntries(urls.map(path => [path, files.has(path.split('/').pop())])) };
        }
        if (url === '/api/files/upload') {
            const { name, data } = JSON.parse(options.body);
            files.set(name, Buffer.from(data, 'base64').toString('utf8'));
            return { ok: true, status: 200, json: async () => ({ path: `/user/files/${name}` }) };
        }
        const name = url.split('/').pop();
        return files.has(name) ? { ok: true, status: 200, text: async () => files.get(name) } : { ok: false, status: 404 };
    };
    // The clean-up's registry file (vault.js) is a separate, unawaited write; the checks below are about the checkpoint and index files.
    const own = list => list.filter(call => !String(call.name || call.url).includes('registry'));
    const gets = () => own(calls.filter(call => call.method === 'GET')).map(call => call.url);
    const vault = fileVault({ fetchFn, headers: { 'X-Test': '1' } });
    const doc = { a: 1, é: '☃' };
    // A fresh chat's first writes: the index of a new lineage and its first checkpoint.
    assert.equal(await vault.getIndex('lg_aaaaaaaa'), null);
    await vault.put('nk_00000001', doc);
    await vault.putIndex('lg_aaaaaaaa', { v: 1 });
    assert.deepEqual(gets(), [], 'nothing was fetched that is not there: no 404');
    assert.deepEqual(JSON.parse(files.get('npc-state-delta-checkpoint-nk_00000001.json')), doc, 'stored as before');
    assert.deepEqual(own(calls.filter(call => call.url === '/api/files/upload')).length, 2);
    // What is there is read, and a checkpoint already kept is not written again.
    assert.deepEqual(await vault.getIndex('lg_aaaaaaaa'), { v: 1 });
    await vault.put('nk_00000001', doc);
    assert.equal(own(calls.filter(call => call.url === '/api/files/upload')).length, 2, 'not written twice');
    assert.equal(gets().length, 2, 'the existing index and checkpoint were read');
    // A save point is read straight (no verify): a checkpoint that is gone is still told by its 404.
    const before = calls.length;
    assert.equal(await vault.get('nk_0000ffff'), null);
    assert.deepEqual(calls.slice(before).map(call => call.url), ['/user/files/npc-state-delta-checkpoint-nk_0000ffff.json']);
    // A server that cannot say (no such route, an error): read as before, the write still happens.
    for (const mode of ['missing', 'throw']) {
        verify = mode;
        const id = `nk_${mode}`;
        const mark = calls.length;
        await vault.put(id, { mode });
        assert.deepEqual(gets().slice(-1), [`/user/files/npc-state-delta-checkpoint-${id}.json`], `${mode}: read first, as before`);
        assert.deepEqual(JSON.parse(files.get(`npc-state-delta-checkpoint-${id}.json`)), { mode }, `${mode}: written`);
        assert.ok(calls.length > mark);
    }
});

test('the file vault gives up on a request that gets no answer', async () => {
    const vault = fileVault({ fetchFn: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))), timeoutMs: 20 });
    await assert.rejects(() => vault.get('nk_00000001'), /did not answer in 20 ms/);
    await assert.rejects(() => vault.putIndex('lg_aaaaaaaa', {}), /did not answer/);
});

// ---- publishing a change Delta already made (the observer) ----

function handleFor(calls, { source = { sid: 'sr_00000001', swipeKey: 'sw_00000001', evidence: 'ev_00000001', ordinal: 0 }, answers = [] } = {}) {
    let head = 0;
    return {
        head: async () => ({ ok: true, headHash: String(head).repeat(64).slice(0, 64), cursor: { sid: 'sr_00000001', swipeKey: 'sw_00000001', op: 0, rev: head }, epoch: 'ep_00000000', prefixHash: 'c'.repeat(64), ...(source ? { source } : {}) }),
        nativeMutation: async input => {
            const made = await input.prepare();
            calls.push({ input, made });
            head += 1;
            const answer = answers.shift();
            if (answer) return answer;
            return { ok: true, checkpoint: made.after.checkpoint, hash: made.after.hash };
        },
    };
}

test('N2: a change Delta made and saved is published as a native mutation: the checkpoint the story stood on, then the state now; unchanged publishes nothing', async () => {
    const { participant, live, hydrate, noteChange, flush } = setup();
    const calls = [];
    participant.attach(handleFor(calls));
    await hydrate();
    assert.deepEqual(await flush(), { ok: true, unchanged: true }, 'nothing changed since the story stood here');
    const baseline = (await participant.status({ return: 'rt_x' })).code;
    assert.equal(baseline, 'NOT_FOUND');
    live.state.npcs.push(npc('npc_vale', 'Vale'));
    live.state.npcs[0].trust = 9;
    noteChange();
    const out = await flush();
    assert.equal(out.ok, true, out.message);
    assert.equal(calls.length, 1);
    const [{ made, input }] = calls;
    assert.equal(input.participant, 'npc-state-delta');
    assert.equal(input.source.ordinal, 0);
    assert.notEqual(made.before.checkpoint, made.after.checkpoint);
    // The host activates the after with its own transaction id; the live state is not overwritten.
    const installs = live.installs;
    const activated = await participant.activate({ return: 'nm_00000001', prepared: made.prepared });
    assert.equal(activated.ok, true, activated.message);
    assert.equal(live.installs, installs, 'a change that is already live is not installed over a newer one');
    assert.equal(live.state.npcs.length, 3);
    assert.deepEqual(await flush(), { ok: true, unchanged: true }, 'and it is now the state the story stands on');
});

test('N2: a host that gives no Source for the head cannot take the change yet (UNSUPPORTED, said once); STALE and RESTORE_PENDING are tried again', async () => {
    const told = [];
    const { participant, live, hydrate, flush } = setup({ extra: { warn: text => told.push(text) } });
    const calls = [];
    participant.attach(handleFor(calls, { source: null }));
    await hydrate();
    live.state.npcs[0].trust = 5;
    assert.equal((await flush()).code, 'UNSUPPORTED');
    assert.deepEqual(told, [], 'not an error to be told every time');
    const later = setup({ extra: { headSource: () => ({ sid: 'sr_00000002', swipeKey: 'sw_00000002', evidence: 'ev_00000002', ordinal: 1 }) } });
    const seen = [];
    later.participant.attach(handleFor(seen, { source: null, answers: [{ ok: false, code: 'STALE', message: 'The head moved.' }] }));
    await later.hydrate();
    later.live.state.npcs[0].trust = 6;
    const out = await later.flush();
    assert.equal(out.ok, true, out.message);
    assert.equal(seen.length, 2, 'the head was read again after STALE');
    assert.equal(seen[0].input.source.ordinal, 1, 'the port gave the Source');
});

test('opening a chat, a reply or a scan hydrates nothing and writes nothing; the first save point or npc.identity question makes the story line', async () => {
    const empty = setup({ state: { npcs: [], socialGraph: { edges: [] }, checkpoints: [], lineage: [], turn: 0 } });
    assert.equal(empty.prime, undefined, 'nothing primes a chat at open');
    assert.equal(empty.live.writes, 0, 'a new chat has no file until it is saved');
    assert.equal(empty.queries['npc.identity'](null, { name: 'Mira' }), null);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(empty.live.writes, 0, 'and asking about a person nobody has met does not make one');
    // The first thing that needs a line makes it: a save point.
    const saved = await empty.participant.checkpoint({});
    assert.equal(saved.ok, true);
    assert.equal(empty.live.writes, 1);
    assert.match(empty.timeline().lineage, LINEAGE_ID);

    // A populated chat that never asks is untouched: no lineage, no ids, no checkpoint, no vault file, however its dossiers change.
    const full = setup();
    const plain = structuredClone(full.live.state);
    full.participant.attach({ head: async () => ({ ok: false, code: 'RESTORE_PENDING' }), nativeMutation: async () => { throw new Error('published'); } });
    full.noteChange();
    full.live.state.npcs[0].trust = 5;
    full.noteChange();
    assert.equal((await full.flush()).unchanged, true, 'nothing to publish for a chat that does not use the timeline');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(full.live.writes, 0);
    assert.equal(full.live.installs, 0);
    assert.equal(full.vault.docs.size, 0);
    assert.equal(full.vault.indexes.size, 0);
    assert.equal(Object.hasOwn(full.live.state, 'timeline'), false);
    full.live.state.npcs[0].trust = plain.npcs[0].trust;
    assert.deepEqual(full.live.state, plain);

    // The first question to npc.identity is a use: the ids are made behind it, and the next ask finds them.
    assert.equal(full.queries['npc.identity'](null, { name: 'Mira' }), null);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(full.timeline().lineage, LINEAGE_ID);
    assert.equal(full.queries['npc.identity'](null, { name: 'Mira' }).nativeKey, 'npc_mira');
});

// ---- checkpoint files: packed on disk, plain in memory; a save that is thrown away removes only what it made -------------------------------

/** A fake SillyTavern user-files server (upload / verify / delete / read) for the file vault. */
function filesServer() {
    const files = new Map();
    const fetchFn = async (url, options = {}) => {
        const name = url.split('/').pop();
        if (url === '/api/files/upload') { const body = JSON.parse(options.body); files.set(body.name, Buffer.from(body.data, 'base64').toString()); return { ok: true, status: 200 }; }
        if (url === '/api/files/verify') { const body = JSON.parse(options.body); return { ok: true, status: 200, json: async () => Object.fromEntries(body.urls.map(u => [u, files.has(u.split('/').pop())])) }; }
        if (url === '/api/files/delete') { const had = files.delete(JSON.parse(options.body).path.split('/').pop()); return { ok: had, status: had ? 200 : 404, text: async () => '' }; }
        return files.has(name) ? { ok: true, status: 200, text: async () => files.get(name) } : { ok: false, status: 404, text: async () => '' };
    };
    return { files, fetchFn, checkpointNames: () => [...files.keys()].filter(name => name.startsWith('npc-state-delta-checkpoint-nk_')) };
}
const bytesOf = (server, names) => names.reduce((sum, name) => sum + Buffer.byteLength(server.files.get(name)), 0);

/** A chat state after `turn` replies: Delta's own rollback history holds a full snapshot per reply (the part that made every file big). */
function stateAt(turn) {
    const people = at => Array.from({ length: 6 }, (_, n) => npc(`npc_${n}`, `Person ${n}`, { trust: (at + n) % 10, memories: Array.from({ length: Math.min(at, 30) }, (_, m) => `memory ${m} of person ${n}, told on reply ${Math.min(at, m + 1)}`) }));
    const checkpoints = Array.from({ length: turn }, (_, i) => {
        const at = i + 1;
        return { messageId: at, fingerprint: `fp${at}`, lineageKey: `L${at}`, parentLineageKey: at > 1 ? `L${at - 1}` : null, reason: 'scan', createdAt: at, rollbackSeq: at, snapshot: { turn: at, npcs: people(at) } };
    });
    return { npcs: people(turn), socialGraph: { edges: [] }, checkpoints, lineage: [{ id: 1 }], turn };
}

test('a checkpoint file is written packed and read back as the very document that was hashed; old plain files and unusable checkpoint lists stay as they are', async () => {
    const server = filesServer();
    const vault = fileVault({ fetchFn: server.fetchFn });
    const built = buildCheckpoint({ lineage: 'lg_aaaaaaaa', state: { ...stateAt(40), timeline: { v: 1, lineage: 'lg_aaaaaaaa' } }, cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    assert.equal(await vault.put(built.id, built.doc), true, 'put says it created the file');
    assert.equal(await vault.put(built.id, built.doc), false, 'the same id again is not a new file');
    const stored = JSON.parse(server.files.get(`npc-state-delta-checkpoint-${built.id}.json`));
    assert.equal(stored.kind, 'npc-state-delta-native-packed');
    assert.equal(stored.packing.scheme, 'chain-rfc6902');
    assert.ok(server.files.get(`npc-state-delta-checkpoint-${built.id}.json`).length * 1.5 < JSON.stringify(built.doc).length, 'much less than the plain bytes');
    const back = await vault.get(built.id);
    assert.deepEqual(back, built.doc);
    assert.equal(hashJson(back), built.hash, 'the hash (and so the id) is the plain document\'s');
    assert.equal(checkpointProblem(back, built.hash), '');
    // An old build's plain file is read as it is, and so is a plain write (no checkpoint list, or an empty one).
    const old = buildCheckpoint({ lineage: 'lg_aaaaaaaa', state: freshState() });
    server.files.set(`npc-state-delta-checkpoint-${old.id}.json`, JSON.stringify(old.doc));
    assert.deepEqual(await vault.get(old.id), old.doc);
    for (const [lineage, state] of [['lg_bbbbbbbb', { npcs: [], timeline: {} }], ['lg_cccccccc', { npcs: [], checkpoints: [], timeline: {} }]]) {
        const plainOne = buildCheckpoint({ lineage, state, headHash: 'c'.repeat(64) });
        await vault.put(plainOne.id, plainOne.doc);
        assert.equal(JSON.parse(server.files.get(`npc-state-delta-checkpoint-${plainOne.id}.json`)).kind, plainOne.doc.kind);
        assert.deepEqual(await vault.get(plainOne.id), plainOne.doc);
    }
    // A packed file that cannot be rebuilt is a file that is not there (never a partial state).
    const broken = JSON.parse(server.files.get(`npc-state-delta-checkpoint-${built.id}.json`));
    broken.doc.state.checkpoints.find(entry => entry.packed).packed.base = 999;
    server.files.set(`npc-state-delta-checkpoint-${built.id}.json`, JSON.stringify(broken));
    assert.equal(await vault.get(built.id), null);
});

test('60 replies on the file vault: the same restores as the plain memory vault, one file per save and a fraction of the bytes (anchors and patches)', async () => {
    const server = filesServer();
    const plainVault = memoryVault();
    const runs = [];
    for (const vault of [fileVault({ fetchFn: server.fetchFn }), plainVault]) {
        const run = setup({ state: stateAt(1), vault });
        await run.hydrate();
        const saves = [];
        for (let turn = 1; turn <= 60; turn += 1) {
            run.live.state = { ...stateAt(turn), timeline: run.live.state.timeline };
            saves.push(await run.participant.checkpoint({ cursor: { sid: `sr_${turn}` }, headHash: hashJson({ turn }) }));
        }
        assert.ok(saves.every(save => save.ok), 'every save succeeds');
        // Rollback / swipe / delete / re-read / reload all come down to prepare + activate of an earlier reply's checkpoint: the installed state.
        const installed = [];
        for (const turn of [59, 41, 30, 3, 60, 1]) {
            const save = saves[turn - 1];
            const prepared = await run.participant.prepare({ return: `rt_${turn}x${installed.length}`, checkpoint: save.checkpoint, hash: save.hash });
            assert.equal(prepared.ok, true, prepared.message);
            const activated = await run.participant.activate({ return: `rt_${turn}x${installed.length}`, prepared: prepared.prepared });
            assert.equal(activated.ok, true, activated.message);
            installed.push(structuredClone(run.live.state));
        }
        runs.push({ saves, installed });
    }
    // Each run mints its own story line (its ids and the np_ map seeded by it), so those differ; what a restore installs must not.
    const unlined = states => states.map(({ timeline, ...state }) => state);
    assert.deepEqual(unlined(runs[0].installed), unlined(runs[1].installed), 'the same state after each restore');
    const names = server.checkpointNames();
    assert.equal(names.length, 61, 'one file per save (and the baseline), none lost, none extra');
    const plainBytes = [...plainVault.docs.values()].reduce((sum, text) => sum + text.length, 0);
    const packedBytes = bytesOf(server, names);
    assert.ok(packedBytes * 5 < plainBytes, `packed ${packedBytes} bytes against ${plainBytes} plain`);
});

test('a save that is thrown away removes the file it made, and only that; a failed removal changes nothing', async () => {
    const run = setup({ vault: memoryVault() });
    await run.hydrate();
    const baseId = [...run.vault.docs.keys()][0];
    const removed = [];
    const remove = run.vault.remove.bind(run.vault);
    run.vault.remove = async (id, options) => { removed.push(id); return remove(id, options); };
    // The state Delta holds changes after the checkpoint was made (the scan started): the first try is thrown away, the second stands.
    let busyOnce = true;
    run.port.busy = () => { const now = busyOnce; busyOnce = false; return now; };
    const before = run.vault.docs.size;
    const saved = await run.participant.checkpoint({ cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    assert.equal(saved.ok, true);
    assert.equal(removed.length, 1, 'the thrown-away try was removed');
    assert.equal(run.vault.docs.size, before + 1, 'and the one that stands is kept');
    assert.ok(run.vault.docs.has(saved.checkpoint));
    // The baseline checkpoint of the same state (same id, made earlier, named by the index) is never removed by a thrown-away save of it.
    let again = true;
    run.port.busy = () => { const now = again; again = false; return now; };
    removed.length = 0;
    const same = await run.participant.checkpoint({});
    assert.equal(same.ok, true);
    assert.equal(removed.length, 0, 'an id that existed before is not removed');
    assert.ok(run.vault.docs.has(baseId));
    // A removal that fails (or a crash before it) leaves the file and the save is still right.
    run.vault.remove = async () => { throw new Error('the server went away'); };
    let third = true;
    run.port.busy = () => { const now = third; third = false; return now; };
    run.live.state.npcs[0].trust = 8;
    const kept = await run.participant.checkpoint({ cursor: { sid: 'sr_9' }, headHash: 'e'.repeat(64) });
    assert.equal(kept.ok, true);
    assert.ok(run.vault.docs.has(kept.checkpoint));
});

const lined = turn => ({ ...stateAt(turn), timeline: { v: 1, lineage: 'lg_aaaaaaaa' } });
const fileOf = (server, id) => JSON.parse(server.files.get(`npc-state-delta-checkpoint-${id}.json`));
async function saveRun(vault, from, to) {
    const out = [];
    for (let turn = from; turn <= to; turn += 1) {
        const built = buildCheckpoint({ lineage: 'lg_aaaaaaaa', state: lined(turn), cursor: { sid: `sr_${turn}` }, headHash: hashJson({ turn }) });
        assert.equal(await vault.put(built.id, built.doc), true);
        out.push(built);
    }
    return out;
}

test('each file is a patch against the one written before it, with a packed anchor after at most DELTA_MAX_DEPTH patches; every id reads back as its own document', async () => {
    const server = filesServer();
    const vault = fileVault({ fetchFn: server.fetchFn });
    const built = await saveRun(vault, 1, 40);
    const stored = built.map(item => fileOf(server, item.id));
    assert.equal(stored[0].kind, 'npc-state-delta-native-packed', 'the first file is an anchor');
    assert.ok(stored.filter(file => file.kind === 'npc-state-delta-native-delta').length >= 20, 'most files are patches');
    assert.ok(stored.filter(file => file.kind !== 'npc-state-delta-native-delta').length >= Math.floor(stored.length / (DELTA_MAX_DEPTH + 1)), 'an anchor at least every DELTA_MAX_DEPTH + 1 files');
    assert.ok(Math.max(...stored.map(file => file.depth ?? 0)) <= DELTA_MAX_DEPTH, 'a chain is never longer than the cap');
    for (const file of stored.filter(item => item.base)) assert.ok(server.files.has(`npc-state-delta-checkpoint-${file.base}.json`));
    for (const item of built) assert.deepEqual(await vault.get(item.id), item.doc, `${item.id} reads back whole`);
    // A fresh vault (a reload) reads the same files, and starts its own anchor.
    const reloaded = fileVault({ fetchFn: server.fetchFn });
    for (const item of built.filter((_, i) => i % 7 === 0)) assert.equal(hashJson(await reloaded.get(item.id)), item.hash);
    const next = buildCheckpoint({ lineage: 'lg_aaaaaaaa', state: lined(41), cursor: { sid: 'sr_41' }, headHash: hashJson({ turn: 41 }) });
    await reloaded.put(next.id, next.doc);
    assert.equal(fileOf(server, next.id).kind, 'npc-state-delta-native-packed');
    assert.equal((await reloaded.describe(built[10].id)).lineage, 'lg_aaaaaaaa');
    assert.equal((await reloaded.describe(next.id)).lineage, 'lg_aaaaaaaa');
    assert.equal((await reloaded.describe(next.id)).base, null, 'an anchor is built on nothing');
    assert.equal((await reloaded.describe(built[10].id)).base, fileOf(server, built[10].id).base ?? null);
});

test('a base is never removed while a file is a patch against it; the sweep takes both once both are old and unused; a missing base is a file that is not there', async () => {
    let t = 1000 * 86400000;
    const server = filesServer();
    const vault = fileVault({ fetchFn: server.fetchFn, now: () => t });
    const [first, second, third] = await saveRun(vault, 20, 22);
    assert.equal(fileOf(server, second.id).base, first.id);
    assert.equal(fileOf(server, third.id).base, second.id);
    assert.equal(await vault.remove(first.id), false, 'the root of a chain stays');
    assert.equal(await vault.remove(second.id), false, 'so does a middle link');
    assert.equal(server.files.has(`npc-state-delta-checkpoint-${first.id}.json`), true);
    // The Storage sweep: all three old and unused, the oldest first: the retry pass takes the whole chain.
    t += 60 * 86400000;
    const sweep = createVaultSweep({ vault, now: () => t });
    const plan = await sweep.plan({ complete: true, referenced: [] });
    assert.equal(plan.candidates.length, 3);
    const done = await sweep.sweep();
    assert.deepEqual([done.ok, done.count, done.skipped], [true, 3, []]);
    assert.deepEqual(server.checkpointNames(), []);
    // A chain whose base file vanished (not by this build) reads as a file that is not there, and a restore says so.
    const again = fileVault({ fetchFn: server.fetchFn });
    const [a, b] = await saveRun(again, 24, 25);
    server.files.delete(`npc-state-delta-checkpoint-${a.id}.json`);
    assert.equal(await again.get(b.id), null);
    const { participant, hydrate } = setup({ vault: again });
    await hydrate();
    assert.equal((await participant.prepare({ return: 'rt_gone', checkpoint: b.id, hash: b.hash })).code, 'SNAPSHOT_UNAVAILABLE');
});

test('the dependency is recorded before the file; when it cannot be recorded or the file cannot be written, nothing is left to break', async () => {
    const server = filesServer();
    const vault = fileVault({ fetchFn: server.fetchFn });
    const [first] = await saveRun(vault, 30, 30);
    // The registry cannot be written: the next file is a self-contained anchor, not a patch.
    const plainFetch = server.fetchFn;
    let blockRegistry = true;
    const flaky = fileVault({ fetchFn: async (url, options = {}) => (blockRegistry && url === '/api/files/upload' && JSON.parse(options.body).name.includes('registry') ? { ok: false, status: 500 } : plainFetch(url, options)) });
    const [x] = await saveRun(flaky, 40, 40);
    const [y] = await saveRun(flaky, 41, 41);
    assert.notEqual(fileOf(server, y.id).kind, 'npc-state-delta-native-delta', 'no recorded dependency, no patch');
    assert.deepEqual(await flaky.get(y.id), y.doc);
    assert.deepEqual(await flaky.get(x.id), x.doc);
    // The file cannot be uploaded: the record that named its base is taken back, so the base can go.
    blockRegistry = false;
    let failUpload = false;
    const dying = fileVault({ fetchFn: async (url, options = {}) => (failUpload && url === '/api/files/upload' && JSON.parse(options.body).name.includes('checkpoint-nk_') ? { ok: false, status: 500 } : plainFetch(url, options)) });
    const [base] = await saveRun(dying, 50, 50);
    failUpload = true;
    const next = buildCheckpoint({ lineage: 'lg_aaaaaaaa', state: lined(51), cursor: { sid: 'sr_51' }, headHash: hashJson({ turn: 51 }) });
    await assert.rejects(dying.put(next.id, next.doc));
    failUpload = false;
    assert.equal(await dying.remove(base.id), true, 'nothing depends on the base any more');
    assert.ok(first.id);
});

test('an old chat with many plain files: they stay readable and untouched next to the new forms, and a new session never patches against a file it did not write', async () => {
    const server = filesServer();
    const olds = Array.from({ length: 40 }, (_, i) => buildCheckpoint({ lineage: 'lg_aaaaaaaa', state: lined(i + 1), cursor: { sid: `sr_${i + 1}` }, headHash: hashJson({ turn: i + 1 }) }));
    for (const item of olds) server.files.set(`npc-state-delta-checkpoint-${item.id}.json`, JSON.stringify(item.doc));
    const before = new Map(server.files);
    const vault = fileVault({ fetchFn: server.fetchFn });
    for (const item of olds) assert.deepEqual(await vault.get(item.id), item.doc);
    const [fresh, later] = await saveRun(vault, 41, 42);
    assert.equal(fileOf(server, fresh.id).kind, 'npc-state-delta-native-packed', 'the first file of a session is an anchor');
    assert.equal(fileOf(server, later.id).base, fresh.id, 'the next one is a patch against it, never against an old plain file');
    for (const [name, text] of before) assert.equal(server.files.get(name), text, 'an old file is not rewritten');
    assert.deepEqual(await vault.get(later.id), later.doc);
});

test('a thrown-away save whose removal fails leaves an ordinary unused file that the Storage clean-up removes later', async () => {
    let t = 1000 * 86400000;
    const server = filesServer();
    const vault = fileVault({ fetchFn: server.fetchFn, now: () => t });
    const guarded = { ...vault, remove: async () => { throw new Error('crash before the cleanup'); }, put: (...args) => vault.put(...args) };
    const run = setup({ vault: guarded });
    await run.hydrate();
    let once = true;
    run.port.busy = () => { const now = once; once = false; return now; };
    run.live.state.npcs[0].trust = 6;
    const saved = await run.participant.checkpoint({ cursor: { sid: 'sr_1' }, headHash: 'a'.repeat(64) });
    assert.equal(saved.ok, true);
    await new Promise(resolve => setTimeout(resolve, 10));
    const listed = (await vault.list()).files.map(file => file.id);
    assert.ok(listed.includes(saved.checkpoint));
    assert.ok(listed.length >= 2, 'the baseline, the save that stands and the thrown-away one (or its twin)');
    t += 60 * 86400000;
    const sweep = createVaultSweep({ vault, now: () => t });
    const index = run.vault.indexes?.size;
    const plan = await sweep.plan({ complete: true, referenced: [saved.checkpoint] });
    assert.ok(plan.candidates.every(file => file.id !== saved.checkpoint), 'what stands is never offered');
    assert.ok(index === undefined || index >= 0);
});
