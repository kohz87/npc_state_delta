import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { relationshipStepHtml } from '../dossier-ui.js';

const change = { impact: 'meaningful', delta: { trust: 3, affection: 0, desire: 0, tension: 2 }, reason: 'She trusted him with the key.', message: 14 };

test('v1.2.15 a meter shows the change the latest reply made: ▲ up, ▼ down, tension rising reads as bad', () => {
    const trust = relationshipStepHtml('trust', 'Trust', change, 14);
    assert.match(trust, />▲3<\/span>$/);
    assert.match(trust, /delta-rel-step-good/);
    assert.match(trust, /title="Trust up 3 since the last reply \(reply #14\)"/);
    const tension = relationshipStepHtml('tension', 'Tension', change, 14);
    assert.match(tension, />▲2</);
    assert.match(tension, /delta-rel-step-bad/, 'more tension is worse');
    const down = relationshipStepHtml('trust', 'Trust', { ...change, delta: { trust: -2 } }, 14);
    assert.match(down, />▼2</);
    assert.match(down, /delta-rel-step-bad/);
    assert.match(relationshipStepHtml('tension', 'Tension', { ...change, delta: { tension: -4 } }, 14), /delta-rel-step-good/, 'tension easing is good');
});

test('v1.2.15 nothing beside a meter when the axis did not move, or the change is from an older reply', () => {
    assert.equal(relationshipStepHtml('affection', 'Affection', change, 14), '');
    assert.equal(relationshipStepHtml('trust', 'Trust', change, 16), '', 'an older change is history, shown below the meters');
    assert.equal(relationshipStepHtml('trust', 'Trust', { ...change, message: null, turn: 9 }, 14), '', 'a legacy turn-stamped change has no reply to compare');
    assert.equal(relationshipStepHtml('trust', 'Trust', null, 14), '');
    assert.equal(relationshipStepHtml('trust', 'Trust', change, null), '');
});

test('v1.2.15 the meters pass the last change and the latest reply; settings fold the rarely touched ones under Advanced', () => {
    const ui = fs.readFileSync(new URL('../dossier-ui.js', import.meta.url), 'utf8');
    assert.match(ui, /relationshipAxis\(label, selected\.relationship\[axis\], axis, selected\.lastRelationshipChange, this\.projection\?\.reply\)/);
    const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const advanced = index.match(/const advanced = \[([\s\S]*?)\]\.join\(''\);/)?.[1] ?? '';
    for (const id of ['npc_state_delta_scan_depth', 'npc_state_delta_inject_budget', 'npc_state_delta_mid_delete_rewind', 'npc_state_delta_branch_rescan']) {
        assert.ok(advanced.includes(`'${id}'`), `${id} is under Advanced`);
        assert.equal(index.split(`settingRow('${id}'`).length - 1, 1, `${id} appears once`);
    }
    assert.match(advanced, /settingsSlot\('scanner-output'\)/, 'Maximum output tokens mounts under Advanced');
    assert.match(index, /settingsGroup\('advanced', 'Advanced', /);
});
