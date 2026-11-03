import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Lean scan cadence through the real event handlers of the synthetic SillyTavern host.
// Each scenario runs in its own process on a fresh host built from the runtime-smoke setup
// (everything before its scenario body), so no scenario depends on the long smoke run.

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
mockState.updatedBlocks = [];
mockState.context.updateMessageBlock = (id, message) => { mockState.updatedBlocks.push({ id, mes: message.mes }); };
mockState.earlierListenerSaw = [];
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    const helpers = (${cadenceHelpers.toString()})(mockState, eventSource, sleep);
    await (${scenario.toString()})(helpers);
    console.log('narration capture scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script,
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual|\bat\b.*<anonymous>/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}

// Runs inside the synthetic host.
function cadenceHelpers(mockState, eventSource, sleep) {
    const fail = message => { throw new Error(message); };
    const check = (condition, message) => { if (!condition) fail(message); };
    const equal = (actual, expected, message) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };
    const runtime = globalThis.NPCStateDelta;
    const settings = mockState.extensionSettings.npc_state_delta;
    const scannerCalls = () => mockState.rawCalls.map(call => call?.[0] || {}).filter(args => /isolated dossier scanner\./i.test(String(args.systemPrompt || '')));
    const emitAsync = async (event, ...args) => {
        await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args)));
        await sleep(40);
    };
    const turn = async (userText, replyText) => {
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: userText });
        await emitAsync('message_sent', mockState.context.chat.length - 1);
        await emitAsync('generation_after_commands', 'normal', {}, false);
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: replyText, swipe_id: 0, swipes: [replyText] });
        const id = mockState.context.chat.length - 1;
        await emitAsync('message_received', id);
        await sleep(80);
        return id;
    };
    mockState.quietResponder = async (args = {}) => {
        if (/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) return JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'scanned adventurer' }] });
        return '{"npcs":[]}';
    };
    return { fail, check, equal, runtime, settings, scannerCalls, turn, mockState, sleep };
}

test('lean: the shipped default of Scan every is 5', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /\n    scanEvery: 5,\n    scanDepth: 6,/);
});

test('lean: a quiet reply with no names makes no scanner call; a new name does', () => {
    runScenario('quiet-then-name', async h => {
        h.settings.scanEvery = 5;
        for (const reply of ['They walk down the road in silence.', 'The wind is cold and the road is long.']) {
            await h.turn('We walk on.', reply);
        }
        h.equal(h.scannerCalls().length, 0, 'quiet replies: no call');
        h.equal(h.runtime.getState().assistantSinceScan, 2, 'the quiet replies are counted for the safety scan');
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        h.equal(h.scannerCalls().length, 1, 'a new name: one call');
        h.equal(h.runtime.getState().assistantSinceScan, 0, 'the scan resets the count');
        // A tracked NPC named again scans; a quiet reply after it does not.
        await h.turn('Go on.', 'Yunyun nods and says nothing.');
        h.equal(h.scannerCalls().length, 2, 'a tracked NPC named: a call');
        await h.turn('We rest.', 'They rest by the fire in silence.');
        h.equal(h.scannerCalls().length, 2, 'quiet again: no call');
    });
});

test('lean: the safety scan runs every Scan every replies, and Scan every 1 scans every reply', () => {
    runScenario('safety', async h => {
        h.settings.scanEvery = 3;
        for (let i = 0; i < 2; i += 1) await h.turn('We walk on.', 'They walk down the road in silence.');
        h.equal(h.scannerCalls().length, 0, 'two quiet replies of three: no call');
        await h.turn('We walk on.', 'They walk down the road in silence.');
        h.equal(h.scannerCalls().length, 1, 'the third quiet reply is the safety scan');
        h.settings.scanEvery = 1;
        await h.turn('We walk on.', 'They walk down the road in silence.');
        h.equal(h.scannerCalls().length, 2, 'Scan every 1 scans a quiet reply, as before');
    });
});

// ---- pure helpers (no host) ----
import { autoScanDue, replyMayChangeDossiers } from '../scan-context.js';
import { buildInjection } from '../core.js';

test('lean: autoScanDue lets a reply that names someone scan at once; a quiet reply waits for the safety scan', () => {
    const due = (sinceScan, extra = {}) => autoScanDue({ autoScan: true, full: false, scanEvery: 5, sinceScan, ...extra });
    assert.equal(due(1), false, 'quiet, 1 of 5');
    assert.equal(due(4), false, 'quiet, 4 of 5');
    assert.equal(due(5), true, 'the safety scan');
    assert.equal(due(1, { replyChanges: true }), true, 'a name in the reply');
    assert.equal(due(1, { replyChanges: true, autoScan: false }), false, 'Auto scan off stays off');
    assert.equal(due(1, { everyReply: false, replyChanges: true }), false, 'Story Suite "every reply" off keeps its own cadence');
});

test('lean: the local check finds a new name, a tracked NPC or an NPC State line, and nothing in quiet prose', () => {
    const roster = [{ id: 'a', name: 'Yunyun Aldis', aliases: ['Yun'], role: 'adventurer' }];
    const check = text => replyMayChangeDossiers({ texts: [text], roster, ignore: ['Ari', 'Narrator'] });
    assert.equal(check('They walk down the road in silence. The wind is cold.'), false);
    assert.equal(check('Ari looks at the Narrator and sighs. "Well," he says.'), false, 'the player and the character are not new names');
    assert.equal(check('Rain falls on the road. The rain keeps falling.'), false, 'a capitalised common word that also shows in lower case');
    assert.equal(check('Then Mara Voss steps in.'), true, 'a new full name');
    assert.equal(check('He meets old Brannock at the gate.'), true, 'a new name mid-sentence');
    assert.equal(check('Kael nods and leaves.'), true, 'a new name opening a sentence');
    assert.equal(check('Yun waves.'), true, 'a tracked NPC by alias');
    assert.equal(check('NPC State: Mira is wary.'), true, 'an NPC State line');
    assert.equal(check(''), false);
});

test('lean: the dossier text is short: preamble and rubric about 600 characters, and every field label the narrator reads is kept', () => {
    const one = buildInjection([{
        id: 'n1', name: 'Vrena', present: true, role: 'Guild clerk', species: 'Human', gender: 'female', age: '30', appearance: 'Slender, dark braid.',
        personality: 'Practical.', speech: 'Clipped.', mannerisms: ['Taps the desk'], mood: 'wary', status: 'on duty', goal: 'Finish the ledger',
        relationshipSummary: 'Cautiously warming.', relationship: { trust: 30, affection: 15, desire: 0, tension: 12 }, behaviorProfile: ['Disposition: guarded - slow to trust'],
        memories: ['Saw the rescue'], keyRelationships: ['Sister of Tolk'], background: 'Port city.', location: 'Guild hall',
    }], 'Vrena', 1, 3);
    const [preamble, ...rest] = one.split('\n- Vrena:');
    const rubric = one.slice(one.indexOf('RELATIONSHIP-TO-BEHAVIOR RUBRIC:'));
    assert.ok(preamble.length + rubric.length <= 700, `preamble + rubric ${preamble.length + rubric.length}`);
    assert.equal(rest.length, 1);
    assert.match(one, /^NPC STATE DELTA DOSSIER\. Only confirmed-present NPCs/);
    assert.match(one, /high scores never mean obedience, clinginess, jealousy, tsundere behavior/);
    for (const label of ['IDENTITY: personality:', 'behavioral profile:', 'speech:', 'mannerisms:', 'AGENCY/BONDS: role:', 'goal:', 'bonds:', 'STATE: mood:', 'status:', 'TOWARD PLAYER (secondary):', 'APPEARANCE (authoritative; species cannot override the form):', 'memories:', 'species:', 'gender:', 'age:', 'location:', 'background:']) {
        assert.ok(one.includes(label), `keeps ${label}`);
    }
});
