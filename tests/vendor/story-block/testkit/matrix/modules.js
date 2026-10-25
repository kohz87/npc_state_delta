// The module loaders and scripts of the combination matrix (docs/v2/MATRIX.md): each module's real
// definition is imported from its checkout by path and given a scripted reply, an action and a few
// facts to read back. Nothing here stubs a module; a module that is not checked out is simply absent
// and the rows that need it are skipped.
//
// A module entry (`MODULES[key]`):
//   * `dir`, `entry`: the folder name next to the others and the file that builds the definition;
//   * `make(imported, ref)`: a fresh definition; `ref.sdk` is the host's sdk once it is up (set after
//     createHost), for the modules whose settings come through it;
//   * `A`, `B`, `C`: three replies' change lines (A first, B second, C the swipe / re-read text);
//   * `setup(host)`: commands run before the first reply (RPG Battle makes its party);
//   * `action(host)` → [type, payload]: the reader's action, run after reply A;
//   * `watch(host)` (optional): what the action is expected to change when `facts` does not show it;
//   * `facts(host)`: a plain projection of what the module keeps, to compare with a host that
//     only played the replies that should be left (never ids, which differ from host to host).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The order modules are registered in (the same as the suite helpers); Story Block's core is always first. */
export const ORDER = ['rb', 'sd', 'nsd'];

const asObject = value => (value && typeof value === 'object' ? value : {});

export const MODULES = {
    sb: {
        id: 'story-block',
        label: 'SB',
        A: ['~ place Bluewatch Village | kind: settlement', '+ item Torch | qty: 2', '+ present Odda'],
        B: ['~ place Millbrook | kind: settlement', '+ item Rope'],
        C: ['~ place Harrow | kind: settlement', '+ item Lantern | qty: 3'],
        action: host => {
            const stack = Object.values(host.head().domains.inventory.stacks).find(entry => host.head().domains.inventory.defs[entry.def]?.name === 'Torch');
            return ['inventory.drop', { stack: stack?.id, qty: 1 }];
        },
        facts: host => {
            const { scene, inventory } = host.head().domains;
            const items = {};
            for (const stack of Object.values(inventory.stacks)) {
                const name = inventory.defs[stack.def]?.name ?? stack.def;
                items[name] = (items[name] ?? 0) + stack.qty;
            }
            // Who is present is left out: a move leaves them behind, so it depends on the replies before it.
            return { place: scene.place.name, items };
        },
    },
    sd: {
        id: 'story-director',
        label: 'SD',
        dir: 'Story_director',
        entry: 'src/v2/module.js',
        make: (imported, ref) => imported.createModule({
            host: { settings: id => ref.sdk?.settings(id) ?? null, substitute: text => ref.sdk?.substitute(text) },
        }),
        A: ['~ time June 3, 1200, 08:00 am', '+ hook Lost Letter — Orsa lost a letter | giver: Orsa | goal: Find the letter'],
        B: ['~ time June 3, 1200, 10:00 am', '+ hook The Farm — news from the farm | goal: Talk to the farmer'],
        C: ['~ time June 3, 1200, 09:00 am', '+ hook The Mill — news from the mill | goal: Talk to the miller'],
        action: async host => {
            const thread = 'th_matrix01';
            const offered = await host.sdk.command('threads.offer', {
                write: 'wr_matrix01', thread, kind: 'hook', key: 'Read the letter',
                summary: 'Hear what Orsa has to say', fields: { goal: 'Talk to Orsa' }, expectedHash: null,
            });
            if (!offered.ok) throw new Error(`threads.offer: ${offered.message}`);
            return ['threads.accept', { write: 'wr_matrix02', thread, expectedHash: host.sdk.query('threads.hash', { thread }) }];
        },
        facts: host => ({
            minutes: host.head().domains.director?.time?.minutes ?? null,
            goals: host.sdk.query('director.threads', { kind: 'hook' }).map(thread => `${thread.key}:${thread.status}:${thread.acceptance ? 'accepted' : 'open'}`).sort(),
        }),
    },
    nsd: {
        id: 'npc-state-delta',
        label: 'NSD',
        dir: 'npc_state_delta',
        entry: 'src/storysuite-v2.js',
        make: imported => imported.createStorySuiteV2Adapter({
            suiteApi: { npcs: () => [] },
            delta: () => ({ isEnabled: () => true, getNpc: () => null }),
            doc: null,
            timers: {},
            logger: { warn() {} },
        }).definition,
        // One NPC per reply: a meter is kept as the value it reached, so a reply's own NPC is what survives
        // any other reply being swiped or deleted.
        A: ['~ npc Odda | trust: +3'],
        B: ['~ npc Brecht | trust: +2'],
        C: ['~ npc Corin | trust: +4'],
        action: () => ['npc.set', { name: 'Odda', meters: { trust: 40 } }],
        facts: host => Object.fromEntries(Object.values(asObject(host.head().domains.npc?.npcs)).map(npc => [npc.name, { ...npc.meters }])),
    },
    rb: {
        id: 'rpg-battle',
        label: 'RB',
        dir: 'rpg_battle',
        entry: 'src/v2/module.js',
        make: (imported, ref) => imported.createModule({ settings: () => ref.sdk?.settings(imported.MODULE_ID) ?? {} }),
        setup: async host => {
            const made = await host.sdk.command('party.create', { name: 'Wessel', preset: 'fighter' });
            if (!made.ok) throw new Error(`party.create: ${made.message}`);
        },
        // Conditions, not HP: HP also moves with the story time (SD), which a swipe or a delete leaves behind.
        A: ['~ wound Wessel — poisoned: a spider bite'],
        B: ['~ wound Wessel — bleeding: a deep cut'],
        C: ['~ wound Wessel — burning: a torch fell'],
        action: () => ['party.rest', { kind: 'short' }],
        facts: host => {
            const party = host.head().domains.party;
            const pc = party?.actors?.[party?.pc];
            return pc ? { name: pc.name, conditions: (pc.conditions ?? []).map(entry => entry.kind).sort() } : { name: null };
        },
        // A rest at full health changes nothing in facts; it is written down as the party's last rest.
        watch: host => ({ ...MODULES.rb.facts(host), rested: host.head().domains.party?.rested ?? null }),
    },
};

/** The checkout folder names, for `discoverRoots`. */
export const FOLDERS = { sb: 'Story_block', rb: 'rpg_battle', sd: 'Story_director', nsd: 'npc_state_delta' };

/**
 * The checkouts next to each other in `base`, by their usual folder names (Story Block's folder may
 * also be `sb`): { sb?, rb?, sd?, nsd? } with the ones that exist.
 */
export function discoverRoots(base) {
    const roots = {};
    for (const [key, folder] of Object.entries(FOLDERS)) {
        for (const name of key === 'sb' ? [folder, 'sb'] : [folder]) {
            const path = resolve(base, name);
            if (existsSync(path)) { roots[key] = path; break; }
        }
    }
    return roots;
}

/**
 * Imports each module's definition builder from its checkout. `roots`: { rb?, sd?, nsd? } (paths);
 * `entries`: { rb?, sd?, nsd? } overrides of the entry file inside a checkout (the modules' wiring
 * moves between releases). A module that is not given, or whose checkout is not there, is `missing`
 * with a sentence; a checkout that does not import is `broken` (that fails its rows, it is not skipped).
 * → { loaded: { key: { ...MODULES[key], root, imported, make(ref) } }, missing: { key: sentence }, broken: { key: error } }
 */
export async function loadModules(roots = {}, entries = {}) {
    const loaded = {};
    const missing = {};
    const broken = {};
    for (const key of ORDER) {
        const spec = MODULES[key];
        const root = roots[key] ? resolve(roots[key]) : null;
        const file = root ? join(root, entries[key] ?? spec.entry) : null;
        if (!root) { missing[key] = `no ${spec.dir} checkout given`; continue; }
        if (!existsSync(file)) { missing[key] = `${file} is not there`; continue; }
        try {
            const imported = await import(pathToFileURL(file).href);
            loaded[key] = { ...spec, root, imported, make: ref => spec.make(imported, ref) };
        } catch (error) {
            broken[key] = error;
        }
    }
    return { loaded, missing, broken };
}
