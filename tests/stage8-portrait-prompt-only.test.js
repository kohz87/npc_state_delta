import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const portraitToolsUrl = new URL('../portrait-tools.js', import.meta.url);
const controlsUrl = new URL('../dossier-tools-controls.js', import.meta.url);

test('maintained Portrait workflow generates prompts but never generates an image', async () => {
    const source = await readFile(portraitToolsUrl, 'utf8');
    assert.match(source, /Generate prompts from dossier/);
    assert.match(source, /portraitPrompts/);
    assert.match(source, /Upload from device|Replace from device/);
    assert.match(source, /Remove portrait/);
    assert.doesNotMatch(source, /generatePortraitUrl/);
    assert.doesNotMatch(source, /data-generate(?:=|>)/);
    assert.doesNotMatch(source, /data-apply-preview/);
    assert.doesNotMatch(source, /SillyTavern Image Generation/);
});

test('dossier Portrait control routes to the prompt-only manager and suppresses legacy image generation actions', async () => {
    const source = await readFile(controlsUrl, 'utf8');
    assert.match(source, /from '\.\/portrait-tools\.js'/);
    assert.match(source, /npc-state-delta-generate-portrait/);
    assert.match(source, /display:none !important/);
    assert.match(source, /top layer/i);
});
