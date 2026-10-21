import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One-pass narration capture through the real event handlers of the synthetic SillyTavern host.
// Each scenario runs in its own process on a fresh host built from the runtime-smoke setup
// (everything before its scenario body), so no scenario depends on the long smoke run.

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runScenario(name, scenario, { makeFirst = false } = {}) {
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
if (${makeFirst}) {
    eventSource.makeFirst = (event, fn) => {
        const list = mockState.listeners.get(event) || [];
        list.unshift(fn);
        mockState.listeners.set(event, list);
    };
    // A listener another extension registered before NPC State Delta loaded.
    eventSource.on('message_received', id => { mockState.earlierListenerSaw.push(String(mockState.context.chat[id]?.mes ?? '')); });
}
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    const helpers = (${captureHelpers.toString()})(mockState, eventSource, sleep, manualAddNpc);
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

// Runs inside the synthetic host. Returns the shared drivers for one scenario.
function captureHelpers(mockState, eventSource, sleep, manualAddNpc) {
    const fail = message => { throw new Error(message); };
    const check = (condition, message) => { if (!condition) fail(message); };
    const equal = (actual, expected, message) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };
    const runtime = globalThis.NPCStateDelta;
    const settings = mockState.extensionSettings.npc_state_delta;
    const HEADER = 'NPC STATE DELTA ONE-PASS CAPTURE.';
    const REPLY = 'Yunyun, a young woman with long dark brown hair and crimson eyes, waves awkwardly. She remains proud but earnest and stays formal when nervous. Yunyun tells Kazuma she trusts him more and is fond of him.';
    const YUNYUN = {
        name: 'Yunyun', present: true, role: 'adventurer', species: 'Crimson Demon',
        appearance: 'Young woman with long dark brown hair and crimson eyes.',
        personality: 'proud but earnest', speech: 'formal when nervous',
        relationshipSummary: 'She is cautiously warming to Kazuma and beginning to trust him.',
        relationshipImpact: 'meaningful',
        relationshipDelta: { trust: 3, affection: 2, desire: 0, tension: 0 },
        relationshipEvidence: { trust: 'Yunyun tells Kazuma she trusts him more.', affection: 'Yunyun tells Kazuma she is fond of him.', desire: '', tension: '' },
        relationshipChangeReason: 'Yunyun tells Kazuma she trusts him more and is fond of him.',
    };
    const block = (payload = { npcs: [YUNYUN] }) => `\n\n<!--npc_state_delta\n${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n-->`;
    const callsOf = pattern => mockState.rawCalls.map(call => call?.[0] || {}).filter(args => pattern.test(String(args.systemPrompt || '')));
    const scannerCalls = () => callsOf(/isolated dossier scanner\./i);
    const relationshipCalls = () => callsOf(/isolated relationship evaluator/i);
    const dossierPrompts = () => mockState.prompts.filter(args => args[0] === 'story_suite_tail_4_npc_state_delta').map(args => String(args[1] ?? ''));
    // (1.2.13) The capture reminder has its own slot at the end of the prompt (depth 0).
    const captureCalls = () => mockState.prompts.filter(args => args[0] === 'story_suite_tail_5_npc_state_delta_capture');
    // (1.2.16) The capture's rules ride early in the system prompt; its context and reminder at the end.
    const rulesCalls = () => mockState.prompts.filter(args => args[0] === 'story_suite_static_npc_state_delta');
    const lastPrompt = () => [String(rulesCalls().at(-1)?.[1] ?? ''), dossierPrompts().at(-1) ?? '', String(captureCalls().at(-1)?.[1] ?? '')].filter(Boolean).join('\n\n');
    const status = () => runtime.uiStatus().narrationCapture;
    const npc = name => runtime.getState().npcs.find(item => item.name === name) || null;
    // Fire every listener in registration order (as the host does) and wait for the async ones.
    const emitAsync = async (event, ...args) => {
        await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args)));
        await sleep(40);
    };
    const generate = (type = 'normal', dryRun = false) => emitAsync('generation_after_commands', type, {}, dryRun);
    const sendUser = async text => {
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: text });
        await emitAsync('message_sent', mockState.context.chat.length - 1);
    };
    const receiveAssistant = async (text, { swipes = [text], swipeId = swipes.length - 1 } = {}) => {
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: swipeId, swipes: [...swipes] });
        const id = mockState.context.chat.length - 1;
        await emitAsync('message_received', id);
        await sleep(80);
        return id;
    };
    const turn = async (userText, replyText, type = 'normal') => {
        await sendUser(userText);
        await generate(type);
        return receiveAssistant(replyText);
    };
    // The fallback scanner names Yunyun too, so a fallback is visible as a real request.
    mockState.quietResponder = async (args = {}) => {
        if (/isolated dossier scanner\./i.test(String(args.systemPrompt || ''))) return JSON.stringify({ npcs: [{ ...YUNYUN, role: 'scanned adventurer' }] });
        return '{"npcs":[]}';
    };
    return { manualAddNpc, fail, check, equal, runtime, settings, HEADER, REPLY, YUNYUN, block, scannerCalls, relationshipCalls, dossierPrompts, captureCalls, rulesCalls, lastPrompt, status, npc, emitAsync, generate, sendUser, receiveAssistant, turn, mockState, sleep };
}

test('v1.1.8 capture arms only fresh replies and continues (not quiet/swipe/regenerate/impersonate/dry-run)', () => {
    runScenario('injection-arming', async h => {
        h.settings.narrationCapture = true;
        await h.sendUser('Who is at the gate?');
        h.equal(h.status().enabled, true, 'capture mode is enabled with Auto scan on');
        h.equal(h.status().armed, false, 'nothing is armed before a generation');
        h.check(!h.lastPrompt().includes(h.HEADER), 'no capture instruction before a generation');

        await h.generate('normal');
        h.check(h.lastPrompt().includes(h.HEADER), 'a normal generation carries the capture instruction');
        h.check(h.lastPrompt().includes('<!--npc_state_delta'), 'the instruction names the hidden block');
        h.check(h.lastPrompt().trimEnd().endsWith('"relationshipReview": ["Name"].'), 'the reminder is the last thing in the injection');
        const sent = h.captureCalls().at(-1);
        h.check(String(sent?.[1] ?? '').includes('"relationshipReview": ["Name"].') && sent?.[2] === 1 && sent?.[3] === 0, 'the context and reminder go in their own slot at depth 0, the end of the prompt');
        const rules = h.rulesCalls().at(-1);
        h.check(String(rules?.[1] ?? '').startsWith(h.HEADER) && rules?.[2] === 0, 'the rules go in the system prompt (IN_PROMPT)');
        h.check(!String(rules?.[1] ?? '').includes('Identity index'), 'the rules carry no dossier context');
        h.check(!h.dossierPrompts().at(-1)?.includes(h.HEADER), 'the dossier slot carries no reminder');
        h.check(!h.lastPrompt().includes('Who is at the gate?'), 'the capture instruction carries no transcript');
        h.check(h.runtime.injectionPreview().captureChars > 1000, 'the preview reports the capture size');
        h.equal(h.status().armed, true, 'armed after a normal generation');
        h.equal(h.status().requested, 0, 'requested is counted at receipt, not at arming');

        await h.generate('quiet');
        h.check(!h.lastPrompt().includes(h.HEADER), 'a quiet generation removes the capture instruction');
        h.equal(h.status().armed, false, 'quiet disarms');
        h.equal(h.runtime.injectionPreview().captureChars, 0);

        for (const type of ['swipe', 'regenerate', 'impersonate']) {
            await h.generate('normal');
            h.equal(h.status().armed, true, `armed before ${type}`);
            await h.generate(type);
            h.check(!h.lastPrompt().includes(h.HEADER), `${type} never carries the capture instruction`);
            h.equal(h.status().armed, false, `${type} disarms`);
            h.equal(h.runtime.injectionPreview().captureChars, 0, `${type} sends no capture`);
        }
        for (const type of ['continue', '', undefined]) {
            await h.generate('quiet');
            await h.generate(type);
            h.check(h.lastPrompt().includes(h.HEADER), `${JSON.stringify(type)} carries the capture instruction`);
            h.equal(h.status().armed, true, `${JSON.stringify(type)} arms`);
        }

        await h.generate('normal');
        const armedPrompt = h.lastPrompt();
        const promptCount = h.dossierPrompts().length;
        await h.generate('quiet', true);
        await h.generate('impersonate', true);
        await h.generate('swipe', true);
        h.equal(h.dossierPrompts().length, promptCount, 'dry runs never rebuild the injection');
        h.equal(h.lastPrompt(), armedPrompt, 'dry runs leave the armed instruction in place');
        h.equal(h.status().armed, true, 'dry runs do not disarm');

        // The instruction is sent even when the dossier injection itself is off.
        h.settings.inject = false;
        await h.generate('normal');
        h.check(h.lastPrompt().startsWith(h.HEADER), 'with Inject off the capture instruction is sent alone');
        h.equal(h.runtime.injectionPreview().text, '', 'no dossier text is sent with Inject off');
        await h.generate('quiet');
        h.equal(h.lastPrompt(), '', 'quiet with Inject off clears the prompt entirely');
        h.equal(h.scannerCalls().length, 0, 'arming never makes a scanner request');
        h.equal(h.status().requested, 0, 'no reply was received');

        // (1.2.16) A preset with its Main Prompt off drops the in-prompt rules: they go back in at
        // prompt-ready, after the leading system messages, once; never into a dry run or a quiet call.
        h.settings.inject = true;
        await h.generate('normal');
        const rulesText = String(h.rulesCalls().at(-1)?.[1] ?? '');
        const dropped = { chat: [{ role: 'system', content: 'Card.' }, { role: 'system', content: 'Scenario.' }, { role: 'user', content: 'Hi' }, { role: 'system', content: 'tail' }], dryRun: false };
        await h.emitAsync('chat_completion_prompt_ready', dropped);
        h.equal(dropped.chat.map(message => message.role), ['system', 'system', 'system', 'user', 'system'], 'inserted after the leading system messages');
        h.equal(dropped.chat[2].content, rulesText.trim(), 'the rules, as sent');
        await h.emitAsync('chat_completion_prompt_ready', dropped);
        h.equal(dropped.chat.length, 5, 'only once: a prompt that already carries them is left alone');
        const dry = { chat: [{ role: 'user', content: 'Hi' }], dryRun: true };
        await h.emitAsync('chat_completion_prompt_ready', dry);
        h.equal(dry.chat.length, 1, 'never into a dry run');
        const ownScan = { chat: [{ role: 'system', content: "You are NPC State Delta's isolated dossier scanner. Use only the supplied scanner payload." }, { role: 'user', content: 'payload' }], dryRun: false };
        await h.emitAsync('chat_completion_prompt_ready', ownScan);
        h.equal(ownScan.chat.length, 2, "never into Delta's own scanner request");
        await h.generate('quiet');
        const quiet = { chat: [{ role: 'user', content: 'Hi' }], dryRun: false };
        await h.emitAsync('chat_completion_prompt_ready', quiet);
        h.equal(quiet.chat.length, 1, 'never into a quiet call');
        // Once the chat has replies, only a prompt that carries them is the story's own.
        await h.generate('normal');
        h.mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'Earlier reply.' });
        const background = { chat: [{ role: 'system', content: 'Summarize.' }, { role: 'user', content: 'text' }], dryRun: false };
        await h.emitAsync('chat_completion_prompt_ready', background);
        h.equal(background.chat.length, 2, "never into another extension's call without the chat's replies");
        const story = { chat: [{ role: 'system', content: 'Card.' }, { role: 'assistant', content: 'Earlier reply.' }, { role: 'user', content: 'Hi' }], dryRun: false };
        await h.emitAsync('chat_completion_prompt_ready', story);
        h.equal(story.chat.length, 4, 'the story prompt gets them');
        h.mockState.context.chat.pop();
        await h.emitAsync('generation_stopped');
        const stopped = { chat: [{ role: 'user', content: 'Hi' }], dryRun: false };
        await h.emitAsync('chat_completion_prompt_ready', stopped);
        h.equal(stopped.chat.length, 1, 'not after the generation is stopped');

        // (1.2.16) The dossier goes last (depth 0) by default; the old default 1 moves there once,
        // any other depth the player set is kept, and so is a 1 set after the move.
        const dossierDepth = () => h.mockState.prompts.filter(args => args[0] === 'story_suite_tail_4_npc_state_delta').at(-1)?.[3];
        h.settings.inject = true;
        h.settings.injectDepth = 1;
        h.settings.injectDepthTailUpgraded = false;
        await h.generate('normal');
        h.equal(dossierDepth(), 0, 'an install on the old default 1 is moved to depth 0');
        h.settings.injectDepth = 3;
        await h.generate('normal');
        h.equal(dossierDepth(), 3, 'a depth the player chose is kept');
        h.settings.injectDepth = 1;
        await h.generate('normal');
        h.equal(dossierDepth(), 1, 'a 1 chosen after the move is kept');
        h.settings.injectDepth = 0;
        await h.generate('normal');
        h.equal(dossierDepth(), 0, '0 is honoured');

        // (1.2.17) The opt-in compact rules: shorter, still in the system prompt, the same each reply.
        const fullRules = String(h.rulesCalls().at(-1)?.[1] ?? '');
        h.equal(h.settings.narrationCaptureCompact, false, 'the compact instruction is off by default');
        h.settings.narrationCaptureCompact = true;
        await h.generate('normal');
        const compactRules = String(h.rulesCalls().at(-1)?.[1] ?? '');
        h.check(compactRules.startsWith(h.HEADER) && compactRules.length < fullRules.length * 0.85 && h.rulesCalls().at(-1)?.[2] === 0, 'the compact rules are shorter and still go in the system prompt');
        await h.generate('normal');
        h.equal(String(h.rulesCalls().at(-1)?.[1] ?? ''), compactRules, 'the compact rules are byte-identical reply to reply');
        h.settings.narrationCaptureCompact = false;
        await h.generate('normal');
        h.equal(String(h.rulesCalls().at(-1)?.[1] ?? ''), fullRules, 'off sends the full rules again');
    });
});

test('v1.1.8 Capture mode off, or Auto scan off, never arms', () => {
    runScenario('arming-gates', async h => {
        await h.sendUser('Who is at the gate?');
        await h.generate('normal');
        h.equal(h.status().armed, false, 'off by default');
        h.settings.narrationCapture = true;
        h.settings.autoScan = false;
        await h.generate('normal');
        h.equal([h.status().enabled, h.status().armed], [false, false], 'Auto scan off disables capture');
        h.check(h.dossierPrompts().every(text => !text.includes(h.HEADER)), 'no capture instruction was ever injected');
    });
});

test('v1.1.8 a valid capture block is stripped and merged without a scanner request', () => {
    runScenario('valid-block', async h => {
        h.settings.narrationCapture = true;
        const id = await h.turn('Who is at the gate?', `${h.REPLY}${h.block()}`);
        const message = h.mockState.context.chat[id];
        h.equal(message.mes, h.REPLY, 'the stored reply has no block');
        h.equal(message.swipes[0], h.REPLY, 'the active swipe has no block');
        h.check(h.mockState.updatedBlocks.some(entry => entry.id === id && entry.mes === h.REPLY), 'the host re-renders the stripped reply');
        h.equal(h.scannerCalls().length, 0, 'the quick scan made no scanner request');
        h.equal(h.relationshipCalls().length, 0, 'a complete relationship decision needs no focused pass');
        const yunyun = h.npc('Yunyun');
        h.check(yunyun, 'the block admitted Yunyun');
        h.equal(yunyun.present, true, 'present from the block');
        h.equal(yunyun.role, 'adventurer', 'role from the block, not the fallback scanner');
        h.equal(yunyun.species, 'Crimson Demon', 'species from the block');
        h.equal(yunyun.relationship.trust > 0, true, 'grounded relationship delta applied');
        const metrics = h.runtime.scanMetrics();
        h.equal(metrics.label, 'narration-capture', 'the scan is labelled as a capture');
        h.equal(metrics.promptChars, 0, 'no scanner prompt was built');
        h.check(metrics.responseChars > 0, 'the block body is reported as the response');
        const counters = h.status();
        h.equal([counters.requested, counters.used, counters.missing, counters.invalid, counters.unterminated, counters.pending], [1, 1, 0, 0, 0, 0], 'capture counters');
        h.equal(counters.armed, false, 'receipt disarms');
        h.check(!h.lastPrompt().includes(h.HEADER), 'the instruction is withdrawn after the reply arrives');

        // A second capture updates the existing dossier, still without a scanner request.
        const second = 'Yunyun now waits at the guild hall, nervously polishing her wand.';
        const update = { npcs: [{ name: 'Yunyun', present: true, location: 'guild hall', relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] };
        const id2 = await h.turn('I go to the guild hall.', `${second}${h.block(update)}`);
        h.equal(h.mockState.context.chat[id2].mes, second);
        h.equal(h.scannerCalls().length, 0, 'the second capture made no scanner request either');
        h.equal(h.relationshipCalls().length, 0, 'no focused relationship pass for a complete no-change decision');
        h.equal(h.runtime.getState().npcs.filter(item => item.name === 'Yunyun').length, 1, 'the existing dossier is updated, not duplicated');
        h.check(/guild hall/i.test(String(h.npc('Yunyun').location || '')), `location from the second block, got ${h.npc('Yunyun').location}`);
        h.equal(h.status().used, 2);
    });
});

test('v1.1.8 receipt withdraws the instruction at once, even when the reply is only a block', () => {
    runScenario('receipt-withdraws', async h => {
        h.settings.narrationCapture = true;
        await h.sendUser('Who is at the gate?');
        await h.generate('normal');
        h.check(h.lastPrompt().includes(h.HEADER), 'armed before the reply');
        h.mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: `${h.REPLY}${h.block()}`, swipe_id: 0, swipes: [`${h.REPLY}${h.block()}`] });
        const id = h.mockState.context.chat.length - 1;
        const pending = Promise.all((h.mockState.listeners.get('message_received') || []).map(fn => fn(id)));
        // Before any asynchronous receipt work runs, the block is gone and so is the instruction.
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'stripped synchronously on receipt');
        h.check(!h.lastPrompt().includes(h.HEADER), 'the instruction is withdrawn synchronously on receipt');
        h.equal(h.status().armed, false);
        await pending;
        await h.sleep(80);
        h.equal(h.status().used, 1);

        // A reply that is nothing but the block leaves an empty message: the receipt handler returns
        // early, yet the instruction must not linger for a later quiet generation.
        await h.sendUser('Anything else?');
        await h.generate('normal');
        h.check(h.lastPrompt().includes(h.HEADER), 're-armed for the next reply');
        const before = h.scannerCalls().length;
        const emptyId = await h.receiveAssistant(h.block().trim());
        h.equal(h.mockState.context.chat[emptyId].mes, '', 'a block-only reply is stripped to nothing');
        h.check(!h.lastPrompt().includes(h.HEADER), 'no instruction remains after a block-only reply');
        await h.generate('quiet');
        h.check(!h.lastPrompt().includes(h.HEADER), 'a later quiet generation carries no instruction');
        h.equal(h.scannerCalls().length, before, 'an empty reply is not scanned');
        h.equal(h.status().used, 1, 'the block of an empty reply is never merged');
        h.equal(h.status().pending, 0, 'the block of an empty reply is not kept');
    });
});

test('v1.1.8 a block in a reply that was not generated under the instruction is stripped and never merged', () => {
    runScenario('unarmed-block', async h => {
        h.settings.narrationCapture = true;
        await h.sendUser('Who is at the gate?');
        // No GENERATION_AFTER_COMMANDS: e.g. /sendas, a card greeting or another extension's message.
        const id = await h.receiveAssistant(`${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'the block is removed from the stored reply');
        h.equal(h.mockState.context.chat[id].swipes[0], h.REPLY);
        h.equal(h.scannerCalls().length, 1, 'the ordinary scanner request runs');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer', 'the unarmed block is never merged');
        h.equal(h.runtime.scanMetrics().label, 'automatic');
        h.equal([h.status().requested, h.status().used, h.status().invalid, h.status().pending], [0, 0, 0, 0]);
    });
});

test('v1.1.8 an invalid capture block is stripped and the normal scanner request runs', () => {
    runScenario('invalid-block', async h => {
        h.settings.narrationCapture = true;
        const id = await h.turn('Who is at the gate?', `${h.REPLY}${h.block('{"npcs": [ {"name": "Yunyun", }')}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'the broken block is still removed');
        h.equal(h.mockState.context.chat[id].swipes[0], h.REPLY);
        h.equal(h.scannerCalls().length, 1, 'the ordinary scanner request runs');
        h.check(!String(h.scannerCalls()[0].prompt).includes('npc_state_delta'), 'the scanner never sees the block');
        h.check(String(h.scannerCalls()[0].prompt).includes('Yunyun tells Kazuma'), 'the scanner reads the stripped reply');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer', 'the dossier comes from the scanner response');
        h.equal(h.runtime.scanMetrics().label, 'automatic');
        h.equal([h.status().used, h.status().invalid, h.status().pending], [0, 1, 0], 'counted as invalid, nothing stored');
    });
});

test('v1.1.8 an unterminated capture block is stripped and the normal scanner request runs', () => {
    runScenario('unterminated-block', async h => {
        h.settings.narrationCapture = true;
        const id = await h.turn('Who is at the gate?', `${h.REPLY}\n\n<!--npc_state_delta\n{"npcs":[{"name":"Yunyun","present":true,"role":"adv`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'the cut-off block is removed');
        h.equal(h.mockState.context.chat[id].swipes[0], h.REPLY);
        h.equal(h.scannerCalls().length, 1, 'the ordinary scanner request runs');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer');
        h.equal([h.status().used, h.status().unterminated, h.status().invalid, h.status().pending], [0, 1, 0, 0]);
    });
});

test('v1.1.8 with capture off a block is still stripped, the scan runs and nothing is injected', () => {
    runScenario('capture-off', async h => {
        h.equal(h.settings.narrationCapture, false, 'the mode defaults to off');
        h.equal(h.status().enabled, false);
        const id = await h.turn('Who is at the gate?', `${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'a stray block never reaches the stored reply');
        h.equal(h.mockState.context.chat[id].swipes[0], h.REPLY);
        h.equal(h.scannerCalls().length, 1, 'the ordinary scanner request runs');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer', 'the block is never merged with the mode off');
        h.check(h.dossierPrompts().every(text => !text.includes(h.HEADER)), 'no capture instruction is ever injected');
        h.equal(h.runtime.injectionPreview().captureChars, 0);
        h.equal([h.status().requested, h.status().used, h.status().missing, h.status().invalid, h.status().pending], [0, 0, 0, 0, 0]);
    });
});

test('v1.1.8 Full scan every turn disables capture instructions and capture use', () => {
    runScenario('full-scan', async h => {
        h.settings.narrationCapture = true;
        h.settings.fullScanEveryTurn = true;
        h.equal(h.status().enabled, false, 'capture is not used with Full scan every turn');
        const id = await h.turn('Who is at the gate?', `${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'the block is still stripped');
        h.check(h.dossierPrompts().every(text => !text.includes(h.HEADER)), 'no capture instruction is injected');
        h.equal(h.scannerCalls().length, 1, 'the full scan request runs');
        h.equal(h.runtime.scanMetrics().label, 'automatic-full');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer');
        h.equal([h.status().requested, h.status().used, h.status().pending], [0, 0, 0]);
    });
});

test('v1.1.8 a capture merges on the first reply even when Scan every is not due', () => {
    runScenario('scan-every', async h => {
        h.settings.narrationCapture = true;
        h.settings.scanEvery = 3;
        await h.turn('Who is at the gate?', `${h.REPLY}${h.block()}`);
        h.equal(h.npc('Yunyun')?.role, 'adventurer', 'the capture merged on reply 1 of 3');
        h.equal(h.scannerCalls().length, 0, 'no scanner request');
        h.equal(h.status().used, 1);
        h.equal(h.runtime.getState().assistantSinceScan, 0, 'the capture counts as the scan for cadence');
        // Without a block the cadence applies again: reply 1 of 3 does not scan.
        await h.turn('We walk on.', 'They walk down the road in silence.');
        h.equal(h.scannerCalls().length, 0, 'an armed reply without a block waits for the cadence');
        h.equal(h.status().missing, 1, 'the missing block is counted');
        h.equal(h.runtime.getState().assistantSinceScan, 1);
    });
});

test('v1.1.8 a stored capture is not reused after the reply text changes', () => {
    runScenario('edited-reply', async h => {
        h.settings.narrationCapture = true;
        await h.turn('Who is at the gate?', 'A quiet wind crosses the gate.');
        const before = h.scannerCalls().length;
        h.equal(before, 1, 'the armed reply without a block fell back to one scanner request');
        // Hold the next scanner request open so the capture reply's scan is queued, not run.
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const responder = h.mockState.quietResponder;
        h.mockState.quietResponder = async (...args) => { await held; return responder(...args); };
        const manual = h.runtime.scan();
        await h.sleep(20);
        h.equal(h.scannerCalls().length, before + 1, 'a manual scan is in flight');
        await h.sendUser('Who is that?');
        await h.generate('normal');
        const id = await h.receiveAssistant(`${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY);
        h.equal(h.status().pending, 1, 'the capture is stored while the scan is busy');
        // The player edits the reply before the queued scan runs.
        const edited = 'Yunyun, a young woman with crimson eyes, waits silently at the gate.';
        h.mockState.context.chat[id].mes = edited;
        h.mockState.context.chat[id].swipes[0] = edited;
        await h.emitAsync('message_edited', id);
        h.mockState.quietResponder = responder;
        release();
        await manual;
        await h.sleep(700);
        const after = h.scannerCalls().slice(before + 1);
        h.check(after.some(args => String(args.prompt).includes(edited)), `the edited reply was rescanned with a real request (${after.length} later requests)`);
        h.equal(h.status().used, 0, 'the stale capture was never merged');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer', 'the dossier comes from the rescan, not the stale block');
    });
});

test('v1.1.8 with a host makeFirst the block is stripped before earlier-registered listeners run', () => {
    runScenario('make-first', async h => {
        h.settings.narrationCapture = true;
        await h.turn('Who is at the gate?', `${h.REPLY}${h.block()}`);
        h.equal(h.mockState.earlierListenerSaw, [h.REPLY], 'a listener registered before the extension already sees the stripped reply');
        h.equal(h.scannerCalls().length, 0);
        h.equal(h.status().used, 1);
    }, { makeFirst: true });
});

test('v1.1.9 a capture survives another extension rewriting the reply on arrival', () => {
    runScenario('rewritten-reply', async h => {
        h.settings.narrationCapture = true;
        // Another extension listening after the strip wraps its own blocks into a comment, so the
        // reply text the scan reads differs from the text Delta stripped (a reported live case).
        const wrapped = '\n\n<!-- STORY_BLOCKS_V1\n<Blocks>\n<CYOA>\n1. Go to the gate.\n</CYOA>\n</Blocks>\n-->';
        const list = h.mockState.listeners.get('message_received');
        list.splice(1, 0, id => { h.mockState.context.chat[id].mes += wrapped; });
        const id = await h.turn('Who is at the gate?', `${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, `${h.REPLY}${wrapped}`, 'the other extension rewrote the stripped reply');
        h.equal(h.scannerCalls().length, 0, 'the capture is still used: no scanner request');
        h.equal([h.status().used, h.status().pending], [1, 0]);
        h.equal(h.npc('Yunyun')?.role, 'adventurer', 'the dossier comes from the block');
        const exported = h.runtime.diagnosticBundle().narrationCapture;
        h.equal([exported.requested, exported.used, exported.pending], [1, 1, 0], 'the diagnostics export carries the counters');
        h.check(!JSON.stringify(exported).includes('Yunyun'), 'and no block content');

    }, { makeFirst: true });
});

test('v1.1.8 tag and fence near-misses are accepted only from an armed reply; unarmed ones stay intact', () => {
    runScenario('lenient-forms', async h => {
        h.settings.narrationCapture = true;
        const fence = `\n\n\`\`\`json\n${JSON.stringify({ npcs: [h.YUNYUN] })}\n\`\`\``;
        await h.sendUser('Who is at the gate?');
        const unarmed = await h.receiveAssistant(`${h.REPLY}${fence}`);
        h.equal(h.mockState.context.chat[unarmed].mes, `${h.REPLY}${fence}`, 'an unarmed reply keeps its fence (strict mode)');
        h.equal(h.mockState.context.chat[unarmed].swipes[0], `${h.REPLY}${fence}`);
        h.equal(h.scannerCalls().length, 1, 'and is scanned normally');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer');

        const tag = `\n<npc_state_delta>${JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, role: 'tagged adventurer' }] })}</npc_state_delta>`;
        await h.sendUser('And now?');
        const unarmedTag = await h.receiveAssistant(`${h.REPLY}${tag}`);
        h.equal(h.mockState.context.chat[unarmedTag].mes, `${h.REPLY}${tag}`, 'an unarmed tag form is left intact');
        h.equal(h.scannerCalls().length, 2, 'and is scanned normally');

        const second = 'Yunyun now waits at the guild hall, nervously polishing her wand.';
        const update = { npcs: [{ name: 'Yunyun', present: true, location: 'guild hall', relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] };
        const armedId = await h.turn('I go to the guild hall.', `${second}\n<npc_state_delta>${JSON.stringify(update)}</npc_state_delta>`);
        h.equal(h.mockState.context.chat[armedId].mes, second, 'an armed reply has its tag form removed (lenient)');
        h.equal(h.scannerCalls().length, 2, 'and the armed tag form replaces the scan');
        h.check(/guild hall/i.test(String(h.npc('Yunyun').location || '')), 'the tag form was merged');
        const fenceId = await h.turn('We sit down.', `They sit at a table.\n\`\`\`json\n${JSON.stringify({ npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] })}\n\`\`\``);
        h.equal(h.mockState.context.chat[fenceId].mes, 'They sit at a table.', 'an armed trailing fence is removed (lenient)');
        h.equal(h.scannerCalls().length, 2);
        h.equal([h.status().requested, h.status().used], [2, 2]);
    });
});

test('v1.1.8 a dossier change between the prompt and the reply makes the block outdated', () => {
    runScenario('outdated', async h => {
        h.settings.narrationCapture = true;
        await h.sendUser('Who is at the gate?');
        await h.generate('normal');
        h.equal(h.status().armed, true);
        // The player adds a dossier while the reply is being generated.
        await h.manualAddNpc('Wiz');
        h.check(h.npc('Wiz'), 'the manual add landed');
        const id = await h.receiveAssistant(`${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'the comment block is still stripped');
        h.equal([h.status().requested, h.status().outdated, h.status().used, h.status().pending], [0, 1, 0, 0], 'counted as outdated, never stored');
        h.equal(h.scannerCalls().length, 1, 'the normal scanner request runs');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer', 'the outdated block is not merged');
        h.check(h.npc('Wiz'), 'the manual dossier survives');

        // Without an intervening write the next reply is current again.
        await h.turn('And then?', `${h.REPLY} Again.${h.block({ npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] })}`);
        h.equal([h.status().requested, h.status().outdated, h.status().used], [1, 1, 1]);
        h.equal(h.scannerCalls().length, 1);
    });
});

test('v1.1.8 editing the earlier user message retires a pending capture', () => {
    runScenario('edited-user-message', async h => {
        h.settings.narrationCapture = true;
        await h.turn('Who is at the gate?', 'A quiet wind crosses the gate.');
        const before = h.scannerCalls().length;
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const responder = h.mockState.quietResponder;
        h.mockState.quietResponder = async (...args) => { await held; return responder(...args); };
        const manual = h.runtime.scan();
        await h.sleep(20);
        await h.sendUser('Who is that?');
        await h.generate('normal');
        const id = await h.receiveAssistant(`${h.REPLY}${h.block()}`);
        h.equal(h.status().pending, 1, 'the capture is stored while the scan is busy');
        const editedUser = 'Who is that girl with the crimson eyes?';
        h.mockState.context.chat[id - 1].mes = editedUser;
        await h.emitAsync('message_edited', id - 1);
        h.mockState.quietResponder = responder;
        release();
        await manual;
        await h.sleep(700);
        const after = h.scannerCalls().slice(before + 1);
        h.check(after.some(args => String(args.prompt).includes(editedUser) && String(args.prompt).includes('Yunyun tells Kazuma')), `the reply was rescanned with a real request after the user edit (${after.length} later requests)`);
        h.equal(h.status().used, 0, 'the capture written for the old user message was never merged');
        h.equal(h.npc('Yunyun')?.role, 'scanned adventurer');
    });
});

test('v1.1.8 every swipe entry is stripped at receipt, leniently only when armed', () => {
    runScenario('swipe-entries', async h => {
        h.settings.narrationCapture = true;
        await h.sendUser('Who is at the gate?');
        await h.generate('normal');
        const older = 'An older sibling reply.';
        const olderTag = 'A tagged sibling.';
        const current = `${h.REPLY}${h.block()}`;
        const id = await h.receiveAssistant(current, {
            swipes: [`${older}${h.block({ npcs: [{ name: 'Old' }] })}`, `${olderTag}\n<npc_state_delta>{"npcs":[]}</npc_state_delta>`, current],
            swipeId: 2,
        });
        h.equal(h.mockState.context.chat[id].swipes, [older, olderTag, h.REPLY], 'all swipe strings are stripped (armed: lenient)');
        h.equal(h.status().used, 1);

        await h.sendUser('Next?');
        const unarmedTag = 'Unarmed tagged sibling.\n<npc_state_delta>{"npcs":[]}</npc_state_delta>';
        const plain = 'A plain reply.';
        const id2 = await h.receiveAssistant(plain, { swipes: [`Hidden sibling.${h.block()}`, unarmedTag, plain], swipeId: 2 });
        h.equal(h.mockState.context.chat[id2].swipes, ['Hidden sibling.', unarmedTag, plain], 'unarmed: comment blocks stripped, tag form kept (strict)');
    });
});

test('v1.1.8 MESSAGE_SWIPED strictly strips the swiped message before other listeners', () => {
    runScenario('message-swiped', async h => {
        h.settings.narrationCapture = true;
        const id = await h.turn('Who is at the gate?', 'A quiet wind crosses the gate.');
        const message = h.mockState.context.chat[id];
        const sibling = 'Yunyun appears at the gate.';
        const tagged = 'Tagged sibling.\n<npc_state_delta>{"npcs":[]}</npc_state_delta>';
        message.swipes = ['A quiet wind crosses the gate.', `${sibling}${h.block()}`, tagged];
        message.swipe_id = 1;
        message.mes = message.swipes[1];
        const listeners = h.mockState.listeners.get('message_swiped') || [];
        h.check(listeners.length >= 2, 'the strip and the reconcile listeners are both registered');
        // Only the first listener (placed by makeFirst) runs here.
        listeners[0](id);
        h.equal(message.mes, sibling, 'the swiped-to text is stripped by the first listener');
        h.equal(message.swipes, ['A quiet wind crosses the gate.', sibling, tagged], 'every stored swipe loses its comment block; the tag form stays (strict)');
        h.equal(h.status().used, 0, 'a swipe never merges a block');
    }, { makeFirst: true });
});

test('v1.1.8 CHAT_CHANGED disarms the instruction', () => {
    runScenario('chat-changed', async h => {
        h.settings.narrationCapture = true;
        await h.sendUser('Who is at the gate?');
        await h.generate('normal');
        h.equal(h.status().armed, true);
        await h.emitAsync('chat_changed');
        await h.sleep(150);
        h.equal(h.status().armed, false, 'a chat change disarms');
        h.check(!h.lastPrompt().includes(h.HEADER), 'the instruction is no longer injected');
        const id = await h.receiveAssistant(`${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY, 'the block is still stripped');
        h.equal(h.scannerCalls().length, 1, 'the reply is scanned normally');
        h.equal([h.status().requested, h.status().used, h.status().pending], [0, 0, 0]);
    });
});

test('v1.1.8 GENERATION_STOPPED disarms the instruction', () => {
    runScenario('generation-stopped', async h => {
        h.settings.narrationCapture = true;
        await h.sendUser('Who is at the gate?');
        await h.generate('normal');
        h.check(h.lastPrompt().includes(h.HEADER));
        await h.emitAsync('generation_stopped');
        h.equal(h.status().armed, false, 'a stopped generation disarms');
        h.check(!h.lastPrompt().includes(h.HEADER), 'and withdraws the instruction at once');
        h.equal(h.runtime.injectionPreview().captureChars, 0);
        const id = await h.receiveAssistant(`${h.REPLY}${h.block()}`);
        h.equal(h.mockState.context.chat[id].mes, h.REPLY);
        h.equal(h.scannerCalls().length, 1, 'a later reply is scanned normally');
        h.equal([h.status().requested, h.status().used], [0, 0]);
    });
});

// (1.2.11) One-pass catch-up: every N captured replies, the NPCs most in them get a quiet Refresh.
test('v1.2.11 one-pass catch-up refreshes the NPCs most in the last N captured replies, quietly', () => {
    runScenario('catch-up', async h => {
        h.settings.narrationCapture = true;
        h.settings.narrationCaptureCatchUp = 2;
        const refreshCalls = () => h.mockState.rawCalls.map(call => call?.[0] || {}).filter(args => /targeted dossier reconciliation scanner/i.test(String(args.systemPrompt || '')));
        const toasts = [];
        for (const level of ['info', 'success', 'warning']) {
            const before = globalThis.toastr?.[level];
            if (globalThis.toastr) globalThis.toastr[level] = (text, ...rest) => { toasts.push(`${level}: ${text}`); return before?.(text, ...rest); };
        }
        await h.turn('Who is at the gate?', `${h.REPLY}${h.block()}`);
        h.equal(refreshCalls().length, 0, 'not after one captured reply');
        const update = { npcs: [{ name: 'Yunyun', present: true, location: 'guild hall', relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] };
        await h.turn('I go to the guild hall.', `Yunyun waits at the guild hall.${h.block(update)}`);
        await h.sleep(300);
        h.equal(h.scannerCalls().length, 0, 'the captures themselves still need no scan');
        h.equal(refreshCalls().length, 1, 'one Refresh after the second captured reply');
        h.check(String(refreshCalls()[0].prompt || '').includes('Yunyun'), 'for the NPC in those replies');
        h.check(!toasts.some(text => /Yunyun is already consistent|no grounded dossier changes/i.test(text)), `a catch-up that changes nothing says nothing: ${toasts.join(' | ')}`);
        // Off: no catch-up.
        h.settings.narrationCaptureCatchUp = 0;
        await h.turn('We wait.', `Yunyun polishes her wand.${h.block(update)}`);
        await h.turn('We wait more.', `Yunyun sighs.${h.block(update)}`);
        await h.sleep(300);
        h.equal(refreshCalls().length, 1, 'none with the setting at 0');
    });
});

// (1.2.12) The relationship evaluator in one-pass: only NPCs the story names are targets, it
// reads the story alone, and the block's own "relationshipsCovered" / "relationshipReview" decide.
test('v1.2.12 one-pass relationship targets: story names only, the block covers or asks for review', () => {
    runScenario('relationship-targets', async h => {
        h.settings.narrationCapture = true;
        await h.manualAddNpc('Brecht');
        h.check(h.npc('Brecht'), 'Brecht has a dossier');
        const worldState = '\n\n<!-- STORY_BLOCKS_V1\n<Blocks>\n<World_State>\n**👥 NPCs Present:**\n**Yunyun:**\n\n**📡 Off-Screen:**\n* Brecht — rallying dockhands at the fish sheds\n</World_State>\n</Blocks>\n-->';
        const yunyunOnly = { npcs: [{ ...h.YUNYUN }] };
        const evaluatorPrompts = () => h.relationshipCalls().map(args => String(args.prompt || ''));
        // 1. Brecht only in the World State's Off-Screen list: no target, no request.
        await h.turn('Who is at the gate?', `${h.REPLY}${worldState}${h.block(yunyunOnly)}`);
        h.equal(h.relationshipCalls().length, 0, 'a name only in the World State is no part in the scene');
        // 2. Brecht named in the story, left out of the block, nothing said: the evaluator checks him,
        // reading the story without the World State.
        const named = 'Yunyun points at Brecht across the square and frowns.';
        const still = { npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] };
        await h.turn('Who is that?', `${named}${worldState}${h.block(still)}`);
        h.equal(h.relationshipCalls().length, 1, 'a named NPC the block skipped is checked');
        h.check(evaluatorPrompts()[0].includes('points at Brecht'), 'the evaluator reads the story');
        h.check(!/Off-Screen|fish sheds/.test(evaluatorPrompts()[0]), 'and not the World State');
        // 3. The same, with the block saying it covered everyone: no request.
        await h.turn('And now?', `${named} Again.${worldState}${h.block({ ...still, relationshipsCovered: true })}`);
        h.equal(h.relationshipCalls().length, 1, '"relationshipsCovered" settles anyone the block left out');
        // 4. Brecht not named at all, but the block asks for him: checked.
        await h.turn('Later.', `Yunyun hums.${worldState}${h.block({ ...still, relationshipsCovered: true, relationshipReview: ['Brecht'] })}`);
        h.equal(h.relationshipCalls().length, 2, '"relationshipReview" asks for a check');
    });
});
