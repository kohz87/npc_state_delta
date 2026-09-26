import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const continuityUi = fs.readFileSync(path.join(root, 'continuity-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const dossierUi = fs.readFileSync(path.join(root, 'dossier-ui.js'), 'utf8');

test('present NPC pane uses portrait-first cards that open the launcher dossier', () => {
    assert.match(index, /function inlineRosterHtml/);
    assert.match(index, /class="npc-state-delta-present-grid"/);
    assert.match(index, /class="npc-state-delta-present-card"/);
    assert.match(index, /class="npc-state-delta-present-card-portrait"/);
    assert.match(index, /class="npc-state-delta-present-card-overlay"/);
    assert.doesNotMatch(index, /npc-state-delta-present-card-relation/);
    // One dossier page: cards hand off to the launcher instead of a separate quick viewer.
    assert.doesNotMatch(index + css, /npc-state-delta-viewer|function openNpcViewer|openViewer:/);
    assert.match(index, /function openLauncherDossier\(npcId\)[\s\S]*new CustomEvent\('npc-state-delta:open-dossier', \{ detail: request \}\)/);
    assert.match(index, /eventTargetClosest\(event, '\.npc-state-delta-present-card, \.npc-state-delta-present-chip'\)/);
    assert.match(index, /openDossier: value =>/);
    assert.match(dossierUi, /addEventListener\('npc-state-delta:open-dossier'[\s\S]*event\.detail\.handled = true;[\s\S]*ui\.openNpc\(npcId\)/);
    assert.match(dossierUi, /if \(this\.pendingNpcId\) \{\s*this\.selectedNpcId = this\.pendingNpcId;[\s\S]*this\.filter = 'all';/, 'the requested NPC survives the chat-change reset and is not hidden by a filter');
    assert.match(css, /\.npc-state-delta-present-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(118px, 160px\)\)[^}]*justify-content:\s*start/s);
    assert.match(css, /\.npc-state-delta-present-card\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4/s);
    assert.match(css, /\.npc-state-delta-present-card-overlay\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*0[^}]*background:\s*linear-gradient/s);
});

test('present NPCs in chat support Full, Compact and Off display modes', () => {
    assert.match(index, /presentCastDisplay: 'full'/);
    assert.match(index, /PRESENT_CAST_DISPLAY_MODES = Object\.freeze\(\['full', 'compact', 'off'\]\)/);
    assert.match(index, /assign\('presentCastDisplay', normalizePresentCastDisplay\(settings\.presentCastDisplay\)\)/);
    assert.match(index, /id="npc_state_delta_present_cast_display"[^>]*><option value="full">Full cards<\/option><option value="compact">Compact strip<\/option><option value="off">Off<\/option>/);
    assert.match(index, /function inlineEntriesForRender\(state\) \{\s*\/\/[^\n]*\n\s*if \(presentCastDisplayMode\(\) === 'off'\) return \[\];/);
    assert.match(index, /function startInlineWatchdog\(\) \{[\s\S]*?if \(presentCastDisplayMode\(\) === 'off'\) return stopInlineWatchdog\(\);/);
    assert.match(index, /class="npc-state-delta-present-chip"/);
    assert.match(css, /\.npc-state-delta-present-chips \{ display: flex;[^}]*overflow-x: auto;/);
});


test('present NPC gallery keeps sparse rosters card-sized on tablet instead of stretching to the block', () => {
    assert.match(css, /@media \(min-width: 701px\) and \(max-width: 1180px\)[\s\S]*?\.npc-state-delta-present-grid \{[^}]*grid-template-columns:\s*repeat\(auto-fill, minmax\(145px, 180px\)\)[^}]*justify-content:\s*start/s);
    assert.doesNotMatch(css, /npc-state-delta-present-grid \{[^}]*repeat\(auto-fit, minmax\(145px, 1fr\)\)/s);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.npc-state-delta-present-grid \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
});

test('present cards resolve the current canonical NPC name after identity promotion', () => {
    assert.match(index, /const displayName = npc\.name \|\| 'NPC'/);
    assert.match(index, /Open \$\{escapeHtml\(displayName\)\} dossier/);
});

test('dossier uses trust affection desire tension and strict presence wording', () => {
    assert.match(dossierUi, /RELATIONSHIP_AXES = Object\.freeze\(\[\['trust', 'Trust'\], \['affection', 'Affection'\], \['desire', 'Desire'\], \['tension', 'Tension'\]\]\)/);
    assert.doesNotMatch(dossierUi, /'Respect'/);
    assert.match(index, /filter\(npc => !npc\.archived && npc\.present && !npc\.minor\)/);
    assert.match(index, /Only active NPCs present in the latest scanned scene/);
});

test('relationship tuning exposes baseline, caps, editable rubrics, and delta audit UI', () => {
    for (const id of ['npc_state_delta_base_trust', 'npc_state_delta_base_affection', 'npc_state_delta_base_desire', 'npc_state_delta_base_tension']) assert.match(index, new RegExp(id));
    for (const id of ['npc_state_delta_cap_ordinary', 'npc_state_delta_cap_meaningful', 'npc_state_delta_cap_major', 'npc_state_delta_cap_extreme']) assert.match(index, new RegExp(id));
    assert.match(index, /npc_state_delta_relationship_criteria/);
    assert.match(index, /npc_state_delta_impact_criteria/);
    assert.match(index, /Reset relationship rules/);
    assert.match(dossierUi, /Last relationship change/);
    assert.match(css, /npc-state-delta-rubric-textarea/);
});

test('important memory criteria are editable and resettable from settings', () => {
    assert.match(index, /<h4>Important memories<\/h4>/);
    assert.match(index, /Important memory criteria/);
    assert.match(index, /npc_state_delta_memory_criteria/);
    assert.match(index, /npc_state_delta_reset_memory_rules/);
    assert.match(index, /Reset memory criteria/);
    assert.match(index, /Existing memories are shown to the scanner/i);
    assert.match(index, /Important memories <small>Max 5/i);
    assert.match(index, /cleanEditorList\(editorField\('npc_state_delta_edit_memories'\), IMPORTANT_MEMORY_LIMIT\)/);
});


test('present-only behavior injection and manual dossier editor controls are exposed', () => {
    assert.match(index, /Inject present NPC state/);
    assert.match(index, /npc_state_delta_behavior_criteria/);
    assert.match(index, /Relationship-to-behavior rubric/);
    assert.match(index, /npc-state-delta-roster-edit/);
    assert.match(index, /Save dossier/);
    assert.match(index, /Protect edited stable profile fields/);
    assert.match(index, /Leave off to use manual edits as an organic baseline/);
    assert.match(index, /\$\{locked\.length \? 'checked' : ''\}/);
    assert.match(index, /npc_state_delta_edit_trust/);
    assert.match(index, /npc_state_delta_edit_affection/);
    assert.match(index, /npc_state_delta_edit_desire/);
    assert.match(index, /npc_state_delta_edit_tension/);
    assert.match(index, /npc_state_delta_edit_behavior_profile/);
    assert.match(index, /Behavioral Levers/);
    assert.match(index, /Max \${BEHAVIOR_PROFILE_LIMIT} compact target-general response\/decision rules/);
    assert.match(index, /Player Dynamic/);
    assert.match(index, /Condition \/ Activity/);
    assert.doesNotMatch(index, /npc_state_delta_edit_importance/);
    assert.match(index, /const Popup = ctx\.Popup/);
    assert.match(index, /allowVerticalScrolling: true/);
    assert.match(css, /npc-state-delta-editor-popup/);
});


test('archive lifecycle controls stay reversible while settings roster exposes confirmed hard delete', () => {
    assert.match(index, /Archive confirmed deaths/);
    assert.match(index, /Reactivate on clear return/);
    assert.match(index, /Archived \(\$\{archived\.length\}\)/);
    assert.match(index, /npc-state-delta-archive-npc/);
    assert.match(index, /npc-state-delta-restore-npc/);
    assert.match(index, /npc-state-delta-roster-delete npc-state-delta-delete-npc/);
    assert.match(index, /Delete \${escapeHtml\(npc\.name\)} dossier/);
    assert.match(index, /function deleteNpcById/);
    assert.match(index, /window\.confirm\(message\)/);
    assert.match(index, /commitBranchCheckpoint\(working, targetMessageId, 'manual-delete'\)/);
    assert.match(index, /click\.npcStateDelta', '\.npc-state-delta-delete-npc'/);
    assert.match(index, /keydown\.npcStateDelta', '\.npc-state-delta-delete-npc'/);
    assert.doesNotMatch(index, /npc-state-delta-inline-delete-npc/);
    assert.match(css, /npc-state-delta-archived-roster/);
    assert.match(css, /npc-state-delta-roster-delete/);
    assert.match(css, /npc-state-delta-editor-lifecycle/);
});

test('roster exposes present versus current off-screen World State activity', () => {
    assert.match(index, /npc\.worldActive \? '◌ '/);
    assert.match(index, /current off-screen activity from World State/);
    assert.match(index, /Present Minor NPCs still update and remain eligible for generation injection/);
    assert.match(index, /Active · Off-screen/);
});


test('generation injection budget is player-configurable in settings', () => {
    assert.match(index, /npc_state_delta_inject_budget/);
    assert.match(index, /Injection budget/);
    assert.match(index, /Approximate hard ceiling/);
});


test('relationship UI is bipolar around neutral zero and legacy audit values are finite-filtered', () => {
    for (const id of ['npc_state_delta_base_trust', 'npc_state_delta_base_affection', 'npc_state_delta_base_desire', 'npc_state_delta_base_tension']) {
        assert.match(index, new RegExp(`${id}[^>]*min=\"-100\"[^>]*max=\"100\"`));
    }
    for (const id of ['npc_state_delta_edit_trust', 'npc_state_delta_edit_affection', 'npc_state_delta_edit_desire', 'npc_state_delta_edit_tension']) {
        assert.match(index, new RegExp(`${id}[^>]*min=\"-100\"[^>]*max=\"100\"`));
    }
    assert.match(index, /Number\.isFinite\(value\)/);
});


test('dossier exposes species/race, age, form-owned appearance, and portrait generation controls', () => {
    assert.match(index, /npc_state_delta_edit_species/);
    assert.match(index, /Species \/ Race/);
    assert.match(index, /npc_state_delta_edit_home_base/);
    assert.match(index, /Home Base \/ Usual Location/);
    assert.match(index, /npc_state_delta_edit_age/);
    assert.match(index, /npc_state_delta_edit_apparent_age/);
    assert.match(index, /Apparent age/);
    assert.doesNotMatch(index, /npc_state_delta_edit_appearance/);
    assert.match(continuityUi, /Appearance forms/);
    assert.match(continuityUi, /Apply appearance forms/);
    assert.match(continuityUi, /Shared appearance/);
    assert.match(continuityUi, /Current form/);
    assert.match(index, /Age:/);
    assert.match(index, /buildNpcPortraitPrompts/);
    assert.match(index, /npc_state_delta_portrait_style_positive[^\n]+maxlength=\"\$\{PORTRAIT_STYLE_PROMPT_LIMIT\}\"/);
    assert.match(index, /npc_state_delta_portrait_style_negative[^\n]+maxlength=\"\$\{PORTRAIT_STYLE_PROMPT_LIMIT\}\"/);
    assert.match(index, /npc_state_delta_portrait_composition[^\n]+maxlength=\"\$\{PORTRAIT_COMPOSITION_PROMPT_LIMIT\}\"/);
    assert.match(index, /npc_state_delta_edit_portrait_positive[^\n]+maxlength=\"\$\{PORTRAIT_NPC_PROMPT_LIMIT\}\"/);
    assert.match(index, /npc_state_delta_edit_portrait_negative[^\n]+maxlength=\"\$\{PORTRAIT_NPC_PROMPT_LIMIT\}\"/);
    assert.doesNotMatch(index, /npc_state_delta_portrait_style_(?:positive|negative)[^\n]+maxlength=\"2400\"/);
    assert.match(fs.readFileSync(path.join(root, 'portrait-tools.js'), 'utf8'), />Generate Portrait<\/button>/);
    assert.doesNotMatch(index, /<b>Current thoughts<\/b>|Thought basis|npc_state_delta_edit_thought/i);
});

test('scanner uses current-exchange auto context and keeps wider history for manual scans', () => {
    assert.match(index, /function currentExchangeTranscript/);
    assert.match(index, /const fullWindowScan = Boolean\(!manual && settings\.fullScanEveryTurn\)/);
    assert.match(index, /\(manual \|\| fullWindowScan\) \? recentTranscript\(settings\.scanDepth\) : currentTranscript/);
    assert.match(index, /SCAN_RESPONSE_LENGTH = 1800/);
    assert.match(index, /FULL_SCAN_RESPONSE_LENGTH = 3200/);
    assert.match(index, /fullWindowScan \? FULL_SCAN_RESPONSE_LENGTH : SCAN_RESPONSE_LENGTH/);
    assert.match(index, /BACKFILL_RESPONSE_LENGTH = 3200/);
    assert.match(index, /JSON_RETRY_RESPONSE_LENGTH = 5200/);
    assert.match(index, /CRITICAL COMPACT JSON RETRY/);
    assert.match(index, /'Scan context'/);
    assert.match(index, /Full scan every turn/);
    assert.match(index, /Quick automatic scans read only the latest user \+ assistant exchange/);
    assert.match(index, /settings\.fullScanEveryTurn \|\| state\.assistantSinceScan >= settings\.scanEvery/);
    assert.match(index, /prepareFullWindowRelationshipEvaluation\(resolvedParsed, state\.npcs\)/);
    assert.match(index, /runFocusedRelationshipPass\(\s*ctx,\s*fullWindowRelationship\.evaluation,\s*state\.npcs,\s*currentTranscript \|\| transcript,\s*settings,\s*\{ currentExchangeOnly: manual \|\| fullWindowScan, requestScope: operation\.requestScope \},\s*\)/);
    assert.match(index, /npc_state_delta_admission_mode/);
    assert.match(index, /Conservative/);
    assert.match(index, /Balanced/);
    assert.match(index, /Manual only/);
    assert.match(index, /processPendingBackfills/);
    assert.match(index, /targeted dossier backfill extractor|dossier backfill scanner/);
});


test('inline card truth follows merged presence and settings roster editor uses direct mobile-safe binding', () => {
    assert.match(index, /function scanInlineNpcIds\(_parsed, merged\)/);
    assert.doesNotMatch(index, /const touched = new Set/);
    assert.match(index, /recordInlineCardsInState\(nextState, targetMessageId, \[finalNpc\.id\], 'dossier-backfill'\)/);
    assert.match(index, /removeNpcInlineCardAtMessage/);
    assert.match(index, /function wireSettingsRosterEditor/);
    assert.match(index, /querySelectorAll\('\.npc-state-delta-roster-edit'\)/);
    assert.match(index, /addEventListener\?\.\('pointerup'/);
    assert.match(index, /document\.addEventListener\('touchend'/);
    assert.match(index, /event\.stopImmediatePropagation\?\.\(\)/);
    assert.match(index, /role="button" tabindex="0"[^>]*npc-state-delta-roster-edit|npc-state-delta-roster-edit" role="button" tabindex="0"/);
    assert.match(index, /const Popup = ctx\.Popup/);
    assert.match(index, /new Popup\(content, POPUP_TYPE\.TEXT/);
    assert.match(index, /large: true/);
    assert.match(index, /allowVerticalScrolling: true/);
    assert.doesNotMatch(index, /overlay\.style\.zIndex = '2147483000'/);
    assert.match(css, /npc-state-delta-editor-popup/);
    assert.equal((index.match(/id="npc_state_delta_edit_personality"/g) || []).length, 1, 'editor must not render duplicate Personality controls');
});


test('UI integration remounts inline cards on SillyTavern render lifecycle and captures roster editor clicks', () => {
    assert.match(index, /CHARACTER_MESSAGE_RENDERED/);
    assert.match(index, /MORE_MESSAGES_LOADED/);
    assert.match(index, /MESSAGE_UPDATED/);
    assert.match(index, /INLINE_RENDER_RETRY_DELAYS/);
    assert.match(index, /function inlineEntriesForRender/);
    assert.match(index, /live-present-grid/);
    assert.match(index, /function installUiCaptureBridge/);
    assert.match(index, /document\.addEventListener\('pointerup', activatePresentCardFromEvent, true\);/);
    assert.match(index, /document\.addEventListener\('pointerup', activateNpcEditorFromEvent, true\);/);
    assert.match(index, /document\.addEventListener\('click', activatePresentCardFromEvent, true\);/);
    assert.match(index, /document\.addEventListener\('click', activateNpcEditorFromEvent, true\);/);
    assert.match(index, /document\.addEventListener\('touchend'/);
    assert.match(index, /eventTargetClosest\(event, '\.npc-state-delta-roster-edit'\)/);
    assert.match(index, /class="menu_button npc-state-delta-roster-edit"/);
    assert.match(index, /\$\(document\)\.on\('click\.npcStateDelta', '\.npc-state-delta-roster-edit'/);
    assert.match(index, /uiStatus:/);
});

test('visible inline rendering is latest-scene present cast only while historical snapshots remain internal', () => {
    assert.match(index, /Visible NPC State Delta is a live present-cast view, not a historical dossier timeline/);
    assert.match(index, /const latestAssistantId = latestMessageId\(true\)/);
    assert.match(index, /filter\(npc => !npc\.archived && npc\.present && !npc\.minor\)/);
    assert.match(index, /return \[\{[\s\S]*reason: 'live-present-grid'/s);
    assert.doesNotMatch(index, /function inlineEntriesForRender\(state\) \{[\s\S]*state\.inlineCards\.map/s);
});

test('inline renderer self-heals host redraws without destructive full remounts', () => {
    assert.match(index, /new globalThis\.MutationObserver/);
    assert.match(index, /inlineMountNeedsRepair/);
    assert.match(index, /startInlineWatchdog/);
    assert.match(index, /existingById/);
    assert.match(index, /if \(!anchor\) \{/);
    assert.match(index, /else if \(anchor\.innerHTML !== html\)/);
    assert.doesNotMatch(index, /querySelectorAll\?\.\('\.npc-state-delta-inline-anchor'\)\.forEach\(node => node\.remove\(\)\)/);
});

test('Megumin master block receives Present NPCs as an in-card tab with standalone fallback preserved', () => {
    assert.match(index, /function mountNpcStateInsideMeguminBlock/);
    assert.match(index, /querySelector\?\.\('\.meg-blocks'\)|querySelector\('\.meg-blocks'\)/);
    assert.match(index, /\.meg-blocks-tabs/);
    assert.match(index, /\.meg-blocks-panel/);
    assert.match(index, /className = 'meg-blocks-tab npc-state-delta-megumin-tab'/);
    assert.match(index, /className = 'meg-block-body npc-state-delta-megumin-pane'/);
    assert.match(index, /pane\.dataset\.key = button\.dataset\.key/);
    assert.match(index, /npcStateDeltaSnapshotSignature/);
    assert.match(index, /closest\('\.npc-state-delta-inline-anchor, \.npc-state-delta-megumin-pane'\)/);
    assert.match(index, /<span class="meg-blocks-tab-label">Present NPCs<\/span>/);
    assert.match(index, /button\.title = 'Present NPCs'/);
    assert.match(index, /mountNpcStateInsideMeguminBlock\(message, messageId, html\)/);
    assert.match(index, /anchor\?\.remove\?\.\(\)/, 'successful Megumin integration should remove the duplicate standalone card');
    assert.match(index, /className = 'npc-state-delta-inline-anchor'/, 'standalone rendering remains the fallback when no Megumin block exists');
    assert.match(index, /cleanupStaleMeguminIntegrations/);
    assert.match(index, /integratedMeguminBlocks:/);
    assert.match(css, /\.npc-state-delta-megumin-pane\s*\{/);
    assert.match(css, /\.npc-state-delta-megumin-tab\s*\{/);
});

test('Megumin integration never rewrites canonical message text and reattaches through the existing render watchdog', () => {
    assert.doesNotMatch(index, /message\.mes\s*=.*NPC_State|\.mes\s*\+=.*NPC_State|<NPC_State>/s);
    assert.match(index, /new globalThis\.MutationObserver/);
    assert.match(index, /\.npc-state-delta-megumin-pane/);
    assert.match(index, /inlineMountNeedsRepair/);
    assert.match(index, /CHARACTER_MESSAGE_RENDERED/);
    assert.match(index, /MESSAGE_UPDATED/);
});

test('compact Megumin World State preserves omitted off-screen activity while still resetting physical presence', () => {
    assert.match(index, /hasCompactMeguminWorldState/);
    assert.match(index, /if \(!compactWorldStateTurn\) npc\.worldActive = false/);
    assert.match(index, /preserveWorldActive: compactWorldStateTurn/);
});

test('per-NPC Scan dossier workflow and Key Relationships controls are exposed', () => {
    assert.match(index, /function findMeguminDossierSources/);
    assert.match(index, /async function scanNpcDossier/);
    assert.match(index, /<\(New_NPC\|NPC_Update\)/);
    assert.match(index, /npc-state-delta-scan-dossier/);
    assert.match(index, /Scan dossier/);
    assert.match(index, /npc-state-delta-refresh-chat/);
    assert.match(index, /Refresh from Chat/);
    assert.match(index, /async function refreshNpcFromChat/);
    assert.match(index, /recentTranscript\(settings\.scanDepth\)/);
    assert.match(index, /skipRelationshipUpdate: true/);
    assert.match(index, /no matching Megumin dossier block found.*scanning recent story context instead/i);
    assert.match(index, /dossier-import/);
    assert.match(index, /npc_state_delta_edit_key_relationships/);
    assert.match(index, /Key relationships/);
    assert.match(index, /cleanEditorList\(editorField\('npc_state_delta_edit_key_relationships'\), KEY_RELATIONSHIP_LIMIT\)/);
    assert.match(index, /keyRelationships: \[\.\.\.\(npc\.keyRelationships \|\| \[\]\)\]/);
    assert.match(dossierUi, /Important bonds/);
});


test('stale NPC lifecycle is configurable and recurring NPCs can be protected', () => {
    assert.match(index, /npc_state_delta_auto_prune_stale/);
    assert.match(index, /Auto-manage stale NPCs/);
    assert.match(index, /npc_state_delta_stale_archive_after/);
    assert.match(index, /npc_state_delta_stale_delete_after/);
    assert.match(index, /staleArchiveAfter:\s*30/);
    assert.match(index, /staleDeleteAfter:\s*50/);
    assert.match(index, /applyStaleLifecycleAfterScan/);
    assert.match(index, /Archived dossiers do not use an active slot/);
    assert.match(index, /npc_state_delta_edit_retention_protected/);
    assert.match(index, /Keep this NPC from automatic stale cleanup/);
    assert.match(index, /retentionProtected/);
    assert.match(index, /Deleted stale NPCs can be rediscovered if they return/);
});

test('minor NPC toggle hides portrait cards without disabling dossier tracking', () => {
    assert.match(index, /npc_state_delta_edit_minor/);
    assert.match(index, /Hide present-NPC card/);
    assert.match(index, /!npc\.minor/);
    assert.match(index, /next\.minor = Boolean/);
    assert.match(index, /still scans, updates, stores memories\/relationships, and injects when present/);
});


test('v0.2 portrait generation settings expose theme, positive/negative prompts, and backend-neutral controls', () => {
    for (const id of [
        'npc_state_delta_portrait_generation_enabled',
        'npc_state_delta_portrait_theme_preset',
        'npc_state_delta_portrait_style_positive',
        'npc_state_delta_portrait_style_negative',
        'npc_state_delta_portrait_composition',
        'npc_state_delta_portrait_prompt_format',
        'npc_state_delta_portrait_use_mood',
        'npc_state_delta_portrait_use_location',
        'npc_state_delta_portrait_save_gallery',
    ]) assert.match(index, new RegExp(id));
    assert.match(index, /SillyTavern Image Generation/i);
    assert.match(index, /Fantasy Anime/);
    assert.match(index, /Anime Key Visual/);
    assert.match(index, /Painterly Fantasy/);
    assert.match(index, /Dark Medieval/);
    assert.match(index, /Semi-Realistic/);
    assert.doesNotMatch(index, /sampler[^\n]*<select|checkpoint[^\n]*<select|cfg[^\n]*<input/i, 'NPC State Delta should not duplicate native backend controls');
});

test('portrait generator is a review-before-apply workflow with per-NPC prompt overrides', () => {
    assert.match(index, /function portraitGeneratorHtml/);
    assert.match(index, /npc-state-delta-portrait-generator-preview/);
    assert.match(index, /id="npc_state_delta_portrait_positive"/);
    assert.match(index, /id="npc_state_delta_portrait_negative"/);
    assert.match(index, /Reset from dossier/);
    assert.match(index, /> Generate</);
    assert.match(index, /Use as Portrait/);
    assert.match(index, /npc_state_delta_edit_portrait_positive/);
    assert.match(index, /npc_state_delta_edit_portrait_negative/);
    assert.match(index, /npc_state_delta_edit_portrait_replace/);
    assert.match(index, /portraitPromptPositive/);
    assert.match(index, /portraitPromptNegative/);
    assert.match(index, /portraitPromptReplace/);
    assert.match(css, /\.npc-state-delta-portrait-generator-overlay\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/s);
    assert.match(css, /@media \(min-width: 701px\) and \(max-width: 1180px\)[\s\S]*?\.npc-state-delta-portrait-generator-dialog\s*\{[^}]*width:\s*100vw;[^}]*height:\s*100dvh/s);
});

test('native portrait bridge uses quiet SillyTavern imagine command and separate negative prompt', () => {
    assert.match(index, /executeSlashCommandsWithOptions/);
    assert.match(index, /'\/imagine'/);
    assert.match(index, /'quiet=true'/);
    assert.match(index, /gallery=\$\{settings\.portraitSaveToGallery/);
    assert.match(index, /negative=\$\{slashQuoted\(negative\)\}/);
    assert.match(index, /result\?\.pipe/);
    assert.match(index, /portraitFileFromGeneratedUrl/);
    assert.match(index, /compressPortrait\(file\)/);
});


test('portrait generator top layer stays above the full-screen dossier on tablet and mobile', () => {
    const dossier = dossierUi.match(/\.delta-panel \{\s*position: fixed; z-index: (\d+)/);
    const generator = css.match(/\.npc-state-delta-portrait-generator-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/);
    assert.ok(dossier, 'dossier panel z-index should be explicit');
    assert.ok(generator, 'portrait generator z-index should be explicit');
    assert.ok(Number(generator[1]) > Number(dossier[1]), `portrait generator (${generator[1]}) must sit above dossier (${dossier[1]})`);
    assert.match(index, /overlay\.style\.zIndex\s*=\s*'2147483600'/);
});
test('settings panel buttons override the host min-content button width', () => {
    // SillyTavern's .menu_button is width:min-content, which stacks each word of a label inside a grid cell.
    assert.match(css, /\.delta-settings-quick-actions \.menu_button,\n#npc_state_delta_settings \.npc-state-delta-custom-preset-actions \.menu_button,\n#npc_state_delta_settings \.delta-settings-maintenance-actions > \.menu_button \{ width: 100%; \}/);
    assert.match(css, /\.npc-state-delta-calendar-actions > \.menu_button,\n#npc_state_delta_settings \.delta-settings-danger > \.menu_button \{ width: auto; white-space: nowrap; \}/);
});
