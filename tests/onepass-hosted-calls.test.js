import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// (user decision 5, b6-soak-2) Model calls per reply in one-pass mode, through Delta's real event
// handlers on the synthetic SillyTavern host (runtime-smoke.mjs), alone or beside a fake Story Block
// v2 with the npc meters slice. Hosted, an ordinary one-pass reply makes no model call of Delta's
// own: no focused relationship pass, no backfill. Without a host the calls are the ones Delta always
// made (a new dossier's backfill, an evaluator for a relationship the block left open), and queued
// backfills no longer hold the reply.

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runCalls(name, hosted, scenario) {
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
        registered: [], sent: [],
        registerModule(def) { sdk.registered.push(def); },
        command: async (type, payload, options) => { sdk.sent.push({ type, payload, options: options ?? null }); return { ok: true, receipt: { summary: '' } }; },
        query: () => null,
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
    globalThis.ZERO = { trust: 0, affection: 0, desire: 0, tension: 0 };
    // A backfill finds the NPC it asks for; every other request finds nothing new.
    mockState.quietResponder = async (args = {}) => {
        const asked = String(args.prompt || '').match(/^Requested NPC: (.+)$/m)?.[1];
        return asked ? JSON.stringify({ npcs: [{ name: asked, present: true, role: 'regular', relationshipImpact: 'none', relationshipDelta: ZERO }] }) : '{"npcs":[]}';
    };
    const emitAll = async (event, ...args) => { await Promise.all((mockState.listeners.get(event) || []).map(fn => fn(...args))); };
    const kinds = () => {
        const out = { scanner: 0, relationship: 0, backfill: 0, refresh: 0 };
        for (const call of mockState.rawCalls) {
            const system = String(call?.[0]?.systemPrompt || '');
            if (/isolated dossier scanner\\./i.test(system)) out.scanner += 1;
            else if (/relationship evaluator/i.test(system)) out.relationship += 1;
            else if (/backfill scanner/i.test(system)) out.backfill += 1;
            else if (/reconciliation scanner/i.test(system)) out.refresh += 1;
        }
        return out;
    };
    const minus = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] - b[key]]));
    // One reply with a capture block: the calls the reply's MESSAGE_RECEIVED awaited, and all the
    // calls it led to once Delta settled.
    const reply = async (text, payload) => {
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
        await emitAll('message_sent', mockState.context.chat.length - 1);
        await emitAll('generation_after_commands', 'normal', {}, false);
        const mes = \`\${text}\\n\\n<!--npc_state_delta\\n\${JSON.stringify(payload)}\\n-->\`;
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes, swipe_id: 0, swipes: [mes] });
        const id = mockState.context.chat.length - 1;
        const before = kinds();
        await emitAll('message_received', id);
        const held = minus(kinds(), before);
        await emitAll('character_message_rendered', id);
        await sleep(400);
        return { id, held, all: minus(kinds(), before) };
    };
    const result = await (${scenario.toString()})({ reply, settings, mockState, sleep, kinds });
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

// The scenarios run in the child process; ZERO (no relationship change) is defined there.
/* global ZERO */
// Two ordinary one-pass replies: Yunyun arrives (a new dossier, a complete no-change decision), then
// speaks again with a row that leaves her relationship open (the evaluator's case).
const twoReplies = async ({ reply }) => {
    const first = await reply('Yunyun, a young woman with crimson eyes, waves from the gate.',
        { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
    const second = await reply('Yunyun tells Kazuma she trusts him more and is fond of him.',
        { npcs: [{ name: 'Yunyun', present: true, mood: 'warm' }] });
    return { first: first.all, firstHeld: first.held, second: second.all };
};

test('hosted one-pass: an ordinary reply makes no extra model call (no relationship pass, no backfill)', () => {
    const hosted = runCalls('hosted-two-replies', true, twoReplies);
    assert.deepEqual(hosted.first, { scanner: 0, relationship: 0, backfill: 1, refresh: 0 }, 'a new NPC in the block: its one backfill (own cadence, batch D), no evaluator');
    assert.deepEqual(hosted.second, { scanner: 0, relationship: 0, backfill: 0, refresh: 0 }, 'an open relationship in the block: no evaluator (the story\'s ~ npc lines move the meters)');
});

test('without a host the same replies make the calls they always made; the reply never waits for a backfill', () => {
    const plain = runCalls('unhosted-two-replies', false, twoReplies);
    assert.deepEqual(plain.first, { scanner: 0, relationship: 0, backfill: 1, refresh: 0 }, 'the new dossier still gets its one backfill');
    assert.equal(plain.firstHeld.backfill, 0, 'the backfill runs after the reply\'s MESSAGE_RECEIVED has returned');
    assert.deepEqual(plain.second, { scanner: 0, relationship: 1, backfill: 0, refresh: 0 }, 'the open relationship still gets its evaluator');
});

test('b6-soak-2: a crowd block admits at most 4 new people and runs at most 2 backfills per reply, none awaited', () => {
    const crowd = async ({ reply, mockState, sleep }) => {
        const npcs = Array.from({ length: 12 }, (_, i) => ({ name: `Dockhand ${String.fromCharCode(65 + i)}`, present: true, role: 'dockhand', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }));
        const first = await reply('Twelve dockhands, Dockhand A to Dockhand L, unload the barge.', { npcs });
        const admitted = globalThis.NPCStateDelta.getState().npcs.filter(npc => npc.name.startsWith('Dockhand')).length;
        const queuedAfterFirst = globalThis.NPCStateDelta.getState().pendingBackfills.length;
        const second = await reply('The quay is quiet.', { npcs: [] });
        await sleep(100);
        return { admitted, first: first.all, firstHeld: first.held, queuedAfterFirst, second: second.all, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length, calls: mockState.rawCalls.length };
    };
    const plain = runCalls('unhosted-crowd', false, crowd);
    assert.equal(plain.admitted, 4, 'one block admits at most 4 new people');
    assert.equal(plain.firstHeld.backfill, 0, 'MESSAGE_RECEIVED awaited no backfill');
    assert.equal(plain.first.backfill, 2, 'at most 2 backfills follow the reply');
    assert.equal(plain.queuedAfterFirst, 2, 'the other admitted dossiers wait in the queue');
    assert.equal(plain.second.backfill, 2, 'the next reply takes the next 2');
    assert.equal(plain.queued, 0);
    const hosted = runCalls('hosted-crowd', true, crowd);
    assert.equal(hosted.admitted, 4);
    assert.deepEqual([hosted.first.backfill, hosted.second.backfill], [1, 1], 'hosted one-pass: one backfill per reply (batch D)');
    assert.equal(hosted.queued, 2, 'the rest wait their turn');
});

test('hosted one-pass: the backfill runs on the reply, the catch-up Refresh on its own schedule', () => {
    const result = runCalls('hosted-catch-up', true, async ({ reply, settings }) => {
        settings.narrationCaptureCatchUp = 2;
        const first = await reply('Yunyun waves from the gate.',
            { npcs: [{ name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'persistent', dossierReason: 'named', directInteraction: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        const second = await reply('Yunyun smiles at Kazuma.', { npcs: [{ name: 'Yunyun', present: true, relationshipImpact: 'none', relationshipDelta: ZERO }] });
        return { first: first.all, second: second.all, queued: globalThis.NPCStateDelta.getState().pendingBackfills.length };
    });
    assert.equal(result.first.backfill, 1, 'the new person is backfilled on the reply');
    assert.equal(result.second.refresh, 1, 'the catch-up Refresh of the second captured reply');
    assert.equal(result.second.backfill, 0, 'nothing left to backfill');
    assert.equal(result.queued, 0);
});

// (ONEPASSCAP) The owner's hosted one-pass chat (12 Nov, payloads main-reply-1755 and nsd-scans-1840): Sieke and Sister Temiwa first appear
// in a reply whose block admits them (no memories, profileUpdates keyed by ids the model guessed); Sieke's new-admission backfill answers with
// a looks fill, ONE keyRelationships string and from/to edges with an underscore id; the next reply's block (the 1755 shape: existing ids,
// a new memory, an appearance change with evidence) must be in the dossier after the reply, without a Refresh.
const onePassCapture = async ({ reply, mockState, sleep }) => {
    const BASE = 'Human woman, ~20, petite build, round cheeks, remarkably large bust';
    mockState.quietResponder = async (args = {}) => {
        const asked = String(args.prompt || '').match(/^Requested NPC: (.+)$/m)?.[1];
        if (asked === 'Sieke') {
            return JSON.stringify({
                npcs: [{ id: 'npc_sieke', name: 'Sieke', present: true, overallAppearance: `${BASE}. Dark hair, wide brown eyes.`,
                    memories: ['Registered Astra at the guild desk while Sister Temiwa watched from the door.'],
                    keyRelationships: 'Sister Temiwa — Church novice who brings her supper | Drops off bread at the guild every evening',
                    relationshipImpact: 'none', relationshipDelta: ZERO }],
                profileUpdates: [],
                keyRelationshipEdges: [{ from: 'npc_sieke', to: 'npc_sister_temiwa', aToB: 'friend', bToA: 'friend' }],
            });
        }
        return asked ? JSON.stringify({ npcs: [{ name: asked, present: true, relationshipImpact: 'none', relationshipDelta: ZERO }] }) : '{"npcs":[]}';
    };
    const pick = id => {
        const npc = globalThis.NPCStateDelta.getState().npcs.find(item => item.id === id) || null;
        return npc && { id: npc.id, name: npc.name, overallAppearance: npc.overallAppearance, appearance: npc.appearance, memories: npc.memories,
            keyRelationships: npc.keyRelationships, mannerisms: npc.mannerisms, evidence: npc.profileEvidence };
    };
    const first = await reply('A petite clerk, Sieke, round-cheeked, with a remarkably large bust, sits at the guild desk in an ink-stained linen bodice with strained laces, a frayed grey wool skirt and scuffed leather slippers. She chews her quill. Sister Temiwa, a weary church novice in a grey habit, waits by the door.', {
        npcs: [
            { name: 'Sieke', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'the guild clerk Astra deals with', sameIndividual: false, directInteraction: true, present: true, worldActive: false,
                role: 'Guild registration clerk', species: 'Human', gender: 'female', apparentAge: '~20', overallAppearance: BASE,
                appearance: 'An ink-stained linen bodice with strained laces, a frayed grey wool skirt, and scuffed leather slippers.', mood: 'flustered', relationshipImpact: 'none', relationshipDelta: ZERO },
            { name: 'Sister Temiwa', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'church novice', sameIndividual: false, directInteraction: true, present: true, worldActive: false,
                role: 'Church novice', species: 'Human', gender: 'female', mood: 'weary', relationshipImpact: 'none', relationshipDelta: ZERO },
        ],
        profileUpdates: [{ id: 'npc_sieke', evidence: { mannerisms: ['She chews her quill.'] } }],
        keyRelationshipEdges: [],
    });
    await sleep(300);
    const afterFirst = { sieke: pick('npc_sieke'), temiwa: pick('npc_sister-temiwa'), backfills: first.all.backfill };
    const second = await reply('Astra paid the fifty copper registration fee in silver coin without arguing. Sieke lunged for the coins and her bodice button snapped, exposing her bare breasts in front of Astra; she clutched the bodice shut with one arm and threw contracts at him in mortification. Sister Temiwa answered his polite question about the village\'s shortage of hands.', {
        npcs: [
            { id: 'npc_sieke', mood: 'mortified and flustered', moodState: 'replace', moodV: -2, moodA: 3, moodD: -2, present: true, relationshipImpact: 'ordinary',
                relationshipDelta: { trust: 1, affection: 0, desire: 0, tension: 2 },
                relationshipEvidence: { trust: 'Astra paid the fifty copper registration fee in silver coin without arguing.', affection: '', desire: '', tension: 'Her bodice button snapped while lunging for the coins, exposing her bare breasts in front of Astra before she threw contracts at him in mortification.' },
                memories: ['Her bodice button snapped as she lunged for Astra\'s silver, exposing her breasts in front of him.'] },
            { id: 'npc_sister-temiwa', mood: 'flustered and weary', present: true, relationshipImpact: 'ordinary', relationshipDelta: { trust: 1, affection: 0, desire: 0, tension: 0 },
                relationshipEvidence: { trust: 'Astra greeted her politely and asked about the village\'s shortage of hands before registering.', affection: '', desire: '', tension: '' } },
        ],
        profileUpdates: [{ id: 'npc_sieke', evidence: { appearance: ['her bodice button snapped', 'she clutched the bodice shut with one arm'] },
            appearanceState: 'change', appearanceReason: 'Her bodice button snapped while she lunged for the coins.',
            appearance: 'An ink-stained linen bodice with a snapped button, clutched shut with one arm; a frayed grey wool skirt and scuffed leather slippers.' }],
        keyRelationshipEdges: [{ from: 'npc_sister_temiwa', to: 'Sieke', aToB: 'friend', bToA: 'friend' }],
        relationshipsCovered: true,
    });
    await sleep(300);
    return { afterFirst, afterSecond: { sieke: pick('npc_sieke'), temiwa: pick('npc_sister-temiwa'), calls: second.all } };
};

test('ONEPASSCAP: a hosted one-pass reply\'s memory, appearance change and evidence, and the admission backfill\'s fill, ties and edges, are in the dossier without a Refresh', async () => {
    const result = runCalls('hosted-onepass-capture', true, onePassCapture);
    const { afterFirst, afterSecond } = result;
    const { fillWanted } = await import('../appearance-fill.js');
    assert.ok(afterFirst.sieke && afterFirst.temiwa, 'both admitted from the block');
    assert.equal(afterFirst.backfills, 1, 'one backfill on the reply (hosted one-pass)');
    assert.match(afterFirst.sieke.overallAppearance, /Dark hair, wide brown eyes\.$/, 'the fill\'s hair and eyes are stored after the base');
    assert.ok(afterFirst.sieke.memories.some(text => /guild desk/.test(text)), 'the backfill\'s memory is stored');
    assert.ok(afterFirst.sieke.keyRelationships.some(text => /Sister Temiwa/.test(text)), 'the one-string keyRelationships is read');
    assert.ok(afterSecond.sieke.memories.some(text => /bodice button snapped/.test(text)), 'the one-pass memory is stored');
    assert.match(afterSecond.sieke.appearance, /snapped button/, 'the grounded appearance change is stored');
    assert.match(afterSecond.sieke.overallAppearance, /Dark hair, wide brown eyes\.$/, 'a later reply keeps the fill');
    assert.equal(fillWanted(afterSecond.sieke), false, 'nothing left to fill: a later Refresh sends no fill line, so it cannot invent other hair or eyes');
    assert.ok(afterSecond.temiwa.keyRelationships.some(text => /^Sieke — friend/.test(text)), 'a from/to edge with an underscore id reaches both dossiers');
    assert.ok(afterSecond.sieke.keyRelationships.some(text => /^Sister Temiwa — /.test(text)));
});

test('ONEPASSCAP-2/3: one keyRelationships string is one entry per line; an edge endpoint resolves by exact id, folded id, then name', async () => {
    const { normalizeScanNpc, mergeScanResult } = await import('../core.js');
    const { resolveNpcId, resolveNpcReference } = await import('../social.js');
    const one = 'Sister Temiwa — Church novice who brings her supper | Drops off bread at the guild every evening';
    assert.deepEqual(normalizeScanNpc({ name: 'Sieke', keyRelationships: one }).keyRelationships, normalizeScanNpc({ name: 'Sieke', keyRelationships: [one] }).keyRelationships, 'the string reads as the one-entry list');
    assert.equal(normalizeScanNpc({ name: 'Sieke', keyRelationships: `${one}\nMarrit — employer | strict` }).keyRelationships.length, 2, 'one entry per line');
    assert.deepEqual(normalizeScanNpc({ name: 'Sieke', keyRelationships: ['Marrit — employer'] }).keyRelationships, ['Marrit — employer'], 'a list reads as before');
    assert.deepEqual(normalizeScanNpc({ name: 'Sieke', keyRelationships: '  ' }).keyRelationships, []);
    const npcs = [{ id: 'npc_sieke', name: 'Sieke' }, { id: 'npc_sister-temiwa', name: 'Sister Temiwa' }];
    assert.equal(resolveNpcId(npcs, 'npc_sister-temiwa')?.name, 'Sister Temiwa', 'exact');
    assert.equal(resolveNpcId(npcs, 'NPC_Sister_Temiwa')?.name, 'Sister Temiwa', 'hyphen, underscore and case folded');
    assert.equal(resolveNpcId(npcs, 'Sister Temiwa'), null, 'a name is not an id');
    assert.equal(resolveNpcId([...npcs, { id: 'npc_sister_temiwa', name: 'Another Temiwa' }], 'npc_sister_temiwa')?.name, 'Another Temiwa', 'an exact id wins over a fold');
    assert.equal(resolveNpcId([{ id: 'npc_a-b', name: 'A' }, { id: 'npc_a_b', name: 'B' }], 'NPC_A_B'), null, 'two folded matches: none');
    assert.equal(resolveNpcReference(npcs, 'Sister Temiwa')?.id, 'npc_sister-temiwa', 'then the name');
    const state = { npcs: [{ id: 'npc_sieke', name: 'Sieke', keyRelationships: [] }, { id: 'npc_sister-temiwa', name: 'Sister Temiwa', keyRelationships: [] }], candidates: [] };
    const merged = mergeScanResult(state, { npcs: [], keyRelationshipEdges: [{ from: 'npc_sieke', to: 'npc_sister_temiwa', aToB: 'friend', bToA: 'friend' }] }, {});
    const ties = id => merged.state.npcs.find(npc => npc.id === id).keyRelationships;
    assert.ok(ties('npc_sieke').some(text => /^Sister Temiwa — friend/.test(text)), 'from = an exact id held in the label slot');
    assert.ok(ties('npc_sister-temiwa').some(text => /^Sieke — friend/.test(text)), 'to = an underscore id for the hyphen id');
    const guessed = mergeScanResult(state, { npcs: [], profileUpdates: [{ id: 'npc_sister_temiwa', evidence: { mannerisms: ['She tucks her hands into her sleeves.'] } }] }, {});
    assert.deepEqual(guessed.state.npcs.find(npc => npc.id === 'npc_sister-temiwa').profileEvidence.mannerisms, ['She tucks her hands into her sleeves.'], 'a profile update keyed by the guessed underscore id reaches the dossier');
    const unknown = mergeScanResult(state, { npcs: [], keyRelationshipEdges: [{ from: 'npc_sieke', to: 'npc_nobody', aToB: 'friend', bToA: 'friend' }] }, {});
    assert.deepEqual(unknown.state.npcs.find(npc => npc.id === 'npc_sieke').keyRelationships, [], 'an id that resolves to no one is never written as a tie\'s name');
    const named = mergeScanResult(state, { npcs: [], keyRelationshipEdges: [{ aId: 'npc_sieke', b: 'Marrit', aToB: 'employer' }] }, {});
    assert.ok(named.state.npcs.find(npc => npc.id === 'npc_sieke').keyRelationships.some(text => /^Marrit — employer/.test(text)), 'a person without a dossier is still written by name, as before');
});
