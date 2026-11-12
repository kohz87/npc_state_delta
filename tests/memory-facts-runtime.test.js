import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Memory facts through the production handler and scanner of the synthetic SillyTavern host: the live-eligibility mark at receipt, the fact an applied
// relationship move leaves, the MEMORY FACTS paragraph only for a call whose own window holds the fact's reply, the phrasing taken at commit, and an old
// (unmarked) chat staying exactly as before. Deterministic fake model; no provider. Each scenario runs in its own process (runtime-smoke setup).
const REPLAY_URL = new URL('../src/storysuite-participant/history-replay.js', import.meta.url).href;
const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

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
    console.log('memory facts scenario ${name} passed');
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
    const runtime = globalThis.NPCStateDelta;
    const settings = mockState.extensionSettings.npc_state_delta;
    settings.scanEvery = 1;
    const scannerCalls = () => mockState.rawCalls.map(call => call?.[0] || {}).filter(args => /isolated dossier scanner\./i.test(String(args.systemPrompt || '')));
    const emitAsync = async (event, ...args) => {
        await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args)));
        await sleep(40);
    };
    let clock = 0;
    const reply = text => ({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text], send_date: new Date(Date.UTC(2026, 0, 1, 0, clock += 1)).toISOString() });
    const turn = async (userText, replyText) => {
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: userText });
        await emitAsync('message_sent', mockState.context.chat.length - 1);
        await emitAsync('generation_after_commands', 'normal', {}, false);
        mockState.context.chat.push(reply(replyText));
        const id = mockState.context.chat.length - 1;
        await emitAsync('message_received', id);
        await sleep(80);
        return id;
    };
    mockState.prompts = [];
    mockState.moveOn = null;
    mockState.phrase = null;
    // The focused relationship evaluator (a separate request): when `focusedOn` is in its prompt it decides a major trust rise for Yunyun.
    mockState.focusedOn = null;
    mockState.quietResponder = async (args = {}) => {
        if (/isolated relationship evaluator/i.test(String(args.systemPrompt || ''))) {
            if (!mockState.focusedOn || !String(args.prompt || '').includes(mockState.focusedOn)) return '{"npcs":[]}';
            return JSON.stringify({ npcs: [{ name: 'Yunyun', relationshipImpact: 'major', relationshipDelta: { trust: 4, affection: 0, desire: 0, tension: 0 }, relationshipChangeReason: 'Yunyun saves Kazuma from the guards', relationshipEvidence: { trust: 'Yunyun saves Kazuma from the guards.', affection: '', desire: '', tension: '' } }] });
        }
        if (!/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) return '{"npcs":[]}';
        const prompt = String(args.prompt || '');
        mockState.prompts.push(prompt);
        const row = { name: 'Yunyun', present: true, role: 'adventurer' };
        if (mockState.moveOn && prompt.includes(mockState.moveOn)) Object.assign(row, { relationshipImpact: 'major', relationshipDelta: { trust: 4, affection: 0, desire: 0, tension: 0 }, relationshipChangeReason: 'Yunyun saves Kazuma from the guards', relationshipEvidence: { trust: 'Yunyun saves Kazuma from the guards.', affection: '', desire: '', tension: '' } });
        const out = { npcs: /Yunyun/.test(prompt) ? [row] : [] };
        if (mockState.phrase && prompt.includes('MEMORY FACTS')) out.mem = mockState.phrase(prompt);
        return JSON.stringify(out);
    };
    const state = () => runtime.getState();
    const yunyun = () => state().npcs.find(npc => npc.name === 'Yunyun');
    const controller = () => createCatchUp({ chatKey: () => runtime.chatKey(), enabled: () => true, live: () => runtime.replay, changed() {}, publish: async () => {}, warn() {} });
    const facts = () => { const npc = state().npcs.find(item => item.name === 'Yunyun'); return JSON.stringify([npc?.memories, npc?.memoryFacts, npc?.memoryStamps]); };
    return { fail, check, controller, facts, runtime, settings, mockState, sleep, turn, scannerCalls, state, yunyun, reply, emitAsync };
}

test('memory facts live: a new live reply is marked, an applied major move leaves one dated fallback memory, later calls never repeat it', () => {
    runScenario('live-fact', async h => {
        await h.turn('We meet.', 'Yunyun greets Kazuma, mark-1.');
        h.mockState.moveOn = 'mark-2';
        await h.turn('Guards!', 'Yunyun saves Kazuma from the guards, mark-2.');
        const npc = h.yunyun();
        h.check(h.state().memoryFactMarks?.keys?.length === 2, 'both live replies are marked');
        h.check(npc.memories.length === 1 && /^My trust in .+ (rose|grew)\.$/.test(npc.memories[0]), `the fallback memory exists: ${JSON.stringify(npc.memories)}`);
        const entry = Object.values(npc.memoryFacts.entries)[0];
        h.check(entry.r === 3 && entry.c === 'A' && entry.pend === 1, 'one pending class-A fact of reply 3');
        h.check(npc.memoryStamps[Object.keys(npc.memoryStamps)[0]].m === 3, 'stamped with its reply');
        h.check(h.mockState.prompts.every(prompt => !prompt.includes('MEMORY FACTS')), 'no paragraph while no pending fact is inside a call window');
        await h.turn('On.', 'Yunyun walks on, mark-3.');
        h.check(yunyunMemories(h).length === 1, 'a later quiet reply adds nothing');
        function yunyunMemories(hh) { return hh.yunyun().memories; }
    });
});

test('memory facts live: a manual scan whose window holds the fact reply carries the paragraph, takes a valid sentence, keeps the stamp', () => {
    runScenario('live-phrase', async h => {
        await h.turn('We meet.', 'Yunyun greets Kazuma, mark-1.');
        h.mockState.moveOn = 'mark-2';
        await h.turn('Guards!', 'Yunyun saves Kazuma from the guards, mark-2.');
        h.mockState.moveOn = null;
        const before = h.yunyun();
        const stampBefore = JSON.stringify(Object.values(before.memoryStamps)[0]);
        h.mockState.phrase = prompt => {
            const line = prompt.split('\n').find(item => item.startsWith('h1: '));
            const forms = JSON.parse(`[${line.slice(4).split(' | ').join(',')}]`);
            return { h1: forms[forms.length - 1] };
        };
        await h.runtime.scan();
        await h.sleep(200);
        const prompts = h.mockState.prompts.filter(prompt => prompt.includes('MEMORY FACTS'));
        h.check(prompts.length >= 1, 'the manual scan window held the reply, so the paragraph was sent');
        const npc = h.yunyun();
        h.check(npc.memories.length === 1 && /grew\.$/.test(npc.memories[0]), `the second allowed sentence was taken: ${JSON.stringify(npc.memories)}`);
        h.check(JSON.stringify(Object.values(npc.memoryStamps)[0]) === stampBefore, 'the stamp moved with the text');
        h.check(!Object.values(npc.memoryFacts.entries)[0].pend, 'phrased: no longer pending');
    });
});

test('memory facts live: the focused relationship pass (where most real moves are applied) leaves the same fact, and it is not repeated', () => {
    runScenario('live-focused', async h => {
        await h.turn('We meet.', 'Yunyun greets Kazuma, mark-1.');
        h.mockState.focusedOn = 'mark-2';
        await h.turn('Guards!', 'Yunyun saves Kazuma from the guards, mark-2.');
        const npc = h.yunyun();
        h.check(npc.relationship.trust > 0, 'the focused decision applied');
        h.check(npc.memories.length === 1 && /^My trust in .+ (rose|grew)\.$/.test(npc.memories[0]), `the focused move left the fallback: ${JSON.stringify(npc.memories)}`);
        h.check(Object.values(npc.memoryFacts.entries)[0].r === 3 && npc.memoryStamps[Object.keys(npc.memoryStamps)[0]].m === 3, 'bound to its reply');
        h.mockState.focusedOn = null;
        await h.turn('On.', 'Yunyun walks on, mark-3.');
        h.check(h.yunyun().memories.length === 1, 'nothing repeated');
    });
});

test('memory facts live: parity - a rebuild from the chat gives the same memories, facts and stamps as the live run', () => {
    runScenario('parity-facts', async h => {
        await h.turn('We meet.', 'Yunyun greets Kazuma, mark-1.');
        h.mockState.focusedOn = 'mark-2';
        await h.turn('Guards!', 'Yunyun saves Kazuma from the guards, mark-2.');
        h.mockState.focusedOn = null;
        await h.turn('On.', 'Yunyun walks on, mark-3.');
        const live = h.facts();
        h.check(h.yunyun().memories.length === 1, 'the live run made the fact');
        const marks = JSON.stringify(h.state().memoryFactMarks.keys);
        const catchUp = h.controller();
        h.mockState.focusedOn = 'mark-2';
        catchUp.rebuild({ replies: null });
        while (catchUp.status().active) await h.sleep(5);
        await catchUp.idle();
        h.check(catchUp.status().outcome === 'done', 'the rebuild finished');
        h.check(h.facts() === live, `replay == live for memories/facts/stamps:\n${live}\n${h.facts()}`);
        h.check(JSON.stringify(h.state().memoryFactMarks.keys) === marks, 'marks kept');
    });
});

test('memory facts live: a rebuild never marks or derives for replies read before the rule was on; rule off derives nothing live', () => {
    runScenario('old-and-off', async h => {
        h.settings.memoryFacts = false;
        await h.turn('We meet.', 'Yunyun greets Kazuma, mark-1.');
        h.mockState.focusedOn = 'mark-2';
        await h.turn('Guards!', 'Yunyun saves Kazuma from the guards, mark-2.');
        h.check(!h.state().memoryFactMarks, 'rule off: no mark written');
        h.check(h.yunyun().relationship.trust > 0 && !h.yunyun().memoryFacts && h.yunyun().memories.length === 0, 'rule off: the move applied, no fact');
        h.settings.memoryFacts = true;
        const catchUp = h.controller();
        catchUp.rebuild({ replies: null });
        while (catchUp.status().active) await h.sleep(5);
        await catchUp.idle();
        h.check(catchUp.status().outcome === 'done', 'the rebuild finished');
        h.check(!h.state().memoryFactMarks, 'a rebuild never marks');
        h.check(!h.yunyun().memoryFacts && h.yunyun().memories.length === 0, 'an unmarked reply read again gains no fact');
    });
});
