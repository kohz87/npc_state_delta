import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const scannerRouting = fs.readFileSync(path.join(root, 'scanner-routing.js'), 'utf8');
// (cleanup step 10) The scanner request moved to src/scanner-request.js.
const request = fs.readFileSync(path.join(root, 'src', 'scanner-request.js'), 'utf8');

test('dossier scanner uses the shared isolated dispatcher and default route preserves raw generation', () => {
    assert.match(request, /dispatchScannerRequest\(ctx,\s*\{[\s\S]*?systemPrompt,[\s\S]*?prompt:[\s\S]*?instructOverride:\s*true,[\s\S]*?responseLength:[\s\S]*?trimNames:\s*false/);
    assert.match(scannerRouting, /ctx\.generateRaw\(options\)/);
    assert.match(request, /SCAN_RESPONSE_LENGTH = 1800/);
    assert.match(request, /BACKFILL_RESPONSE_LENGTH = 3200/);
    assert.match(request, /JSON_RETRY_RESPONSE_LENGTH = 5200/);
    assert.match(request, /isTruncatedScannerJsonError/);
    assert.match(request, /returned invalid JSON; retrying once with a compact correction prompt/);
    for (const source of [index, request]) assert.doesNotMatch(source, /jsonSchema:\s*SCANNER_JSON_SCHEMA/);
    for (const source of [index, request]) assert.doesNotMatch(source, /ctx\.generateQuietPrompt\s*\(/);
    assert.doesNotMatch(index, /quietPrompt:\s*prompt/);
    assert.doesNotMatch(index, /skipWIAN:\s*true/);
});
