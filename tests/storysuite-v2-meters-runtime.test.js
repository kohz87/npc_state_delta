import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// NPC meters (F81, F90) with Delta's real runtime: the established synthetic host (runtime-smoke.mjs)
// loads Delta, alone or beside a fake Story Block v2 global, and runs the same turns. Hosted, a
// scan's relationship change is sent to the host as npc.adjust and the injection reads the slice's
// numbers; without a host nothing is sent and the sidecar and the injection are the same as hosted
// (the slice never writes back into Delta's own data).

const TRY_MARKER = '\ntry {\n    await import(pathToFileURL(path.join(extRoot, \'index.js\'))';

function runHostScenario(name, prelude, scenario) {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const cut = source.indexOf(TRY_MARKER);
    if (cut < 0) throw new Error('Runtime smoke import marker changed');
    const script = `${source.slice(0, cut)}
globalThis.document.documentElement = { dataset: {} };
globalThis.document.readyState = 'loading';
// index.js imports the adapter from src/ at runtime, as the package ships it.
fs.cpSync(path.join(sourceRoot, 'src'), path.join(extRoot, 'src'), { recursive: true });
mockState.storyBlockTabs = [];
// Every request for one of Delta's chat sidecars, and what the server answered.
mockState.sidecarReads = [];
const sidecarFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
    const response = await sidecarFetch(url, options);
    if (typeof url === 'string' && /^\\/user\\/files\\/npc-state-delta-[^/]*\\.json$/.test(url)) mockState.sidecarReads.push({ url, status: response.status });
    return response;
};
const misses = () => mockState.sidecarReads.filter(read => read.status === 404).length;
async function turn(text) {
    mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'And then?' });
    const userId = mockState.context.chat.length - 1;
    await Promise.all((mockState.listeners.get('message_sent') || []).map(fn => fn(userId)));
    mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
    const id = mockState.context.chat.length - 1;
    await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
    await Promise.all((mockState.listeners.get('character_message_rendered') || []).map(fn => fn(id)));
    await sleep(150);
    return id;
}
// Chat events that make Delta check its sidecar without writing anything; the reads they made.
async function quietEvents() {
    const before = mockState.sidecarReads.length;
    const uploads = mockState.uploadCalls;
    for (const name of ['chat_loaded', 'chat_changed', 'message_edited', 'message_swiped']) {
        await Promise.all((mockState.listeners.get(name) || []).map(fn => fn(0)));
        await sleep(250);
    }
    assert.equal(mockState.uploadCalls, uploads, 'these events write nothing');
    return mockState.sidecarReads.slice(before);
}
const turns = ${turns.toString()};
await (${prelude.toString()})();
try {
    await import(pathToFileURL(path.join(extRoot, 'index.js')).href + \`?t=\${Date.now()}\`);
    await sleep(30);
    eventSource.emit('app_ready');
    eventSource.emit('extension_settings_loaded');
    await sleep(30);
    await import(pathToFileURL(path.join(extRoot, 'story-block-tabs.js')).href);
    await sleep(30);
    await (${scenario.toString()})();
    console.log('story suite v2 meters scenario ${name} passed');
} finally {
    for (const handle of pendingHostTimers) nativeClearTimeout(handle);
    pendingHostTimers.clear();
    delete globalThis.__npcMock;
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
`;
    try {
        return execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
            input: script, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr || '');
        const detail = stderr.split('\n').filter(line => /Error|assert|expected|actual/i.test(line)).slice(0, 30).join('\n');
        throw new Error(`scenario ${name} failed:\n${detail || stderr.slice(-4000)}`);
    }
}


// The same two turns in every scenario: Yunyun arrives, then trusts Kazuma with a secret.
const turns = async () => {
    const api = globalThis.NPCStateDelta;
    const arrive = { name: 'Yunyun', present: true, role: 'adventurer', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } };
    mockState.quietResponder = async () => JSON.stringify({ npcs: [arrive] });
    await turn('Yunyun waves from the gate.');
    await sleep(200);
    const confide = {
        ...arrive, relationshipImpact: 'meaningful', relationshipDelta: { trust: 2, affection: 0, desire: 0, tension: 0 },
        relationshipEvidence: { trust: 'Yunyun confided a private secret and trusted Kazuma with it.', affection: '', desire: '', tension: '' },
        relationshipChangeReason: 'Yunyun confided a private secret to Kazuma.',
    };
    mockState.quietResponder = async args => {
        const id = api.getState().npcs.find(npc => npc.name === 'Yunyun')?.id;
        return JSON.stringify({ npcs: [{ ...confide, ...(id ? { id } : {}) }] });
    };
    const id = await turn('Yunyun confided a private secret and trusted Kazuma with it, whispering by the gate.');
    await sleep(300);
    const yunyun = api.getState().npcs.find(npc => npc.name === 'Yunyun');
    return { id, relationship: yunyun?.relationship ?? null };
};

function scenarioOutput(output) {
    const line = String(output).split('\n').find(text => text.startsWith('RESULT '));
    assert.ok(line, 'the scenario printed its result');
    return JSON.parse(line.slice(7));
}

test('hosted: a scan\'s relationship change goes to the slice as npc.adjust; the injection reads the slice', () => {
    const output = runHostScenario('meters-hosted', async () => {
        const sdk = {
            registered: [], sent: [], entries: [],
            registerModule(def) { sdk.registered.push(def); },
            command: async (type, payload, options) => { sdk.sent.push({ type, payload, options: options ?? null }); return { ok: true, receipt: { summary: '' } }; },
            query: name => (name === 'npc.meters' ? structuredClone(sdk.entries) : null),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, async () => {
        const api = globalThis.NPCStateDelta;
        assert.ok(await waitFor(() => mockState.sdk.registered.length === 1));
        const { id, relationship } = await turns();
        assert.ok(relationship && relationship.trust > 0, `the scan changed Yunyun's trust (${JSON.stringify(relationship)})`);
        assert.ok(await waitFor(() => mockState.sdk.sent.length >= 1), 'a command was sent');
        const sent = mockState.sdk.sent.filter(item => item.type === 'npc.adjust');
        assert.equal(sent.length, 1, JSON.stringify(mockState.sdk.sent));
        assert.equal(sent[0].payload.name, 'Yunyun');
        assert.deepEqual(sent[0].payload.meters, { trust: relationship.trust });
        assert.deepEqual(sent[0].payload.start, { trust: 0, affection: 0, desire: 0, tension: 0 });
        assert.equal(sent[0].payload.reply, id);
        assert.equal(sent[0].options, null, 'sent as Delta\'s own action (cause ui)');
        const injectionBefore = api.injectionPreview().text;
        // The slice says otherwise: views and the injection follow it, Delta's own data does not.
        mockState.sdk.entries = [{ key: 'yunyun', name: 'Yunyun', meters: { trust: 88, affection: 0, desire: 0, tension: 0 }, stages: {}, unlocked: [] }];
        assert.equal(api.getDossierState().npcs.find(npc => npc.name === 'Yunyun').relationship.trust, 88);
        assert.equal(api.getState().npcs.find(npc => npc.name === 'Yunyun').relationship.trust, relationship.trust, 'the sidecar keeps its own numbers');
        api.render();
        await turn('Yunyun nods.');
        await sleep(200);
        assert.notEqual(api.injectionPreview().text, injectionBefore);
        assert.match(api.injectionPreview().text, /strong trust/);
        console.log('RESULT ' + JSON.stringify({ relationship, injection: injectionBefore }));
    });
    assert.ok(scenarioOutput(output).relationship.trust > 0);
});

test('without a v2 host the same turns send nothing, and the sidecar and the injection are the same as hosted', () => {
    const run = (name, prelude) => scenarioOutput(runHostScenario(name, prelude, async () => {
        const api = globalThis.NPCStateDelta;
        await sleep(200);
        const { relationship } = await turns();
        const yunyun = api.getState().npcs.find(npc => npc.name === 'Yunyun');
        assert.equal(api.getDossierState().npcs.find(npc => npc.name === 'Yunyun').relationship.trust, yunyun.relationship.trust, 'the dossier view shows the sidecar numbers');
        console.log('RESULT ' + JSON.stringify({
            relationship,
            sent: mockState.sdk?.sent?.length ?? 0,
            hosted: globalThis.document.documentElement.dataset.npcStateDeltaStoryBlockV2 ?? null,
            injection: api.injectionPreview().text,
            lastChange: { ...yunyun.lastRelationshipChange, at: undefined },
            milestones: yunyun.relationshipMilestones,
        }));
    }));
    const alone = run('meters-alone', async () => {});
    // A host whose slice has no entries yet: Delta forwards the change, everything it shows is its own.
    const hosted = run('meters-empty-slice', async () => {
        const sdk = { registered: [], sent: [], registerModule(def) { sdk.registered.push(def); }, command: async (type, payload) => { sdk.sent.push({ type, payload }); return { ok: true }; }, query: () => [], settings: () => ({}) };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    });
    assert.equal(alone.hosted, null);
    assert.equal(alone.sent, 0, 'nothing is sent without a host');
    assert.equal(hosted.hosted, '1');
    assert.equal(hosted.sent, 1);
    assert.ok(alone.relationship.trust > 0);
    assert.deepEqual(alone.relationship, hosted.relationship, 'the sidecar numbers follow v1 rules either way');
    assert.deepEqual(alone.lastChange, hosted.lastChange);
    assert.deepEqual(alone.milestones, hosted.milestones);
    assert.equal(alone.injection, hosted.injection, 'the injection is the same text');
});

test('index.js: the v2 meter hooks are the identity without a host', () => {
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    // Every hook asks storySuiteV2Meters() first, which is null unless the page flag is set and the adapter is hosted.
    assert.match(index, /function storySuiteV2Meters\(\) \{\n    return storyBlockV2Hosted\(\) && storySuiteV2\?\.hosted\?\.\(\) \? storySuiteV2 : null;\n\}/);
    assert.match(index, /function hostedMeterView\(npcs\) \{\n    const adapter = storySuiteV2Meters\(\);\n    if \(!adapter\) return npcs;/);
    assert.match(index, /function forwardRelationshipChangesToHost\(before, after, messageId\) \{\n    const adapter = storySuiteV2Meters\(\);\n    if \(!adapter\) return;/);
    assert.match(index, /function hostedSecretsEditorHtml\(npc\) \{\n    const adapter = storySuiteV2Meters\(\);\n    if \(!adapter\) return '';/);
    assert.match(index, /const secretsInput = hostedMeters \? document\.getElementById\(SECRETS_EDITOR_ID\) : null;/);
    assert.match(index, /if \(shownRelationship\) \{/);
    assert.equal((index.match(/forwardRelationshipChangesToHost\(/g) || []).length, 2, 'one hook, in the live scan\'s commit');
});

// The dossier editor: while hosted it shows the slice's numbers and a Hidden notes field, and saves
// edited numbers to the slice (npc.set) and the notes to the dossier; alone it is v1's editor.
const editorScenario = async () => {
    const api = globalThis.NPCStateDelta;
    await sleep(200);
    await manualAddNpc('Yunyun');
    await sleep(100);
    const yunyun = api.getState().npcs.find(npc => npc.name === 'Yunyun');
    await api.openEditor(yunyun.id);
    await sleep(30);
    const popup = mockState.popupCalls.at(-1);
    const html = String(popup.content?.innerHTML ?? popup.content ?? '');
    const values = new Map();
    for (const match of html.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"([^>]*)>/g)) values.set(match[1], { value: (match[2].match(/value="([^"]*)"/) || [])[1] ?? '', checked: /\bchecked\b/.test(match[2]) });
    for (const match of html.matchAll(/id="(npc_state_delta_edit_[a-z_]+)"[^>]*>([^<]*)<\/textarea>/g)) values.set(match[1], { value: match[2], checked: false });
    const shownTrust = values.get('npc_state_delta_edit_trust')?.value;
    const hasNotes = values.has('npc_state_delta_edit_secrets');
    values.set('npc_state_delta_edit_trust', { value: '45', checked: false });
    if (hasNotes) values.set('npc_state_delta_edit_secrets', { value: 'trust 40: She hides a map of the old mine.\nnonsense line', checked: false });
    const realGet = document.getElementById;
    document.getElementById = id => values.get(id) || null;
    await popup.complete(1);
    await sleep(150);
    document.getElementById = realGet;
    const saved = api.getState().npcs.find(npc => npc.name === 'Yunyun');
    console.log('RESULT ' + JSON.stringify({
        shownTrust, hasNotes, savedTrust: saved.relationship.trust, secrets: saved.secrets ?? null,
        sent: (mockState.sdk?.sent ?? []).map(({ type, payload }) => ({ type, payload })),
        injectionHasNote: api.injectionPreview().text.includes('old mine'),
    }));
};

test('the dossier editor: hosted, it edits the slice and the hidden notes; alone, it is unchanged', () => {
    const hosted = scenarioOutput(runHostScenario('meters-editor-hosted', async () => {
        const sdk = {
            registered: [], sent: [],
            entries: [{ key: 'yunyun', name: 'Yunyun', meters: { trust: 30, affection: 0, desire: 0, tension: 0 }, stages: {}, unlocked: [] }],
            registerModule(def) { sdk.registered.push(def); },
            command: async (type, payload) => { sdk.sent.push({ type, payload }); return { ok: true, receipt: { summary: '' } }; },
            query: name => (name === 'npc.meters' ? structuredClone(sdk.entries) : null),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    }, `async () => { const editorScenario = ${editorScenario.toString()}; await editorScenario(); }`));
    assert.equal(hosted.shownTrust, '30', 'the slice\'s number is shown');
    assert.equal(hosted.hasNotes, true);
    assert.equal(hosted.savedTrust, 0, 'Delta\'s own number is left as it was');
    assert.equal(hosted.secrets.length, 1, 'the unreadable line is not kept');
    assert.deepEqual({ meter: hosted.secrets[0].meter, at: hosted.secrets[0].at, text: hosted.secrets[0].text }, { meter: 'trust', at: 40, text: 'She hides a map of the old mine.' });
    assert.match(hosted.secrets[0].id, /^sec_[0-9a-z]{8}$/);
    assert.deepEqual(hosted.sent.map(item => item.type), ['npc.set', 'npc.refresh']);
    assert.equal(hosted.sent[0].payload.name, 'Yunyun');
    assert.deepEqual(hosted.sent[0].payload.meters, { trust: 45 });
    assert.equal(hosted.injectionHasNote, false, 'a locked note is never in Delta\'s injection');

    const alone = scenarioOutput(runHostScenario('meters-editor-alone', async () => {}, `async () => { const editorScenario = ${editorScenario.toString()}; await editorScenario(); }`));
    assert.equal(alone.shownTrust, '0');
    assert.equal(alone.hasNotes, false, 'no Hidden notes field without a host');
    assert.equal(alone.savedTrust, 45, 'v1: the editor sets Delta\'s own number');
    assert.equal(alone.secrets, null);
    assert.deepEqual(alone.sent, []);
});
