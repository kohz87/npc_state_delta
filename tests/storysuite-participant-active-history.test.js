// Delta reads only the messages the story stands on. After a restore Story Block hides the faded replies with SillyTavern's own flag; Delta's own
// readers skip a hidden message like every other reader does, and ask Story Block's one active-history filter (sdk.timeline.history) before they
// build any prompt from the chat, so a reply the host could not hide (or the moment before it has) still is not evidence. No prompt text is
// filtered: the prompts are what they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterRig, BATCH } from './helpers/participant-rig.js';
import { runHostScenario } from './helpers/host-scenario.js';
import { setActiveCalendarConfig } from '../core.js';
import {
    activeChat, recentTranscript, refreshMessageGate, storyDayAt, useMessageGate, useTranscriptSource, currentExchangeMessages,
} from '../src/transcript.js';

const CALENDAR = Object.freeze({ era: 'CY', months: [{ name: 'Goldfield', days: 30 }, { name: 'Leafturn', days: 30 }, { name: 'Deepfrost', days: 30 }] });
const dated = (date, text) => `<details><summary>World State</summary>Time | ${date} | dusk\nLocation | The Grey Post</details>\n${text}`;
const VALE = '<New_NPC name="Vale">Vale, a courier of the dead timeline, carries a ZEBRA-marked satchel.</New_NPC>';

test.beforeEach(() => setActiveCalendarConfig(CALENDAR));
test.afterEach(() => { setActiveCalendarConfig(null); useMessageGate(null); });

/** A story with a save point, a dead timeline after it (a dated reply that introduces Vale), a restore, and a waking reply. */
async function faded(t) {
    const r = await adapterRig(t);
    const { host } = r;
    await host.send('Hello.', dated('CY308, Goldfield 2', 'The hall is quiet.'));
    const point = (await host.sdk.timeline.make({ kind: 'manual', name: 'Before the road' })).snapshot;
    await host.send('Onward.', dated('CY308, Leafturn 3', `Vale arrives at the post. ${VALE}`));
    await host.send('Further.', 'Vale draws a knife.');
    assert.equal((await host.sdk.command('tl.seal', { id: BATCH.id })).ok, true);
    const head = await host.sdk.timeline.head();
    const prepared = await host.timeline.host.prepare({ snapshot: point.id, deathEvents: ['ev_death001'], batchResult: BATCH, expectedHead: head.headHash });
    assert.equal(prepared.ok, true, prepared.message);
    const done = await host.timeline.host.activate({ prepared: prepared.prepared, expectedHead: head.headHash });
    assert.equal(done.status, 'complete');
    await host.send('I wake.', 'The hall again, quiet.');
    return r;
}

/** Points Delta's transcript readers at the rig's host chat, the gate being the adapter's own (what index.js does with the real chat). */
function readFrom(r) {
    useTranscriptSource({ context: () => ({ chat: r.host.ctx.chat, name1: 'You', name2: 'Narrator' }), scanDepth: () => 12 });
    useMessageGate(r.api.gate);
}

async function reads(r) {
    await refreshMessageGate();
    const chat = r.host.ctx.chat;
    return {
        storyDay: storyDayAt(chat.length - 1),
        transcript: recentTranscript(12, { messageIds: true }),
        exchange: currentExchangeMessages(chat.length - 1)?.map(message => message.mes),
    };
}

function assertActiveOnly(seen) {
    assert.doesNotMatch(seen.transcript, /ZEBRA|Vale/, 'the dead timeline is not in the window');
    assert.match(seen.transcript, /hall again/);
    assert.doesNotMatch(seen.exchange.join('\n'), /Vale/);
}

test('the story day and the transcript window use only the messages the story stands on', async t => {
    const r = await faded(t);
    readFrom(r);
    const chat = r.host.ctx.chat;
    const hidden = chat.map((message, at) => (message.is_system ? at : -1)).filter(at => at >= 0);
    assert.equal(hidden.length > 0, true, 'the host hid the faded replies with SillyTavern\'s own flag');
    const day = (await import('../core.js')).calendarDayNumber('CY308, Goldfield 2', CALENDAR);
    const seen = await reads(r);
    assert.equal(seen.storyDay, day, 'the day of the last active dated reply, not the dead timeline\'s Leafturn 3');
    assertActiveOnly(seen);
});

test('a faded reply the host could not hide is still not evidence: the gate is asked before the chat is read', async t => {
    const r = await faded(t);
    readFrom(r);
    const chat = r.host.ctx.chat;
    for (const message of chat) if (message.story_suite_hid) message.is_system = false;   // the hide failed (or was undone)
    assert.equal(chat.some(message => message.story_suite_hid && !message.is_system), true);
    const day = (await import('../core.js')).calendarDayNumber('CY308, Goldfield 2', CALENDAR);
    const seen = await reads(r);
    assert.equal(seen.storyDay, day);
    assertActiveOnly(seen);
    // What was asked is the host's one filter, once per read, and the result is by message, not by place: a delete before the faded reply moves it.
    const spliced = chat.splice(0, 1);
    assert.equal(spliced.length, 1);
    assert.doesNotMatch(recentTranscript(12, { messageIds: true }), /ZEBRA|Vale/, 'the mark followed the message');
    chat.unshift(...spliced);
});

test('no gate, or nothing faded: the chat is read as it always was, byte for byte', async t => {
    const r = await adapterRig(t);
    await r.host.send('Hello.', dated('CY308, Goldfield 2', 'The hall is quiet.'));
    await r.host.send('Onward.', dated('CY308, Leafturn 3', `Vale arrives. ${VALE}`));
    useTranscriptSource({ context: () => ({ chat: r.host.ctx.chat, name1: 'You', name2: 'Narrator' }), scanDepth: () => 12 });
    useMessageGate(null);
    const alone = { window: recentTranscript(12, { messageIds: true }), day: storyDayAt(3) };
    useMessageGate(r.api.gate);
    await refreshMessageGate();
    assert.deepEqual({ window: recentTranscript(12, { messageIds: true }), day: storyDayAt(3) }, alone);
    assert.equal(activeChat(r.host.ctx.chat), r.host.ctx.chat, 'the same array');
    assert.match(alone.window, /Vale arrives/, 'nothing is faded here');
});

test('after a reload and a rebuild the same messages are faded and the same reads follow', async t => {
    const r = await faded(t);
    const again = await r.reload();
    again.host.store.rebuild();
    await again.host.timeline.host.recover();
    readFrom(again);
    const day = (await import('../core.js')).calendarDayNumber('CY308, Goldfield 2', CALENDAR);
    const seen = await reads(again);
    assert.equal(seen.storyDay, day);
    assertActiveOnly(seen);
    for (const message of again.host.ctx.chat) if (message.story_suite_hid) message.is_system = false;
    const unhidden = await reads(again);
    assert.equal(unhidden.storyDay, day);
    assertActiveOnly(unhidden);
});

test('Delta\'s targeted reads ask the gate before the prompt is built: Refresh from chat, the dossier import and a backfill', () => {
    runHostScenario('active-history-targeted', async () => {
        mockState.history = { flags: null, calls: 0, log: [] };
        const sdk = {
            registered: [], registerModule(def) { sdk.registered.push(def); },
            timeline: { history: async () => { mockState.history.calls += 1; mockState.history.log.push('history'); return { ok: true, messages: mockState.context.chat.map((_, at) => ({ active: mockState.history.flags ? mockState.history.flags[at] !== false : true })), faded: [] }; } },
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        assert.equal(await waitFor(() => mockState.sdk.registered.length === 1), true);
        assert.equal(await waitFor(() => api.stateReady()), true);
        await manualAddNpc('Vale');
        await api.flush();
        const add = (is_user, mes) => mockState.context.chat.push({ is_user, is_system: false, name: is_user ? 'Kazuma' : 'Megumin', mes, swipe_id: 0 });
        add(false, 'The hall is quiet and Vale waits by the door, a courier with a plain satchel.');
        add(true, 'Who is at the door?');
        add(false, '<New_NPC name="Vale">Vale, a courier of the dead timeline, carries a ZEBRA-marked satchel.</New_NPC> Vale draws a knife in the dead timeline.');
        add(true, 'I wake from the dream.');
        add(false, 'The hall again, quiet, and Vale still waits by the door with the plain satchel.');
        mockState.history.flags = [true, true, false, true, true];   // the third message is the dead timeline's; the host could not hide it
        const prompts = [];
        mockState.quietResponder = async (args = {}) => {
            mockState.history.log.push('model');
            prompts.push(String(args.prompt || ''));
            return '{"npcs":[]}';
        };
        mockState.history.log.length = 0;
        assert.equal(typeof api.refreshFromChat, 'function');
        await api.refreshFromChat('Vale');
        assert.equal(prompts.length > 0, true, 'a request was made');
        assert.ok(mockState.history.log.indexOf('history') >= 0 && mockState.history.log.indexOf('history') < mockState.history.log.indexOf('model'), 'the gate was asked before the model was');
        for (const prompt of prompts) assert.doesNotMatch(prompt, /ZEBRA|dead timeline/, 'the refresh window has only the active messages');
        assert.match(prompts.join('\n'), /plain satchel/);
        // The dossier import: the only block is faded, so there is nothing to import and the history is read instead, without it.
        prompts.length = 0;
        mockState.history.log.length = 0;
        await api.scanDossier('Vale');
        assert.ok(mockState.history.log.indexOf('history') >= 0, 'the gate was asked before the import read the chat');
        for (const prompt of prompts) assert.doesNotMatch(prompt, /ZEBRA|dead timeline/, 'a faded dossier block is not imported');
        // With the block active, the same import finds it.
        mockState.history.flags = null;
        prompts.length = 0;
        await api.scanDossier('Vale');
        assert.match(prompts.join('\n'), /ZEBRA/, 'an active block is imported');
    });
});
