// The registry's lifecycle (docs/v2/LIFECYCLE.md): peer readiness, cycles, the restore barrier and
// held-back modules, extracted from registry.js. It owns the peer and switch state and returns
// the lookup and host-control methods registry.js exposes.

import { satisfies } from '../packs/version.js';
import { HOST_MODULE, RESTORE_STATES } from '../registry-checks.js';

export function createLifecycle({ defs }) {
    // Each module's peers as they were when it registered (module id → [{ peer, range }]), like
    // `declared` above: a definition changed afterwards changes nothing.
    const peerNeeds = new Map();
    // Modules switched off by the host (id → reason), and the restore barrier (setRestore).
    const switchedOff = new Map();
    let barrier = { state: 'idle', reason: '' };
    let barrierEpoch = 0;
    // id → { status: 'ready'|'dormant', reason }: the peers' verdict, without the barrier. Cleared
    // whenever a module registers or is switched on or off; worked out again when next asked.
    let lifeCache = null;
    const nameOf = id => (typeof defs.get(id)?.name === 'string' && defs.get(id).name ? defs.get(id).name : id);

    // The ids from `id` back to `id` along registered peers (['a', 'b', 'a']), or null when `id` is on no cycle.
    function cycleFrom(id) {
        const seen = new Set();
        const walk = (at, path) => {
            for (const { peer } of peerNeeds.get(at) ?? []) {
                if (!defs.has(peer)) continue;
                if (peer === id) return [...path, id];
                if (seen.has(peer)) continue;
                seen.add(peer);
                const found = walk(peer, [...path, peer]);
                if (found) return found;
            }
            return null;
        };
        return walk(id, [id]);
    }

    function peerVerdicts() {
        if (lifeCache) return lifeCache;
        const verdicts = new Map();
        const ids = [...defs.keys()].sort();
        for (const id of ids) {
            if (switchedOff.has(id)) { verdicts.set(id, { status: 'dormant', reason: switchedOff.get(id) }); continue; }
            const cycle = cycleFrom(id);
            if (cycle) verdicts.set(id, { status: 'dormant', reason: `Its peers need each other (${cycle.join(' → ')}), so none of them can start.` });
            else verdicts.set(id, { status: 'ready', reason: null });
        }
        // A peer's own readiness can only take more modules down, so this settles in a few rounds.
        for (let changed = true; changed;) {
            changed = false;
            for (const id of ids) {
                if (verdicts.get(id).status !== 'ready') continue;
                const unmet = [];
                for (const { peer, range } of peerNeeds.get(id) ?? []) {
                    const other = defs.get(peer);
                    if (!other) { unmet.push(`Needs ${peer} ${range}, which is not installed.`); continue; }
                    const version = typeof other.version === 'string' ? other.version : '';
                    if (!satisfies(version, range)) { unmet.push(`Needs ${peer} ${range}; the one installed is ${version || 'of unknown version'}.`); continue; }
                    const theirs = verdicts.get(peer);
                    if (theirs.status !== 'ready') unmet.push(`Needs ${nameOf(peer)}, which is not ready: ${theirs.reason}`);
                }
                if (unmet.length) { verdicts.set(id, { status: 'dormant', reason: unmet.join(' ') }); changed = true; }
            }
        }
        lifeCache = verdicts;
        return verdicts;
    }

    const BARRIER_REASON = 'A restore is in progress; every part must agree before the story goes on.';

    /** `{ status: 'ready'|'dormant'|'restore-pending', reason: string|null }` of a registered module, else null. */
    function lifecycle(id) {
        const base = peerVerdicts().get(id);
        if (!base) return null;
        if (barrier.state === 'pending') return { status: 'restore-pending', reason: barrier.reason || BARRIER_REASON };
        return { status: base.status, reason: base.reason };
    }

    // Is module `id` held back (dormant, or the restore barrier is up and it is not Story Block's own)?
    function held(id) {
        const base = peerVerdicts().get(id);
        if (!base) return false;
        return base.status === 'dormant' || (barrier.state === 'pending' && id !== HOST_MODULE);
    }

    /**
     * Host-internal: switch module `id` off (dormant, with `reason`) or on again. Story Block's own
     * module cannot be switched off. → whether anything changed.
     */
    const setEnabled = (id, on, reason = 'Turned off.') => {
        if (!defs.has(id) || id === HOST_MODULE) return false;
        const was = switchedOff.has(id);
        if (on === false) switchedOff.set(id, String(reason || 'Turned off.'));
        else switchedOff.delete(id);
        lifeCache = null;
        return was !== switchedOff.has(id);
    };
    /** The restore barrier: `{ state: 'idle'|'pending'|'failed', reason }`. */
    const restore = () => ({ ...barrier });
    /** Changes when a new restore barrier is raised, not when its reason changes. */
    const restoreEpoch = () => barrierEpoch;
    /**
     * Host-internal: raise or drop the restore barrier (the save-point package drives it; tests use it).
     * While 'pending', no module but Story Block's own is ready (see held). 'failed' is only reported
     * (sdk.preflight): it holds nothing.
     */
    const setRestore = (state, reason = '', { temporary = false } = {}) => {
        if (!RESTORE_STATES.includes(state)) throw new Error(`Story Suite: a restore is ${RESTORE_STATES.join(', ')}, not "${state}".`);
        if (!temporary && state === 'pending' && barrier.state !== 'pending') barrierEpoch += 1;
        barrier = { state, reason: state === 'idle' ? '' : String(reason ?? '') };
    };
    /** [{ module, range }] the peers module `id` named when it registered. */
    const peers = id => (peerNeeds.get(id) ?? []).map(({ peer, range }) => ({ module: peer, range }));
    function setPeers(id, list) {
        peerNeeds.set(id, list);
        lifeCache = null;
    }

    return { lifecycle, held, setEnabled, restore, restoreEpoch, setRestore, peers, setPeers, nameOf };
}
