import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('portrait prompt workflow moves combined prompt action to footer and keeps clipboard fallback', () => {
    const source = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    assert.match(source, /<footer>[\s\S]*data-remove-portrait[\s\S]*data-generate-final-prompt>Generate Prompt<\/button>/);
    assert.doesNotMatch(source, />Copy both<\/button>/);
    assert.match(source, /function fallbackCopyText/);
    assert.match(source, /execCommand\('copy'\)/);
    assert.match(source, /navigator\?\.clipboard\?\.writeText/);
    assert.match(source, /copyText\(combinedPrompt\(draft\), 'Generated prompt'\)/);
});

test('settings boolean controls render as native semantic toggle switches', () => {
    const source = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    assert.match(source, /npc-state-delta-setting-row input\[type="checkbox"\][^{]*\{[\s\S]*appearance:none!important/);
    assert.match(source, /width:46px!important;height:26px!important/);
    assert.match(source, /input\[type="checkbox"\]:checked\{[\s\S]*calc\(100% - 13px\)/);
    assert.match(source, /input\[type="checkbox"\]:focus-visible/);
    assert.match(source, /input\[type="checkbox"\]:disabled/);
});
