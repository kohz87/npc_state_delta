// The matrix runner's §2 extra cases, moved unchanged from run.js: missing query, malformed answer,
// feature off, unset clock, disabled SD, late registration and duplicate name.

import assert from 'node:assert/strict';
import { MODULES, ORDER } from '../modules.js';
import { activeOf, keysOf, label, withHost, factsOf, play, runSetups, queryNames, hostilePeer } from './host.js';
import { checkRegistered, changed, dormancy, gapNote, noProblems, oracle, replayed } from './checks.js';

const na = detail => ({ na: detail });

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
            assert.ok(MODULES.sd.facts(host).goals.length, 'SD should still create a neutral goal with the clock unset');
            const [type, payload] = await MODULES.sd.action(host);
            const accepted = await host.sdk.command(type, payload);
            assert.ok(accepted.ok, `neutral acceptance with the clock unset: ${accepted.message}`);
            const goal = host.sdk.query('director.thread', { id: payload.thread });
            assert.ok(goal.acceptance, 'neutral acceptance should retain its evidence without time');
            assert.equal(goal.acceptance.minute, null);
            assert.equal(goal.rpg, undefined, 'a neutral goal needs no RPG extension');
            replayed(host);
            return { note: 'creation and views work with the clock unset' };
        });
    });
}

async function disabledSd(env, row, rec) {
    await rec.step('disabled-sd', async () => {
        if (!row.modules.includes('sd')) return na('there is no SD in this row to disable');
        const held = row.modules.filter(key => key === 'sd');
        const active = row.modules.filter(key => !held.includes(key));
        await withHost(env, row.modules, {}, async host => {
            const domains = host.sdk.modules().filter(entry => held.some(key => MODULES[key].id === entry.id)).flatMap(entry => entry.domains);
            const saved = () => structuredClone(Object.fromEntries(domains.map(domain => [domain, host.head().domains[domain]])));
            const disable = async () => {
                assert.equal(host.registry.setEnabled(MODULES.sd.id, false, 'Matrix: SD disabled.'), true);
                for (const key of held) {
                    await dormancy(host, key, 'with SD disabled');
                    assert.ok(host.registry.contexts().every(entry => entry.moduleId !== MODULES[key].id), `${label(key)} still supplies prompts`);
                    const def = env.loaded[key].make(host.ref);
                    for (const hook of Object.keys(def.hooks ?? {})) {
                        assert.ok(host.registry.hookEntries(hook).every(entry => entry.moduleId !== def.id), `${label(key)} still supplies ${hook}`);
                    }
                    for (const kind of Object.keys(def.capture?.kinds ?? {})) assert.equal(host.registry.capture(kind), null, `${label(key)} still captures ${kind}`);
                }
                const refused = await host.sdk.command('threads.offer', {
                    write: 'wr_disabled', thread: 'th_disabled', kind: 'hook', key: 'Disabled goal',
                    summary: '', fields: {}, expectedHash: null,
                });
                assert.equal(refused.code, 'DEPENDENCY_UNAVAILABLE');
            };
            // Disable before the other modules play.
            await disable();
            const initial = factsOf(host, active);
            const before = saved();
            await play(host, active, 'A');
            changed(initial, factsOf(host, active), active, 'a reply with SD disabled');
            assert.deepEqual(saved(), before, 'disabled modules changed their saved slices');
            noProblems(host);
            replayed(host, ' (SD disabled before setup)');
            host.registry.setEnabled(MODULES.sd.id, true);
            checkRegistered(host, row);
            await runSetups(host, activeOf(row));
            await play(host, activeOf(row), 'B');
            noProblems(host);
            // Disable a second time with real saved state, then reactivate without resetting it.
            const established = saved();
            await disable();
            await play(host, active, 'C');
            assert.deepEqual(saved(), established, 'disabling SD must preserve initialized slices');
            noProblems(host);
            replayed(host, ' (SD disabled with saved state)');
            host.registry.setEnabled(MODULES.sd.id, true);
            checkRegistered(host, row);
            assert.deepEqual(saved(), established, 'reactivation reset saved state');
        });
    });
}

async function lateRegistration(env, row, rec) {
    await rec.step('late', async () => {
        const order = ORDER.filter(key => row.modules.includes(key));
        const late = order.at(-1);
        if (!late) return na('SB alone has no module to register late');
        const early = row.modules.filter(key => key !== late);
        const activeEarly = await withHost(env, row.modules, { withhold: [late] }, host => early.filter(key => {
            const entry = host.sdk.modules().find(item => item.id === MODULES[key].id);
            return entry?.status ? entry.status === 'ready' : !row.dormant.includes(key);
        }));
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
            else await runSetups(host, active.filter(key => !activeEarly.includes(key)));
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

export { missingQuery, malformed, featureOff, unsetClock, disabledSd, lateRegistration, duplicateName };
