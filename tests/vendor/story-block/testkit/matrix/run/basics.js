// The matrix runner's basic row, moved unchanged from run.js: boot and registration, the scripted reply,
// each module's action, the cold replay and the static prompt, then dormancy or its not-applicable note.

import assert from 'node:assert/strict';
import { MODULES } from '../modules.js';
import { activeOf, keysOf, label, boot, factsOf, play, runSetups, withHost } from './host.js';
import { checkRegistered, changed, dormancy, gapNote, noProblems, replayed } from './checks.js';

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
                    const [type, payload] = await MODULES[key].action(host);
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

export { basics };
