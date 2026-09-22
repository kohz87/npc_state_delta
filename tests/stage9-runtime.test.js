import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Reuse the established synthetic host and its real runtime, not a second implementation.
// Inject extra assertions before its cleanup; the production module itself is unmodified.
async function additionalChecks(mockState, eventSource, manualAddNpc, sleep, extRoot, uiHandlers, emitDocumentEvent) {
    const runtime = globalThis.NPCStateDelta;
    manualAddNpc('Continuity Probe');
    await runtime.flush();
    let npc = runtime.getState().npcs.find(item => item.name === 'Continuity Probe');
    const chatKey = runtime.uiStatus().chatKey;
    const before = runtime.getState();
    assert.equal(runtime.updateAppearance(npc.id, { currentForm: 'Human', formsText: 'Human | Golden-blue hair, ordinary human ears.\nRaven | Black feathers, beak and wings.' }, { chatKey, lockAppearance: true }), true);
    assert.equal(runtime.updateAppearance(npc.id, { currentForm: 'Raven' }, { chatKey, lockAppearance: true }), true);
    npc = runtime.getNpc(npc.id);
    assert.match(npc.appearance, /Black feathers/);
    assert.doesNotMatch(npc.appearance, /human ears/);
    assert.equal(npc.appearanceForms.length, 2);
    assert.deepEqual(npc.relationship, before.npcs.find(item => item.id === npc.id).relationship);
    assert.equal(runtime.updateAppearance(npc.id, { currentForm: 'Human' }, { chatKey: 'chat:other:owner' }), false);
    const projection = runtime.getDossierState();
    assert.equal(projection.checkpoints, undefined);
    assert.equal(projection.lineage, undefined);
    projection.npcs[0].name = 'Never canonical';
    assert.notEqual(runtime.getState().npcs[0].name, 'Never canonical');

    // Manual correction uses the canonical state/checkpoint path and retains unrelated edits.
    assert.equal(runtime.updateLifeState(npc.id, 'deceased', { chatKey }), true);
    assert.equal(runtime.getNpc(npc.id).lifeState, 'deceased');
    assert.equal(runtime.updateLifeState(npc.id, 'alive', { chatKey: 'chat:other:owner' }), false);
    assert.equal(runtime.getNpc(npc.id).lifeState, 'deceased');
    assert.equal(runtime.updateLifeState(npc.id, 'alive', { chatKey }), true);
    assert.equal(runtime.getNpc(npc.id).lifeState, 'alive');
    assert.equal(runtime.getNpc(npc.id).present, false);
    assert.ok(runtime.getNpc(npc.id).deathCorrection);
    assert.equal(runtime.updateLifeState(npc.id, 'arbitrary', { chatKey }), false);

    // The public importer cannot bypass complete native-envelope validation.
    const { encodeNpcStateBundle } = await import(pathToFileURL(path.join(extRoot, 'bundle.js')).href);
    const { prepareNativeImport } = await import(pathToFileURL(path.join(extRoot, 'native-transfer.js')).href);
    const bundleBytes = manifest => {
        const text = new TextEncoder().encode(JSON.stringify(manifest));
        const bytes = new Uint8Array(12 + text.length);
        bytes.set(new TextEncoder().encode('NPCSTB01'));
        new DataView(bytes.buffer).setUint32(8, text.length, true); bytes.set(text, 12); return bytes;
    };
    const beforeImport = runtime.getState();
    assert.throws(() => runtime.importBytes(bundleBytes({ format: 'npc_state_delta_bundle', formatVersion: 1,
        state: { npcs: [{ ...npc, name: 'Must not partially replace' }] }, portableSettings: { scannerConnectionProfile: 'foreign' },
    })), /unsupported portable setting/);
    assert.deepEqual(runtime.getState(), beforeImport);
    const foreign = { ...runtime.getNpc(npc.id), birthDateSourceMessageId: 1234 };
    runtime.importBytes(encodeNpcStateBundle({ npcs: [foreign] }, { chatKey: 'chat:foreign:source' }));
    assert.equal(runtime.getNpc(npc.id).birthDateSourceMessageId, null);

    // Foreign activity counters are source-chat clocks. Matching target dossiers keep their
    // target chronology, while newly admitted foreign dossiers start at the target import turn.
    const targetActivity = runtime.getNpc(npc.id);
    for (const sourceTurn of [2, 9999]) {
        const foreignMatch = {
            ...runtime.getNpc(npc.id),
            lastSeenTurn: sourceTurn,
            lastWorldActiveTurn: sourceTurn,
        };
        runtime.importBytes(encodeNpcStateBundle({ npcs: [foreignMatch] }, { chatKey: `chat:foreign:${sourceTurn}` }));
        assert.equal(runtime.getNpc(npc.id).lastSeenTurn, targetActivity.lastSeenTurn);
        assert.equal(runtime.getNpc(npc.id).lastWorldActiveTurn, targetActivity.lastWorldActiveTurn);
    }
    const targetImportTurn = runtime.getState().turn;
    const directForeign = {
        ...runtime.getNpc(npc.id),
        id: 'npc_direct_foreign_activity',
        name: 'Direct Foreign Activity',
        aliases: [],
        keyRelationships: [],
        lastSeenTurn: 2,
        lastWorldActiveTurn: 2,
        present: false,
        worldActive: false,
        archived: false,
        archiveReason: '',
    };
    runtime.importBytes(encodeNpcStateBundle({ npcs: [directForeign] }, { chatKey: 'chat:foreign:direct' }));
    assert.equal(runtime.getNpc('npc_direct_foreign_activity').lastSeenTurn, targetImportTurn);
    assert.equal(runtime.getNpc('npc_direct_foreign_activity').lastWorldActiveTurn, targetImportTurn);

    const preparedForeign = {
        ...directForeign,
        id: 'npc_prepared_foreign_activity',
        name: 'Prepared Foreign Activity',
        lastSeenTurn: 9999,
        lastWorldActiveTurn: 9999,
    };
    const prepared = prepareNativeImport(
        encodeNpcStateBundle({ npcs: [preparedForeign] }, { chatKey: 'chat:foreign:prepared' }),
        chatKey,
    );
    runtime.importBytes(prepared.importBytes);
    assert.equal(runtime.getNpc('npc_prepared_foreign_activity').lastSeenTurn, targetImportTurn);
    assert.equal(runtime.getNpc('npc_prepared_foreign_activity').lastWorldActiveTurn, targetImportTurn);
    await runtime.flush();

    // Raw World State survives the real scanner's UI-noise stripping and reaches next injection.
    const calendarCore = await import(pathToFileURL(path.join(extRoot, 'core.js')).href);
    const previousResponder = mockState.quietResponder;
    calendarCore.setActiveCalendarConfig({ era: 'CR', months: [{ name: 'Redleaf', days: 30 }, { name: 'Sunwane', days: 31 }] });
    runtime.importBytes(encodeNpcStateBundle({ npcs: [{ ...runtime.getNpc(npc.id), age: '6', apparentAge: '~6',
        birthDate: { era: 'CR', year: 815, month: 'Redleaf', day: 16 }, birthDateSource: 'established', birthDateYearSource: 'established',
    }] }, { chatKey }));
    await runtime.flush();
    mockState.context.chat.push({ is_user: false, name: 'Narrator', mes: '<World_State>Time | CR822, Redleaf 16 | evening\nNPCs Present: Continuity Probe</World_State> Continuity Probe checks the route.' });
    mockState.quietResponder = async () => JSON.stringify({ npcs: [{ id: npc.id, name: 'Continuity Probe', present: true }] });
    try {
        await runtime.scan();
        assert.equal(runtime.getNpc(npc.id).age, '7');
        assert.equal(runtime.getNpc(npc.id).apparentAge, '~7');
        const injection = [...mockState.prompts].reverse().find(args => args[0] === 'npc_state_delta_live_dossier')?.[1] || '';
        assert.match(injection, /Continuity Probe/);
        assert.match(injection, /(?:age|chronological)[^\n]{0,25}7/i);
        await runtime.flush();
    } finally {
        mockState.quietResponder = previousResponder;
        calendarCore.setActiveCalendarConfig(null);
    }

    const originalCreate = document.createElement;
    const originalReader = globalThis.FileReader;
    const originalImage = globalThis.Image;
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const held = [];
    globalThis.FileReader = class {
        readAsDataURL(file) {
            const complete = () => { if (file.fail) this.onerror?.(); else { this.result = dataUrl; this.onload?.(); } };
            if (file.hold) held.push(complete); else queueMicrotask(complete);
        }
    };
    globalThis.Image = class {
        width = 32; height = 48;
        set src(value) { queueMicrotask(() => this.onload?.()); }
    };
    document.createElement = tag => tag === 'canvas' ? {
        getContext: () => ({ drawImage() {} }), toDataURL: () => dataUrl,
    } : originalCreate.call(document, tag);
    const file = (name, extra = {}) => ({ name, type: 'image/png', size: 100, ...extra });
    try {
        assert.equal(await runtime.setPortrait(npc.id, file('first.png'), { chatKey }), true);
        assert.equal(runtime.getNpc(npc.id).portrait.sourceName, 'first.png');
        const selected = runtime.getNpc(npc.id).portrait;
        assert.equal(await runtime.setPortrait(npc.id, null, { chatKey }), false);
        await assert.rejects(runtime.setPortrait(npc.id, file('bad.svg', { type: 'image/svg+xml' }), { chatKey }), /Choose a PNG/);
        await assert.rejects(runtime.setPortrait(npc.id, file('oversize.png', { size: 17 * 1024 * 1024 }), { chatKey }), /16 MB/);
        await assert.rejects(runtime.setPortrait(npc.id, file('broken.png', { fail: true }), { chatKey }));
        assert.deepEqual(runtime.getNpc(npc.id).portrait, selected);

        const older = runtime.setPortrait(npc.id, file('older.png', { hold: true }), { chatKey });
        assert.equal(await runtime.setPortrait(npc.id, file('newer.png'), { chatKey }), true);
        held.shift()();
        assert.equal(await older, false);
        assert.equal(runtime.getNpc(npc.id).portrait.sourceName, 'newer.png');

        let open = true;
        const cancelled = runtime.setPortrait(npc.id, file('cancelled.png', { hold: true }), { chatKey, isCurrent: () => open });
        open = false; held.shift()();
        assert.equal(await cancelled, false);
        assert.equal(runtime.getNpc(npc.id).portrait.sourceName, 'newer.png');

        const switched = runtime.setPortrait(npc.id, file('other-chat.png', { hold: true }), { chatKey });
        const owner = mockState.context.characterId;
        mockState.context.characterId = owner === 0 ? 1 : 0;
        held.shift()();
        assert.equal(await switched, false);
        mockState.context.characterId = owner;
        assert.equal(runtime.getNpc(npc.id).portrait.sourceName, 'newer.png');

        // A preview request returns a URL without replacing the selected portrait.
        const portraitBeforePreview = runtime.getNpc(npc.id).portrait;
        await runtime.generatePortraitUrl(npc.id);
        assert.deepEqual(runtime.getNpc(npc.id).portrait, portraitBeforePreview);

        // Per-NPC portrait seeds persist independently and are passed through the host /imagine contract.
        assert.equal(runtime.setPortraitSeed(npc.id, 424242, { chatKey }), true);
        assert.equal(runtime.getNpc(npc.id).portraitSeed, 424242);
        let seededCommand = '';
        const seededExecute = mockState.context.executeSlashCommandsWithOptions;
        mockState.context.executeSlashCommandsWithOptions = command => {
            seededCommand = String(command || '');
            return Promise.resolve({ pipe: '/user/images/seeded.png' });
        };
        await runtime.generatePortraitUrl(npc.id);
        assert.match(seededCommand, /(?:^|\s)seed=424242(?:\s|$)/);
        mockState.context.executeSlashCommandsWithOptions = seededExecute;
        assert.throws(() => runtime.setPortraitSeed(npc.id, -1, { chatKey }), /whole number/);
        assert.equal(runtime.setPortraitSeed(npc.id, null, { chatKey }), true);
        assert.equal(runtime.getNpc(npc.id).portraitSeed, null);

        // Exercise retained native preview/application through its actual registered UI controls.
        const originalAppend = document.body.appendChild;
        const originalExecute = mockState.context.executeSlashCommandsWithOptions;
        const originalGeneratedFetch = globalThis.fetch;
        let dialog;
        document.body.appendChild = node => {
            originalAppend.call(document.body, node);
            if (node.id !== 'npc_state_delta_portrait_generator_overlay') return;
            dialog = node;
            const controls = new Map();
            node.querySelector = selector => {
                if (!controls.has(selector)) controls.set(selector, { value: selector.includes('positive') ? 'A synthetic portrait' : '', hidden: true, disabled: false });
                return controls.get(selector);
            };
        };
        const invoke = selector => uiHandlers.get('click.npcStateDelta|' + selector)({ preventDefault() {} });
        const settled = async () => {
            for (let i = 0; i < 50 && runtime.uiStatus().portraitGenerationBusy; i++) await sleep(5);
            assert.equal(runtime.uiStatus().portraitGenerationBusy, false);
        };
        try {
            runtime.openPortraitGenerator(npc.id);
            invoke('.npc-state-delta-portrait-run'); await settled();
            assert.equal(runtime.getNpc(npc.id).portrait.sourceName, 'newer.png');
            assert.equal(dialog.querySelector('.npc-state-delta-portrait-generator-image').hidden, false);
            globalThis.fetch = (url, options) => String(url).includes('/user/images/')
                ? Promise.resolve({ ok: true, blob: async () => new Blob(['synthetic'], { type: 'image/png' }) })
                : originalGeneratedFetch(url, options);
            invoke('.npc-state-delta-portrait-use'); await settled();
            assert.match(runtime.getNpc(npc.id).portrait.sourceName, /generated/);
            assert.equal(runtime.uiStatus().portraitGeneratorOpen, false);

            // A capture-phase legacy handler must not consume Escape above another tools dialog.
            runtime.openPortraitGenerator(npc.id);
            const oldLookup = document.getElementById;
            document.getElementById = id => id === 'npc_state_delta_tools_overlay' ? { isConnected: true } : oldLookup?.(id);
            emitDocumentEvent('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
            assert.equal(runtime.uiStatus().portraitGeneratorOpen, true);
            document.getElementById = oldLookup;
            runtime.openPortraitGenerator(npc.id);
            let releaseGeneration;
            mockState.context.executeSlashCommandsWithOptions = () => new Promise(resolve => { releaseGeneration = resolve; });
            invoke('.npc-state-delta-portrait-run');
            assert.equal(dialog.querySelector('.npc-state-delta-portrait-generator-close').disabled, false);
            emitDocumentEvent('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
            assert.equal(runtime.uiStatus().portraitGeneratorOpen, false);
            releaseGeneration({ pipe: '/user/images/stale.png' }); await sleep(10);
            assert.equal(runtime.uiStatus().portraitGeneratorOpen, false);

            runtime.openPortraitGenerator(npc.id); invoke('.npc-state-delta-portrait-run');
            const oldDialog = dialog;
            runtime.openPortraitGenerator(npc.id);
            releaseGeneration({ pipe: '/user/images/stale.png' }); await sleep(10);
            assert.notEqual(dialog, oldDialog);
            assert.equal(dialog.querySelector('.npc-state-delta-portrait-generator-image').hidden, true);
            assert.equal(runtime.uiStatus().portraitGenerationBusy, false);

            mockState.context.executeSlashCommandsWithOptions = originalExecute;
            invoke('.npc-state-delta-portrait-run'); await settled();
            let releaseImage;
            globalThis.fetch = (url, options) => String(url).includes('/user/images/')
                ? new Promise(resolve => { releaseImage = resolve; }) : originalGeneratedFetch(url, options);
            const priorImage = runtime.getNpc(npc.id).portrait;
            invoke('.npc-state-delta-portrait-use');
            runtime.openPortraitGenerator(npc.id);
            releaseImage({ ok: true, blob: async () => new Blob(['stale'], { type: 'image/png' }) });
            await sleep(10);
            assert.deepEqual(runtime.getNpc(npc.id).portrait, priorImage);
            assert.equal(runtime.uiStatus().portraitGeneratorOpen, true);
            emitDocumentEvent('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
        } finally {
            document.body.appendChild = originalAppend;
            mockState.context.executeSlashCommandsWithOptions = originalExecute;
            globalThis.fetch = originalGeneratedFetch;
        }

        await runtime.flush();
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (url, options) => url === '/api/files/upload'
            ? Promise.resolve({ ok: false, status: 403, text: async () => 'Synthetic write failure' })
            : originalFetch(url, options);
        assert.equal(await runtime.setPortrait(npc.id, file('local-only.png'), { chatKey }), true);
        await assert.rejects(runtime.flush());
        assert.equal(runtime.persistenceStatus().currentChatPending, true);
        assert.equal(runtime.getNpc(npc.id).portrait.sourceName, 'local-only.png');
        globalThis.fetch = originalFetch;
        await runtime.flush();
        assert.equal(runtime.persistenceStatus().currentChatPending, false);
        const persisted = JSON.parse(mockState.files.get(runtime.dataFile().path));
        assert.equal(persisted.state.portraitAssets[npc.id].sourceName, 'local-only.png');

        // A permanently rejected write may survive cache eviction through storage's undurable
        // shadow. Rehydrating that shadow must remain locally dirty until a later write really
        // reaches the sidecar; hydration must never promote it to a false durable version.
        const persistenceIdentity = {
            groupId: mockState.context.groupId,
            characterId: mockState.context.characterId,
            chatId: mockState.context.chatId,
            getCurrentChatId: mockState.context.getCurrentChatId,
            chat: structuredClone(mockState.context.chat),
        };
        const durableFetch = globalThis.fetch;
        globalThis.fetch = (url, options) => url === '/api/files/upload'
            ? Promise.resolve({ ok: false, status: 413, text: async () => 'Synthetic payload too large' })
            : durableFetch(url, options);
        try {
            assert.equal(runtime.archive(npc.id), true);
            await assert.rejects(runtime.flush(), error => Number(error?.status) === 413);
            assert.equal(runtime.persistenceStatus().currentChatPending, true);
            assert.equal(runtime.getNpc(npc.id).archived, true);
        } finally {
            globalThis.fetch = durableFetch;
        }

        for (let index = 0; index < 8; index += 1) {
            mockState.context.groupId = null;
            mockState.context.characterId = persistenceIdentity.characterId;
            mockState.context.chatId = `undurable-evict-${index}`;
            mockState.context.getCurrentChatId = () => mockState.context.chatId;
            mockState.context.chat = [{ is_user: false, is_system: false, name: 'Narrator', mes: `eviction-${index}` }];
            eventSource.emit('chat_changed');
            await sleep(90);
        }

        mockState.context.groupId = persistenceIdentity.groupId;
        mockState.context.characterId = persistenceIdentity.characterId;
        mockState.context.chatId = persistenceIdentity.chatId;
        mockState.context.getCurrentChatId = persistenceIdentity.getCurrentChatId;
        mockState.context.chat = persistenceIdentity.chat;
        eventSource.emit('chat_changed');
        await sleep(160);
        assert.equal(runtime.uiStatus().chatKey, chatKey);
        assert.equal(runtime.getNpc(npc.id).archived, true, 'undurable state must win over the older sidecar after cache eviction');
        assert.equal(runtime.persistenceStatus().currentChatPending, true,
            'rehydrated undurable state must remain pending until it is actually written');
        await runtime.flush();
        assert.equal(runtime.persistenceStatus().currentChatPending, false);
        const persistedAfterRehydrate = JSON.parse(mockState.files.get(runtime.dataFile().path));
        assert.equal(persistedAfterRehydrate.state.npcs.find(item => item.id === npc.id).archived, true);
        assert.equal(runtime.restore(npc.id), true);
        await runtime.flush();
        assert.equal(runtime.getNpc(npc.id).archived, false);

        const beforeRemoval = runtime.getNpc(npc.id);
        const removePending = runtime.setPortrait(npc.id, file('after-removal.png', { hold: true }), { chatKey });
        assert.equal(runtime.removePortrait(npc.id, { chatKey }), true);
        held.shift()();
        assert.equal(await removePending, false);
        assert.equal(runtime.getNpc(npc.id).portrait, null);
        assert.equal(runtime.getNpc(npc.id).name, beforeRemoval.name);
        assert.deepEqual(runtime.getNpc(npc.id).appearanceForms, beforeRemoval.appearanceForms);
        assert.equal(runtime.getState().portraitAssets[npc.id], undefined);

        const deletion = runtime.setPortrait(npc.id, file('deleted.png', { hold: true }), { chatKey });
        runtime.deleteNpc(npc.id);
        held.shift()();
        assert.equal(await deletion, false);
        assert.equal(runtime.getNpc(npc.id), null);
        await runtime.flush();
    } finally {
        document.createElement = originalCreate;
        globalThis.FileReader = originalReader;
        globalThis.Image = originalImage;
    }
    console.log('Stage 9 runtime actions: scoped forms, portrait upload/replace/remove, cancellation, stale actions, preview isolation and dirty-write recovery passed.');
}

test('Stage 9 APIs execute inside the complete synthetic host, including failed persistence and stale completion', () => {
    const harnessPath = new URL('./runtime-smoke.mjs', import.meta.url);
    let source = fs.readFileSync(harnessPath, 'utf8');
    source = source.replace('const here = path.dirname(fileURLToPath(import.meta.url));', `const here = ${JSON.stringify(fileURLToPath(new URL('.', import.meta.url)))};`);
    const marker = "    console.log('Runtime smoke:";
    if (!source.includes(marker)) throw new Error('Runtime smoke cleanup marker changed; review this integrated fixture.');
    source = source.replace(marker, `    await (${additionalChecks.toString()})(mockState, eventSource, manualAddNpc, sleep, extRoot, uiHandlers, emitDocumentEvent);\n${marker}`);
    execFileSync(process.execPath, ['--import', new URL('./active-runtime-test-setup.mjs', import.meta.url).href, '--input-type=module'], {
        input: source, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    });
});
