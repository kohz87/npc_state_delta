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

// (EDITKEEP) The owner's shape: a reply with Story Block's hidden Changes block and a one-pass block; the edit changes only the Changes lines.
test('an edit of only the hidden Changes block is not a branch rollback; a prose edit is still reconciled', () => {
    runEditorHostScenario('edit-keeps-state', async () => {
        const chat = mockState.context.chat;
        const hidden = lines => `<!-- STORY_SUITE_V2\n<Changes>\n${lines}\n</Changes>\n-->`;
        chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Hello?' });
        chat.push({ is_user: false, is_system: false, name: 'Narrator', mes: `Fenna waves.\n${hidden('~ npc Fenna trust +1')}`, swipe_id: 0, swipes: [] });
        eventSource.emit('message_received', 1);
        await sleep(700);
        const api = globalThis.NPCStateDelta;
        const events = () => api.uiStatus().branchReconciliations || [];
        const before = api.getState().lineage.slice();
        chat[1].mes = `Fenna waves.\n${hidden('~ npc Fenna trust +1\n~ npc Fenna mood calm')}`;
        eventSource.emit('message_edited', 1);
        await sleep(600);
        const after = api.getState().lineage;
        if (JSON.stringify(after) === JSON.stringify(before) || after.length !== before.length) throw new Error('the stored lineage did not follow the edited text');
        const kept = events().filter(event => event.operation === 'edit').at(-1);
        if (!kept) throw new Error('no edit reconciliation was recorded: ' + JSON.stringify(events()));
        if ((kept.invalidated || kept.action !== 'content-unchanged')) throw new Error('a Changes-only edit was treated as a rollback: ' + JSON.stringify(kept));
        chat[1].mes = `Fenna bows.\n${hidden('~ npc Fenna trust +1')}`;
        eventSource.emit('message_edited', 1);
        await sleep(600);
        const real = events().filter(event => event.operation === 'edit').at(-1);
        if (!real || real.action === 'content-unchanged') throw new Error('a prose edit was not reconciled: ' + JSON.stringify(real));
        // The rebuild after a real edit re-reads the reply's one-pass block from its text (valid and complete only), as the live capture did.
        const narration = await import(pathToFileURL(path.join(extRoot, 'runtime-narration.js')).href);
        mockState.extensionSettings.npc_state_delta.narrationCapture = true;
        const block = '<!--npc_state_delta {"npcs":[{"name":"Fenna","present":true,"role":"innkeeper"}]} -->';
        chat[1].mes = `Fenna bows low.\n${block}\n${hidden('~ npc Fenna trust +1')}`;
        const found = narration.textCapture(chat[1]);
        if (found?.parsed?.npcs?.[0]?.name !== 'Fenna') throw new Error('the block in the edited text was not read: ' + JSON.stringify(found));
        // An old or swiped reply with a block in its text and no journal entry replays as before (historical read): no invented capture.
        if (narration.captureJournalEntry({ captureJournal: [] }, chat, 1)) throw new Error('the journal invented a capture from the text');
        const marked = { captureJournal: [] };
        narration.recordReadMark(marked, chat, 1);
        if (marked.captureJournal.length !== 1 || marked.captureJournal[0].parsed) throw new Error('the read mark was not written plain: ' + JSON.stringify(marked));
        narration.recordAcceptedFill(marked, chat, 1, 'n1', { role: 'x' });
        if (marked.captureJournal[0].fills?.n1?.role !== 'x') throw new Error('a fill was not kept in the journal');
        chat[1].mes = `Fenna bows low.\n<!--npc_state_delta {"npcs":[{"name":"Fe`;
        if (narration.textCapture(chat[1])) throw new Error('a cut-off block was read');
    });
});
