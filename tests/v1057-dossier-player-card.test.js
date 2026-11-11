import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dossierDetailProjection, lastRelationshipChangeHtml } from '../dossier-ui.js';
import { dossierUiSource } from './helpers/dossier-ui-source.js';

const npc = {
    id: 'elia', name: 'Elia',
    relationship: { trust: 12, affection: 8, desire: 0, tension: -3 },
    lastRelationshipChange: {
        impact: 'ordinary', delta: { trust: 1, affection: 0, desire: 0, tension: -2 },
        reason: "Noc's command enabled her to successfully execute her mark and survive the ambush.",
        sourceMessageId: 140, turn: 71, evidence: { trust: 'followed his command' },
    },
    relationshipEventHistory: [
        { impact: 'meaningful', reason: 'He shielded her from the thug.', turn: 60 },
        { impact: 'ordinary', reason: "Noc's command enabled her to successfully execute her mark and survive the ambush.", turn: 71 },
    ],
};

test('the player card projects the last relationship change with its reason and signed deltas', () => {
    const projected = dossierDetailProjection(npc);
    assert.deepEqual(projected.lastRelationshipChange, {
        impact: 'ordinary', delta: { trust: 1, affection: 0, desire: 0, tension: -2 }, reason: npc.lastRelationshipChange.reason, turn: 71,
        message: null, when: 'Turn 71',
    });
    assert.deepEqual(projected.recentRelationshipChanges.map(item => item.turn), [71, 60], 'newest first, reason/impact/turn only');
    assert.equal('evidence' in projected.recentRelationshipChanges[0], false);

    const html = lastRelationshipChangeHtml(projected.lastRelationshipChange);
    assert.match(html, /Last relationship change/);
    assert.match(html, />Ordinary</);
    assert.match(html, /Turn 71/);
    assert.match(html, /Trust \+1/);
    assert.match(html, /Tension -2/);
    assert.doesNotMatch(html, /Affection|Desire/, 'unchanged axes are not listed');
    assert.match(html, /Noc&#039;s command enabled her/, 'the reason is escaped');
});

test('the player card states when no change or only progress was recorded', () => {
    assert.match(lastRelationshipChangeHtml(dossierDetailProjection({ id: 'x', name: 'X' }).lastRelationshipChange), /No relationship change recorded yet/);
    const progress = dossierDetailProjection({ id: 'y', name: 'Y', lastRelationshipChange: { impact: 'ordinary', delta: {}, reason: 'Small kindness.', turn: 3 } });
    assert.match(lastRelationshipChangeHtml(progress.lastRelationshipChange), /Progress only · no point change/);
});

test('the dossier layout keeps portrait emphasis, section jumps and compact dead cards', () => {
    const ui = dossierUiSource();
    const experience = fs.readFileSync(new URL('../dossier-experience-styles.js', import.meta.url), 'utf8');
    // The portrait is the dial's centre (a tap opens the profile) and fills the profile's left column; a tap there opens it full size.
    assert.match(ui, /data-delta-screen="profile"/);
    assert.match(ui, /img\.delta-profile-image/);
    assert.match(ui, /openLightbox\(\)/);
    assert.match(ui, /data-delta-section="\$\{esc\(tile\.section\)\}"/, 'a tile opens its section');
    assert.match(ui, /data-bucket="\$\{escapeHtml\(npc\.bucket \|\| ''\)\}"/);
    assert.doesNotMatch(experience, /delta-cast-card|delta-hero/, 'the old rail and hero rules are gone');
    // Desktop: the board beside a section; the profile is two columns with the portrait on the left.
    assert.match(ui, /\.delta-profile \{ grid-template-columns:minmax\(0,\.8fr\) minmax\(0,1\.2fr\); gap:0; padding:0;/);
});
