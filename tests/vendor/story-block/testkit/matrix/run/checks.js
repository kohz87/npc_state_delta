// State checks and host probes for the matrix runner, moved unchanged from run.js: no store problems,
// a cold rebuild from the chat, changed facts, the fresh-host oracle, dormancy, registration and the
// held-back first message.

import assert from 'node:assert/strict';
import { createStore } from '../../../src/v2/store.js';
import { createCommandBus } from '../../../src/v2/commands.js';
import { MODULES } from '../modules.js';
import { keysOf, activeOf, label, factsOf, withHost, runSetups, play } from './host.js';

const gap = detail => ({ gap: detail });
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
    const chat = structuredClone(host.ctx.chat);
    const metadata = structuredClone(host.ctx.chatMetadata ?? {});
    const fresh = createStore({ chat: () => chat, metadata: () => metadata, save: () => {}, validate, scratch: name => registry.scratch(name) });
    // As on a real reload, the bus attaches the owners' replay guards before the first store read.
    createCommandBus({ store: fresh, registry, settings: id => host.sdk.settings(id) });
    fresh.ensureInitial(registry.initialState());
    assert.deepEqual(fresh.head().domains, host.head().domains, `a cold rebuild from the chat's records is not the live state${when}`);
    assert.deepEqual(fresh.problems(), [], `a cold rebuild reports problems${when}`);
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

export { gap, noProblems, replayed, changed, oracle, dormancy, checkRegistered, gapNote, heldBack };
