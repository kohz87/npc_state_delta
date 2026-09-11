import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = fs.readFileSync(path.join(root, 'launcher-ui.js'), 'utf8');

test('tablet cast rail keeps search and filters on one row so dossier cards have vertical room', () => {
    assert.match(source, /@media \(min-width: 651px\) and \(max-width: 900px\)/);
    assert.match(source, /\.delta-library\s*\{\s*grid-template-rows:\s*minmax\(0, 1fr\) 178px;/);
    assert.match(source, /\.delta-cast-tools\s*\{\s*align-items:\s*center;\s*flex-direction:\s*row;/);
    assert.match(source, /\.delta-search-label\s*\{\s*flex:\s*1 1 0;\s*min-width:\s*0;/);
    assert.match(source, /\.delta-filters\s*\{\s*flex:\s*0 0 auto;\s*flex-wrap:\s*nowrap;/);
    assert.match(source, /\.delta-cast-list\s*\{\s*min-height:\s*92px;/);
});

test('phone cast rail reserves enough height for stacked controls and one complete dossier card', () => {
    assert.match(source, /@media \(max-width: 650px\)/);
    assert.match(source, /grid-template-rows:\s*minmax\(0, 1fr\) clamp\(224px, 30dvh, 260px\)/);
    assert.match(source, /padding-bottom:\s*max\(10px, env\(safe-area-inset-bottom\)\)/);
    assert.match(source, /min-height:\s*94px/);
});

test('touch layouts retain a minimum bottom inset even when the browser reports zero safe-area padding', () => {
    assert.match(source, /padding-bottom:\s*max\(8px, env\(safe-area-inset-bottom\)\)/);
});
