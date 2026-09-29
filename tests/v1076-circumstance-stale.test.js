import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileRefreshPrompt, buildScannerPrompt, normalizeNpcRecord } from '../core.js';

function elena(fieldChanges, extra = {}) {
    return normalizeNpcRecord({
        name: 'Elena',
        role: 'Owner and Innkeeper of The Grey Post',
        personality: 'Guarded, quiet, and deeply submissive under constant mistreatment.',
        speech: 'Quiet, hesitant, and guarded.',
        behaviorProfile: ['Disposition: docile - endures mistreatment and orders in quiet, submissive silence'],
        background: 'Daughter of the late Master Corin; reclaimed her inn from her aunt.',
        fieldChanges,
        ...extra,
    });
}

const hint = prompt => prompt.split('\n').find(line => line.startsWith('Stored ')) || '';

test('v1.0.76 Refresh re-checks stable fields written before a later change of circumstances', () => {
    const npc = elena({ behaviorProfile: 7, background: 18 });
    const line = hint(buildProfileRefreshPrompt({ transcript: '[m70] Elena counts coin.', targetNpc: npc, turn: 29 }));
    assert.match(line, /^Stored personality\/speech\/behaviorProfile predate later background\/home changes:/, 'fields set at creation count as older than any later change');
    const home = hint(buildProfileRefreshPrompt({ transcript: '[m70] x', targetNpc: elena({ personality: 10, speech: 10, behaviorProfile: 10, homeBase: 12 }) }));
    assert.match(home, /^Stored personality\/speech\/behaviorProfile predate/, 'a home-base change counts without a turn');
});

test('v1.0.76 fields updated after the circumstance change are not named', () => {
    const npc = elena({ personality: 20, speech: 20, behaviorProfile: 7, background: 18 });
    assert.match(hint(buildProfileRefreshPrompt({ transcript: '[m70] x', targetNpc: npc, turn: 29 })), /^Stored behaviorProfile predate/);
    const current = elena({ personality: 20, speech: 20, behaviorProfile: 20, background: 18 });
    assert.equal(hint(buildProfileRefreshPrompt({ transcript: '[m70] x', targetNpc: current, turn: 29 })), '');
    const locked = elena({ background: 18 }, { manualProfileFields: ['personality', 'speech', 'behaviorProfile'] });
    assert.equal(hint(buildProfileRefreshPrompt({ transcript: '[m70] x', targetNpc: locked, turn: 29 })), '', 'protected fields are never named');
    assert.equal(hint(buildProfileRefreshPrompt({ transcript: '[m70] x', targetNpc: elena({}), turn: 29 })), '', 'no recorded circumstance change, no hint');
});

test('v1.0.76 scanner and Refresh prompts ask for labelled lever evidence', () => {
    const npc = elena({});
    assert.match(buildProfileRefreshPrompt({ transcript: '[m70] x', targetNpc: npc }), /"Label: level - effect" levers \(evidence items too\)/);
    assert.match(buildScannerPrompt({ transcript: 'Elena counts coin.', existingNpcs: [npc] }), /"Label: level - effect" levers \(evidence too\)/);
});
