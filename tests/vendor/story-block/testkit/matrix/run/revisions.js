// The matrix runner's swipe, re-read and delete cases, moved unchanged from run.js: each compares the
// surviving state with a fresh host that played only the replies left.

import assert from 'node:assert/strict';
import { activeOf, factsOf, replyText, withHost, play, runSetups } from './host.js';
import { noProblems, oracle, replayed } from './checks.js';

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

export { swipe, reread, deleteMessage };
