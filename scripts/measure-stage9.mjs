// Executes production builders, retry construction and both dispatcher routes with
// synthetic responses. It measures Delta-owned bytes, not host preset/provider tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
const core = await import(pathToFileURL(path.join(root, 'core.js')));
const routing = await import(pathToFileURL(path.join(root, 'scanner-routing.js')));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const lengths = Object.fromEntries([...source.matchAll(/const (\w+RESPONSE_LENGTH) = (\d+);/g)].map(match => [match[1], Number(match[2])]));
const systems = [...source.matchAll(/systemPrompt: "([^"]+)"/g)].map(match => match[1]);
assert.equal(systems.length, 5, 'Review measurement fixture when request owners change.');
function definition(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length)); }
const requestOwner = new Function('dispatchScannerRequest', 'parseScanJson', 'scannerRoutingError', 'IMPORTANT_MEMORY_LIMIT', 'JSON_RETRY_RESPONSE_LENGTH',
    definition('function isTruncatedScannerJsonError(', '\nasync function backfillNpcFromHistory(') + '\nreturn generateParsedNpcJson;')(
    routing.dispatchScannerRequest, core.parseScanJson, routing.scannerRoutingError, core.IMPORTANT_MEMORY_LIMIT, lengths.JSON_RETRY_RESPONSE_LENGTH);
const npc = core.normalizeNpcRecord({ id: 'survey-clerk', name: 'Mara', age: '26', apparentAge: '~26', present: true,
    role: 'Survey clerk', species: 'Human', personality: 'Patient and observant.', speech: 'Concise formal sentences.',
    behaviorProfile: ['Keeps firm boundaries.'], mannerisms: ['Squares the ledger.'], goal: 'Finish the route survey.',
    appearanceModelVersion: 1, currentForm: 'Human', overallAppearance: 'Silver pendant.',
    appearanceForms: [{ name: 'Human', appearance: 'Dark brown hair, amber eyes, ordinary human ears; blue wool coat.' },
        { name: 'Raven', appearance: 'Black feathers, beak and wings.' }],
    relationship: { trust: 25, affection: 0, desire: 0, tension: 0 }, createdAt: 1, updatedAt: 1 });
const transcript = 'Ari: I ask Mara to check the survey.\nMara: Mara squares the ledger and checks each route, speaking in concise formal sentences.';
const common = { transcript, currentTranscript: transcript, userName: 'Ari', charName: 'Narrator', existingNpcs: [npc], existingNpc: npc, targetNpc: npc, targetName: 'Mara', targets: [npc], dossierText: 'Mara is a survey clerk with dark brown hair and amber eyes.' };
const cases = [
    ['scanner', core.buildScannerPrompt(common), systems[4], lengths.SCAN_RESPONSE_LENGTH],
    ['full-window', core.buildScannerPrompt({ ...common, transcript: `${transcript}\n${transcript}` }), systems[4], lengths.FULL_SCAN_RESPONSE_LENGTH],
    ['refresh', core.buildProfileRefreshPrompt(common), systems[1], lengths.BACKFILL_RESPONSE_LENGTH],
    ['backfill', core.buildBackfillPrompt(common), systems[2], lengths.BACKFILL_RESPONSE_LENGTH],
    ['dossier-import', core.buildDossierImportPrompt(common), systems[0], lengths.BACKFILL_RESPONSE_LENGTH],
    ['focused-relationship', core.buildRelationshipPassPrompt(common), systems[3], lengths.RELATIONSHIP_RESPONSE_LENGTH],
    ['scanner-retry', core.buildScannerPrompt(common), systems[4], lengths.SCAN_RESPONSE_LENGTH],
];
const hash = value => createHash('sha256').update(value).digest('hex');
const report = { source: 'production functions with synthetic provider responses', lengths, routes: {}, injection: {} };
for (const routeName of ['default', 'profile']) {
    const rows = [];
    for (const [label, prompt, systemPrompt, responseLength] of cases) {
        const captures = [];
        const profile = { id: 'measurement', name: 'Synthetic measurement' };
        const response = () => label === 'scanner-retry' && captures.length === 1 ? '{' : '{"npcs":[]}';
        const capture = (messages, maxTokens, options) => {
            const serialized = JSON.stringify(messages);
            captures.push({ charsIncludingSystem: messages.reduce((n, item) => n + item.content.length, 0),
                serializedMessagesChars: serialized.length, inputSha256: hash(serialized), responseLength: maxTokens,
                options: Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'signal')) });
            return response();
        };
        const ctx = { extensionSettings: { npc_state_delta: {}, connectionManager: { profiles: [profile] } },
            generateRaw(options) { return capture([{ role: 'system', content: options.systemPrompt }, { role: 'user', content: options.prompt }], options.responseLength,
                { quietToLoud: options.quietToLoud, instructOverride: options.instructOverride, trimNames: options.trimNames }); },
            ConnectionManagerRequestService: { getProfile: () => profile, isProfileSupported: () => true,
                sendRequest(id, messages, maxTokens, options) { assert.equal(id, profile.id); return capture(messages, maxTokens, options); } } };
        await requestOwner(ctx, { prompt, systemPrompt, responseLength, label, requestScope: { route: { profileId: routeName === 'profile' ? profile.id : '' }, isCurrent: () => true } });
        rows.push({ label, requests: captures.length, captures });
    }
    report.routes[routeName] = rows;
}
const injection = core.buildInjection([npc], transcript, 1, 3);
report.injection = { chars: injection.length, sha256: hash(injection) };
report.reasoning = 'No Delta reasoning/thinking parameter; host/profile preset settings remain host-owned and unmeasured.';
report.providerUsage = 'Unavailable; these are character counts, hashes, options and actual mocked dispatcher invocations, not paid provider usage.';
if (!process.argv[2]) {
    const baselinePath = new URL('../tests/fixtures/stage9-budgets.json', import.meta.url);
    if (fs.existsSync(baselinePath)) assert.deepEqual(report, JSON.parse(fs.readFileSync(baselinePath)), 'Accepted prompt/request budget changed; investigate before publishing.');
}
console.log(JSON.stringify(report, null, 2));
