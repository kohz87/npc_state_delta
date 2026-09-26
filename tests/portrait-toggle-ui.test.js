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

test('settings booleans use CSS-only row status pills with grey and green dots', () => {
    const script = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    const source = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(script, /function enhanceSettingsToggles\(/, 'startup must not mutate checkbox sibling DOM');
    assert.doesNotMatch(script, /insertAdjacentElement\('afterend'/, 'startup must not inject toggle siblings from the global observer');
    assert.doesNotMatch(script + source, /delta-toggle-native|delta-toggle-pill|delta-toggle-label/, 'runtime toggle enhancer classes must remain absent');
    assert.match(source, /@supports selector\(label:has\(> input\[type="checkbox"\]:checked\)\)/);
    assert.match(source, /\.npc-state-delta-setting-row>input\[type="checkbox"\][^{]*\{[\s\S]*clip-path:inset\(50%\)!important/);
    assert.match(source, /\.npc-state-delta-setting-row:has\(> input\[type="checkbox"\]\)::after\{[\s\S]*content:"Disabled"!important/s);
    assert.match(source, /content:"Disabled"!important[\s\S]*radial-gradient\(circle at 10px 50%,rgba\(190,195,202,\.62\)/s);
    assert.match(source, /:has\(> input\[type="checkbox"\]:checked\)::after\{[\s\S]*content:"Enabled"!important/s);
    assert.match(source, /content:"Enabled"!important[\s\S]*radial-gradient\(circle at 10px 50%,#57d17b/s);
    assert.match(source, /:has\(> input\[type="checkbox"\]:focus-visible\)::after/);
    assert.doesNotMatch(source, /input\[type="checkbox"\]::before/);
    assert.doesNotMatch(source, /input\[type="checkbox"\]::after/);
});

test('settings owner events replace document observation without rewriting toggle DOM', () => {
    const source = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /new MutationObserver/);
    assert.match(source, /addEventListener\('npc-state-delta:settings-mounted', mountControl\)/);
    assert.match(source, /attempt < 40/);
    assert.doesNotMatch(source, /syncTogglePill|enhanceSettingsToggles|pill\.innerHTML|label\.textContent/);
});
