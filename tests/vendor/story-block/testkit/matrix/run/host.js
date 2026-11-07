// Host setup and scripted-play helpers for the matrix runner, moved unchanged from run.js: the seeded
// crypto and global swap around createHost, the live host wrapper, module keys, reply text, module facts,
// setup/play and the peer query stand-in.

import { createHost } from '../../host.js';
import { MODULES, ORDER } from '../modules.js';

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

export { oneLine, label, boot, withHost, keysOf, activeOf, replyText, factsOf, runSetups, play, queryNames, hostilePeer };
