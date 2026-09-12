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

test('portrait copying delegates to SillyTavern host utility and exposes a selected manual fallback', () => {
    const source = fs.readFileSync(new URL('../portrait-tools.js', import.meta.url), 'utf8');
    assert.match(source, /import \{ copyText as hostCopyText \} from '\.\.\/\.\.\/\.\.\/utils\.js'/);
    assert.match(source, /await hostCopyText\(value\)/);
    assert.doesNotMatch(source, /function fallbackCopyText/);
    assert.match(source, /data-delta-tools-manual-copy/);
    assert.match(source, /data-delta-tools-manual-copy-text/);
    assert.match(source, /automatic clipboard access was blocked/);
    assert.match(source, /textarea\.setSelectionRange\(0, textarea\.value\.length\)/);
    assert.match(source, /is empty; nothing was copied/);
});

test('settings booleans use separate compact status-dot pills so host checkbox ticks cannot leak through', () => {
    const source = fs.readFileSync(new URL('../scanner-output-ui.js', import.meta.url), 'utf8');
    assert.match(source, /function enhanceSettingsToggles\(root\)/);
    assert.match(source, /input\.classList\.add\('delta-toggle-native'\)/);
    assert.match(source, /pill\.className = 'delta-toggle-pill'/);
    assert.match(source, /delta-toggle-dot/);
    assert.match(source, /enabled \? 'Enabled' : 'Disabled'/);
    assert.match(source, /input\.delta-toggle-native\[type="checkbox"\][^{]*\{[\s\S]*clip-path:inset\(50%\)!important/);
    assert.match(source, /delta-toggle-pill[^}]*min-width:74px!important[^}]*height:24px!important/s);
    assert.match(source, /delta-toggle-dot[^}]*background:rgba\(190,195,202,\.62\)!important/s, 'unchecked/disabled state must show a grey dot');
    assert.match(source, /:checked \+ \.delta-toggle-pill \.delta-toggle-dot[^}]*background:#57d17b!important/s, 'enabled state must show a green dot');
    assert.match(source, /:focus-visible \+ \.delta-toggle-pill/);
    assert.match(source, /:disabled \+ \.delta-toggle-pill/);
    assert.doesNotMatch(source, /content:"Enabled"/);
    assert.doesNotMatch(source, /content:"Disabled"/);
});
