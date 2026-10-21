import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
// (cleanup step 10) The focused relationship pass moved to src/relationship-pass.js.
const passSource = fs.readFileSync(new URL('../src/relationship-pass.js', import.meta.url), 'utf8');

test('v0.2.23 relationship repair targets current-exchange NPCs even when broad scan omits them', () => {
    assert.match(passSource, /currentExchangeRelationshipRelevant/);
    assert.match(passSource, /transcriptMentionsNpcRecord\(transcript, npc\)/);
    // (1.2.12) A returned row is judged by its decision; an omitted NPC is a target unless a one-pass block says it covered everyone.
    assert.match(passSource, /if \(raw\) return !hasCompletePrimaryRelationshipDecision\(raw, transcript\);\s*return options\.covered !== true;/);
    assert.match(passSource, /for \(let offset = 0; offset < targets\.length; offset \+= 4\)/);
    const relationshipPassSource = passSource.slice(
        passSource.indexOf('async function runFocusedRelationshipPass'),
        passSource.indexOf('function suppressPrimaryRelationshipForFocusedDecisions'),
    );
    assert.ok(relationshipPassSource.length > 1000);
    assert.doesNotMatch(relationshipPassSource, /\.slice\(0,\s*4\)/);
});

test('new NPC admission enriches only the newly admitted dossiers while omitted current participants still get continuity repair', () => {
    assert.doesNotMatch(source, /deepSweep: true/);
    assert.match(source, /state\.pendingBackfills\.length > 100/);
    assert.match(source, /touchedIds = new Set/);
    assert.match(source, /!npcParticipatesInExchange\(npc, nextState\.npcs \|\| \[\], currentTranscript \|\| '', \{ includeRole: false \}\)/);
    assert.match(source, /for \(const id of newlyAdmittedIds\)/);
    assert.match(source, /const admitted = nextState\.npcs\.find\(npc => npc\.id === id && !npc\.archived\)/);
    assert.match(source, /queueNpcBackfillInState\(nextState, admitted\.id, admitted\.name, targetMessageId/);
    assert.match(source, /reason: 'missed-participant'/);
    assert.match(source, /reason: 'new-admission'/);
    assert.match(source, /queueVersion: AUTOMATIC_BACKFILL_QUEUE_VERSION/);
    assert.match(source, /\.map\(normalizeAutomaticBackfillRequest\)/);
    assert.match(source, /automaticBackfillStillRelevant\(request, target, state\.npcs, owningExchange\)/);
    assert.match(source, /AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT/);
    assert.match(source, /const missedParticipants = \[\]/);
    assert.match(source, /missedParticipants\.length <= AUTOMATIC_MISSED_PARTICIPANT_REPAIR_LIMIT/);
    assert.match(source, /suppressed automatic per-NPC continuity fan-out after broad scan omitted multiple apparent participants/);
    assert.doesNotMatch(source, /cast topology change is a natural checkpoint for a deeper continuity sweep/i);
});

test('v0.2.23 manual and full-window scans scrub rolling relationship output and evaluate only the current exchange', () => {
    assert.match(source, /const fullWindowRelationship = \(manual \|\| fullWindowScan\)/);
    assert.match(source, /currentExchangeOnly: manual \|\| fullWindowScan/);
    assert.match(passSource, /if \(currentExchangeOnly\) return false/);
    const relevance = passSource.slice(
        passSource.indexOf('function currentExchangeRelationshipRelevant'),
        passSource.indexOf('function rawScanMatchesExisting'),
    );
    assert.ok(relevance.length > 200);
    assert.doesNotMatch(relevance, /npc\.present \|\| npc\.worldActive/);
});

test('v0.2.23 portrait settings use explicit transactional Save', () => {
    assert.match(source, /id="npc_state_delta_save_portrait_settings"/);
    assert.match(source, /async function savePortraitSettingsDraft/);
    assert.match(source, /await saveHostSettings\(\)/);
    assert.match(source, /Object\.assign\(settings, before\)/);
    assert.match(source, /Unsaved changes/);
    assert.match(source, /Fantasy Anime defaults loaded as an unsaved portrait-settings draft/);
});
