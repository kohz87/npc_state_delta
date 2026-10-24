// B-a1-15 (a1, story-suite break pass 2): NPC meters move at most `changeCap` (15) within one reply
// (npc-meters.js moveMeters: `record.turn = { reply, from }`), and the reply is told by its INDEX
// (`ctx.carrier.index`, npc-meters.js storyLine). After a middle delete the next new reply can land on the
// index the last reply had before the delete, so it is taken for that reply: its window starts where that
// reply started. Reply C moved trust 1 → -14 (cap); an earlier exchange is deleted; the next reply D,
// now at C's old index, moves trust -14 → 11 (+25 in one reply, past the cap of 15). The other way round
// it moves nothing. Story Block gives every reply a record id (`ctx.carrier.sid`) that a delete never moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../../vendor/story-block/testkit/index.js';
import { createStorySuiteV2Adapter } from '../../../src/storysuite-v2.js';

const reply = (text, lines) => `${text}\n\n<Changes>\n${lines.join('\n')}\n</Changes>`;

test('after a middle delete, a new reply\'s meter change is held to the cap from where that reply began', async t => {
    t.mock.method(console, 'warn', () => {});
    const nsd = createStorySuiteV2Adapter({ suiteApi: { npcs: () => [{ name: 'Fenna' }] }, delta: () => ({ isEnabled: () => true, getNpc: () => null }), doc: null, timers: {}, logger: { warn() {} } }).definition;
    const host = await createHost({ modules: [nsd] });
    t.after(() => host.close());
    const trust = () => host.head().domains.npc.npcs.fenna.meters.trust;
    await host.send('A.', reply('Fenna is here.', ['+ present Fenna', '~ npc Fenna | trust: +1']));
    await host.send('B.', reply('Rain.', ['~ place Bluewatch Village']));
    await host.send('C.', reply('An insult.', ['~ npc Fenna | trust: -25']));
    assert.equal(trust(), -14, 'setup: C moved trust by the cap (15)');
    const c = host.ctx.chat.length - 1;
    await host.st.deleteMessage(c - 2);   // B's reply
    await host.st.deleteMessage(c - 3);   // B's user message
    assert.equal(trust(), -14, 'setup: the delete leaves C\'s change');
    await host.send('D.', reply('A rescue.', ['~ npc Fenna | trust: +25']));
    assert.equal(host.ctx.chat.length - 1, c, 'setup: D sits where C sat before the delete');
    assert.equal(trust(), -14 + 15, `a new reply moves trust at most 15 (it moved ${trust() + 14})`);
});
