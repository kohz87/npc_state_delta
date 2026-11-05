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
    return { fail, check, equal, runtime, settings, scannerCalls, turn, emitAsync, mockState, sleep };
}

test('lean: the shipped default of Scan every is 5', () => {
    const index = runtimeSource();
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
        // A tracked NPC named again scans; a pronoun-only reply does not, even with her in the scene.
        await h.turn('Go on.', 'Yunyun nods and says nothing.');
        h.equal(h.scannerCalls().length, 2, 'a tracked NPC named: a call');
        await h.turn('We rest.', 'She rests by the fire in silence.');
        h.equal(h.scannerCalls().length, 2, 'a present tracked NPC by pronoun only: the local check skips');
    });
});

test('lean: a scan reads every reply since the last scan, the ones the local check skipped included', () => {
    runScenario('skipped-replies-read', async h => {
        h.settings.scanEvery = 5;
        h.settings.scanDepth = 6;
        const base = 0;
        await h.turn('We walk on.', 'They walk down the road in silence, past the skipped-one milestone.');
        await h.turn('We walk on.', 'The wind is cold and the road is skipped-two long.');
        h.equal(h.scannerCalls().length, base, 'two quiet replies: no call');
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        const calls = h.scannerCalls().slice(base);
        h.equal(calls.length, 1, 'the name scans');
        h.check(/EARLIER exchanges[^]*skipped-one[^]*CURRENT exchange[^]*Yunyun steps out/.test(String(calls[0].prompt || '')), 'earlier replies are labelled EARLIER, the latest CURRENT');
        const prompt = String(calls[0].prompt || '');
        h.check(prompt.includes('skipped-one') && prompt.includes('skipped-two') && prompt.includes('Yunyun steps out'), 'the scan reads the skipped replies and the current one');
        // The next scan with nothing skipped reads the current exchange alone.
        await h.turn('Go on.', 'Yunyun nods and says nothing.');
        const last = String(h.scannerCalls()[base + 1].prompt || '');
        h.check(last.includes('Yunyun nods') && !last.includes('skipped-one'), 'nothing skipped: the current exchange only');
    });
});

test('lean: the window covers every skipped reply even when it is larger than Scan context', () => {
    runScenario('skipped-window', async h => {
        h.settings.scanEvery = 30;
        h.settings.scanDepth = 4;
        const base = 0;
        for (let i = 1; i <= 4; i += 1) await h.turn('We walk on.', `The road goes on, mile ${i} of skipped-${i}.`);
        h.equal(h.scannerCalls().length, base, 'quiet replies: no call');
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        const prompt = String(h.scannerCalls()[base].prompt || '');
        h.check(prompt.includes('Yunyun steps out') && prompt.includes('skipped-4') && prompt.includes('skipped-1'), 'all 5 replies are read although Scan context is 4');
    });
});

test('lean: a catch-up window applies a relationship change from an earlier reply once, and sets no presence, mood or location', () => {
    runScenario('catch-up', async h => {
        h.settings.scanEvery = 20;
        const yunyun = () => h.runtime.getState().npcs.find(n => n.name === 'Yunyun');
        let call = 0;
        h.mockState.quietResponder = async (args = {}) => {
            if (!/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) return '{"npcs":[]}';
            call += 1;
            if (call === 1) return JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', mood: 'calm', location: 'the gate' }] });
            if (call === 2) {
                return JSON.stringify({ npcs: [{
                    name: 'Yunyun', present: false, mood: 'furious', location: 'the moon',
                    relationshipDelta: { trust: 3, affection: 0, desire: 0, tension: 0 }, relationshipImpact: 'major',
                    relationshipChangeReason: 'She smiled at the player warmly and vouched for them.',
                    relationshipEvidence: { trust: 'She smiles at you warmly' },
                    relationshipSummary: 'Warming to the player.',
                }] });
            }
            return JSON.stringify({ npcs: [{ name: 'Yunyun', present: true }] });
        };
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        h.equal(h.scannerCalls().length, 1, 'she is added');
        const base = Number(yunyun().relationship.trust);
        for (let i = 1; i <= 16; i += 1) {
            await h.turn('We walk on.', i === 3 ? 'She smiles at you warmly, marker-3.' : `The road goes on, mile ${i} of marker-${i}.`);
        }
        h.equal(h.scannerCalls().length, 1, 'quiet replies (pronoun only): no call');
        await h.turn('Who is that?', 'Yunyun waves again.');
        const first = String(h.scannerCalls()[1].prompt || '');
        h.check(first.includes('marker-1.') && first.includes('marker-15.') && !first.includes('marker-16.'), 'the oldest 15 waiting replies are read first');
        h.check(/EARLIER exchanges/.test(first) && !/CURRENT exchange \(authoritative/.test(first), 'all earlier, no CURRENT');
        const afterEarlier = Number(yunyun().relationship.trust);
        h.check(afterEarlier > base, `the change from the earlier reply is applied (trust ${base} -> ${afterEarlier})`);
        h.check(yunyun().present === true && yunyun().mood === 'calm' && yunyun().location === 'the gate', 'an earlier-only window sets no presence, mood or location');
        await h.turn('Go on.', 'The fog thickens around the gate.');
        h.equal(h.scannerCalls().length, 3, 'the chat is still behind: the next reply scans at once');
        const second = String(h.scannerCalls()[2].prompt || '');
        h.check(second.includes('marker-16.') && second.includes('Yunyun waves again') && second.includes('fog thickens') && !second.includes('marker-15.') && !second.includes('smiles at you warmly'), 'the rest is read once; the reply with the change is not re-read');
        h.check(/CURRENT exchange[^]*fog thickens/.test(second), 'the latest is CURRENT');
        h.equal(Number(yunyun().relationship.trust), afterEarlier, 'the change applied exactly once');
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
    assert.equal(due(1, { everyReply: false, replyChanges: true }), false, 'Story Suite "every reply" off: the cadence alone, never earlier than 1.7.4');
    assert.equal(due(1, { everyReply: false }), false, 'Story Suite "every reply" off: a quiet reply keeps its own cadence');
    assert.equal(due(5, { everyReply: false }), true, 'Story Suite "every reply" off: the safety scan');
});

test('lean: the local check finds a new name, a tracked NPC or an NPC State line, and nothing in quiet prose', () => {
    const roster = [{ id: 'a', name: 'Yunyun Aldis', aliases: ['Yun'], role: 'adventurer' }];
    const check = (text, people = roster, ignore = ['Ari', 'Narrator']) => replyMayChangeDossiers({ texts: [text], roster: people, ignore,  });
    assert.equal(check('They walk down the road in silence. The wind is cold.'), false);
    assert.equal(check('Ari looks at the Narrator and sighs. "Well," he says.'), false, 'the player and the character are not new names');
    assert.equal(check('Rain falls on the road. The rain keeps falling.'), false, 'a capitalised common word that also shows in lower case');
    assert.equal(check('Then Mara Voss steps in.'), true, 'a new full name');
    assert.equal(check('He meets old Brannock at the gate.'), true, 'a new name mid-sentence');
    assert.equal(check('Kael nods and leaves.'), true, 'a new name opening a sentence');
    assert.equal(check('Yun waves.'), true, 'a tracked NPC by alias');
    assert.equal(check('NPC State: Mira is wary.'), true, 'an NPC State line');
    assert.equal(check('She sighs and looks away.', [{ id: 'm', name: 'Mira Vale', aliases: [], present: true }]), false, 'a present tracked NPC by pronoun only: the next scan reads it');
    assert.equal(check('Mira sighs and looks away.', [{ id: 'm', name: 'Mira Vale', aliases: [], present: true }]), true, 'a tracked NPC named');
    assert.equal(check('A boy runs up. "I am Bo," he says.'), true, 'a two-letter name');
    assert.equal(check('Will smiled. He will not be moved.'), true, 'a name that is also a common word, before a person verb');
    assert.equal(check('美咲という若い女性が微笑んで、こちらへ歩いてきた。'), true, 'a CJK name');
    assert.equal(check('ミラが扉を開けた。'), true, 'a katakana name');
    assert.equal(check('雨が降り続いている。'), false, 'quiet CJK prose');
    assert.equal(check('في الطريق مطر', ), true, 'text in a script without capitals is looked at');
    assert.equal(check('美咲がこちらを見た。', [{ id: 'c', name: '美咲', aliases: [], present: false }]), true, 'a tracked CJK name');
    assert.equal(check(''), false);
});

test('lean: the dossier text is short: preamble and rubric about 750 characters, and every field label the narrator reads is kept', () => {
    const one = buildInjection([{
        id: 'n1', name: 'Vrena', present: true, role: 'Guild clerk', species: 'Human', gender: 'female', age: '30', appearance: 'Slender, dark braid.',
        personality: 'Practical.', speech: 'Clipped.', mannerisms: ['Taps the desk'], mood: 'wary', status: 'on duty', goal: 'Finish the ledger',
        relationshipSummary: 'Cautiously warming.', relationship: { trust: 30, affection: 15, desire: 0, tension: 12 }, behaviorProfile: ['Disposition: guarded - slow to trust'],
        memories: ['Saw the rescue'], keyRelationships: ['Sister of Tolk'], background: 'Port city.', location: 'Guild hall',
    }], 'Vrena', 1, 3);
    const [preamble, ...rest] = one.split('\n- Vrena:');
    const rubric = one.slice(one.indexOf('RELATIONSHIP-TO-BEHAVIOR RUBRIC:'));
    assert.ok(preamble.length + rubric.length <= 850, `preamble + rubric ${preamble.length + rubric.length}`);
    for (const rule of [/never mention it or any numeric value/, /do not flatten distinct voices/, /durable identity changes gradually unless a time skip/]) assert.match(one, rule);
    assert.equal(rest.length, 1);
    assert.match(one, /^NPC STATE DELTA DOSSIER\. Only confirmed-present NPCs/);
    assert.match(one, /high scores never mean obedience, clinginess, jealousy, tsundere behavior/);
    for (const label of ['IDENTITY: personality:', 'behavioral profile:', 'speech:', 'mannerisms:', 'AGENCY/BONDS: role:', 'goal:', 'bonds:', 'STATE: mood:', 'status:', 'TOWARD PLAYER (secondary):', 'APPEARANCE (authoritative; species cannot override the form):', 'memories:', 'species:', 'gender:', 'age:', 'location:', 'background:']) {
        assert.ok(one.includes(label), `keeps ${label}`);
    }
});

test('lean: a low-standing NPC adds the "only them" rule to the dossier header', () => {
    const low = buildInjection([{ id: 'n1', name: 'Vrena', present: true, role: 'Guild clerk', personality: 'Practical.', relationship: { trust: -40, affection: -30, desire: 0, tension: 60 } }], 'Vrena', 1, 3);
    assert.match(low, /LOW SCORES: the player is not special to them; no obligation, fixation or "only them" thinking\./);
});

import { skippedExchangesWindow, useTranscriptSource } from '../src/transcript.js';
import { buildScannerPrompt } from '../core.js';

test('lean: the window covers every skipped reply (5 replies at Scan context 6 keep the first) and reports the true count', () => {
    const chat = [{ is_user: false, name: 'Nar', mes: 'Opening.' }];
    for (let k = 1; k <= 5; k += 1) { chat.push({ is_user: true, name: 'User', mes: `U${k}` }); chat.push({ is_user: false, name: 'Nar', mes: `R${k}` }); }
    useTranscriptSource({ context: () => ({ chat, name1: 'User', name2: 'Nar' }), scanDepth: () => 6 });
    const w = skippedExchangesWindow(10, { afterId: 0, replies: 5, limit: 6 });
    assert.ok(w.transcript.includes('R1') && w.transcript.includes('U1') && w.transcript.includes('R5'));
    assert.equal(w.replies, 5);
    assert.equal(w.latest, true);
    assert.equal(w.readThrough, 10);
});

// The walk of index.js's automatic scan: cadence, window, marker and the catch-up flag, over a chat of quiet replies.
function walk({ replies, everyReply, scanEvery = 5, scanDepth = 6, fail = () => false, initMarker = 0, fresh = false }) {
    const chat = [{ is_user: false, name: 'Nar', mes: 'R0 opening.' }];
    useTranscriptSource({ context: () => ({ chat, name1: 'User', name2: 'Nar' }), scanDepth: () => scanDepth });
    const roster = [{ name: 'Mira Vale', aliases: [], present: true }];
    let marker = initMarker; let since = 0; let behind = false;
    const reads = {}; const earlierOnly = [];
    for (let k = 1; k <= replies; k += 1) {
        chat.push({ is_user: true, name: 'User', mes: `U${k}` });
        chat.push({ is_user: false, name: 'Nar', mes: `R${k} she sighs.` });
        const id = chat.length - 1;
        since += 1;
        const changes = replyMayChangeDossiers({ texts: [chat[id - 1].mes, chat[id].mes], roster, ignore: ['User', 'Nar'] });
        if (!autoScanDue({ autoScan: true, full: false, sinceScan: since, scanEvery, everyReply, replyChanges: changes, catchUp: behind })) continue;
        if (fail(k)) continue;
        const w = skippedExchangesWindow(id, { afterId: marker, replies: since, limit: scanDepth, fresh: fresh && marker === null });
        const read = w ? [...w.transcript.matchAll(/Nar: R(\d+)/g)].map(m => +m[1]) : [k];
        for (const r of read) reads[r] = (reads[r] || 0) + 1;
        if (w && !w.latest) earlierOnly.push(read);
        marker = w ? w.readThrough : id;
        behind = Boolean(w && !w.latest);
        since = 0;
    }
    return { reads, earlierOnly, marker, behind, last: chat.length - 1 };
}
// Every reply up to the marker was read exactly once; none past it was read; what waits is shorter than the cadence.
const everyOnce = (result, scanEvery) => {
    const through = result.marker / 2;
    for (let r = 1; r <= through; r += 1) assert.equal(result.reads[r], 1, `reply ${r} read ${result.reads[r] || 0} times`);
    for (const r of Object.keys(result.reads)) assert.ok(Number(r) <= through, `reply ${r} read past the marker`);
    assert.ok((result.last - result.marker) / 2 < Math.max(scanEvery, 3) || result.behind, 'only a tail shorter than the cadence waits');
};

test('lean: after failing scans the chat catches up, oldest first, every reply read exactly once (Lean and default)', () => {
    for (const everyReply of [false, true]) {
        const result = walk({ replies: 40, everyReply, fail: k => k >= 3 && k <= 15 });
        everyOnce(result, 5);
        assert.ok(result.marker / 2 >= 36, 'the scans reached the end of the chat');
        assert.ok(result.earlierOnly.length >= 1, 'a catch-up window was used');
        for (const read of result.earlierOnly) assert.ok(read.length <= 15, 'a window holds at most 15 replies');
        assert.equal(result.earlierOnly[0][0], 1, 'the oldest waiting reply is read first');
    }
});

test('lean: Scan every 20 over 60 replies reads every reply once (catch-up, oldest first)', () => {
    for (const everyReply of [false, true]) {
        const result = walk({ replies: 60, everyReply, scanEvery: 20 });
        everyOnce(result, 20);
        assert.ok(result.marker / 2 >= 40);
        assert.equal(result.earlierOnly.length, 2, 'two catch-up windows of 15 replies, each followed by a scan of the rest');
    }
});

test('lean: a catch-up window labels everything EARLIER and has no CURRENT; the scan is due at once while behind', () => {
    const prompt = buildScannerPrompt({ transcript: 'User: u1\nNar: r1\nUser: u2\nNar: r2', currentTranscript: 'User: u2\nNar: r2', earlierOnly: true, existingNpcs: [], candidates: [] });
    assert.match(prompt, /EARLIER exchanges[^]*durable facts and relationship changes[^]*never current presence, mood or location[^]*User: u1[^]*User: u2/);
    assert.doesNotMatch(prompt, /CURRENT exchange \(authoritative/);
    assert.equal(autoScanDue({ autoScan: true, full: false, sinceScan: 1, scanEvery: 20, everyReply: false, catchUp: true }), true);
    assert.equal(autoScanDue({ autoScan: false, full: false, sinceScan: 1, scanEvery: 20, catchUp: true }), false, 'Auto scan off stays off');
});

test('lean: Lean mode (Scan after every reply off) scans no more often than every 3 replies, as in 1.7.4', () => {
    const due = (sinceScan, extra = {}) => autoScanDue({ autoScan: true, full: false, scanEvery: 1, sinceScan, everyReply: false, ...extra });
    assert.deepEqual([1, 2, 3].map(n => due(n, { replyChanges: true })), [false, false, true]);
    assert.deepEqual([1, 2, 3].map(n => due(n)), [false, false, true]);
});

test('lean: a scan of several exchanges labels the earlier ones and the latest CURRENT', () => {
    const prompt = buildScannerPrompt({ transcript: 'User: u1\nNar: r1\nUser: u2\nNar: r2', currentTranscript: 'User: u2\nNar: r2', existingNpcs: [], candidates: [] });
    assert.match(prompt, /EARLIER exchanges[^]*durable facts and relationship changes[^]*User: u1\nNar: r1\n\nCURRENT exchange[^]*User: u2\nNar: r2/);
    const single = buildScannerPrompt({ transcript: 'User: u2\nNar: r2', currentTranscript: 'User: u2\nNar: r2', existingNpcs: [], candidates: [] });
    assert.doesNotMatch(single, /EARLIER exchanges \(replies/);
});

import { currentExchangeRelationshipRelevant } from '../src/relationship-pass.js';

test('lean: a window scan hands the relationship pass the story alone: an Off-Screen name is no target', () => {
    const chat = [{ is_user: false, name: 'Nar', mes: 'R0' }];
    const ws = '<World_State>Present: Bram\nOff-Screen: Mira Vale (at the guild)</World_State>';
    for (let k = 1; k <= 3; k += 1) { chat.push({ is_user: true, name: 'User', mes: `U${k}` }); chat.push({ is_user: false, name: 'Nar', mes: `R${k} Bram nods. ${ws}` }); }
    useTranscriptSource({ context: () => ({ chat, name1: 'User', name2: 'Nar' }), scanDepth: () => 6 });
    const w = skippedExchangesWindow(6, { afterId: 0, replies: 3 });
    const mira = { id: 'm', name: 'Mira Vale', aliases: [] };
    assert.match(w.transcript, /Off-Screen/, 'the scanner prompt still carries the World State');
    assert.doesNotMatch(w.prose, /Off-Screen|World_State|Mira/);
    assert.match(w.prose, /Bram nods/);
    assert.equal(currentExchangeRelationshipRelevant(mira, w.prose, null, {}), false);
});

test('lean: a new chat in Lean mode reads replies 1 to 5 once at the first scan; a null marker on a chat already scanned reads the latest only', () => {
    const fresh = walk({ replies: 5, everyReply: false, initMarker: null, fresh: true });
    for (let r = 1; r <= 5; r += 1) assert.equal(fresh.reads[r], 1, `reply ${r} read ${fresh.reads[r] || 0} times`);
    const lean40 = walk({ replies: 40, everyReply: false, initMarker: null, fresh: true });
    for (let r = 1; r <= lean40.marker / 2; r += 1) assert.equal(lean40.reads[r], 1, `reply ${r} read ${lean40.reads[r] || 0} times`);
    const chat = [{ is_user: false, name: 'Nar', mes: 'R0' }];
    for (let k = 1; k <= 6; k += 1) { chat.push({ is_user: true, name: 'User', mes: `U${k}` }); chat.push({ is_user: false, name: 'Nar', mes: `R${k}` }); }
    useTranscriptSource({ context: () => ({ chat, name1: 'User', name2: 'Nar' }), scanDepth: () => 6 });
    assert.equal(skippedExchangesWindow(12, { afterId: null, replies: 6, limit: 6 }), null, 'null marker, not a new chat: the latest reply only');
    const startOfChat = skippedExchangesWindow(12, { afterId: null, replies: 6, limit: 6, fresh: true });
    assert.ok(startOfChat.transcript.includes('R0') && startOfChat.transcript.includes('R6'), 'a new chat reads from the start');
});

test('lean: the prompt takes relationship evidence from CURRENT or any EARLIER exchange shown, and CURRENT claims authority only for presence, mood and location', () => {
    const cur = 'User: U3\nNar: R3';
    const windowPrompt = buildScannerPrompt({ existingNpcs: [], candidates: [], transcript: `User: U1\nNar: R1\n${cur}`, currentTranscript: cur });
    const earlierPrompt = buildScannerPrompt({ existingNpcs: [], candidates: [], transcript: `User: U1\nNar: R1\n${cur}`, currentTranscript: cur, earlierOnly: true });
    for (const prompt of [windowPrompt, earlierPrompt]) {
        assert.match(prompt, /grounded evidence from the CURRENT exchange or, when EARLIER exchanges are shown, from the EARLIER exchange it happened in/);
        assert.doesNotMatch(prompt, /EVERY non-zero axis needs grounded CURRENT-exchange evidence/);
        assert.doesNotMatch(prompt, /authoritative for [^)]*relationship deltas/);
    }
    assert.match(windowPrompt, /CURRENT exchange \(authoritative for presence, mood and location\):\nUser: U3/);
    assert.doesNotMatch(earlierPrompt, /CURRENT exchange \(authoritative/);
    assert.match(earlierPrompt, /EARLIER exchanges[^]*relationship changes[^]*never current presence, mood or location/);
});

import { buildRelationshipPassPrompt } from '../core.js';

test('lean: the relationship evaluator prompt scores a change in the exchange it happened in for a window, and is unchanged for one exchange', () => {
    const base = { transcript: 'User: u1\nNar: r1', targets: [{ id: 'n1', name: 'Mira' }], userName: 'User' };
    const single = buildRelationshipPassPrompt(base);
    assert.match(single, /because of the supplied CURRENT exchange\./);
    assert.match(single, /short CURRENT-exchange evidence/);
    assert.match(single, /grounded relationshipEvidence from CURRENT exchange/);
    assert.match(single, /\nCurrent exchange:\nUser: u1/);
    assert.equal(buildRelationshipPassPrompt({ ...base, window: false }), single, 'no window: byte-identical');
    const multi = buildRelationshipPassPrompt({ ...base, window: true });
    assert.match(multi, /because of the supplied exchanges\. They are in order, the latest last; each was read once/);
    assert.match(multi, /short evidence from the exchange it happened in/);
    assert.match(multi, /grounded relationshipEvidence from the exchange it happened in/);
    assert.match(multi, /\nExchanges:\nUser: u1/);
    assert.doesNotMatch(multi, /CURRENT/);
});

test('lean: the relationship evaluator system prompt says exchanges for a window and is unchanged otherwise', () => {
    const source = fs.readFileSync(new URL('../src/relationship-pass.js', import.meta.url), 'utf8');
    assert.match(source, /Use only the supplied targets and current exchange\. Return only the requested JSON object\."\.replace\(options\.window === true \? \/current exchange\/ : \/\(\?!\)\/, 'exchanges'\)/);
});

import { mergeImportedDossierState } from '../bundle.js';
import { runtimeSource } from './helpers/runtime-source.js';

test('lean: a new short chat reads replies 1 to 5 once at its first scan; a long chat with no sidecar reads the latest reply only', () => {
    runScenario('new-chat-short', async h => {
        h.settings.scanEvery = 5;
        for (let i = 1; i <= 5; i += 1) await h.turn('We walk on.', `The road goes on, mile ${i} of marker-${i}.`);
        const calls = h.scannerCalls();
        h.equal(calls.length, 1, 'the safety scan');
        const prompt = String(calls[0].prompt || '');
        h.check([1, 2, 3, 4, 5].every(i => prompt.split(`marker-${i}.`).length === 2), 'every reply 1 to 5 is read exactly once');
    });
    runScenario('long-chat-no-sidecar', async h => {
        h.settings.scanEvery = 20;
        for (let i = 1; i <= 20; i += 1) await h.turn('We walk on.', `The road goes on, mile ${i} of marker-${i}.`);
        const calls = h.scannerCalls();
        h.equal(calls.length, 1, 'the safety scan');
        const prompt = String(calls[0].prompt || '');
        h.check(prompt.includes('marker-20.') && !prompt.includes('marker-1.') && !prompt.includes('marker-19.'), 'more replies than one window: the latest reply only');
    });
});

test('lean: an import never leaves a chat looking new, and Clear leaves the marker on the latest reply', () => {
    const empty = { npcs: [], candidates: [], dismissed: [], socialGraph: { edges: [], unresolved: [] }, scanCount: 0, lastScannedMessageId: null };
    const scanned = mergeImportedDossierState(empty, { npcs: [], lastScannedMessageId: 79, scanCount: 12 });
    assert.ok(scanned.scanCount >= 1, 'a bundle that had scans');
    assert.equal(scanned.lastScannedMessageId, null);
    const withDossiers = mergeImportedDossierState(empty, { npcs: [{ id: 'a', name: 'Mira Vale' }] });
    assert.ok(withDossiers.scanCount >= 1, 'a bundle with dossiers');
    assert.equal(mergeImportedDossierState(empty, { npcs: [] }).scanCount, 0, 'an empty bundle changes nothing');
    const index = runtimeSource();
    assert.match(index, /cleared\.lastScannedMessageId = latestMessageId\(true\) >= 0 \? latestMessageId\(true\) : null;/);
    assert.match(index, /fresh: chatNeverScanned\(getChatState\(scanChatKey\), messageId\),/);
});

test('lean: Clear every dossier, then a swipe, then the next scan reads the latest reply only', () => {
    runScenario('clear-then-swipe', async h => {
        h.settings.scanEvery = 20;
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        for (let i = 1; i <= 3; i += 1) await h.turn('We walk on.', `The road goes on, mile ${i} of older-${i}.`);
        const before = h.runtime.getState().scanCount;
        h.check(before >= 1, 'the chat was scanned once');
        const previous = globalThis.window.confirm;
        globalThis.window.confirm = () => true;
        try {
            const clear = uiHandlers.get('click.npcStateDelta|#npc_state_delta_clear_chat');
            h.check(typeof clear === 'function', 'Clear must be connected to the production handler');
            await clear();
        } finally { globalThis.window.confirm = previous; }
        const cleared = h.runtime.getState();
        h.equal(cleared.npcs.length, 0, 'every dossier is gone');
        h.equal(cleared.scanCount, Math.max(1, before), 'scanCount stays at max(1, previous)');
        // A swipe of the latest reply, then the next reply: the marker is gone after a swipe, the chat must still not look new.
        const chat = h.mockState.context.chat;
        chat[chat.length - 1] = { ...chat[chat.length - 1], mes: 'The road goes on, a swiped-mile.', swipe_id: 1, swipes: [chat[chat.length - 1].mes, 'The road goes on, a swiped-mile.'] };
        await h.emitAsync('message_swiped', chat.length - 1);
        h.runtime.getState().lastScannedMessageId = null;
        h.settings.scanEvery = 1;
        const calls = h.scannerCalls().length;
        await h.turn('Who is that?', 'Wiz walks in and nods at the counter.');
        const scans = h.scannerCalls().slice(calls);
        h.equal(scans.length, 1, 'one scan');
        const prompt = String(scans[0].prompt || '');
        h.check(prompt.includes('Wiz walks in') && !prompt.includes('older-1.') && !prompt.includes('older-2.') && !prompt.includes('Yunyun steps out'), 'the older replies are not read back in');
    });
});

// ---- 1.10.0 (L2a): a manual scan, a Refresh or a narration capture no longer moves the marker past replies that still wait ----

test('lean: a manual scan reads the latest replies without losing the older waiting ones; the next scan reads those and skips what the manual scan read', () => {
    runScenario('manual-read-ahead', async h => {
        h.settings.scanEvery = 30;
        h.settings.scanDepth = 4;
        for (let i = 1; i <= 6; i += 1) await h.turn('We walk on.', `The road goes on, mile ${i} of marker-${i}.`);
        h.equal(h.scannerCalls().length, 0, 'quiet replies: no call');
        h.check(await h.runtime.scan(), 'the manual scan ran');
        h.equal(h.scannerCalls().length, 1, 'one manual call');
        const manual = String(h.scannerCalls()[0].prompt || '');
        h.check(manual.includes('marker-6') && manual.includes('marker-5') && !manual.includes('marker-1.'), 'the manual scan reads the last Scan context messages');
        const state = h.runtime.getState();
        h.check(Array.isArray(state.readAhead) && state.readAhead.length === 2, `the two replies it read are remembered (${JSON.stringify(state.readAhead)})`);
        h.check(state.lastScannedMessageId < state.readAhead[0], 'the marker stayed behind the unread replies');
        h.equal(state.assistantSinceScan, 4, 'the four unread replies count toward the safety scan');
        await h.turn('Who is that?', 'Yunyun steps out of the mist and waves.');
        h.equal(h.scannerCalls().length, 2, 'the name scans');
        const next = String(h.scannerCalls()[1].prompt || '');
        h.check(['marker-1.', 'marker-2.', 'marker-3.', 'marker-4.', 'Yunyun steps out'].every(text => next.includes(text)), 'the waiting replies and the new one are read');
        h.check(!next.includes('marker-5.') && !next.includes('marker-6.'), 'the replies the manual scan read are not read again');
        const after = h.runtime.getState();
        h.equal(after.readAhead, [], 'nothing is left read ahead');
        h.equal(after.lastScannedMessageId, h.mockState.context.chat.length - 1, 'the marker is at the latest reply');
        h.equal(after.assistantSinceScan, 0, 'the count restarts');
    });
});
