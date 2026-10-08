import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeScanResult } from '../core.js';
import { completeFormWithShared } from '../appearance.js';

const BODY = 'Tall and slender, long silver hair, violet eyes';

test('1: only an outfit-only form receives the scan\'s Physical features', () => {
    for (const text of ['A silver dragon', 'A great black wolf', 'Spirit form, translucent and glowing', 'A small red fox', 'Silver scales and wings']) {
        assert.equal(completeFormWithShared(BODY, text), text, text);
    }
    for (const text of ['Wearing a grey cloak', 'In her battle armour, sword drawn', 'Dressed in a blood-stained blue gown']) {
        assert.equal(completeFormWithShared(BODY, text), `${BODY}; ${text}`, text);
    }
    const result = mergeScanResult({ npcs: [], candidates: [], turn: 1 }, { npcs: [{
        name: 'Noela', overallAppearance: BODY, present: true, dossierSignal: 'persistent', currentForm: 'Dragon',
        appearanceForms: [{ name: 'Human', appearance: 'Wearing a grey cloak' }, { name: 'Dragon', appearance: 'A silver dragon' }],
    }] }, { turn: 1, sourceMessageId: 1, developmentContext: 'Noela, tall and slender with long silver hair and violet eyes, wears a grey cloak. She becomes a silver dragon.' });
    const forms = Object.fromEntries(result.state.npcs[0].appearanceForms.map(form => [form.name, form.appearance]));
    assert.equal(forms.Dragon, 'A silver dragon', 'the dragon does not get the human body');
    assert.equal(forms.Human, `${BODY}; Wearing a grey cloak`);
});

test('2/3: no unused imports or uncalled functions remain in shipped modules', () => {
    const modules = JSON.parse(fs.readFileSync(new URL('../runtime-modules.json', import.meta.url), 'utf8')).modules.map(module => module.path);
    const sources = Object.fromEntries(modules.map(path => [path, fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')]));
    const all = Object.values(sources).join('\n');
    // Exported only so the test suite can drive them.
    const testHooks = new Set(['cancelScannerRequests', 'estimateInjectionTokens', 'sameChatOwnerScope', 'pendingNpcStateDurabilityKeys', 'modalTopLayerSupported']);
    const problems = [];
    for (const [path, source] of Object.entries(sources)) {
        for (const match of source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm)) {
            const name = match[1];
            if (!testHooks.has(name) && (all.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length <= 1) problems.push(`${path}: ${name} is never called`);
        }
        for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
            const rest = source.slice(match.index + match[0].length);
            for (const entry of match[1].split(',').map(item => item.trim()).filter(Boolean)) {
                const local = entry.split(' as ').pop().trim();
                if (!new RegExp(`\\b${local}\\b`).test(rest)) problems.push(`${path}: ${local} is imported but unused`);
            }
        }
    }
    assert.deepEqual(problems, []);
});

test('4: the README explains where the body of a multi-form NPC belongs', () => {
    const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.match(readme, /For an NPC with named forms, the body belongs in each form instead/);
});
