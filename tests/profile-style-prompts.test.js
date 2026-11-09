// The scanner writes people the way the cast is written: each prompt that describes the profile fields carries the
// one shared style line (voice with a line, personality with a tension, behaviour with the act, a physical habit),
// the evidence rule stays, examples are generic and valid, and old and new behaviorProfile entries both parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfillPrompt, buildDossierImportPrompt, buildNarrationCaptureParts, buildProfileRefreshPrompt, buildScannerPrompt, DURABLE_PROFILE_LIMITS, normalizeNpcRecord } from '../core.js';
import { PROFILE_STYLE_LINE } from '../core-prompts-targeted.js';
import { normalizeBehaviorProfile, isBehaviorLever } from '../core-behavior.js';

const npc = normalizeNpcRecord({ id: 'npc_myla', name: 'Myla Venn' });
const transcript = '[m1] Myla set the cup down. "Sit, I\'ll pour."';
const prompts = {
    scanner: buildScannerPrompt({ transcript }),
    capture: buildNarrationCaptureParts({ transcript, compactCapture: true }).rules,
    captureFull: buildNarrationCaptureParts({ transcript }).rules,
    backfill: buildBackfillPrompt({ transcript, targetName: 'Myla Venn', existingNpc: npc }),
    import: buildDossierImportPrompt({ dossierText: 'Name: Myla', targetName: 'Myla Venn', existingNpc: npc }),
    refresh: buildProfileRefreshPrompt({ transcript, targetNpc: npc }),
};

test('every prompt that describes the profile fields carries the style instructions and the evidence line', () => {
    for (const [name, prompt] of Object.entries(prompts)) {
        assert.ok(prompt.includes(PROFILE_STYLE_LINE), `${name} carries the style line`);
    }
    for (const part of ['one short line in their words', 'tension or reason under the surface', 'Label: level - what they do', 'one physical habit', 'quoted evidence', 'unsupported = leave out']) {
        assert.ok(PROFILE_STYLE_LINE.includes(part), part);
    }
    assert.ok(PROFILE_STYLE_LINE.length < 400, `style line is ${PROFILE_STYLE_LINE.length} chars`);
});

test('the identity firewall stays beside the style line', () => {
    assert.match(prompts.capture, /Mood, stress, intimacy, injury or relationship-specific behaviour never becomes global/);
    assert.match(prompts.scanner, /IDENTITY FIREWALL/);
});

test('the prompt examples are valid JSON, within the limits, generic and sexual-content free', () => {
    const balanced = (text, from) => {
        let depth = 0, inString = false;
        for (let i = from; i < text.length; i++) {
            const c = text[i];
            if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
            if (c === '"') inString = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
        }
        return '';
    };
    for (const text of [prompts.capture, prompts.scanner]) {
        const example = JSON.parse(balanced(text, text.indexOf('{"id":"npc_myla"')));
        assert.ok(example.speech.length <= DURABLE_PROFILE_LIMITS.speech);
        assert.ok(example.speech.includes("Sit, I'll pour."));
        assert.deepEqual(example.evidence.speech, ["'Sit, I'll pour.'"]);
    }
    for (const prompt of Object.values(prompts)) {
        assert.doesNotMatch(prompt, /Ersveil|Aldric|Kaelen/i);
    }
    assert.doesNotMatch(PROFILE_STYLE_LINE, /sex|nude|erotic/i);
});

test('an old "Label: level" and a new "Trait: level - act" entry both parse, display and fit the limit', () => {
    const oldEntry = 'Care: high';
    const newEntry = 'Threat: high - vets every stranger at the door before she lets them in';
    assert.ok(newEntry.length <= DURABLE_PROFILE_LIMITS.behaviorProfile);
    assert.deepEqual(normalizeBehaviorProfile([oldEntry, newEntry]), [oldEntry, newEntry]);
    assert.ok(isBehaviorLever(newEntry));
    const record = normalizeNpcRecord({ id: 'npc_a', name: 'A', behaviorProfile: [oldEntry, newEntry] });
    assert.deepEqual(record.behaviorProfile, [oldEntry, newEntry]);
});
