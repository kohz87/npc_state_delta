import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const portraitToolsUrl = new URL('../portrait-tools.js', import.meta.url);
const controlsUrl = new URL('../dossier-tools.js', import.meta.url);

test('maintained Portrait workflow uses SillyTavern Image Generation with explicit preview application', async () => {
    const source = await readFile(portraitToolsUrl, 'utf8');
    assert.match(source, /Generate prompts from dossier/);
    assert.match(source, /portraitPrompts/);
    assert.match(source, /Upload from device|Replace from device/);
    assert.match(source, /Remove portrait/);
    assert.match(source, /generatePortraitUrl/);
    assert.match(source, /data-generate-portrait/);
    assert.match(source, /data-use-generated-portrait/);
    assert.match(source, /SillyTavern Image Generation/);
    assert.match(source, /Generated images stay preview-only/);
    assert.match(source, /generatedFrom: url/);
    assert.match(source, /setPortrait/);
    assert.match(source, /session\.actionSeq/);
    assert.match(source, /currentSessionIs\(session\)/);
    assert.doesNotMatch(source, /\/imagine/);
    assert.doesNotMatch(source, /127\.0\.0\.1:8188|\/prompt\b/);
});

test('dossier Portrait control routes to the maintained manager and suppresses the legacy image-generation action', async () => {
    const source = await readFile(controlsUrl, 'utf8');
    const experience = await readFile(new URL('../dossier-experience.js', import.meta.url), 'utf8');
    assert.match(experience, /from '\.\/portrait-tools\.js'/);
    assert.match(source, /npc-state-delta-generate-portrait/);
    assert.match(source, /display:none !important/);
    assert.match(source, /top layer/i);
});
