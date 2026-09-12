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
    assert.match(source, /copyPromptText\(combinedPrompt\(draft\), 'Portrait prompt', overlay\)/);
});

test('portrait copying lazy-loads SillyTavern host utility and exposes a selected manual fallback', () => {
    const source = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import .*utils\.js/m, 'host-only utils must not be resolved at module load in isolated tests');
    assert.match(source, /async function hostCopyText\(value\)/);
    assert.match(source, /await import\('\.\.\/\.\.\/\.\.\/utils\.js'\)/);
    assert.match(source, /hostUtils\.copyText\(value\)/);
    assert.match(source, /await hostCopyText\(value\)/);
    assert.doesNotMatch(source, /function fallbackCopyText/);
    assert.match(source, /data-delta-tools-manual-copy/);
    assert.match(source, /data-delta-tools-manual-copy-text/);
    assert.match(source, /automatic clipboard access was blocked/);
    assert.match(source, /textarea\.setSelectionRange\(0, textarea\.value\.length\)/);
    assert.match(source, /is empty; nothing was copied/);
});

test('settings booleans are CSS-only status pills with grey and green dots', () => {
    const source = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /function enhanceSettingsToggles\(/, 'startup must not mutate checkbox sibling DOM');
    assert.doesNotMatch(source, /insertAdjacentElement\('afterend'/, 'startup must not inject toggle siblings from the global observer');
    assert.doesNotMatch(source, /delta-toggle-native|delta-toggle-pill|delta-toggle-label/, 'runtime toggle enhancer classes must be absent');
    assert.match(source, /input\[type="checkbox"\][^{]*\{[\s\S]*appearance:none!important/);
    assert.match(source, /width:82px!important;height:26px!important/);
    assert.match(source, /input\[type="checkbox"\]::before\{[\s\S]*background:rgba\(190,195,202,\.62\)!important/);
    assert.match(source, /input\[type="checkbox"\]:checked::before\{[\s\S]*background:#57d17b!important/);
    assert.match(source, /input\[type="checkbox"\]::after\{[\s\S]*content:"Disabled"!important/);
    assert.match(source, /input\[type="checkbox"\]:checked::after\{content:"Enabled"!important/);
});

test('document MutationObserver does not rewrite toggle DOM', () => {
    const source = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    assert.match(source, /new MutationObserver\(\(\) => mountControl\(\)\)/);
    assert.doesNotMatch(source, /syncTogglePill|enhanceSettingsToggles|pill\.innerHTML|label\.textContent/);
});
