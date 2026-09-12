import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('portrait prompt workflow uses a footer Copy Prompt action and preserves non-empty combined text', () => {
    const source = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    assert.match(source, /<footer>[\s\S]*data-remove-portrait[\s\S]*data-copy-final-prompt>Copy Prompt<\/button>/);
    assert.doesNotMatch(source, />Copy both<\/button>/);
    assert.doesNotMatch(source, />Generate Prompt<\/button>/);
    assert.match(source, /function combinedPrompt\(draft\)[\s\S]*Positive prompt:/);
    assert.match(source, /Negative prompt:/);
    assert.match(source, /copyText\(combinedPrompt\(draft\), 'Portrait prompt'\)/);
});

test('clipboard fallback runs synchronously before async Clipboard API and empty copies fail closed', () => {
    const source = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    assert.match(source, /function fallbackCopyText/);
    assert.match(source, /execCommand\('copy'\)/);
    assert.match(source, /is empty; nothing was copied/);
    const fallbackIndex = source.indexOf('if (fallbackCopyText(value))');
    const clipboardIndex = source.indexOf('navigator?.clipboard?.writeText');
    assert.ok(fallbackIndex >= 0, 'synchronous fallback must exist');
    assert.ok(clipboardIndex > fallbackIndex, 'fallback must run before async Clipboard API so click activation is preserved');
});

test('settings boolean controls render as Enabled or Disabled status pills with no checkbox tick', () => {
    const source = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    assert.match(source, /npc-state-delta-setting-row input\[type="checkbox"\][^{]*\{[\s\S]*appearance:none!important/);
    assert.match(source, /width:86px!important;height:28px!important/);
    assert.match(source, /background-image:none!important/);
    assert.match(source, /input\[type="checkbox"\]::before\{[\s\S]*content:""!important/);
    assert.match(source, /input\[type="checkbox"\]::after\{[\s\S]*content:"Disabled"!important/);
    assert.match(source, /input\[type="checkbox"\]:checked::after\{content:"Enabled"!important/);
    assert.match(source, /input\[type="checkbox"\]:checked::before\{[\s\S]*#57d17b/);
    assert.match(source, /input\[type="checkbox"\]:focus-visible/);
    assert.match(source, /input\[type="checkbox"\]:disabled/);
    assert.doesNotMatch(source, /radial-gradient/);
});
