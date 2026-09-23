import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    createNpcRecord,
    mergeScanResult,
    normalizeNpcRecord,
    parseScanJson,
    setActiveCalendarConfig,
} from '../core.js';
import {
    decodeStateFilePayload,
    encodeRetiredStateFilePayload,
    encodeStateFilePayload,
} from '../storage.js';
import { npcParticipatesInExchange } from '../scan-context.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const readSource = name => fs.readFileSync(path.join(root, name), 'utf8');

test.afterEach(() => setActiveCalendarConfig(null));

test('scanner parser rejects empty schema-incomplete JSON while preserving substantive profile-only output', () => {
    assert.throws(() => parseScanJson('{}'), /required npcs array/i);
    assert.throws(() => parseScanJson('{"npcs":{}}'), /required npcs array/i);
    assert.throws(() => parseScanJson({}), /required npcs array/i);
    assert.throws(() => parseScanJson({ profileUpdates: [] }), /required npcs array/i);
    assert.deepEqual(parseScanJson('{"npcs":[]}').npcs, []);
    const profileOnly = parseScanJson({ profileUpdates: [{ id: 'npc_mira', speechState: 'refine', speech: 'Formal.' }] });
    assert.deepEqual(profileOnly.npcs, []);
    assert.equal(profileOnly.profileUpdates.length, 1);
});

test('automatic gender establishment and correction require target-grounded story evidence', () => {
    const npc = createNpcRecord('Mira');
    let result = mergeScanResult({ npcs: [npc], candidates: [], turn: 1 }, {
        npcs: [{ id: npc.id, name: npc.name, gender: 'female' }],
    }, { turn: 2, developmentContext: 'Mira continues her work at the inn.' });
    assert.equal(result.state.npcs[0].gender, '', 'provider-only gender must not establish canon');

    result = mergeScanResult(result.state, {
        npcs: [{ id: npc.id, name: npc.name, gender: 'female' }],
    }, { turn: 3, developmentContext: 'Mira is a woman serving at the inn.' });
    assert.equal(result.state.npcs[0].gender, 'female');

    result = mergeScanResult(result.state, {
        npcs: [{
            id: npc.id,
            name: npc.name,
            gender: 'male',
            genderState: 'correct',
            genderReason: 'Correction.',
        }],
    }, { turn: 4, developmentContext: 'Mira continues her work at the inn.' });
    assert.equal(result.state.npcs[0].gender, 'female', 'fabricated correction metadata must not flip canon');

    result = mergeScanResult(result.state, {
        npcs: [{
            id: npc.id,
            name: npc.name,
            gender: 'male',
            genderState: 'correct',
            genderReason: 'The earlier record was wrong.',
        }],
    }, { turn: 5, developmentContext: 'The earlier record was wrong: Mira is a man.' });
    assert.equal(result.state.npcs[0].gender, 'male');
});

test('candidate gender cannot flip silently before promotion', () => {
    let state = { npcs: [], candidates: [], turn: 1 };
    state = mergeScanResult(state, {
        npcs: [{
            name: 'Barmaid',
            identityKind: 'role_label',
            dossierSignal: 'incidental',
            gender: 'female',
            present: true,
        }],
    }, { turn: 2, developmentContext: 'The Barmaid is a woman serving at the counter.' }).state;
    assert.equal(state.candidates[0]?.gender, 'female');

    const promoted = mergeScanResult(state, {
        npcs: [{
            name: 'Barmaid',
            identityKind: 'role_label',
            dossierSignal: 'incidental',
            sameIndividual: true,
            gender: 'male',
            present: true,
        }],
    }, { turn: 3, developmentContext: 'The Barmaid serves another mug of ale.' }).state;
    assert.equal(promoted.npcs.length, 1);
    assert.equal(promoted.npcs[0].gender, 'female');
});

test('ready gradual Speech evolution cannot carry an unsupported extra claim', () => {
    const npc = createNpcRecord('Marris');
    npc.speech = 'Formal and restrained.';
    const candidate = 'Formal and restrained; gives concise conclusion-first explanations; fluent in ancient Celestial.';
    let state = { npcs: [npc], candidates: [], turn: 9 };
    const update = evidence => ({
        npcs: [],
        profileUpdates: [{
            id: npc.id,
            evidence: { speech: [evidence] },
            speechState: 'evolve',
            speech: candidate,
            speechReason: 'Repeated scenes establish concise conclusion-first explanations.',
            developmentScale: 'gradual',
            developmentReason: 'Repeated scenes establish concise conclusion-first explanations.',
        }],
    });

    state = mergeScanResult(state, update('directness: gives the conclusion first before a concise explanation'), {
        turn: 10,
        sourceMessageId: 100,
        developmentContext: 'Marris gives the conclusion first before a concise explanation.',
    }).state;
    const second = mergeScanResult(state, update('delivery: again leads with the conclusion before a concise explanation'), {
        turn: 12,
        sourceMessageId: 102,
        developmentContext: 'Marris again leads with the conclusion before a concise explanation.',
    });
    assert.equal(second.state.npcs[0].speech, 'Formal and restrained.');
    assert.ok((second.state.npcs[0].profileEvidence?.speech || []).length >= 1);
});

test('alias consolidation preserves newer stable identity fields and hidden-card preference', () => {
    const thunderbird = createNpcRecord('Thunderbird');
    thunderbird.identityKind = 'role_label';
    thunderbird.createdAt = 100;
    const mina = createNpcRecord('Mina');
    mina.aliases = ['Thunderbird'];
    mina.identityKind = 'proper_name';
    mina.createdAt = 200;
    mina.updatedAt = 200;
    mina.gender = 'female';
    mina.homeBase = 'Fordhouse Inn';
    mina.minor = true;

    const result = mergeScanResult({ npcs: [thunderbird, mina], candidates: [], turn: 1 }, { npcs: [] }, {
        turn: 2,
        preservePresence: true,
    });
    assert.equal(result.state.npcs.length, 1);
    assert.equal(result.state.npcs[0].gender, 'female');
    assert.equal(result.state.npcs[0].homeBase, 'Fordhouse Inn');
    assert.equal(result.state.npcs[0].minor, true);
});

test('non-retired sidecars require the canonical NPC roster while retired tombstones stay valid', () => {
    const valid = decodeStateFilePayload(encodeStateFilePayload('chat:test', { npcs: [] }));
    assert.deepEqual(valid.state.npcs, []);
    const partial = JSON.parse(encodeStateFilePayload('chat:test', { npcs: [] }));
    partial.state = {};
    assert.throws(() => decodeStateFilePayload(JSON.stringify(partial)), /canonical NPC roster/i);
    assert.equal(decodeStateFilePayload(encodeRetiredStateFilePayload('chat:test')).retired, true);
});

test('yearless birthday fallback is bound to the named NPC rather than every same-date dossier', () => {
    setActiveCalendarConfig({
        era: 'CR',
        months: [
            { name: 'Redleaf', days: 30 },
            { name: 'Sunwane', days: 31 },
        ],
    });
    const ryu = normalizeNpcRecord({
        id: 'npc_ryu',
        name: 'Ryu',
        age: '13',
        apparentAge: '~13',
        birthDate: { month: 'Redleaf', day: 16 },
        birthDateSource: 'established',
    });
    const sora = normalizeNpcRecord({
        id: 'npc_sora',
        name: 'Sora',
        age: '13',
        apparentAge: '~13',
        birthDate: { month: 'Redleaf', day: 16 },
        birthDateSource: 'established',
    });
    const result = mergeScanResult({
        npcs: [ryu, sora],
        candidates: [],
        turn: 20,
    }, {
        npcs: [
            { id: ryu.id, name: ryu.name, age: '13', ageState: 'keep' },
            { id: sora.id, name: sora.name, age: '13', ageState: 'keep' },
        ],
    }, {
        sourceMessageId: 21,
        developmentContext: '<World_State>Time | CR822, Redleaf 16 | evening</World_State> Ryu celebrates her nameday feast.',
    });
    assert.equal(result.state.npcs.find(npc => npc.id === ryu.id)?.age, '14');
    assert.equal(result.state.npcs.find(npc => npc.id === sora.id)?.age, '13');
});

test('plain roster/status lines cannot authorize missed-participant repair', () => {
    const astra = { id: 'astra', name: 'Astra Vale', aliases: [], role: 'registrar' };
    assert.equal(npcParticipatesInExchange(astra, [astra], 'NPCs Present: Astra Vale'), false);
    assert.equal(npcParticipatesInExchange(astra, [astra], '- NPC Status: Astra Vale | present'), false);
    assert.equal(npcParticipatesInExchange(astra, [astra], 'Astra Vale closes the ledger.'), true);
});

test('targeted runtime paths require target identity and do not grant dossier blocks user authority', () => {
    const source = readSource('index.js');
    assert.doesNotMatch(source, /returned\.length === 1 \? returned\[0\]/);
    assert.doesNotMatch(source, /rawProfileUpdates\.length === 1 \? rawProfileUpdates\[0\]/);
    const dossierStart = source.indexOf('async function scanNpcDossier');
    const dossierEnd = source.indexOf('function setNpcChatRefreshIndicator', dossierStart);
    const dossierBody = source.slice(dossierStart, dossierEnd);
    assert.doesNotMatch(dossierBody, /userDevelopmentContext:\s*sourceText/);
    assert.match(source, /fullScanMode:\s*fullWindowScan/);
    assert.match(source, /historyScanMode:\s*manual/);
});

test('full-cast and Stage 8 UI guards cover audited ownership and continuity gaps', () => {
    const fullCast = readSource('full-cast.js');
    const tools = readSource('dossier-tools.js');
    const portrait = readSource('portrait-tools.js');
    const experience = readSource('dossier-experience.js');
    const dossier = readSource('dossier-ui.js');

    assert.match(fullCast, /gender:\s*npc\.gender/);
    assert.match(fullCast, /homeBase:\s*npc\.homeBase/);
    assert.match(fullCast, /function exchangeStillCurrent/);
    assert.match(fullCast, /current\.text === exchange\.text/);

    assert.match(tools, /diagnosticAction && !currentSessionIs\(session\)/);
    assert.match(portrait, /Saving portrait seed…'\);/);
    assert.match(portrait, /Preparing generated preview…'.*allowClose: true/);
    assert.match(portrait, /Applying generated preview through the canonical portrait handler…'\);/);

    assert.match(experience, /npc_state_delta_edit_gender/);
    assert.match(experience, /diagnosticOpenSummaryKeys/);
    assert.match(dossier, /event\.key !== 'Tab'/);
    assert.match(dossier, /focusable\[focusable\.length - 1\]/);
});
