import test from 'node:test';
import assert from 'node:assert/strict';
import { runEditorHostScenario } from './editor-host.mjs';

// b7-combos design note: removing a capture block on MESSAGE_RECEIVED asked the host to re-render a
// reply it had not drawn yet (SillyTavern then throws "getAttribute" and Delta logged a warning per
// armed reply). The reply is drawn next, from the stripped text; only a drawn message is re-rendered.
test('removing a capture block re-renders only a message that is already drawn', () => {
    runEditorHostScenario('capture-rerender', async () => {
        const rendered = [];
        const warnings = [];
        mockState.context.updateMessageBlock = id => {
            if (!mockState.messageDomReady) throw new TypeError("Cannot read properties of undefined (reading 'getAttribute')");
            rendered.push(id);
        };
        const previousWarn = console.warn;
        console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
        try {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Hello?' });
            const block = '<!--npc_state_delta {"npcs":[{"name":"Fenna","present":true}]} -->';
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Narrator', mes: `Fenna waves.\n${block}`, swipe_id: 0, swipes: [`Fenna waves.\n${block}`] });
            const id = mockState.context.chat.length - 1;
            mockState.messageDomReady = false;
            eventSource.emit('message_received', id);
            await sleep(100);
            assert.equal(mockState.context.chat[id].mes, 'Fenna waves.', 'the block is removed');
            assert.deepEqual(rendered, [], 'a reply not drawn yet is not re-rendered');
            assert.equal(warnings.filter(line => /could not re-render/.test(line)).length, 0, 'no warning');
            mockState.messageDomReady = true;
            mockState.context.chat[id] = { ...mockState.context.chat[id], mes: `Fenna bows.\n${block}`, swipe_id: 1, swipes: ['Fenna waves.', `Fenna bows.\n${block}`] };
            eventSource.emit('message_swiped', id);
            await sleep(100);
            assert.equal(mockState.context.chat[id].mes, 'Fenna bows.');
            assert.deepEqual(rendered, [id], 'a drawn reply is re-rendered once after its block is removed');
        } finally {
            console.warn = previousWarn;
        }
    });
});
