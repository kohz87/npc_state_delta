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
    const controller = () => createCatchUp({
        chatKey: () => runtime.chatKey(), enabled: () => true, live: () => runtime.replay, changed: () => { changes += 1; }, publish: async () => { published += 1; }, warn() {},
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

test('parity: replaying a chat from an empty state gives the dossiers of the live run (fake model)', () => {
    runScenario('parity', async h => {
        for (let i = 1; i <= 5; i += 1) await h.turn('We walk on.', i % 2 ? `Yunyun speaks, mark-${i}.` : `The road goes on, mark-${i}.`);
        const live = h.stable(h.runtime.getState());
        h.check(live.npcs.length >= 1, 'the live run made a dossier');
        const calls = h.scannerCalls().length;
        const catchUp = h.controller();
        const during = [];
        const quiet = () => { const copy = JSON.parse(JSON.stringify(h.runtime.getState())); delete copy.catchUp; return JSON.stringify(copy); };
        const before = quiet();
        catchUp.rebuild({ replies: null });
        while (catchUp.status().active) { during.push(quiet() === before); await h.sleep(5); }
        await catchUp.idle();
        h.check(during.every(Boolean) && during.length > 0, 'the live state is untouched until the install (the empty state is never installed first)');
        h.equal(catchUp.status().outcome, 'done', 'the rebuild finished');
        h.check(h.scannerCalls().length > calls, 'the replay made model calls');
        h.equal(h.stable(h.runtime.getState()), live, 'replay from empty == the live run');
        h.equal(h.published(), 1, 'one publication');
    });
});

test('order and view: windows in chat order, each ending at its own reply; turn once per reply; time is the reply send date', () => {
    runScenario('order', async h => {
        h.addReplies(7);
        const before = h.runtime.getState().turn;
        const sentLast = Date.parse(h.mockState.context.chat.at(-1).send_date);
        const catchUp = h.controller();
        catchUp.restored();
        h.check(catchUp.canGenerate().ok === false, 'sending is held at once');
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'done');
        const prompts = h.mockState.fakeCalls;
        h.equal(prompts.length, 7, 'one call per reply');
        const ends = prompts.map(prompt => Math.max(...[...prompt.matchAll(/mark-(\d+)/g)].map(match => Number(match[1]))));
        h.equal(ends, [1, 2, 3, 4, 5, 6, 7], 'each window ends at its own reply, oldest first');
        h.check(prompts.every((prompt, at) => !prompt.includes(`mark-${at + 2}`)), 'no window reads a later reply');
        h.equal(h.runtime.getState().turn, before + 7, 'turn advanced once per reply');
        h.equal(h.runtime.getState().lastScanAt, sentLast, 'time is the reply send date, not now');
        h.equal(h.runtime.getState().npcs.find(n => n.name === 'Yunyun')?.location, 'mile 7', 'the last reply decided the location');
        h.check(catchUp.canGenerate() === true, 'sending is back');
    });
});

test('no outward writes during a replay; exactly one publication at the end', () => {
    runScenario('outward', async h => {
        h.addReplies(4);
        const toasts = [];
        for (const kind of ['info', 'success', 'warning', 'error']) globalThis.toastr[kind] = text => toasts.push([kind, text]);
        const promptsBefore = h.mockState.prompts.length;
        const written = [];
        const quiet = () => { const copy = JSON.parse(JSON.stringify(h.runtime.getState())); delete copy.catchUp; return JSON.stringify(copy); };
        const state = quiet();
        const catchUp = h.controller();
        const seen = [];
        catchUp.restored();
        while (catchUp.status().active) { seen.push(h.mockState.prompts.length); written.push(quiet() === state); await h.sleep(5); }
        await catchUp.idle();
        h.check(written.every(Boolean), 'nothing of the live state moved before the install');
        h.check(seen.every(count => count === promptsBefore), 'no prompt injection during the replay');
        h.equal(toasts, [], 'no toast during the replay');
        h.equal(h.published(), 1, 'one publication');
        h.check(h.mockState.prompts.length > promptsBefore, 'the install updated the injection once it was done');
    });
});

test('all or nothing: a failed reply, a new message and a chat change leave the live state as it was; the field stays and resumes', () => {
    runScenario('atomic', async h => {
        h.addReplies(6);
        const snapshot = JSON.stringify(h.runtime.getState());
        h.mockState.failWhen = (prompt, count) => count === 3;
        let catchUp = h.controller();
        catchUp.restored();
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'failed', 'the failed reply stops the replay');
        h.check(catchUp.canGenerate() === true, 'sending is not held after a failure');
        const live = h.runtime.getState();
        h.equal(live.catchUp?.attempt, 1, 'the field stays, attempt 1');
        const without = JSON.parse(JSON.stringify(live));
        delete without.catchUp;
        h.equal(without, JSON.parse(snapshot), 'the live dossiers are byte-identical to before');
        // A reload: a new controller resumes and finishes (the model works now).
        h.mockState.failWhen = null;
        catchUp = h.controller();
        h.equal(catchUp.resume().started, true, 'resume on chat open');
        h.check(catchUp.canGenerate().ok === false, 'held again while it resumes');
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'resumed and done');
        h.check(h.runtime.getState().catchUp === undefined, 'the field is cleared after the publication');
        h.equal(h.published(), 1, 'one publication in all');
        // A new message mid-run: stale, nothing installed.
        h.addReplies(3);
        const mid = JSON.stringify(h.runtime.getState());
        h.mockState.holdWhen = async (prompt, count) => { if (count === h.mockState.fakeCalls.length && /mark-2\b/.test(prompt) && !h.mockState.moved) { h.mockState.moved = true; h.mockState.context.chat.push(h.reply('A late reply, mark-99.', 99)); } };
        catchUp = h.controller();
        catchUp.restored();
        await catchUp.idle();
        h.check(['stale', 'failed'].includes(catchUp.status().outcome), `the head changed: ${catchUp.status().outcome}`);
        const after = JSON.parse(JSON.stringify(h.runtime.getState()));
        delete after.catchUp;
        const midState = JSON.parse(mid);
        delete midState.catchUp;
        h.equal(after, midState, 'nothing installed after a head change');
    });
});

test('retry cap: three failed attempts across reloads, then no more', () => {
    runScenario('retry-cap', async h => {
        h.addReplies(3);
        h.mockState.failWhen = () => true;
        const attempts = [];
        for (let i = 0; i < 4; i += 1) {
            const catchUp = h.controller();
            const started = i === 0 ? catchUp.restored() : catchUp.resume();
            attempts.push(started.started);
            await catchUp.idle();
        }
        h.equal(attempts, [true, true, true, false], 'three tries, the fourth does not start');
        h.equal(h.runtime.getState().catchUp.attempt, 3, 'the field says 3 tries');
    });
});

test('Skip: stops after the current reply, keeps the dossiers, marks the replies read, releases sending', () => {
    runScenario('skip', async h => {
        h.addReplies(5);
        const before = JSON.stringify(h.runtime.getState().npcs);
        let release;
        h.mockState.holdWhen = async (prompt, count) => { if (count === 2) await new Promise(resolve => { release = resolve; }); };
        const catchUp = h.controller();
        catchUp.restored();
        for (let i = 0; i < 100 && !release; i += 1) await h.sleep(10);
        const held = catchUp.canGenerate();
        h.check(held.ok === false && /^Sending waits until the dossiers catch up \(reply 2 of 5\)\.$/.test(held.reason), `held with the progress: ${held.reason}`);
        catchUp.skip();
        release();
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'skipped', 'skipped');
        h.equal(h.mockState.fakeCalls.length, 2, 'it stopped after the current reply');
        h.equal(JSON.stringify(h.runtime.getState().npcs), before, 'the dossiers stay as installed');
        const state = h.runtime.getState();
        h.equal(state.lastScannedMessageId, h.mockState.context.chat.length - 1, 'the replies are marked read');
        h.check(state.catchUp === undefined, 'no field is left');
        h.check(catchUp.canGenerate() === true, 'sending is back');
        h.equal(h.published(), 0, 'nothing published');
    });
});

test('cap: 60 missed replies read the last 40; the older 20 are marked read', () => {
    runScenario('cap', async h => {
        h.addReplies(60);
        const catchUp = h.controller();
        catchUp.restored();
        h.equal([catchUp.status().total, catchUp.status().older], [40, 20], 'the banner counts 40 of 60');
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'done');
        const prompts = h.mockState.fakeCalls;
        h.equal(prompts.length, 40, '40 calls');
        const first = [...prompts[0].matchAll(/mark-(\d+)/g)].map(match => Number(match[1]));
        h.check(Math.min(...first) >= 21 && Math.max(...first) === 21, `the first window is reply 21 alone (marked-read marker): ${first}`);
    });
});

test('rebuild with N replies reads the last N onto an empty state', () => {
    runScenario('rebuild-n', async h => {
        h.addReplies(8);
        const catchUp = h.controller();
        catchUp.rebuild({ replies: 3 });
        await catchUp.idle();
        h.equal(h.mockState.fakeCalls.length, 3, 'three calls');
        h.equal(catchUp.status().older, 5, 'five marked read');
    });
});

test('a disabled Delta or a chat with nothing missed holds nothing', () => {
    runScenario('nothing', async h => {
        const catchUp = h.controller();
        h.equal(catchUp.restored().started, false, 'no replies: nothing starts');
        h.check(catchUp.canGenerate() === true, 'not held');
    });
});

test('participant: restored is exposed to Story Block; an exact install never calls it', async () => {
    const { createParticipant } = await import('../src/storysuite-participant/participant.js');
    let live = 0;
    const port = { chatKey: () => 'chat', readState: () => ({ npcs: [] }), installState() {}, writeTimeline() {}, enabled: () => true, live: () => { live += 1; return null; } };
    const { participant } = createParticipant({ port, vault: { put() {}, get() {}, getIndex() {}, putIndex() {} } });
    assert.equal(typeof participant.restored, 'function');
    assert.equal(typeof participant.rebuild, 'function');
    assert.equal(live, 0, 'registering touches nothing');
    const handlers = fs.readFileSync(new URL('../src/storysuite-participant/participant/handlers.js', import.meta.url), 'utf8');
    assert.ok(!/port\.restored/.test(handlers), 'an install (an exact restore too) does not start a catch-up');
    const answer = await participant.prepare({ return: '', checkpoint: 'c', hash: 'h' });
    assert.equal(answer.ok, false, 'an empty return is refused before anything is adopted');
});

test('Story Block as a replay sees it: reads are asked as of the reply, writes go to the sink and are never sent', () => {
    runScenario('scoped-adapter', async h => {
        const { scopedAdapter } = await import(pathToFileURL(path.join(extRoot, 'runtime-scan-helpers.js')).href);
        const asked = [];
        const sent = [];
        const adapter = {
            at: (index, fn) => { asked.push(index); return fn(); },
            sliceView: npcs => npcs,
            adjust: () => { sent.push('adjust'); },
            openByEvent: () => { sent.push('open'); },
        };
        const writes = [];
        const view = scopedAdapter(adapter, 7, { hostedWrite: (name, args) => writes.push([name, args]) });
        h.equal(view.sliceView([1]), [1], 'a read answers');
        h.equal(asked, [7], 'a read is asked as of reply 7');
        await view.adjust({ name: 'A' });
        await view.openByEvent({ name: 'A', ids: ['n'] });
        h.equal(sent, [], 'nothing reaches Story Block');
        h.equal(writes.map(entry => entry[0]), ['adjust', 'openByEvent'], 'the writes are recorded in the sink');
    });
});
