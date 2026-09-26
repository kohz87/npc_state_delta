import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function formPortraitChecks(mockState, eventSource, manualAddNpc, sleep) {
    const runtime = globalThis.NPCStateDelta;
    // Minimal browser image stack so the canonical compression path runs unchanged.
    globalThis.FileReader = class { readAsDataURL(file) { this.result = `data:${file.type};base64,${file.payload}`; queueMicrotask(() => this.onload?.()); } };
    globalThis.Image = class { set src(value) { this._src = value; this.width = 64; this.height = 96; queueMicrotask(() => this.onload?.()); } get src() { return this._src; } };
    const previousCreate = document.createElement;
    document.createElement = function (tag, ...rest) {
        if (String(tag).toLowerCase() !== 'canvas') return previousCreate?.call(this, tag, ...rest);
        let last = '';
        return {
            width: 0, height: 0,
            getContext: () => ({ drawImage(image) { last = String(image?._src || '').split(',').pop(); } }),
            toDataURL: () => `data:image/webp;base64,${last}`,
        };
    };
    const file = payload => ({ type: 'image/png', size: 64, name: `${payload}.png`, payload });

    mockState.context.groupId = null;
    mockState.context.chatId = 'form-portraits';
    mockState.context.getCurrentChatId = () => mockState.context.chatId;
    mockState.context.chat = [
        { is_user: true, name: 'User', mes: 'Shifter Mira arrives.' },
        { is_user: false, name: 'Narrator', mes: 'Shifter Mira waits in human form.' },
    ];
    eventSource.emit('chat_changed');
    await sleep(120);
    await manualAddNpc('Shifter Mira');
    await runtime.flush();
    const key = runtime.uiStatus().chatKey;
    const npc = runtime.getState().npcs.find(item => item.name === 'Shifter Mira');
    assert.equal(await runtime.updateAppearance(npc.id, {
        overallAppearance: 'Amber eyes',
        currentForm: 'Human',
        formsText: 'Human | Copper hair; linen dress\nFox | Red fur; white-tipped tail',
    }, { chatKey: key }), true);
    await runtime.flush();

    assert.equal(await runtime.setPortrait(npc.id, file('MAIN'), { chatKey: key }), true);
    assert.equal(await runtime.setPortrait(npc.id, file('FOX'), { chatKey: key, form: 'fox' }), true);
    await runtime.flush();
    await assert.rejects(runtime.setPortrait(npc.id, file('BAD'), { chatKey: key, form: 'Dragon' }), /no appearance form named/);

    const live = runtime.getNpc(npc.id);
    assert.match(live.portrait.dataUrl, /MAIN$/, 'a form portrait never replaces the main portrait');
    assert.ok(live.portrait.appearanceFingerprint, 'the main portrait records the appearance it was made for');
    assert.equal(live.portrait.appearanceForm, 'Human');
    const forms = runtime.formPortraits(npc.id);
    assert.deepEqual(Object.keys(forms), ['Fox']);
    assert.match(forms.Fox.dataUrl, /FOX$/);
    assert.equal(forms.Fox.appearanceForm, 'Fox');
    assert.ok(forms.Fox.appearanceFingerprint && forms.Fox.appearanceFingerprint !== live.portrait.appearanceFingerprint,
        'a form portrait fingerprints that form, not the current one');

    const saved = JSON.parse(mockState.files.get(runtime.dataFile().path));
    assert.match(saved.state.formPortraitAssets[npc.id].fox.dataUrl, /FOX$/, 'form portraits persist in the sidecar');
    for (const checkpoint of saved.state.checkpoints || []) {
        assert.equal('formPortraitAssets' in (checkpoint.snapshot || {}), false, 'checkpoints never duplicate form images');
    }
    const dossier = runtime.getDossierState();
    assert.match(dossier.formPortraits[npc.id].Fox.dataUrl, /FOX$/);

    // Switching the current form to Fox is the only thing that changes which image is shown.
    assert.equal(await runtime.updateAppearance(npc.id, {
        overallAppearance: 'Amber eyes', currentForm: 'Fox',
        formsText: 'Human | Copper hair; linen dress\nFox | Red fur; white-tipped tail',
    }, { chatKey: key }), true);
    await runtime.flush();
    assert.equal(runtime.getNpc(npc.id).currentForm, 'Fox');
    assert.match(runtime.getDossierState().formPortraits[npc.id].Fox.dataUrl, /FOX$/, 'switching forms keeps every stored image');

    assert.equal(await runtime.removePortrait(npc.id, { chatKey: key, form: 'Fox' }), true);
    await runtime.flush();
    assert.deepEqual(runtime.formPortraits(npc.id), {});
    assert.match(runtime.getNpc(npc.id).portrait.dataUrl, /MAIN$/, 'removing a form portrait keeps the main portrait');

    assert.equal(await runtime.setPortrait(npc.id, file('FOX2'), { chatKey: key, form: 'Fox' }), true);
    assert.equal(await runtime.deleteNpc(npc.id), true);
    await runtime.flush();
    const afterDelete = JSON.parse(mockState.files.get(runtime.dataFile().path));
    assert.equal(npc.id in (afterDelete.state.formPortraitAssets || {}), false, 'deleting the dossier deletes its form portraits');
    document.createElement = previousCreate;
}

test('per-form portraits persist beside the main portrait, follow the current form and are removed with the dossier', () => {
    let source = fs.readFileSync(new URL('./runtime-smoke.mjs', import.meta.url), 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed');
    source = source.replace(marker, `    await (${formPortraitChecks.toString()})(mockState, eventSource, manualAddNpc, sleep);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source, encoding: 'utf8', timeout: 45000, maxBuffer: 8 * 1024 * 1024,
    });
});
