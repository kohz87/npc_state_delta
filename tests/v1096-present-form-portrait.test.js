import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs inside the synthetic host right after it mounts Yunyun's present-cast card.
async function presentFormPortraitCheck(inlineAnchors, sleep) {
    const runtime = globalThis.NPCStateDelta;
    const fail = message => { throw new Error(message); };
    const chatKey = runtime.uiStatus().chatKey;
    const npc = runtime.getState().npcs.find(item => item.name === 'Yunyun');
    const MAIN = 'data:image/png;base64,TUFJTlBPUlRSQUlU';
    const DEMON = 'data:image/png;base64,REVNT05GT1JN';
    const originalCreate = document.createElement;
    const originalReader = globalThis.FileReader;
    const originalImage = globalThis.Image;
    let dataUrl = MAIN;
    globalThis.FileReader = class { readAsDataURL() { queueMicrotask(() => { this.result = dataUrl; this.onload?.(); }); } };
    globalThis.Image = class { width = 32; height = 48; set src(value) { queueMicrotask(() => this.onload?.()); } };
    document.createElement = tag => tag === 'canvas' ? { getContext: () => ({ drawImage() {} }), toDataURL: () => dataUrl } : originalCreate.call(document, tag);
    const file = name => ({ name, type: 'image/png', size: 100 });
    const card = () => inlineAnchors.map(anchor => String(anchor.innerHTML || '')).join('\n');
    const original = { overallAppearance: npc.overallAppearance || '', appearance: npc.appearance || '' };
    try {
        const select = form => runtime.updateAppearance(npc.id, {
            overallAppearance: 'Crimson eyes',
            formsText: 'Human | black hair in pigtails\nDemon | curling black horns',
            currentForm: form,
            currentAppearance: '',
        }, { chatKey });
        if (!await select('Human')) fail('the form setup was rejected');
        if (!await runtime.setPortrait(npc.id, file('main.png'), { chatKey })) fail('the main portrait was not attached');
        dataUrl = DEMON;
        if (!await runtime.setPortrait(npc.id, file('demon.png'), { chatKey, form: 'Demon' })) fail('the form portrait was not attached');
        await sleep(150);
        if (!card().includes(MAIN)) fail('a form without its own portrait should show the main portrait');
        if (!await select('Demon')) fail('selecting the Demon form was rejected');
        await sleep(150);
        if (!card().includes(DEMON)) fail('the present card does not show the current form\'s portrait');
        if (card().includes(MAIN)) fail('the present card still shows the main portrait for a form with its own image');
        if (!await select('Human')) fail('switching back was rejected');
        await sleep(150);
        if (!card().includes(MAIN) || card().includes(DEMON)) fail('switching back did not restore the main portrait');
    } finally {
        // Leave Yunyun as the rest of the smoke run expects her.
        await runtime.removePortrait(npc.id, { chatKey, form: 'Demon' }).catch(() => false);
        await runtime.removePortrait(npc.id, { chatKey }).catch(() => false);
        await runtime.updateAppearance(npc.id, { overallAppearance: original.overallAppearance, formsText: '', currentForm: '__none__', currentAppearance: original.appearance }, { chatKey });
        document.createElement = originalCreate;
        globalThis.FileReader = originalReader;
        globalThis.Image = originalImage;
    }
}

test('v1.0.96 the present cast shows the current form\'s portrait', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "'portrait grid should stay compact; detailed fields belong in the launcher dossier');\n";
    if (!source.includes(marker)) throw new Error('Runtime smoke present-card marker changed');
    source = source.replace(marker, `${marker}    await (${presentFormPortraitCheck.toString()})(inlineAnchors, sleep);\n`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 16 * 1024 * 1024,
    });
});
