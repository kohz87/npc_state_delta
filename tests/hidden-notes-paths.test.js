import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    NARRATION_CAPTURE_CONTEXT_MARKER, buildBackfillPrompt, buildNarrationCaptureParts, buildNarrationCapturePrompt, buildProfileRefreshPrompt, buildScannerPrompt,
} from '../core.js';
import { appendHiddenNotePrompt } from '../core-mechanics.js';
import { secretEventsShown } from '../core-prompts-capture.js';

// Hidden notes (layered notes for a new dossier, the story events of present people's locked notes) in every path that
// builds a dossier or scans a present person, not only the ordinary scan: the one-pass block (full and compact rules),
// the targeted backfill of a new dossier and the targeted Refresh. Off, or with nobody to watch, every prompt is as before.
//
// Which path runs by default: `narrationCapture` (one-pass) is OFF and `fullScanEveryTurn` is OFF, so Standard and Full both
// use the ordinary single-exchange dossier scan after every reply; Lean turns "Scan after every reply" off, so the same
// scan runs every third reply. The one-pass block, the backfill and the Refresh are opt-in or follow-ups.

const EVENT = 'The duke is exposed as a traitor';
const WATCH = [{ key: 's1', name: 'Mira', event: EVENT }];
const ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
const base = { transcript: 'USER: hi\nASSISTANT: Mira laughs.', currentTranscript: 'Mira laughs.', existingNpcs: [], userName: 'Ari', charName: 'Narrator' };

// ---- the prompts ----

test('one-pass block: the layered-notes rule rides with the rules, the events with the context; off or nobody to watch is byte-identical', () => {
    for (const compactCapture of [false, true]) {
        const plain = buildNarrationCaptureParts({ ...base, compactCapture });
        assert.equal(plain.rules.includes('HIDDEN NOTES'), false);
        assert.equal(plain.context.includes('STORY EVENTS'), false);
        assert.deepEqual(buildNarrationCaptureParts({ ...base, compactCapture, layeredSecrets: false, eventWatch: [] }), plain, 'asked for nothing: byte-identical');
        assert.deepEqual(buildNarrationCaptureParts({ ...base, compactCapture, eventWatch: [{ name: 'x' }, null] }), plain, 'an item with no key or event is no watch');

        const layered = buildNarrationCaptureParts({ ...base, compactCapture, layeredSecrets: true });
        assert.match(layered.rules, /\n(?:12|16)\. HIDDEN NOTES: for each NEW dossier-worthy NPC only/, `rules carry the layered rule (compact ${compactCapture})`);
        assert.equal(layered.context, plain.context, 'the context part is unchanged by it');
        assert.equal(layered.rules.replace(/\n(?:12|16)\. HIDDEN NOTES:[^\n]*/, ''), plain.rules, 'it adds that one rule and nothing else');

        // The events change from reply to reply: they go in the context, so the rules stay byte-identical (cacheable).
        const watched = buildNarrationCaptureParts({ ...base, compactCapture, layeredSecrets: true, eventWatch: WATCH });
        assert.equal(watched.rules, layered.rules, 'the rules do not change with the events');
        assert.match(watched.context, /\n\nSTORY EVENTS to look for \(present NPCs' hidden notes\): s1 = Mira: The duke is exposed as a traitor\. Return top-level "secretEvents":\["<key>",\.\.\.\] with ONLY the keys whose event the CURRENT exchange clearly shows/);
        const other = buildNarrationCaptureParts({ ...base, compactCapture, layeredSecrets: true, eventWatch: [{ key: 's1', name: 'Oren', event: 'The bridge falls' }] });
        assert.equal(other.rules, watched.rules);
        assert.ok(watched.context.includes(NARRATION_CAPTURE_CONTEXT_MARKER.slice(0, 8)) || watched.context.startsWith('NPC STATE DELTA ONE-PASS CAPTURE'));
    }
    // The ordinary scanner keeps numbering them as rules (unchanged).
    assert.match(buildScannerPrompt({ ...base, layeredSecrets: true, eventWatch: WATCH }), /\n16\. HIDDEN NOTES[^\n]*\n17\. STORY EVENTS/);
    assert.equal(buildNarrationCapturePrompt({ ...base, eventWatch: WATCH }).includes('\n16. STORY EVENTS'), false, 'in a one-pass block the events are not a numbered rule');
});

test('targeted backfill and Refresh: the notes are asked for in paragraphs at the end; nothing asked, nothing added', () => {
    const npc = { id: 'npc_mira', name: 'Mira', present: true };
    const options = { transcript: '[m1] Mira laughs.', targetName: 'Mira', existingNpc: npc, targetNpc: npc, userName: 'Ari', charName: 'Narrator' };
    for (const build of [buildBackfillPrompt, buildProfileRefreshPrompt]) {
        const plain = build(options);
        assert.equal(build({ ...options, layeredSecrets: false, eventWatch: [] }), plain, 'byte-identical');
        assert.equal(plain.includes('HIDDEN NOTES') || plain.includes('STORY EVENTS'), false);
        const layered = build({ ...options, layeredSecrets: true });
        assert.ok(layered.startsWith(plain));
        assert.match(layered.slice(plain.length), /^\n\nHIDDEN NOTES: this dossier is NEW: also return "secrets" in the npcs\[\] row of the target: 2 to 5 layered hidden notes/);
        const watched = build({ ...options, eventWatch: WATCH });
        assert.ok(watched.startsWith(plain));
        assert.match(watched.slice(plain.length), /^\n\nSTORY EVENTS to look for \(present NPCs' hidden notes\): s1 = Mira: The duke is exposed as a traitor\. Return top-level "secretEvents"[^\n]*the supplied story shows happened \(clearly, never a guess\)/);
        const both = build({ ...options, layeredSecrets: true, eventWatch: WATCH });
        assert.equal(both, `${layered}\n\n${watched.slice(plain.length + 2)}`);
    }
    assert.equal(appendHiddenNotePrompt('P', {}), 'P');
    assert.equal(appendHiddenNotePrompt('P'), 'P');
});

// ---- the runtime: the one-pass block, the backfill and the Refresh on the synthetic host, beside a fake Story Block v2 ----

const yunyun = (extra = {}) => ({ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO, ...extra });
const NOTE_EVENT = 'The duke is exposed as a traitor';
const layers = [1, 2, 3, 4, 5, 6, 7].map(i => ({ title: `Layer ${i}`, text: `Secret number ${i} about Yunyun.`, meter: 'trust', at: 10 * i }));
const withEvent = [{ title: 'The duke', text: 'She knew about the duke.', when: NOTE_EVENT }, { title: 'Light', text: 'She likes tea.', meter: 'trust', at: 20 }];

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runPath(name, { hosted = true, setup = () => {} } = {}, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
globalThis.document.documentElement = { dataset: {} };
globalThis.document.readyState = 'loading';
fs.cpSync(path.join(sourceRoot, 'src'), path.join(extRoot, 'src'), { recursive: true });
mockState.storyBlockTabs = [];
mockState.context.eventTypes.GENERATION_AFTER_COMMANDS = 'generation_after_commands';
mockState.context.eventTypes.GENERATION_STOPPED = 'generation_stopped';
mockState.context.eventTypes.CHAT_COMPLETION_PROMPT_READY = 'chat_completion_prompt_ready';
mockState.context.updateMessageBlock = () => {};
if (${hosted}) {
    const sdk = {
        registered: [], sent: [], entries: [],
        registerModule(def) { sdk.registered.push(def); },
        command: async (type, payload, options) => { sdk.sent.push({ type, payload, options: options ?? null }); return { ok: true, receipt: { summary: '' } }; },
        query: name => (name === 'npc.meters' ? structuredClone(sdk.entries) : null),
        settings: () => ({}),
    };
    mockState.sdk = sdk;
    globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
}
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await import(pathToFileURL(path.join(extRoot, 'story-block-tabs.js')).href);
    await sleep(30);
    if (${hosted}) await waitFor(() => mockState.sdk.registered.length === 1);
    const settings = mockState.extensionSettings.npc_state_delta;
    settings.narrationCapture = true;
    await (${setup.toString()})(settings);
    globalThis.ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
    const NOTE_EVENT = ${JSON.stringify(NOTE_EVENT)};
    const withEvent = ${JSON.stringify(withEvent)};
    const yunyun = ${yunyun.toString()};
    const emitAll = async (event, ...args) => { await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args))); };
    // The latest rules and context the one-pass instruction went out with (what the model was given with that reply).
    const lastPrompt = key => { const found = mockState.prompts.filter(args => args[0] === key).at(-1); return String(found?.[1] ?? ''); };
    const sent = { rules: '', context: '' };
    // One reply with a capture block; \`payload\` is what the model wrote beside it.
    const reply = async (text, payload) => {
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
        await emitAll('message_sent', mockState.context.chat.length - 1);
        await emitAll('generation_after_commands', 'normal', {}, false);
        sent.rules = lastPrompt('story_suite_static_npc_state_delta');
        sent.context = lastPrompt('story_suite_tail_5_npc_state_delta_capture');
        const mes = \`\${text}\\n\\n<!--npc_state_delta\\n\${JSON.stringify(payload)}\\n-->\`;
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes, swipe_id: 0, swipes: [mes] });
        const id = mockState.context.chat.length - 1;
        await emitAll('message_received', id);
        await emitAll('character_message_rendered', id);
        await sleep(500);
        return { id, rules: sent.rules, context: sent.context };
    };
    const result = await (${scenario.toString()})({ reply, settings, mockState, sleep });
    console.log('RESULT ' + JSON.stringify(result));
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    let output;
    try {
        output = execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
    const line = String(output).split('\n').find(text => text.startsWith('RESULT '));
    assert.ok(line, `scenario ${name} printed its result`);
    return JSON.parse(line.slice(7));
}

// What the one-pass scenario does: a new dossier whose block carries notes, then a reply that shows the event.
const onePassScenario = async ({ reply, mockState }) => {
    const first = await reply('Yunyun, a young woman with crimson eyes, waves from the gate.', { npcs: [yunyun({ secrets: withEvent })] });
    const dossier = globalThis.NPCStateDelta.getState().npcs.find(npc => npc.name === 'Yunyun');
    const noteId = (dossier?.secrets ?? []).find(note => note.when)?.id ?? null;
    const second = await reply('The duke is dragged out in chains.', { npcs: [{ ...yunyun(), id: dossier?.id }], secretEvents: ['s1', 's9'], secretEventEvidence: { s1: 'dragged out in chains', s9: 'never said' } });
    return {
        first, second, noteId,
        secrets: (dossier?.secrets ?? []).map(note => ({ meter: note.meter ?? null, when: note.when ?? null, id: /^sec_[0-9a-z]{8}$/.test(note.id) })),
        opened: mockState.sdk?.sent.filter(item => item.type === 'npc.open').map(item => ({ payload: item.payload, options: item.options })) ?? [],
    };
};

for (const [label, compact, rule] of [['full rules', false, 16], ['compact rules', true, 12]]) {
    test(`hosted one-pass block (${label}): the block writes a new dossier's layered notes; present people's event notes are watched and opened`, () => {
        const out = runPath(`onepass-${label}`, { setup: new Function('settings', `settings.narrationCaptureCompact = ${compact};`) }, onePassScenario);
        assert.match(out.first.rules, new RegExp(`\\n${rule}\\. HIDDEN NOTES: for each NEW dossier-worthy NPC only`), 'the rules ask for layers');
        assert.equal(out.first.context.includes('STORY EVENTS'), false, 'nobody has an event note yet');
        assert.deepEqual(out.secrets, [{ meter: null, when: NOTE_EVENT, id: true }, { meter: 'trust', when: null, id: true }], 'the notes from the block, cleaned');
        assert.match(out.second.context, /\n\nSTORY EVENTS to look for \(present NPCs' hidden notes\): s1 = Yunyun: The duke is exposed as a traitor\. /, 'the context lists the event');
        assert.equal(out.second.rules, out.first.rules, 'the rules are byte-identical from reply to reply');
        assert.equal(out.opened.length, 1, 'one npc.open: the key the block returned (an unknown key is ignored)');
        assert.deepEqual(out.opened[0].payload, { name: 'Yunyun', open: [out.noteId], by: 'story' });
        assert.deepEqual(out.opened[0].options, { background: true }, 'sent as Delta\'s own action, as a background change (Story Block\'s late save window)');
    });
}

test('one-pass block with "Hidden notes for new people" off: no layered rule, nothing kept from a block that has them; as an unhosted Delta sends it', () => {
    const out = runPath('onepass-off', { setup: settings => { settings.layeredSecrets = false; } }, async ({ reply }) => {
        const first = await reply('Yunyun waves from the gate.', { npcs: [yunyun({ secrets: withEvent })] });
        const dossier = globalThis.NPCStateDelta.getState().npcs.find(npc => npc.name === 'Yunyun');
        return { rules: first.rules, secrets: (dossier?.secrets ?? []).length };
    });
    assert.equal(out.rules.includes('HIDDEN NOTES'), false);
    assert.equal(out.secrets, 0);
    // Off, the rules are exactly what an unhosted Delta sends (nothing about hidden notes anywhere).
    const alone = runPath('onepass-unhosted', { hosted: false }, async ({ reply }) => ({ rules: (await reply('Yunyun waves from the gate.', { npcs: [yunyun()] })).rules }));
    assert.equal(out.rules, alone.rules, 'byte-identical');
    assert.ok(alone.rules.length > 500);
});

test('hosted: a backfill of a new dossier asks for layered notes and keeps them; a Refresh of a present person looks for their story events', () => {
    const out = runPath('backfill-refresh', { setup: settings => { settings.narrationCaptureCatchUp = 2; } }, async ({ reply, mockState }) => {
        const asked = [];
        mockState.quietResponder = async (args = {}) => {
            const system = String(args.systemPrompt || '');
            const prompt = String(args.prompt || '');
            if (/backfill scanner/i.test(system)) {
                asked.push({ kind: 'backfill', prompt });
                const name = prompt.match(/^(?:Requested|Target) NPC: (.+?)(?: [(].*)?$/m)?.[1] ?? 'Yunyun';
                return JSON.stringify({ npcs: [{ name, present: true, role: 'adventurer', relationshipImpact: 'none', relationshipDelta: ZERO, secrets: withEvent }] });
            }
            if (/reconciliation scanner/i.test(system)) {
                asked.push({ kind: 'refresh', prompt });
                // The answer holds no dossier change at all, only the event the story showed.
                return JSON.stringify({ npcs: [], secretEvents: /s1 = Yunyun/.test(prompt) ? ['s1'] : [], secretEventEvidence: { s1: 'dragged out in chains' } });
            }
            return '{"npcs":[]}';
        };
        // Replies 1 and 2: Yunyun is new (her backfill runs on reply 1), then the catch-up Refresh runs on reply 2.
        await reply('Yunyun, a young woman with crimson eyes, waves from the gate.', { npcs: [yunyun()] });
        await reply('Yunyun smiles at Kazuma.', { npcs: [yunyun({ relationshipDelta: ZERO })] });
        const afterTwo = globalThis.NPCStateDelta.getState().npcs.find(npc => npc.name === 'Yunyun');
        const noteId = (afterTwo?.secrets ?? []).find(note => note.when)?.id ?? null;
        // Replies 3 and 4: the next catch-up Refresh finds the event note and asks about it.
        await reply('The duke is dragged out in chains.', { npcs: [yunyun()] });
        await reply('Yunyun watches him go.', { npcs: [yunyun()] });
        return {
            asked: asked.map(item => ({ kind: item.kind, layered: item.prompt.includes('HIDDEN NOTES: this dossier is NEW: also return "secrets"'), events: /STORY EVENTS to look for[^\n]*s1 = Yunyun: The duke is exposed as a traitor\./.test(item.prompt) })),
            secrets: (afterTwo?.secrets ?? []).map(note => [note.meter ?? null, note.when ?? null]),
            noteId,
            opened: mockState.sdk.sent.filter(item => item.type === 'npc.open').map(item => ({ payload: item.payload, options: item.options })),
        };
    });
    const backfills = out.asked.filter(item => item.kind === 'backfill');
    const refreshes = out.asked.filter(item => item.kind === 'refresh');
    assert.equal(backfills.length, 1, 'one backfill, for the new dossier');
    assert.equal(backfills[0].layered, true, 'it asks for the layered notes');
    assert.equal(backfills[0].events, false);
    assert.deepEqual(out.secrets, [[null, NOTE_EVENT], ['trust', null]], 'and keeps what it returned');
    assert.ok(refreshes.length >= 2);
    assert.equal(refreshes[0].events, true, 'the backfill now runs on the first reply (own cadence), so the first Refresh already sees the event note');
    assert.equal(refreshes[0].layered, false, 'a Refresh never asks for layers');
    assert.equal(refreshes.at(-1).events, true, 'the later Refresh lists the event');
    // The fake answers s1 every time, but only the later Refresh's window holds its quote ("dragged out in chains"): the earlier one is refused.
    assert.equal(out.opened.length, refreshes.length - 1, 'only the Refresh whose window shows the quote sends the open');
    for (const sent of out.opened) {
        assert.deepEqual(sent.payload, { name: 'Yunyun', open: [out.noteId], by: 'story' });
        assert.deepEqual(sent.options, { background: true });
    }
});

test('a backfill of a dossier that already has notes, and any pass without a host, asks for none', () => {
    const hostedWithNotes = runPath('backfill-has-notes', { setup: settings => { settings.narrationCaptureCatchUp = 2; } }, async ({ reply, mockState }) => {
        const prompts = [];
        mockState.quietResponder = async (args = {}) => {
            const system = String(args.systemPrompt || '');
            if (/backfill scanner/i.test(system)) prompts.push(String(args.prompt || ''));
            const name = (/backfill scanner/i.test(String(args.systemPrompt || '')) ? String(args.prompt || '').match(/^(?:Requested|Target) NPC: (.+?)(?: [(].*)?$/m)?.[1] : undefined);
            return name ? JSON.stringify({ npcs: [{ name, present: true, role: 'adventurer', relationshipImpact: 'none', relationshipDelta: ZERO }] }) : '{"npcs":[]}';
        };
        // The block already wrote this person's notes.
        await reply('Yunyun waves from the gate.', { npcs: [yunyun({ secrets: withEvent })] });
        await reply('Yunyun smiles.', { npcs: [yunyun()] });
        return { prompts: prompts.length, layered: prompts.some(text => text.includes('HIDDEN NOTES')) };
    });
    assert.equal(hostedWithNotes.layered, false);
    const alone = runPath('backfill-unhosted', { hosted: false }, async ({ reply, mockState }) => {
        const prompts = [];
        mockState.quietResponder = async (args = {}) => {
            prompts.push(String(args.prompt || ''));
            const name = (/backfill scanner/i.test(String(args.systemPrompt || '')) ? String(args.prompt || '').match(/^(?:Requested|Target) NPC: (.+?)(?: [(].*)?$/m)?.[1] : undefined);
            return name ? JSON.stringify({ npcs: [{ name, present: true, role: 'adventurer', relationshipImpact: 'none', relationshipDelta: ZERO }] }) : '{"npcs":[]}';
        };
        await reply('Yunyun waves from the gate.', { npcs: [yunyun()] });
        await reply('Yunyun smiles.', { npcs: [yunyun()] });
        return { calls: prompts.length, any: prompts.some(text => /HIDDEN NOTES|STORY EVENTS/.test(text)) };
    });
    assert.ok(alone.calls >= 1, 'unhosted, the backfill still runs');
    assert.equal(alone.any, false, 'and has no word about hidden notes');
});

// ---- strict story events: the event as written, with a quote the code finds ----

const PRESS = 'Sieke: Pressed about Auvoth\'s threats or why she is desperate';
const LETTER = 'USER: I wait by the fire.\nASSISTANT: Sieke unfolds an Auvoth letter and reads it aloud: "He swears he will burn the dock if the debt is not paid."';
const PRESSED = 'USER: "Why are you so desperate, Sieke? What did Auvoth threaten you with?"\nASSISTANT: Sieke flinches. "He swore he would burn the dock," she whispers.';

test('the events rule asks for the event as written by its actor, with a quote per key; the schema text is the same in every path', () => {
    for (const rule of [buildNarrationCaptureParts({ ...base, eventWatch: WATCH }).context, appendHiddenNotePrompt('P', { eventWatch: WATCH })]) {
        assert.match(rule, /happens as written, by the actor it names \("pressed" needs someone to press that person on it\)/);
        assert.match(rule, /the person raising the topic themselves, a mention, a hint or something about to happen does not/);
        assert.match(rule, /"secretEventEvidence":\{"<key>":"short exact quote showing the event"\} for every key; no quote, no key\./);
    }
});

test('secretEventsShown: the Sieke case (letter read aloud, nobody pressing) is refused by its quote; a real pressing is kept', () => {
    assert.ok(PRESS);
    // The model matched the topic: the quote it gives for "pressed" is not a pressing, and the line it names is not in the letter exchange.
    assert.deepEqual(secretEventsShown({ secretEvents: ['s4'], secretEventEvidence: { s4: 'Why are you so desperate, Sieke?' } }, LETTER), []);
    // A quote that is in the text but shows no pressing is the model's to get wrong; the prompt forbids it. A quote that IS the pressing line passes.
    assert.deepEqual(secretEventsShown({ secretEvents: ['s4'], secretEventEvidence: { s4: 'Why are you so desperate, Sieke?' } }, PRESSED), ['s4']);
});

test('secretEventsShown: no evidence, a short or made-up quote, a non-string quote or a non-list answer is dropped; small punctuation differences and "..." parts are tolerated', () => {
    const logged = [];
    const original = console.debug;
    console.debug = line => logged.push(String(line));
    try {
        assert.deepEqual(secretEventsShown({ secretEvents: ['s1'] }, PRESSED), [], 'no evidence at all');
        assert.deepEqual(secretEventsShown({ secretEvents: ['s1'], secretEventEvidence: {} }, PRESSED), [], 'no quote for the key');
        assert.deepEqual(secretEventsShown({ secretEvents: ['s1'], secretEventEvidence: { s1: 'Sieke slams the table' } }, PRESSED), [], 'made-up quote');
        assert.deepEqual(secretEventsShown({ secretEvents: ['s1'], secretEventEvidence: { s1: 'Sieke' } }, PRESSED), [], 'too short to be a quote');
        assert.deepEqual(secretEventsShown({ secretEvents: ['s1'], secretEventEvidence: { s1: 42 } }, PRESSED), [], 'not a string');
        assert.deepEqual(secretEventsShown({ secretEvents: 's1', secretEventEvidence: { s1: 'Why are you so desperate' } }, PRESSED), [], 'not a list');
        assert.deepEqual(secretEventsShown(null, PRESSED), []);
        assert.equal(logged.filter(line => /refused/.test(line)).length, 5, 'each refused key is logged');
        assert.deepEqual(secretEventsShown({ secretEvents: ['s1', 's2'], secretEventEvidence: { s1: '\u201cwhy are you so   desperate, sieke\u201d', s2: 'He swore\u2026 burn the dock' } }, PRESSED), ['s1', 's2'], 'quotes, case, spacing and an ellipsis are not mismatches');
    } finally {
        console.debug = original;
    }
});

test('hosted one-pass: a key with no evidence quote, or a made-up one, opens no note; the same key with a real quote opens it', () => {
    const out = runPath('onepass-evidence', {}, async ({ reply, mockState }) => {
        await reply('Yunyun, a young woman with crimson eyes, waves from the gate.', { npcs: [yunyun({ secrets: withEvent })] });
        const dossier = globalThis.NPCStateDelta.getState().npcs.find(npc => npc.name === 'Yunyun');
        const sentOpens = () => mockState.sdk.sent.filter(item => item.type === 'npc.open').length;
        const row = { ...yunyun(), id: dossier?.id };
        await reply('The duke is dragged out in chains.', { npcs: [row], secretEvents: ['s1'] });
        const bare = sentOpens();
        await reply('The duke is dragged out in chains.', { npcs: [row], secretEvents: ['s1'], secretEventEvidence: { s1: 'the duke confesses to treason' } });
        const made = sentOpens();
        await reply('The duke is dragged out in chains.', { npcs: [row], secretEvents: ['s1'], secretEventEvidence: { s1: 'The duke is dragged out in chains.' } });
        return { bare, made, real: sentOpens() };
    });
    assert.deepEqual(out, { bare: 0, made: 0, real: 1 });
});
