import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BACKFILL_RESPONSE_LENGTH, JSON_RETRY_RESPONSE_LENGTH, SCAN_RESPONSE_LENGTH, compactRetryPrompt, generateParsedNpcJson, isTruncatedScannerJsonError } from '../src/scanner-request.js';

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
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(index, /generateParsedNpcJson,\n\} from '\.\/src\/scanner-request\.js';/);
    assert.doesNotMatch(index, /function (?:generateParsedNpcJson|compactRetryPrompt|isTruncatedScannerJsonError)\(/);
});
