// A middle delete through the production runtime (the participant's before-change catch-up, src/storysuite-participant/participant/handlers.js): the runtime's
// `pendingOf` boundary names the surviving replies from the change, and the catch-up reads them as of each reply on the restored state. Each scenario runs
// in its own process on a fresh synthetic host (the harness is the one of history-replay-wiring.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// History replay through the production handler and scanner of the synthetic SillyTavern host (HR3): the controller of
// src/storysuite-participant/history-replay.js over the runtime's replay boundaries, with a deterministic fake model.
// Each scenario runs in its own process on a fresh host built from the runtime-smoke setup.
// Story Block's `restored` and `asOf` (batch/b-p1) are not in the vendored copy: `restored` is driven on the participant directly and the
// as-of reads are proven on the adapter's `at` and the scoped adapter, not against a host.

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';
const REPLAY_URL = new URL('../src/storysuite-participant/history-replay.js', import.meta.url).href;
const TIMELINE_URL = new URL('../src/storysuite-participant/timeline.js', import.meta.url).href;

function runScenario(name, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
mockState.context.eventTypes.GENERATION_AFTER_COMMANDS = 'generation_after_commands';
mockState.context.eventTypes.GENERATION_STOPPED = 'generation_stopped';
mockState.context.eventTypes.CHAT_COMPLETION_PROMPT_READY = 'chat_completion_prompt_ready';
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    const helpers = await (${helpers.toString()})(mockState, eventSource, sleep, ${JSON.stringify(REPLAY_URL)});
    helpers.timelineUrl = ${JSON.stringify(TIMELINE_URL)};
    await (${scenario.toString()})(helpers);
    console.log('history replay scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual|\bat\b.*<anonymous>/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}

// Runs inside the synthetic host.
async function helpers(mockState, eventSource, sleep, replayUrl) {
    const { createCatchUp } = await import(replayUrl);
    const fail = message => { throw new Error(message); };
    const check = (condition, message) => { if (!condition) fail(message); };
    const equal = (actual, expected, message) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${JSON.stringify(expected).slice(0, 400)}, got ${JSON.stringify(actual).slice(0, 400)}`);
    };
    const runtime = globalThis.NPCStateDelta;
    const settings = mockState.extensionSettings.npc_state_delta;
    settings.scanEvery = 1;
    const scannerCalls = () => mockState.rawCalls.map(call => call?.[0] || {}).filter(args => /isolated dossier scanner\./i.test(String(args.systemPrompt || '')));
    const emitAsync = async (event, ...args) => {
        await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args)));
        await sleep(40);
    };
    const reply = (text, at) => ({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text], send_date: new Date(Date.UTC(2026, 0, 1, 0, at)).toISOString() });
    const user = text => ({ is_user: true, is_system: false, name: 'Kazuma', mes: text });
    // A live turn through the real events.
    let clock = 0;
    const turn = async (userText, replyText) => {
        mockState.context.chat.push(user(userText));
        await emitAsync('message_sent', mockState.context.chat.length - 1);
        await emitAsync('generation_after_commands', 'normal', {}, false);
        mockState.context.chat.push(reply(replyText, clock += 1));
        const id = mockState.context.chat.length - 1;
        await emitAsync('message_received', id);
        await sleep(80);
        return id;
    };
    // Replies added to the chat with no event: the ones a restore left unread.
    const addReplies = count => {
        for (let i = 1; i <= count; i += 1) {
            mockState.context.chat.push(user(`We walk on ${i}.`));
            mockState.context.chat.push(reply(i % 3 === 0 ? `Yunyun speaks, mark-${i}.` : `The road goes on, mark-${i}.`, clock += 1));
        }
    };
    // The deterministic model: its answer depends on the CURRENT exchange of the prompt alone.
    mockState.fakeCalls = [];
    mockState.quietResponder = async (args = {}) => {
        if (!/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) return '{"npcs":[]}';
        const prompt = String(args.prompt || '');
        mockState.fakeCalls.push(prompt);
        if (mockState.failWhen?.(prompt, mockState.fakeCalls.length)) throw new Error('the model failed');
        if (mockState.holdWhen) await mockState.holdWhen(prompt, mockState.fakeCalls.length);
        const seen = [...prompt.matchAll(/mark-(\d+)/g)].map(match => Number(match[1]));
        const top = seen.length ? Math.max(...seen) : 0;
        const npcs = /Yunyun/.test(prompt) ? [{ name: 'Yunyun', present: true, role: 'adventurer', mood: top % 2 ? 'calm' : 'wary', location: `mile ${top}` }] : [];
        return JSON.stringify({ npcs });
    };
    let published = 0;
    let changes = 0;
    const controller = (extra = {}) => createCatchUp({
        chatKey: () => runtime.chatKey(), enabled: () => true, live: () => runtime.replay, changed: () => { changes += 1; }, publish: async () => { published += 1; }, warn() {}, ...extra,
    });
    const stable = state => {
        const copy = JSON.parse(JSON.stringify(state));
        // The dossiers, the counters and the cards; not the clock stamps, the journal of rollbacks or the branch bookkeeping (those differ by when they ran).
        for (const key of Object.keys(copy)) if (/^(rollback|branch)|^(lastScanAt|timeline|catchUp|checkpoints|scanCount|lineage|portraitAssets|formPortraitAssets)$/.test(key)) delete copy[key];
        for (const item of [...(copy.pendingBackfills || []), ...(copy.inlineCards || [])]) for (const key of ['requestedAt', 'lastAttemptAt', 'createdAt']) delete item[key];
        for (const list of [copy.npcs, ...(copy.inlineCards || []).map(entry => entry.cards)]) for (const npc of list || []) for (const key of ['createdAt', 'updatedAt', 'archivedAt']) delete npc[key];
        return copy;
    };
    return { fail, check, equal, runtime, settings, scannerCalls, turn, addReplies, reply, user, emitAsync, mockState, sleep, controller, stable, published: () => published, changes: () => changes };
}

test('before-change: a middle delete installs the state saved before it, pendingOf names the later replies, the catch-up reads them and no more', () => {
    runScenario('before-change', async h => {
        for (let i = 1; i <= 2; i += 1) await h.turn('We walk on.', i % 2 ? `Yunyun speaks, mark-${i}.` : `The road goes on, mark-${i}.`);
        const before = structuredClone(h.runtime.getState());                     // the state saved before reply 3: B
        for (let i = 3; i <= 5; i += 1) await h.turn('We walk on.', i % 2 ? `Yunyun speaks, mark-${i}.` : `The road goes on, mark-${i}.`);
        const chat = h.mockState.context.chat;
        h.equal(chat.length, 10, 'five turns');
        chat.splice(4, 2);                                                         // the reader deletes reply 3 (its turn goes with it in this test)
        const L = h.runtime.replay;
        const middle = L.pendingOf(before, 4);
        h.equal([middle.ids, middle.marker, middle.n], [[5, 7], 3, 3], 'the replies from the change on; the note says before reply 3');
        h.equal(L.pendingOf(before, 7).ids, [], 'a changed latest reply is the normal path\'s (swipe, latest edit or Re-read)');
        h.equal(L.pendingOf(before, 8).ids, [], 'delete of the last reply leaves none');
        // install B and the field, as activate does, then the catch-up resumes from the field
        await h.runtime.installState(before);
        await L.writeCatchUp({ from: 0, to: 1, reason: 'before-change', attempt: 0, ids: middle.ids, cap: 40, since: middle.marker });
        h.mockState.fakeCalls.length = 0;
        const catchUp = h.controller();
        h.equal(catchUp.resume().started, true, 'the saved field resumes');
        h.check(catchUp.canGenerate().ok === false, 'sending is held');
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'done');
        h.equal(h.mockState.fakeCalls.length, 2, 'one call per surviving reply from the change on');
        h.check(h.mockState.fakeCalls.every(prompt => !prompt.includes('mark-3')), 'the removed reply is never read');
        const state = h.runtime.getState();
        h.equal([state.catchUp, state.lastScannedMessageId], [undefined, 7], 'the field is cleared and the replies are marked read');
        h.equal(state.npcs.find(n => n.name === 'Yunyun')?.location, 'mile 5', 'the last surviving reply decided the location');
        h.equal(h.published(), 1, 'one publication');
    });
});

test('delete the last reply, then regenerate: no catch-up is needed (nothing later survives); the normal scan reads the new reply only', () => {
    runScenario('delete-last-regenerate', async h => {
        for (let i = 1; i <= 3; i += 1) await h.turn('We walk on.', i % 2 ? `Yunyun speaks, mark-${i}.` : `The road goes on, mark-${i}.`);
        const before = structuredClone(h.runtime.getState());                     // after reply 3 (the parent of the reply that is deleted next)
        await h.turn('We walk on.', 'Yunyun speaks, mark-4.');
        const chat = h.mockState.context.chat;
        chat.pop();                                                                // the reader deletes the last reply
        const { changeAt } = await import(h.timelineUrl);
        const at = changeAt({ saved: before.lineage, live: h.runtime.getState().lineage, chat: h.runtime.chatLineage() });
        h.equal(h.runtime.replay.pendingOf(before, at).ids, [], 'no surviving reply after the change: no catch-up, no note');
        await h.runtime.installState(before);
        h.mockState.fakeCalls.length = 0;
        chat.push(h.reply('Yunyun speaks, mark-9.', 9));                           // the regenerated reply
        await h.emitAsync('message_received', chat.length - 1);
        await h.sleep(80);
        h.equal(h.mockState.fakeCalls.length, 1, 'the normal scan reads the new reply, once');
        h.check(/mark-9/.test(h.mockState.fakeCalls[0]) && !/mark-4/.test(h.mockState.fakeCalls[0]), 'it reads the new reply, not the deleted one');
        h.equal(h.runtime.getState().npcs.find(n => n.name === 'Yunyun')?.location, 'mile 9', 'the dossier follows the new reply');
    });
});

test('run-4 shape: eight replies, the seventh is deleted: dossiers 1-6 come from the saved state, the seventh\'s person is absent, the eighth is read again', () => {
    runScenario('run-4', async h => {
        const baseResponder = h.mockState.quietResponder;
        h.mockState.quietResponder = async args => {
            const prompt = String(args?.prompt || '');
            if (/isolated dossier scanner\./i.test(String(args?.systemPrompt || '')) && /Seven appears/.test(prompt)) {
                const npcs = JSON.parse(await baseResponder(args)).npcs;
                return JSON.stringify({ npcs: [...npcs, { name: 'Seven', present: true, role: 'stranger', mood: 'calm', location: 'the gate' }] });
            }
            return baseResponder(args);
        };
        let before = null;
        for (let i = 1; i <= 8; i += 1) {
            await h.turn('We walk on.', i === 7 ? `Seven appears, Yunyun speaks, mark-${i}.` : i % 2 ? `Yunyun speaks, mark-${i}.` : `The road goes on, mark-${i}.`);
            if (i === 6) before = structuredClone(h.runtime.getState());
        }
        h.check(h.runtime.getState().npcs.some(n => n.name === 'Seven'), 'the seventh reply made a dossier');
        const chat = h.mockState.context.chat;
        chat.splice(12, 2);                                                        // delete reply 7 (its turn goes with it)
        const { changeAt } = await import(h.timelineUrl);
        const at = changeAt({ saved: before.lineage, live: h.runtime.getState().lineage, chat: h.runtime.chatLineage() });
        const plan = h.runtime.replay.pendingOf(before, at, h.runtime.getState().lineage.length > chat.length);
        h.equal([plan.ids, plan.n], [[13], 7], 'only the eighth reply survives after the change; the note says before reply 7');
        await h.runtime.installState(before);
        await h.runtime.replay.writeCatchUp({ from: 0, to: 0, reason: 'before-change', attempt: 0, ids: plan.ids, cap: 40, since: plan.marker });
        h.mockState.fakeCalls.length = 0;
        const catchUp = h.controller();
        h.equal(catchUp.resume().started, true, 'the saved field resumes');
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'done');
        const state = h.runtime.getState();
        h.check(!state.npcs.some(n => n.name === 'Seven'), 'the removed reply\'s person is absent');
        h.equal(state.npcs.find(n => n.name === 'Yunyun')?.location, 'mile 8', 'the eighth reply was read again on the restored state');
        h.equal(h.mockState.fakeCalls.length, 1, 'one reply read');
    });
});
