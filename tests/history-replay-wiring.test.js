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

test('Skip pressed before the engine starts (Story Block\'s barrier still up): nothing is read, the replies are marked read, sending is back', () => {
    runScenario('skip-early', async h => {
        h.addReplies(4);
        const before = JSON.stringify(h.runtime.getState().npcs);
        let lower;
        const catchUp = h.controller({ settled: () => (lower ? true : new Promise(resolve => { lower = () => resolve(true); })) });
        catchUp.restored();
        h.check(catchUp.canGenerate().ok === false, 'held while waiting for the barrier');
        await catchUp.skip();
        lower();
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'skipped', 'skipped');
        h.equal(h.mockState.fakeCalls.length, 0, 'no model call was made');
        h.equal(JSON.stringify(h.runtime.getState().npcs), before, 'the dossiers stay as installed');
        const state = h.runtime.getState();
        h.equal(state.lastScannedMessageId, h.mockState.context.chat.length - 1, 'the replies are marked read');
        h.check(state.catchUp === undefined, 'no field is left');
        h.check(catchUp.canGenerate() === true, 'sending is back');
        h.equal(h.published(), 0, 'nothing published');
        // A later catch-up is not born skipped.
        h.addReplies(2);
        catchUp.restored();
        await catchUp.idle();
        h.check(catchUp.status().outcome !== 'skipped', 'the next catch-up runs');
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

test('live readers and writers during a catch-up that awaits the model: they see the installed state; a manual edit is kept, the catch-up retries on top of it', () => {
    runScenario('live-during-wait', async h => {
        await h.turn('We meet.', 'Yunyun speaks, mark-1.');
        const chatKey = h.runtime.uiStatus().chatKey;
        const npcId = h.runtime.getState().npcs[0].id;
        h.addReplies(4);
        const installed = JSON.stringify(h.runtime.getDossierState().npcs);
        let release;
        let held = 0;
        h.mockState.holdWhen = async () => { if (!held) { held = 1; await new Promise(resolve => { release = resolve; }); } };
        const catchUp = h.controller();
        catchUp.restored();
        for (let i = 0; i < 100 && !release; i += 1) await h.sleep(10);
        h.check(release, 'the catch-up is waiting for the model');
        // A live read sees the installed state, never the copy (and token counts / injection read the same state).
        h.equal(JSON.stringify(h.runtime.getDossierState().npcs), installed, 'the dossier panel reads the installed state');
        // A manual edit is applied to the live state and saved.
        h.check(await h.runtime.setPortraitSeed(npcId, 4242, { chatKey }) === true, 'the manual edit was accepted');
        await h.runtime.flush();
        h.equal(h.runtime.getState().npcs.find(n => n.id === npcId).portraitSeed, 4242, 'the edit is in the live state');
        release();
        await catchUp.idle();
        // The first try found the live state moved (stale); the retry ran on top of the edit and installed.
        h.equal(catchUp.status().outcome, 'done', 'the retry finished');
        const after = h.runtime.getState();
        h.check(after.npcs.some(n => n.id === npcId), 'the edited dossier is still there');
        h.equal(after.npcs.find(n => n.id === npcId).portraitSeed, 4242, 'the manual edit was not lost');
        h.check(h.mockState.fakeCalls.length > 4, 'the catch-up ran again on top of the edit');
        h.check(after.catchUp === undefined, 'no field left');
        h.check(catchUp.canGenerate() === true, 'sending is back');
    });
});

test('a catch-up whose backfill waits for the host gate: live readers see the installed state, a manual edit is kept (the short await steps aside too)', () => {
    runScenario('live-during-gate', async h => {
        await h.turn('We meet.', 'Yunyun speaks, mark-1.');
        const chatKey = h.runtime.uiStatus().chatKey;
        const npc = h.runtime.getState().npcs[0];
        h.addReplies(4);
        const live = JSON.parse(JSON.stringify(h.runtime.getState()));
        live.pendingBackfills = [{ queueVersion: 1, reason: 'new-admission', npcId: npc.id, label: npc.name, requestedMessageId: null, preserveLiveState: false, silent: true, requestedAt: Date.now(), attempts: 0, lastAttemptAt: 0 }];
        await h.runtime.installState(live);
        const installed = JSON.stringify(h.runtime.getDossierState().npcs);
        let release = null;
        let asked = 0;
        h.runtime.useMessageGate({ refresh: async () => { asked += 1; if (!release) await new Promise(resolve => { release = resolve; }); return null; }, settled: async () => true });
        const catchUp = h.controller();
        catchUp.restored();
        for (let i = 0; i < 200 && !release; i += 1) await h.sleep(10);
        h.check(release, `the catch-up is waiting for the host gate (asked ${asked}, ${JSON.stringify(catchUp.status())}, pending ${JSON.stringify(h.runtime.getState().pendingBackfills)}, calls ${h.mockState.fakeCalls.length})`);
        h.equal(JSON.stringify(h.runtime.getDossierState().npcs), installed, 'live readers see the installed state');
        h.check(await h.runtime.setPortraitSeed(npc.id, 4242, { chatKey }) === true, 'the manual edit was accepted');
        await h.runtime.flush();
        h.equal(h.runtime.getState().npcs.find(n => n.id === npc.id).portraitSeed, 4242, 'the edit is in the live state and saved');
        release();
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'the catch-up finished on top of the edit');
        h.equal(h.runtime.getState().npcs.find(n => n.id === npc.id).portraitSeed, 4242, 'the manual edit was not lost');
        h.check(catchUp.canGenerate() === true, 'sending is back');
    });
});

test('a publication that fails after a successful install: the catch-up is done, installed, and the publication is retried by the normal path', () => {
    runScenario('publish-fails', async h => {
        h.addReplies(3);
        let retried = 0;
        const catchUp = h.controller({ publish: async () => { throw new Error('the host was busy'); }, retryPublish: () => { retried += 1; } });
        catchUp.restored();
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'done, not failed');
        h.equal(retried, 1, 'the normal publication path was asked to retry');
        h.check(h.runtime.getState().catchUp === undefined, 'the field is gone (installed)');
        h.check(catchUp.canGenerate() === true, 'sending is back');
    });
});

// (ONEPASSCAPR2-1) A reply whose one-pass block was accepted is rebuilt from that accepted block, not from a model's answer: replay == live.
test('parity: a captured one-pass reply (memory, tie string, edge) replays to the live dossiers; the old reply read again keeps its bytes', () => {
    runScenario('captured-parity', async h => {
        h.settings.narrationCapture = true;
        const mockState = h.mockState;
        const block = payload => `\n\n<!--npc_state_delta\n${JSON.stringify(payload)}\n-->`;
        const ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
        const scanner = mockState.quietResponder;
        // An accepted admission fill: the backfill answers for the person asked, with a look.
        mockState.quietResponder = async (args = {}) => {
            const asked = (/backfill scanner/i.test(String(args.systemPrompt || '')) ? String(args.prompt || '').match(/^(?:Requested|Target) NPC: (.+?)(?: [(].*)?$/m)?.[1] : undefined);
            return asked ? JSON.stringify({ npcs: [{ name: asked, present: true, overallAppearance: 'Human woman. Dark hair, wide brown eyes.', relationshipImpact: 'none', relationshipDelta: ZERO }] }) : scanner(args);
        };
        const row = { name: 'Sieke', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'clerk', directInteraction: true, present: true, role: 'Clerk', species: 'Human', gender: 'female',
            memories: ['Registered Astra at the guild desk.'], keyRelationships: 'Sister Temiwa — novice | brings bread', relationshipImpact: 'none', relationshipDelta: ZERO };
        await h.turn('Hello.', `Sieke, a clerk, sits at the guild desk. Sister Temiwa waits.${block({ npcs: [row, { ...row, name: 'Sister Temiwa', memories: [], keyRelationships: [] }], keyRelationshipEdges: [{ from: 'Sieke', to: 'Sister Temiwa', aToB: 'friend', bToA: 'friend' }] })}`);
        await h.turn('Go on.', `Sieke stamps a form.${block({ npcs: [{ name: 'Sieke', present: true, memories: ['Stamped Astra\'s form while the novice watched.'], relationshipImpact: 'none', relationshipDelta: ZERO }] })}`);
        const live = h.stable(h.runtime.getState());
        h.check(live.npcs.find(npc => npc.name === 'Sieke')?.memories?.length >= 2, 'the live run kept both memories');
        const catchUp = h.controller();
        catchUp.rebuild({ replies: null });
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'the rebuild finished');
        const replayed = h.stable(h.runtime.getState());
        const moved = [];
        for (const key of new Set([...Object.keys(live), ...Object.keys(replayed)])) {
            if (key === 'npcs') for (const npc of live.npcs) { const other = replayed.npcs.find(item => item.id === npc.id) || {}; for (const field of Object.keys(npc)) if (JSON.stringify(npc[field]) !== JSON.stringify(other[field])) moved.push(`${npc.id}.${field}`); }
            else if (JSON.stringify(live[key]) !== JSON.stringify(replayed[key])) moved.push(key);
        }
        if (moved.includes('pendingBackfills')) h.fail(`backfills ${JSON.stringify(live.pendingBackfills)} vs ${JSON.stringify(replayed.pendingBackfills)}`);
        h.equal(moved, [], 'replay of captured replies == the live run (nothing lost)');
    });
});

// (ONEPASSCAPR2-8) With Full scan every reply on, a deferred full scan of a reply the automatic scan already read is skipped: one read per reply.
test('full scan: a reply the automatic scan covered is not read again by the full scan', () => {
    runScenario('full-scan-once', async h => {
        h.settings.fullScanEveryTurn = true;
        const id = await h.turn('Hello.', 'Yunyun speaks, mark-1.');
        const after = h.scannerCalls().length;
        h.check(after >= 1, 'the reply was read');
        h.equal(h.runtime.getState().lastScannedMessageId, id, 'the marker is on the reply');
        // The second trigger: a branch reconcile asks for a rescan of the latest reply (the chat is unchanged).
        await h.runtime.reconcile({ rescan: true, reason: 'test-reconcile' });
        await h.sleep(300);
        h.equal(h.scannerCalls().length, after, 'no second read of the same, unchanged reply');
    });
});

// (ONEPASSCAPR2-1) The new readings (string ties, folded ids, no ambiguous binding) apply to a reply the SCANNER read live too, so replay reads them the same way;
// a reply with no journal entry (read before the journal existed) is a historical re-read and keeps the old bytes.
test('parity: a scanner-read reply with a string tie and an underscore-id edge replays to the live dossier; an old reply (no journal entry) keeps its old reading', () => {
    runScenario('scanner-new-shapes', async h => {
        const ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
        const row = (name, extra = {}) => ({ name, present: true, role: 'regular', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO, ...extra });
        h.mockState.quietResponder = async (args = {}) => {
            if (!/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) return '{"npcs":[]}';
            return JSON.stringify({ npcs: [row('Sister Chris'), row('Sieke', { keyRelationships: 'Sister Chris — novice | brings bread' })], keyRelationshipEdges: [{ from: 'npc_sieke', to: 'npc_sister_chris', aToB: 'friend', bToA: 'friend' }] });
        };
        await h.turn('Hello.', 'Sieke and Sister Chris talk at the desk, mark-1.');
        const live = h.stable(h.runtime.getState());
        const sieke = live.npcs.find(npc => npc.name === 'Sieke');
        h.check(sieke?.keyRelationships?.some(text => /^Sister Chris — /.test(text)), `the live run read the string tie: ${JSON.stringify(sieke?.keyRelationships)}`);
        const catchUp = h.controller();
        catchUp.rebuild({ replies: null });
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'the rebuild finished');
        const replayed = h.stable(h.runtime.getState());
        h.equal(replayed.npcs.map(npc => [npc.name, npc.keyRelationships]), live.npcs.map(npc => [npc.name, npc.keyRelationships]), 'replay == live for the new shapes');
        // The same chat as an old save: no journal entry for the reply, so the replay is a historical re-read with the old reading.
        const saved = h.runtime.getState();
        delete saved.captureJournal;
        await h.runtime.installState(saved);
        h.check(!h.runtime.getState().captureJournal?.length, 'the journal is gone, like an old save');
        const old = h.controller();
        old.rebuild({ replies: null });
        await old.idle();
        h.equal(h.runtime.getState().npcs.find(npc => npc.name === 'Sieke').keyRelationships, [], 'an old reply keeps its old bytes: the string tie is still not read');
    });
});

test('ONEPASSMISS-1: replay does not invent missing-capture fallbacks for old replies', () => {
    runScenario('no-capture-fallback-on-replay', async h => {
        h.settings.narrationCapture = true;
        h.settings.scanEvery = 10;
        h.addReplies(2);
        const calls = h.scannerCalls().length;
        const catchUp = h.controller();
        catchUp.rebuild({ replies: null });
        await catchUp.idle();
        h.equal(catchUp.status().outcome, 'done', 'rebuild finished');
        h.equal(h.scannerCalls().length, calls, 'quiet historical replies keep their ordinary cadence');
        h.equal(h.runtime.scannerReport().filter(line => line.includes('the reply had no NPC capture')), [], 'replay reports no live fallback');
    });
});
