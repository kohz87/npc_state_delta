import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKFILL_RESPONSE_LENGTH, JSON_RETRY_RESPONSE_LENGTH, SCAN_RESPONSE_LENGTH, compactRetryPrompt, generateParsedNpcJson, isTruncatedScannerJsonError, salvageScannerJson } from '../src/scanner-request.js';
import { parseScanJson } from '../core.js';
import { runtimeSource } from './helpers/runtime-source.js';

// Cleanup step 10: the scanner request moved from index.js to src/scanner-request.js unchanged.

const scope = { route: { profileId: '' }, isCurrent: () => true };

test('one request through the dispatcher, parsed; a malformed reply is retried once compactly', async () => {
    const calls = [];
    const replies = ['{"npcs":[{"name":"Mira"', '{"npcs":[{"name":"Mira"}]}'];
    const ctx = { generateRaw: async options => { calls.push(options); return replies.shift(); } };
    const out = await generateParsedNpcJson(ctx, { systemPrompt: 'S', prompt: 'P', responseLength: SCAN_RESPONSE_LENGTH, label: 'chat refresh for Mira', requestScope: scope });
    assert.deepEqual(out.parsed.npcs, [{ name: 'Mira' }]);
    assert.equal(out.retried, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /^P\n\nCRITICAL COMPACT JSON RETRY \(chat refresh for Mira\): /);
    assert.match(calls[1].prompt, /memories at most 5 distinct events/, 'a targeted label keeps its five-memory retry wording');
    assert.equal(calls[1].responseLength, JSON_RETRY_RESPONSE_LENGTH);
    assert.equal(compactRetryPrompt('P', 'dossier scan'), compactRetryPrompt('P', 'dossier scan', 'malformed'));
    assert.equal(isTruncatedScannerJsonError(new Error('Unexpected end of JSON input')), true);
    assert.equal(BACKFILL_RESPONSE_LENGTH, 3200);
});

test('a text reply twice is reported with a short excerpt', async () => {
    const ctx = { generateRaw: async () => 'I cannot help with that.' };
    await assert.rejects(generateParsedNpcJson(ctx, { systemPrompt: 'S', prompt: 'P', responseLength: 100, label: 'scan', requestScope: scope }),
        /received a text reply instead of JSON twice\. The provider\/model said: "I cannot help with that\."/);
});

test('index.js imports the request and keeps no copy', () => {
    const index = runtimeSource();
    assert.match(index, /import \{[^}]*\bgenerateParsedNpcJson\b[^}]*\} from '\.\/src\/scanner-request\.js';/);
    assert.doesNotMatch(runtimeSource(), /function (?:generateParsedNpcJson|compactRetryPrompt|isTruncatedScannerJsonError)\(/);
});

// rule NSDFOLLOW-1 (owner report 12 Nov ~17:50): the follow-up backfill reply for Roelof, verbatim from the proxy log. The model left the
// three mood-number keys' closing quotes off ("moodV:0,"moodA:-1,"moodD:0,), so JSON.parse read `"moodV:0,"` as a key and stopped.
const OWNER_FOLLOWUP_REPLY = "{\"npcs\":[{\"id\":\"npc_the-inspector\",\"name\":\"Roelof\",\"aliases\":[\"The inspector\"],\"identityKind\":\"proper_name\",\"role\":\"Quay Inspector\",\"species\":\"human\",\"gender\":\"male\",\"genderState\":\"keep\",\"homeBase\":\"Bluewatch quay\",\"homeBaseState\":\"update\",\"homeBaseReason\":\"durable workplace established where he inspects arrivals and manages river-gate entry records\",\"age\":\"\",\"ageState\":\"keep\",\"apparentAge\":\"\",\"apparentAgeState\":\"keep\",\"overallAppearance\":\"A stooped, weather-beaten human quay clerk with thin grey-streaked hair, pale watery eyes, and ink-stained fingers from long hours logging river traffic.\",\"appearance\":\"A wool coat with a brass tag stamped Roelof pinned to the lapel, holding a damp ledger and a pen.\",\"appearanceState\":\"refine\",\"personality\":\"Pragmatic, routine-bound frontier clerk who treats every arrival with weary suspicion and follows procedural questions without personal warmth.\",\"personalityState\":\"refine\",\"speech\":\"Flat, bureaucratic tone; \\\"Name. Where from. And what you\u2019re here for. Everybody\u2019s here for something this season.\\\"\",\"speechState\":\"refine\",\"behaviorProfile\":[\"Analytical: high - scrutinizes travelers, sticks, and faces before logging entries\",\"Disposition: low - strictly procedural and indifferent to drifters\"],\"behaviorProfileState\":\"refine\",\"mannerisms\":[\"Wetting his pen before recording answers into the damp ledger\"],\"mannerismState\":\"refine\",\"background\":\"Stationed at the Bluewatch river-gate to inspect arrivals, record identities and points of origin, and control passage beyond the chain.\",\"backgroundState\":\"update\",\"keyRelationships\":[],\"keyRelationshipsState\":\"keep\",\"relationshipSummary\":\"Indifferent, logged Astra's declared origins and permitted passage through the chain without incident.\",\"mood\":\"weary bureaucratic indifference\",\"moodState\":\"keep\",\"moodV:0,\"moodA:-1,\"moodD:0,\"location\":\"Bluewatch quay\",\"locationState\":\"keep\",\"goal\":\"record arrivals at the Bluewatch quay\",\"goalState\":\"keep\",\"status\":\"inspecting arrivals on the quay\",\"statusState\":\"keep\",\"lifeState\":\"alive\",\"lifeStateCertainty\":\"inferred\",\"lifeStateReason\":\"actively recording arrivals at the quay during arrival sequence\",\"memories\":[\"Logged Astra's arrival from Auvoth and waved him past the river-gate chain.\"],\"memoryRetention\":[\"Logged Astra's arrival from Auvoth and waved him past the river-gate chain.\"],\"present\":false,\"worldActive\":false,\"secrets\":[{\"title\":\"Bribe Tolerances\",\"text\":\"Roelof turns a blind eye to mismatched bond names if coin covers the discrepancy, knowing Grey Ledger agents watch the docks.\",\"meter\":\"trust\",\"at\":20},{\"title\":\"Ledger Duplicate\",\"text\":\"Keeps a side tally of unusual travelers bearing weapons or escorts to sell to local factions when tensions boil over.\",\"meter\":\"trust\",\"at\":45}]}]}";

test('rule NSDFOLLOW-1: the owner\'s follow-up reply with slipped key quotes is repaired field by field, without a retry, with a Problems line', async () => {
    assert.throws(() => parseScanJson(OWNER_FOLLOWUP_REPLY), /malformed JSON/, 'the older repairs alone cannot read it');
    const calls = [];
    const ctx = { generateRaw: async options => { calls.push(options); return OWNER_FOLLOWUP_REPLY; } };
    const warned = [];
    const warn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    let out;
    try { out = await generateParsedNpcJson(ctx, { systemPrompt: 'S', prompt: 'P', responseLength: BACKFILL_RESPONSE_LENGTH, label: 'backfill for The inspector', requestScope: scope }); } finally { console.warn = warn; }
    assert.equal(calls.length, 1, 'no JSON retry request');
    assert.equal(out.retried, false);
    assert.deepEqual(out.repairs, ['moodV (closing quote restored)', 'moodA (closing quote restored)', 'moodD (closing quote restored)']);
    assert.ok(warned.some(line => /^\[NPC State Delta\] Problems: backfill for The inspector returned JSON with broken keys; repaired without a retry: moodV \(closing quote restored\), moodA/.test(line)), warned.join('\n'));
    const [row] = out.parsed.npcs;
    assert.equal(out.parsed.npcs.length, 1);
    assert.deepEqual([row.moodV, row.moodA, row.moodD], [0, -1, 0], 'the model\'s own numbers, none invented');
    assert.equal(row.mood, 'weary bureaucratic indifference');
    assert.equal(row.location, 'Bluewatch quay', 'the key after the slips is read as a key again');
    assert.equal(row.present, false);
    assert.equal(row.secrets.length, 2, 'everything after the slip is kept');
    assert.equal(row.name, 'Roelof');
    // Every other field equals what the reply said, with only the three quotes put back.
    const fixed = OWNER_FOLLOWUP_REPLY.replace('"moodV:0,"moodA:-1,"moodD:0,"location"', '"moodV":0,"moodA":-1,"moodD":0,"location"');
    assert.deepEqual(out.parsed, JSON.parse(fixed));
});

test('rule NSDFOLLOW-1: similar key-quote slips are salvaged only where the parser stopped; an unreadable slipped value is dropped, never guessed', () => {
    const one = text => salvageScannerJson(text);
    assert.deepEqual(one('{"npcs":[{"name":"Mira","mood:"weary","moodV":1}]}').parsed.npcs[0], { name: 'Mira', mood: 'weary', moodV: 1 }, 'a quote that slipped onto the string value');
    assert.deepEqual(one('{"npcs":[{"name":"Mira",moodV":2,"moodA":0}]}').parsed.npcs[0], { name: 'Mira', moodV: 2, moodA: 0 }, 'a key missing its opening quote');
    const dropped = one('{"npcs":[{"name":"Mira","moodV:high,"moodA":1}]}');
    assert.deepEqual(dropped.parsed.npcs[0], { name: 'Mira', moodA: 1 }, 'the slipped key with a word for a number is dropped whole');
    assert.deepEqual(dropped.repairs, ['moodV (unreadable value, dropped)']);
    // Text inside a string is never touched: the same characters in a memory stay as written.
    assert.deepEqual(one('{"npcs":[{"memories":["time:5,","x"],"moodV:1,"moodA":0}]}').parsed.npcs[0], { memories: ['time:5,', 'x'], moodV: 1, moodA: 0 });
    assert.deepEqual(one('```json\n{"npcs":[{"name":"Mira","moodV:true,"a":1,}]}\n```').parsed.npcs[0], { name: 'Mira', moodV: true, a: 1 }, 'a fence and a trailing comma beside a slip');
    // A reply that parses, or that the older repairs read, is not this salvage's: null (parseScanJson reads it as before).
    assert.equal(one('{"npcs":[{"name":"Mira"}]}'), null);
    assert.equal(one('{npcs:[{name:"Guild Boy", present:true}]}'), null);
    assert.equal(one('{"npcs":[{"name":"Myla","appearance":"Young woman with dark'), null, 'a cut-off reply stays a retry');
    assert.equal(one('{"npcs":[{"name":"Mira","moodV:0"moodA":1}]}'), null, 'a slip with no comma is ambiguous: not guessed');
});

test('rule NSDFOLLOW-1: a reply the parser read before is read the same, with no repairs and no retry', async () => {
    const replies = ['{"npcs":[{"name":"Mira", }]}'];
    const ctx = { generateRaw: async () => replies.shift() };
    const out = await generateParsedNpcJson(ctx, { systemPrompt: 'S', prompt: 'P', responseLength: SCAN_RESPONSE_LENGTH, label: 'scan', requestScope: scope });
    assert.deepEqual(out, { parsed: { npcs: [{ name: 'Mira' }] }, raw: '{"npcs":[{"name":"Mira", }]}', retried: false });
});
