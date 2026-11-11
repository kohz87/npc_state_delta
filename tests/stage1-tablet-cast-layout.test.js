import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(root, 'launcher-ui.js'), 'utf8');

test('the launcher stylesheet no longer sizes a cast rail: the library is a face grid that needs no per-width rows', () => {
    assert.doesNotMatch(source, /delta-cast-list|delta-cast-tools|delta-search-label|delta-filters|\.delta-library\s*\{/);
    assert.doesNotMatch(source, /delta-document-head/);
});

test('phone and tablet screens keep room for the safe area under the scrolling screen', () => {
    assert.match(source, /@media \(max-width: 650px\)/);
    assert.match(source, /\.delta-document\s*\{\s*padding-bottom:\s*max\(10px, env\(safe-area-inset-bottom\)\)/);
});

test('touch layouts retain a minimum bottom inset even when the browser reports zero safe-area padding', () => {
    assert.match(source, /padding-bottom:\s*max\(8px, env\(safe-area-inset-bottom\)\)/);
});
