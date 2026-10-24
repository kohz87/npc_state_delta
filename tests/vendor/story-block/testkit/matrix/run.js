// The matrix runner (docs/v2/MATRIX.md): for each combination row it boots the real module definitions
// in createHost, registers them once, plays a scripted reply, runs each module's action and replays
// the chat cold, then the §2 extra cases (docs/v2/contract/RB_CONTRACT.md): missing query, malformed
// answer, feature off, unset clock, late registration, duplicate name, swipe, re-read and delete.
//
// What is compared is never a hand-written number: a module's facts after a swipe, a delete or a
// re-read must equal the facts of a fresh host that only played the replies that are left. A cold
// rebuild from the chat's records must equal the live state. A hostile peer (a stand-in that answers
// the real peer's query names badly) is the one stub here, and it stands in for a *peer*, never for the
// module under test.
//
// A result is { row, id, status, detail }, status: pass | fail | gap | na | skip.
//   gap:  a known gap, not a failure (RB does not yet go dormant without SD); `strict` fails it. A gap
//         closes by itself: once the host reports `status` in sdk.modules(), the same check is strict.
//   na:   the case does not apply to the row.
//   todo: the case applies, but today's host cannot express it yet (a row of its own once it can).
//   skip: a module the row needs is not checked out.

import assert from 'node:assert/strict';
import { createHost } from '../host.js';
import { createStore } from '../../src/v2/store.js';
import { MODULES, ORDER } from './modules.js';
import { CASES, NOT_EXPRESSIBLE, ROWS } from './rows.js';

const gap = detail => ({ gap: detail });
const na = detail => ({ na: detail });
const todo = detail => ({ todo: detail });
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 360);
const label = key => (key === 'sb' ? 'SB' : MODULES[key].label);
const PEER_QUERIES = { sd: ['director.time', 'director.threads'], nsd: ['npc.present', 'npc.dossier'] };

function seededCrypto(seed) {
    let x = seed | 0;
    const next = () => {
        x = (x + 0x9E3779B9) | 0;
        let z = x;
        z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B);
        z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35);
        return (z ^ (z >>> 16)) >>> 0;
    };
    return {
        getRandomValues(array) {
            for (let i = 0; i < array.length; i += 1) array[i] = array instanceof Uint8Array ? next() & 0xFF : next();
            return array;
        },
        randomUUID: () => `00000000-0000-4000-8000-${String(next()).padStart(12, '0').slice(0, 12)}`,
    };
}

/**
 * A host with Story Block's core and the given module keys (registered in ORDER, `withhold` left
 * out for a late registration, `extra` definitions after them). Receipt ids and seeds come from a seeded
 * counter while it lives, console warnings are kept in `host.noise`, and `globalThis.StoryBlock` is the
 * host's, as in SillyTavern; `await host.release()` puts all of that back.
 */
async function boot(env, keys, { withhold = [], extra = [] } = {}) {
    const ref = { sdk: null };
    const definitions = ORDER.filter(key => keys.includes(key) && !withhold.includes(key)).map(key => env.loaded[key].make(ref));
    const savedCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const savedConsole = { warn: console.warn, error: console.error, log: console.log, info: console.info };
    const savedBlock = Object.getOwnPropertyDescriptor(globalThis, 'StoryBlock');
    const noise = [];
    const restore = () => {
        console.warn = savedConsole.warn;
        console.error = savedConsole.error;
        console.log = savedConsole.log;
        console.info = savedConsole.info;
        if (savedBlock) Object.defineProperty(globalThis, 'StoryBlock', savedBlock); else delete globalThis.StoryBlock;
        if (savedCrypto) Object.defineProperty(globalThis, 'crypto', savedCrypto);
    };
    Object.defineProperty(globalThis, 'crypto', { value: seededCrypto(1), configurable: true, writable: true });
    console.warn = (...args) => { noise.push(['warn', oneLine(args.join(' '))]); };
    console.error = (...args) => { noise.push(['error', oneLine(args.join(' '))]); };
    console.log = (...args) => { noise.push(['log', oneLine(args.join(' '))]); };
    console.info = console.log;
    let host;
    try {
        host = await createHost({ modules: [...definitions, ...extra] });
    } catch (error) {
        restore();
        throw error;
    }
    ref.sdk = host.sdk;
    globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(host.sdk), sdk: host.sdk };
    const close = host.close;
    // `release` puts the globals back after the host's last timers have run (the assist helpers log late).
    host.release = async () => {
        close();
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        restore();
    };
    host.noise = noise;
    host.ref = ref;
    return host;
}

async function withHost(env, keys, options, fn) {
    const host = await boot(env, keys, options);
    try { return await fn(host); } finally { await host.release(); }
}

const keysOf = (row, keys = row.modules) => ['sb', ...ORDER.filter(key => keys.includes(key))];
/** The modules whose scripts run: the row's, less those it expects dormant. */
const activeOf = row => row.modules.filter(key => !row.dormant.includes(key));
const linesFor = (keys, set) => keysOf({}, keys).flatMap(key => MODULES[key][set]);
const replyText = (keys, set) => `The ${set} reply.\n\n<Changes>\n${linesFor(keys, set).join('\n')}\n</Changes>`;
const factsOf = (host, keys) => Object.fromEntries(keysOf({}, keys).map(key => [key, MODULES[key].facts(host)]));

async function runSetups(host, keys) {
    for (const key of ORDER.filter(entry => keys.includes(entry))) if (MODULES[key].setup) await MODULES[key].setup(host);
}
async function play(host, keys, set) {
    const sent = await host.send(`Turn ${set}.`, replyText(keys, set));
    if (sent.aborted) throw new Error(`the reply ${set} was held back: ${host.st.notices.map(item => `"${item.reason}"`).join(', ') || 'no reason given'}`);
    return sent;
}

const noProblems = host => assert.deepEqual(host.store.problems(), [], 'the store reports problems');
/**
 * A cold rebuild: a second store over the same chat, set up the way a reload does it (the registry's
 * initial state for a first carrier that lacks one), must read the state the live store has.
 */
function replayed(host, when = '') {
    assert.ok(host.ctx.chat.some(message => !message.is_user && message.extra?.storySuite?.ops?.length), 'no reply was recorded, so there is nothing to replay');
    const registry = host.registry;
    const validate = (state, names) => names.flatMap(name => {
        const fn = registry.validator(name);
        const errors = typeof fn === 'function' ? fn(state?.domains?.[name], state) : [];
        return Array.isArray(errors) ? errors.map(String) : [];
    });
    const fresh = createStore({ chat: () => host.ctx.chat, save: () => {}, validate, scratch: name => registry.scratch(name) });
    fresh.ensureInitial(registry.initialState());
    assert.deepEqual(fresh.head().domains, host.head().domains, `a cold rebuild from the chat's records is not the live state${when}`);
}
function changed(before, after, keys, what) {
    for (const key of keysOf({}, keys)) assert.notDeepEqual(after[key], before[key], `${label(key)}: ${what} changed nothing it keeps`);
}

/** The facts a fresh host ends with after `plays` ([{ set, keys? }]), the oracle for the swipe, re-read, delete and late cases. */
async function oracle(env, row, plays, { keys = activeOf(row) } = {}) {
    return withHost(env, row.modules, {}, async host => {
        await runSetups(host, keys);
        for (const entry of plays) await play(host, entry.keys ?? keys, entry.set);
        return factsOf(host, keys);
    });
}

function queryNames(env, key) {
    try {
        const def = env.loaded[key].make({ sdk: null });
        const names = Object.keys(def.queries ?? {});
        if (names.length) return names;
    } catch { /* falls back below */ }
    return PEER_QUERIES[key];
}

/** A stand-in for a peer module: its real query names, each answering badly (`mode`). */
function hostilePeer(env, key, mode, tally) {
    const answer = {
        throws: () => { throw new Error('matrix: the peer query failed'); },
        null: () => null,
        garbage: () => ({ api: 99, enabled: 'yes', clock: [], tiers: 7, minutes: 'soon' }),
    }[mode];
    return {
        id: MODULES[key].id,
        name: `${MODULES[key].label} (matrix stand-in)`,
        version: '0.0.0',
        queries: Object.fromEntries(queryNames(env, key).map(name => [name, (...args) => { tally.asked += 1; return answer(...args); }])),
    };
}

/** Whether module `key` is dormant on `host`. A real status is strict; before the lifecycle exists it is a gap. */
async function dormancy(host, key, why, { probe = false } = {}) {
    const spec = MODULES[key];
    const entry = host.sdk.modules().find(item => item.id === spec.id);
    assert.ok(entry, `${spec.label} is not registered`);
    if (Object.hasOwn(entry, 'status')) {
        assert.equal(entry.status, 'dormant', `${spec.label} should be dormant ${why}`);
        assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), `${spec.label} is dormant but says no reason`);
        if (spec.setup) {
            let refused = false;
            try { await spec.setup(host); } catch { refused = true; }
            assert.ok(refused, `${spec.label} is dormant but still ran its setup command`);
        }
        return null;
    }
    let held = '';
    if (probe) {
        const sent = await host.send('Turn.', 'A quiet reply.');
        if (sent.aborted) held = `; the reader's first message is held back (${host.st.notices.map(item => `"${item.reason}"`).join(', ') || 'no reason given'})`;
    }
    let works = false;
    try { await spec.setup?.(host); works = true; } catch { works = false; }
    return gap(`${spec.label} is not dormant ${why}: sdk.modules() has no status yet, its setup command ${works ? 'ran' : 'was refused'}${held}`);
}

function checkRegistered(host, row) {
    const modules = host.sdk.modules();
    const ids = modules.map(entry => entry.id);
    assert.equal(new Set(ids).size, ids.length, `a module is listed twice: ${ids.join(', ')}`);
    for (const key of keysOf(row)) {
        const entry = modules.find(item => item.id === MODULES[key].id);
        assert.ok(entry, `${label(key)} is not registered (have ${ids.join(', ')})`);
        if (Object.hasOwn(entry, 'status') && !row.dormant.includes(key)) assert.equal(entry.status, 'ready', `${label(key)} should be ready`);
    }
    assert.equal(ids.length, keysOf(row).length, `expected ${keysOf(row).length} modules, have ${ids.join(', ')}`);
    assert.deepEqual(host.st.notices, [], 'a generation was held back at boot');
}

// ---- the recorder ------------------------------------------------------------------------------------

function recorder(results, row, strict, lenient = null) {
    const add = (id, status, detail = '', raw = '') => results.push({ row: row.name, id, status, detail, ...(raw ? { raw } : {}) });
    return {
        add,
        async step(id, fn) {
            try {
                const out = await fn();
                if (out?.gap) add(id, strict ? 'fail' : 'gap', `${strict ? 'strict: ' : ''}${out.gap}`);
                else if (out?.na) add(id, 'na', out.na);
                else if (out?.todo) add(id, 'todo', out.todo);
                else add(id, 'pass', out?.note ?? '');
            } catch (error) {
                const why = oneLine(error?.message ?? error);
                // A negative row while the module that should be dormant still blocks generation: the others
                // cannot work, which is the known gap, not a second failure.
                if (lenient) add(id, strict ? 'fail' : 'gap', `${strict ? 'strict: ' : ''}${lenient}`, why);
                else add(id, 'fail', why);
            }
        },
    };
}
const gapNote = gaps => (gaps.length ? gap([...new Set(gaps)].join('; ')) : undefined);

/**
 * For a negative row: why the other modules cannot work yet, or null. Only while the host has no module
 * status (no lifecycle) and a dormant-to-be module still holds the reader's first message back.
 */
async function heldBack(env, row) {
    return withHost(env, row.modules, {}, async host => {
        if (host.sdk.modules().some(entry => Object.hasOwn(entry, 'status'))) return null;
        const sent = await host.send('Turn.', 'A quiet reply.');
        if (!sent.aborted) return null;
        const who = row.dormant.map(key => label(key)).join(', ');
        return `${who} is not dormant yet and holds the reader's first message back (${host.st.notices.map(item => `"${item.reason}"`).join(', ')})`;
    });
}

// ---- the basic run -----------------------------------------------------------------------------------

async function basics(env, row, rec) {
    const active = activeOf(row);
    let host = null;
    try {
        await rec.step('register', async () => {
            host = await boot(env, row.modules);
            checkRegistered(host, row);
        });
        if (!host) {
            for (const id of ['reply', 'action', 'replay', 'prompt']) rec.add(id, 'fail', 'the host did not boot');
        } else {
            const initial = factsOf(host, active);
            await rec.step('reply', async () => {
                await runSetups(host, active);
                await play(host, active, 'A');
                noProblems(host);
                changed(initial, factsOf(host, active), active, 'the scripted reply');
                const errors = host.noise.filter(([level]) => level === 'error');
                assert.deepEqual(errors, [], 'console errors while playing');
            });
            await rec.step('action', async () => {
                for (const key of keysOf(row, active)) {
                    const watch = MODULES[key].watch ?? MODULES[key].facts;
                    const before = watch(host);
                    const [type, payload] = MODULES[key].action(host);
                    const result = await host.sdk.command(type, payload);
                    assert.ok(result.ok, `${label(key)} ${type} was refused: ${result.message}`);
                    assert.notDeepEqual(watch(host), before, `${label(key)} ${type} changed nothing it keeps`);
                }
                noProblems(host);
            });
            await rec.step('replay', async () => { replayed(host, ' (after the actions)'); });
            await rec.step('prompt', async () => {
                await play(host, active, 'B');
                noProblems(host);
                replayed(host, ' (after the second reply)');
                const statics = [...new Set(host.st.promptLog.filter(entry => entry.key === 'story_suite_static' && entry.value).map(entry => entry.value))];
                assert.equal(statics.length, 1, `the static prompt part changed between replies (${statics.length} versions)`);
            });
        }
    } finally {
        await host?.release();
    }
    if (row.dormant.length) {
        await rec.step('dormant', async () => {
            const gaps = [];
            await withHost(env, row.modules, {}, async dormantHost => {
                for (const key of row.dormant) gaps.push((await dormancy(dormantHost, key, 'without SD', { probe: true }))?.gap);
            });
            return gapNote(gaps.filter(Boolean));
        });
    } else {
        rec.add('dormant', 'na', 'no module is expected dormant in this row');
    }
}

// ---- the §2 extra cases ------------------------------------------------------------------------------

async function missingQuery(env, row, rec) {
    await rec.step('missing-query', async () => {
        const absent = ['sd', 'nsd'].filter(key => !row.modules.includes(key));
        if (!absent.length) return na('every peer is in this row');
        const active = activeOf(row);
        await withHost(env, row.modules, {}, async host => {
            for (const key of absent) {
                for (const name of queryNames(env, key)) {
                    assert.throws(() => host.sdk.query(name), /no module answers the query/, `${name} (${label(key)}, absent) should be an unknown query`);
                }
            }
            assert.throws(() => host.sdk.query('matrix.nothing'), /no module answers the query/);
            const initial = factsOf(host, active);
            await runSetups(host, active);
            await play(host, active, 'A');
            noProblems(host);
            changed(initial, factsOf(host, active), active, 'a reply after the missing queries');
            replayed(host);
        });
    });
}

async function malformed(env, row, rec) {
    await rec.step('malformed', async () => {
        const absent = ['sd', 'nsd'].filter(key => !row.modules.includes(key));
        if (!absent.length) return na('every peer is in this row');
        const active = activeOf(row);
        const gaps = [];
        const tally = { asked: 0 };
        for (const peer of absent) {
            for (const mode of ['throws', 'null', 'garbage']) {
                const where = `${label(peer)} stand-in answering "${mode}"`;
                try {
                    await withHost(env, row.modules, { extra: [hostilePeer(env, peer, mode, tally)] }, async host => {
                        const initial = factsOf(host, active);
                        await runSetups(host, active);
                        await play(host, active, 'A');
                        noProblems(host);
                        changed(initial, factsOf(host, active), active, 'a reply');
                        replayed(host);
                        const errors = host.noise.filter(([level]) => level === 'error');
                        assert.deepEqual(errors, [], 'console errors');
                        if (peer === 'sd') for (const key of row.dormant) gaps.push((await dormancy(host, key, `with a malformed ${label(peer)}`))?.gap);
                    });
                } catch (error) {
                    throw new Error(`${where}: ${error.message}`);
                }
            }
        }
        return gapNote(gaps.filter(Boolean)) ?? { note: `${absent.map(label).join(', ')} stood in 3 ways each; the modules asked ${tally.asked} times` };
    });
}

async function featureOff(env, row, rec) {
    await rec.step('feature-off', async () => {
        const active = activeOf(row);
        const notes = [];
        for (const key of keysOf(row)) {
            await withHost(env, row.modules, {}, async host => {
                const entry = host.sdk.modules().find(item => item.id === MODULES[key].id);
                const ids = entry?.features ?? [];
                if (!ids.length) { notes.push(`${label(key)} declares no features`); return; }
                for (const id of ids) {
                    host.features.set(id, false);
                    assert.equal(host.sdk.feature(id), false, `${id} did not turn off`);
                }
                const initial = factsOf(host, active);
                await runSetups(host, active);
                await play(host, active, 'A');
                noProblems(host);
                const others = active.filter(other => other !== key);
                changed(initial, factsOf(host, active), key === 'sb' ? others : [...others], `a reply with ${label(key)}'s features off, for the others,`);
                replayed(host, ` (${label(key)} features off)`);
                for (const id of ids) host.features.set(id, true);
                await play(host, active, 'B');
                noProblems(host);
                replayed(host, ` (${label(key)} features back on)`);
            });
        }
        return notes.length ? { note: notes.join('; ') } : undefined;
    });
}

async function unsetClock(env, row, rec) {
    await rec.step('unset-clock', async () => {
        if (!row.modules.includes('sd')) return na('there is no story clock without SD');
        const active = activeOf(row);
        const quiet = keysOf(row, active).flatMap(key => MODULES[key].A.filter(line => !line.startsWith('~ time')));
        return withHost(env, row.modules, {}, async host => {
            await runSetups(host, active);
            await host.send('Turn A.', `A reply with no time.\n\n<Changes>\n${quiet.join('\n')}\n</Changes>`);
            noProblems(host);
            assert.equal(host.head().domains.director.time.minutes, null, 'the clock should still be unset');
            assert.ok(MODULES.sd.facts(host).quests.length, 'SD should still create a quest with the clock unset');
            replayed(host);
            if (!active.includes('rb')) return { note: 'creation and views work; no timed action in this row' };
            const rest = await host.sdk.command('party.rest', { kind: 'short' });
            if (rest.ok) return gap('RB ran a timed action (party.rest) with the clock unset; CLOCK_UNSET lands with RB\'s dependency work');
            assert.equal(rest.code, 'CLOCK_UNSET', `a timed action with the clock unset was refused with ${rest.code}: ${rest.message}`);
            return undefined;
        });
    });
}

async function disabledSd(env, row, rec) {
    await rec.step('disabled-sd', async () => {
        if (!row.modules.includes('sd')) return na('there is no SD in this row to disable');
        return todo(NOT_EXPRESSIBLE['disabled-SD']);
    });
}

async function lateRegistration(env, row, rec) {
    await rec.step('late', async () => {
        const order = ORDER.filter(key => row.modules.includes(key));
        const late = order.at(-1);
        if (!late) return na('SB alone has no module to register late');
        const early = row.modules.filter(key => key !== late);
        const activeEarly = early.filter(key => !row.dormant.includes(key));
        const active = activeOf(row);
        const expected = await oracle(env, row, [{ set: 'A', keys: activeEarly }, { set: 'B' }]);
        const gaps = [];
        await withHost(env, row.modules, { withhold: [late] }, async host => {
            await runSetups(host, activeEarly);
            await play(host, activeEarly, 'A');
            const before = factsOf(host, activeEarly);
            await host.sdk.registerModule(env.loaded[late].make(host.ref));
            const ids = host.sdk.modules().map(entry => entry.id);
            assert.equal(ids.filter(id => id === MODULES[late].id).length, 1, `${label(late)} is not listed exactly once after a late registration (${ids.join(', ')})`);
            assert.deepEqual(factsOf(host, activeEarly), before, 'registering a module changed what the others keep');
            noProblems(host);
            if (row.dormant.includes(late)) gaps.push((await dormancy(host, late, 'when registered late'))?.gap);
            else await runSetups(host, [late]);
            await play(host, active, 'B');
            noProblems(host);
            assert.deepEqual(factsOf(host, active), expected, 'a late registration should end where a boot with all of them does');
            replayed(host);
        });
        return gapNote(gaps.filter(Boolean));
    });
}

async function duplicateName(env, row, rec) {
    await rec.step('duplicate', async () => {
        const active = activeOf(row);
        const notes = [];
        await withHost(env, row.modules, {}, async host => {
            const before = host.sdk.modules().map(entry => entry.id);
            for (const key of row.modules) {
                await assert.rejects(() => host.sdk.registerModule(env.loaded[key].make(host.ref)), /already registered/, `${label(key)} registered twice`);
            }
            for (const key of keysOf(row)) {
                const name = key === 'sb' ? 'scene.place' : queryNames(env, key)[0];
                const owner = MODULES[key].id;
                await assert.rejects(
                    () => host.sdk.registerModule({ id: 'matrix-clash', name: 'Clash', version: '1.0.0', queries: { [name]: () => 'taken' } }),
                    new RegExp(`already belongs to "${owner}"`),
                    `a second owner of ${name} should be refused`,
                );
            }
            assert.deepEqual(host.sdk.modules().map(entry => entry.id), before, 'a refused registration changed the module list');
            const initial = factsOf(host, active);
            await runSetups(host, active);
            await play(host, active, 'A');
            noProblems(host);
            changed(initial, factsOf(host, active), active, 'a reply after the refusals');
            replayed(host);
            notes.push(`${row.modules.length} ids and ${keysOf(row).length} claimed names refused`);
        });
        return { note: notes.join('; ') };
    });
}

/** Plays A then B on `host`; → the index of reply B. */
async function twoReplies(host, active) {
    await runSetups(host, active);
    await play(host, active, 'A');
    await play(host, active, 'B');
    return host.ctx.chat.length - 1;
}

async function swipe(env, row, rec) {
    await rec.step('swipe', async () => {
        const active = activeOf(row);
        const afterC = await oracle(env, row, [{ set: 'A' }, { set: 'C' }]);
        const afterB = await oracle(env, row, [{ set: 'A' }, { set: 'B' }]);
        await withHost(env, row.modules, {}, async host => {
            const index = await twoReplies(host, active);
            assert.deepEqual(factsOf(host, active), afterB, 'the two replies are not what a fresh host keeps');
            await host.swipe(replyText(active, 'C'));
            noProblems(host);
            assert.deepEqual(factsOf(host, active), afterC, 'after a swipe the state should be as if only the new swipe was written');
            replayed(host, ' (after the swipe)');
            await host.st.swipeTo(index, 0);
            noProblems(host);
            assert.deepEqual(factsOf(host, active), afterB, 'swiping back should bring the first swipe\'s state back');
            replayed(host, ' (after swiping back)');
        });
    });
}

async function reread(env, row, rec) {
    await rec.step('re-read', async () => {
        const active = activeOf(row);
        const afterC = await oracle(env, row, [{ set: 'A' }, { set: 'C' }]);
        await withHost(env, row.modules, {}, async host => {
            const index = await twoReplies(host, active);
            await host.st.editMessage(index, replyText(active, 'C'));
            const done = await host.sdk.reread(index);
            assert.ok(done.ok, `re-read: ${done.message}`);
            noProblems(host);
            assert.deepEqual(factsOf(host, active), afterC, 're-reading the edited reply should leave the state of the edited text');
            replayed(host, ' (after the re-read)');
        });
    });
}

async function deleteMessage(env, row, rec) {
    await rec.step('delete', async () => {
        const active = activeOf(row);
        // Replies A, B, C sit at 2, 4 and 6 (the greeting is 0, the reader's messages the odd ones).
        const left = {
            last: [await oracle(env, row, [{ set: 'A' }, { set: 'B' }]), 6],
            middle: [await oracle(env, row, [{ set: 'A' }, { set: 'C' }]), 4],
            first: [await oracle(env, row, [{ set: 'B' }, { set: 'C' }]), 2],
        };
        for (const [which, [expected, index]] of Object.entries(left)) {
            await withHost(env, row.modules, {}, async host => {
                await twoReplies(host, active);
                await play(host, active, 'C');
                assert.equal(host.ctx.chat.length, 7);
                await host.st.deleteMessage(index);
                noProblems(host);
                assert.deepEqual(factsOf(host, active), expected, `deleting the ${which} reply should leave the other two`);
                replayed(host, ` (after deleting the ${which} reply)`);
            });
        }
    });
}

// ---- the whole run -----------------------------------------------------------------------------------

/**
 * Runs the rows. `options`: { loaded, missing?, broken? } (loadModules), `rows?` (names), `only?` (module key:
 * just the rows that include it), `cases?` (ids), `strict?` (a known gap fails), `onResult?`.
 * → { results, ok, counts }
 */
export async function runMatrix({ loaded = {}, missing = {}, broken = {}, rows = null, only = null, cases = null, strict = false, onResult = null } = {}) {
    const env = { loaded };
    const results = [];
    const selected = ROWS.filter(row => (!rows || rows.includes(row.name)) && (!only || row.modules.includes(only) || (only === 'sb')));
    for (const row of selected) {
        const blocked = row.modules.filter(key => !loaded[key]);
        if (blocked.length) {
            const rec = recorder(results, row, strict);
            for (const [id] of CASES) {
                const why = blocked.map(key => (broken[key] ? `${label(key)} does not load: ${oneLine(broken[key].message)}` : `${label(key)}: ${missing[key] ?? 'not checked out'}`)).join('; ');
                rec.add(id, blocked.some(key => broken[key]) ? 'fail' : 'skip', why);
            }
            continue;
        }
        const rec = recorder(results, row, strict, row.dormant.length ? await heldBack(env, row) : null);
        const wanted = id => !cases || cases.includes(id);
        const quiet = { add: (...args) => { if (wanted(args[0])) rec.add(...args); }, step: (id, fn) => (wanted(id) ? rec.step(id, fn) : undefined) };
        await basics(env, row, quiet);
        for (const run of [missingQuery, malformed, featureOff, unsetClock, disabledSd, lateRegistration, duplicateName, swipe, reread, deleteMessage]) await run(env, row, quiet);
    }
    if (onResult) for (const result of results) onResult(result);
    const counts = {};
    for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1;
    return { results, counts, ok: !results.some(result => result.status === 'fail'), notExpressible: NOT_EXPRESSIBLE };
}
