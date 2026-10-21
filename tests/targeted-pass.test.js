import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runEditorHostScenario } from './editor-host.mjs';

// Cleanup step 8: Refresh, backfill and the Megumin dossier import run one targeted pass. Fixed on the
// way: the stale rule (I-16: a reply another extension rewrote in place is still the source; an
// explicit edit or swipe still discards), isolation (I-17: no other dossier changes), receipts for
// every kind (I-19), backfill's two live-state fallbacks (C-3), Refresh's memory limit (I-14), and
// (v2 meters) the relationship forward from every targeted pass, and a hosted scan working from the
// slice's numbers.

const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('the three targeted passes share one runner', () => {
    for (const name of ['scanNpcDossier', 'refreshNpcFromChat', 'backfillNpcFromHistory']) {
        const start = index.indexOf(`async function ${name}(`);
        const body = index.slice(start, index.indexOf('\n}\n', start));
        assert.match(body, /return runTargetedDossierPass\(\{/, name);
        assert.doesNotMatch(body, /mergeScanResult\(|generateParsedNpcJson\(|commitBranchCheckpoint\(/, `${name} keeps no copy of the shared steps`);
    }
    const runner = index.slice(index.indexOf('async function runTargetedDossierPass'), index.indexOf('function scopeTargetedChannels'));
    assert.match(runner, /lineageMoved\(lineage, chatLineage\(getContext\(\)\.chat \|\| \[\]\), operation\.sourceMessageId\)/);
    assert.match(runner, /forwardRelationshipChangesToHost\(latest\.npcs, merged\.state\.npcs, targetMessageId, operation\.chatHead\)/);
    assert.match(runner, /recordScanDiagnostics\(chatKey, metrics, parsed, merged\.report/);
    assert.match(index, /\(I-14\) The Refresh prompt asks for at most three new memories \(rule 14\); its merge takes three\.\n\s*memoryInputLimit: 3,/);
});

test('targeted passes through the synthetic host: rewrite tolerance, memory limit, isolation and receipts', () => {
    runEditorHostScenario('targeted-pass', async () => {
        const runtime = globalThis.NPCStateDelta;
        const yunyunRow = extra => ({ name: 'Yunyun', present: true, role: 'adventurer', mood: 'calm', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, ...extra });
        const reply = async (user, text) => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: user });
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await sleep(250);
            return id;
        };
        mockState.quietResponder = async () => JSON.stringify({ npcs: [yunyunRow(), { name: 'Mira', present: true, role: 'innkeeper', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named innkeeper', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 } }] });
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'The guild hall is quiet.' });
        const last = await reply('Who is here?', 'Yunyun, the calm adventurer, and Mira the innkeeper wait at the gate. Yunyun says she grew up in the Crimson Demon village and once saved a lost lamb, chased a thief, fixed a wagon, sang at a wedding and found a silver key.');
        const npc = name => runtime.getDossierState().npcs.find(item => item.name === name);
        const yunyunId = npc('Yunyun').id;
        const miraBefore = structuredClone(runtime.getNpc(npc('Mira').id));

        // I-16: another extension rewrites the latest reply in place (no edit event) while Refresh runs.
        mockState.quietResponder = async () => {
            mockState.context.chat[last].mes = `${mockState.context.chat[last].mes}\n<!-- another extension's block -->`;
            return JSON.stringify({ npcs: [{ id: yunyunId, name: 'Yunyun', background: 'Grew up in the Crimson Demon village.',
                memories: ['Yunyun saved a lost lamb.', 'Yunyun chased a thief.', 'Yunyun fixed a wagon.', 'Yunyun sang at a wedding.', 'Yunyun found a silver key.'] }],
                keyRelationshipEdges: [{ aId: yunyunId, a: 'Yunyun', b: 'Mira', aToB: 'friend', bToA: 'friend', reason: 'They wait together at the gate.' }] });
        };
        assert.equal(await runtime.refreshFromChat(yunyunId), true, 'Refresh keeps a result whose reply was only rewritten in place');
        const refreshed = runtime.getNpc(yunyunId);
        assert.equal(refreshed.background, 'Grew up in the Crimson Demon village.');
        // I-14: the Refresh prompt asks for at most three new memories.
        assert.equal(refreshed.memories.length, 3, `Refresh adds at most three memories (${refreshed.memories.length})`);
        // I-17: the other dossier is untouched by the targeted pass.
        const miraAfter = runtime.getNpc(npc('Mira').id);
        const unrelated = record => Object.fromEntries(Object.entries(record).filter(([key]) => !['keyRelationships', 'updatedAt', 'fieldChanges', 'fieldChangeMessages', 'fieldChangeDays'].includes(key)));
        assert.deepEqual(unrelated(miraAfter), unrelated(miraBefore), 'Refresh changed nothing of Mira\'s own');
        assert.ok(miraAfter.keyRelationships.every(entry => miraBefore.keyRelationships.includes(entry) || /^Yunyun\b/.test(entry)), 'only the mirror of the target\'s own bond');

        // A manual add backfills; the backfill leaves a receipt (I-19) and changes no other dossier (I-17).
        mockState.quietResponder = async () => JSON.stringify({ npcs: [{ name: 'Neris', role: 'courier', present: false, background: 'A courier.' }],
            keyRelationshipEdges: [{ a: 'Neris', b: 'Mira', aToB: 'employer', bToA: 'courier', reason: 'Neris carries Mira\'s letters.' }] });
        mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: 'Neris, the courier, carries letters for Mira.' });
        const miraBeforeBackfill = structuredClone(runtime.getNpc(npc('Mira').id));
        await manualAddNpc('Neris');
        await sleep(400);
        assert.ok(npc('Neris'), 'the NPC was added');
        const miraAfterBackfill = runtime.getNpc(npc('Mira').id);
        assert.deepEqual(unrelated(miraAfterBackfill), unrelated(miraBeforeBackfill), 'the backfill changed nothing of Mira\'s own');
        assert.ok(miraAfterBackfill.keyRelationships.every(entry => miraBeforeBackfill.keyRelationships.includes(entry) || /^Neris\b/.test(entry)), 'only the mirror of the target\'s own bond');
        const types = runtime.diagnosticsRecords().map(row => row.type);
        assert.ok(types.includes('dossier-backfill'), `the backfill left a receipt (${types.join(', ')})`);
        assert.ok(types.includes('targeted-refresh'));
    });
});

test('a hosted scan scores relationship changes from the slice\'s numbers and forwards them from there', () => {
    runEditorHostScenario('hosted-scan-slice', async () => {
        const runtime = globalThis.NPCStateDelta;
        await sleep(400);
        assert.equal(globalThis.document.documentElement.dataset.npcStateDeltaStoryBlockV2, '1', 'hosted');
        const yunyunRow = extra => ({ name: 'Yunyun', present: true, role: 'adventurer', mood: 'calm', identityKind: 'proper_name', dossierSignal: 'high', dossierReason: 'named companion', directInteraction: true, relationshipImpact: 'none', relationshipDelta: { trust: 0, affection: 0, desire: 0, tension: 0 }, ...extra });
        let row = yunyunRow();
        mockState.quietResponder = async (args = {}) => {
            if (/isolated relationship evaluator/i.test(String(args.systemPrompt || ''))) {
                return JSON.stringify({ npcs: [{ id: runtime.getDossierState().npcs[0]?.id, name: 'Yunyun', relationshipImpact: 'meaningful', relationshipDelta: { trust: 3, affection: 0, desire: 0, tension: 0 }, relationshipEvidence: { trust: 'Yunyun thanks Kazuma warmly.', affection: '', desire: '', tension: '' }, relationshipChangeReason: 'Yunyun thanks Kazuma warmly.' }] });
            }
            return JSON.stringify({ npcs: [row] });
        };
        const reply = async (user, text) => {
            mockState.context.chat.push({ is_user: true, is_system: false, name: 'Kazuma', mes: user });
            mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: text, swipe_id: 0, swipes: [text] });
            const id = mockState.context.chat.length - 1;
            await Promise.all((mockState.listeners.get('message_received') || []).map(fn => fn(id)));
            await sleep(300);
        };
        mockState.context.chat.push({ is_user: false, is_system: false, name: 'Megumin', mes: 'The guild hall is quiet.' });
        await reply('Who is here?', 'Yunyun, the calm adventurer, waits.');
        // The reader set trust to 30 in the slice; the sidecar still says 0.
        mockState.sdk.entries = [{ key: 'yunyun', name: 'Yunyun', meters: { trust: 30, affection: 0, desire: 0, tension: 0 }, stages: {}, unlocked: [] }];
        assert.equal(runtime.getState().npcs[0].relationship.trust, 0);
        row = { name: 'Yunyun', present: true };
        mockState.sdk.sent.length = 0;
        await reply('Thanks for the help.', 'Yunyun thanks Kazuma warmly.');
        const adjust = mockState.sdk.sent.find(item => item.type === 'npc.adjust');
        assert.ok(adjust, 'the change was forwarded');
        assert.equal(adjust.payload.start.trust, 30, 'from the slice\'s number');
        assert.ok(adjust.payload.meters.trust > 0);
        assert.ok(runtime.getState().npcs[0].relationship.trust > 30, 'the sidecar follows the slice while hosted');
    }, { prelude: async () => {
        const sdk = {
            registered: [], sent: [], entries: [],
            registerModule(def) { sdk.registered.push(def); },
            command: async (type, payload) => { sdk.sent.push({ type, payload }); return { ok: true }; },
            query: name => (name === 'npc.meters' ? structuredClone(sdk.entries) : (name === 'scene.present' ? ['Yunyun'] : null)),
            settings: () => ({}),
        };
        mockState.sdk = sdk;
        globalThis.StoryBlock = { apiVersion: 2, ready: Promise.resolve(sdk), sdk };
    } });
});
