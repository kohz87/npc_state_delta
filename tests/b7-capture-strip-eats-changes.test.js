// B-b7-combos-3: NSD strips its one-pass capture block on MESSAGE_RECEIVED (makeFirst, before Story
// Block reads the reply). An unterminated `<!--npc_state_delta` (always) or `<npc_state_delta>`
// (armed/lenient) block is removed up to the END of the reply, so Story Block's `<Changes>` block
// written after it is deleted before Story Block sees it: every item, coin, quest and check line of
// that reply is lost silently. Both static instructions tell the model to put its block "at the end
// after the story", so the order is the model's choice.


import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractNarrationCapture } from '../core-mechanics.js';

const CHANGES = '<Changes>\n+ item Rope | qty: 1\n+ coin 5 | from: Fenna\n</Changes>';

test('an unterminated NSD comment block does not swallow the Story Block <Changes> block after it', () => {
    const reply = `Fenna hands you a rope.\n\n<!--npc_state_delta {"npcs":[{"name":"Fenna","present":true}]}\n\n${CHANGES}`;
    for (const lenient of [false, true]) {
        const out = extractNarrationCapture(reply, { lenient });
        assert.ok(out.text.includes(CHANGES), `lenient=${lenient}: the <Changes> block was removed with NSD's block: ${JSON.stringify(out.text)}`);
    }
});

test('an unterminated <npc_state_delta> tag (armed capture) does not swallow the <Changes> block after it', () => {
    const reply = `Fenna hands you a rope.\n<npc_state_delta>{"npcs":[]}\n${CHANGES}`;
    const out = extractNarrationCapture(reply, { lenient: true });
    assert.ok(out.text.includes(CHANGES), `the <Changes> block was removed: ${JSON.stringify(out.text)}`);
});
