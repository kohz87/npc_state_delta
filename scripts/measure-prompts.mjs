import assert from 'node:assert/strict';
import { buildScannerPrompt, buildProfileRefreshPrompt, buildInjection, buildNarrationCapturePrompt, buildNarrationCaptureParts } from '../core.js';
import { createNpcPart } from '../src/npc-meters.js';

// Same short source scenes used in the legacy/Beta comparison. No provider calls.
const cases = [
  { name: 'minimal-one-npc', npcs: [{ id: 'vrena', name: 'Vrena Tolk', present: true, speech: 'Formal.' }], user: 'I ask what to sign.', assistant: 'Vrena Tolk answers with clipped practical instructions.' },
  { name: 'rich-first-encounter', npcs: [], user: 'I approach the registration desk and ask for field work.', assistant: 'Vrena Tolk, a slender young woman in a wool waistcoat over ink-stained linen sleeves, catches the ledger before it slides. “Name first. Then the south-trail form.” She taps the signature line with a carved bone bodkin and waits with her arms crossed behind the Rimecross Adventurer Guild counter.' },
];
function estimateTokens(value) {
  const text = String(value);
  const nonAscii = [...text].filter(char => char.codePointAt(0) > 127).length;
  return Math.ceil((text.length - nonAscii) / 3.5 + nonAscii * 1.1);
}
function commonPrefixChars(a, b) {
  const left = String(a), right = String(b);
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}
function requestText(systemPrompt, userPrompt) {
  return `${String(systemPrompt)}\n${String(userPrompt)}`;
}
const system = "You are NPC State Delta's isolated dossier scanner. Use only the supplied scanner payload. Return only the requested JSON object.";
const refreshSystem = "You are NPC State Delta's targeted dossier reconciliation scanner. Re-read the supplied recent-story window for exactly one existing NPC. Return only the requested JSON object.";
for (const fixture of cases) {
  const transcript = `USER: ${fixture.user}\nASSISTANT: ${fixture.assistant}`;
  const prompt = buildScannerPrompt({ transcript, currentTranscript: transcript, existingNpcs: fixture.npcs, userName: 'Ari', charName: 'Character' });
  console.log(JSON.stringify({ name: fixture.name, charsIncludingSystem: prompt.length + system.length, estimatedInputTokens: estimateTokens(prompt) + estimateTokens(system) }));
}
const sharedRefreshHistory = [
  '[m201] Two months passed while Ryu and Sora studied under Sister Morwenna.',
  '[m202] Ryu practiced formal rhetoric each morning while Sora drilled hospice anatomy and herb preparation.',
  '[m203] On their Suncrest 14 birthday, both girls returned from lessons with visibly straighter posture.',
  '[m204] Sora folds her fading mana-wings inward until the last blue-gold feathers dissolve, then answers with a measured formal cadence.',
].join('\n');
const ryu = {
  id: 'npc_ryu', name: 'Ryu', aliases: ['Silver Dragon'], role: 'Student', species: 'Silver Dragon Chimera', age: '13', apparentAge: '~12',
  appearance: 'Silver-haired girl with grey eyes.', personality: 'Composed and analytical.', speech: 'Precise and reserved.',
  behaviorProfile: ['Disposition: observant and methodical.'], mannerisms: ['Studies a room before speaking.'],
  birthDate: { era: 'CR', year: null, month: 'Suncrest', day: 14 },
  appearanceForms: [{ name: 'Chimera Form', appearance: 'Silver horns, wings, and tail formed from pale mana.' }], currentForm: 'Chimera Form',
};
const sora = {
  id: 'npc_sora', name: 'Sora', aliases: ['Stormcrown Thunderbird'], role: 'Student', species: 'Stormcrown Thunderbird Chimera', age: '13', apparentAge: '~13',
  appearance: 'Golden-blue-haired girl with bright eyes.', personality: 'Energetic, proud, curious.', speech: 'Bright and direct.',
  behaviorProfile: ['Disposition: energetic and observant.'], mannerisms: ['Puffs her chest when proud.'],
  birthDate: { era: 'CR', year: null, month: 'Suncrest', day: 14 },
  appearanceForms: [{ name: 'Chimera Form', appearance: 'Blue-gold avian wings and feathered ears formed from storm mana.' }], currentForm: 'Chimera Form',
};
const soraChanged = { ...sora, speech: 'Measured, soft, and thoroughly formal.', personality: 'Energetic, proud, curious, and increasingly studious.' };
const refreshCommon = { transcript: sharedRefreshHistory, userName: 'Lucien', charName: 'Narrator' };
const refreshRyu = buildProfileRefreshPrompt({ ...refreshCommon, targetNpc: ryu });
const refreshSora = buildProfileRefreshPrompt({ ...refreshCommon, targetNpc: sora });
const refreshSoraChanged = buildProfileRefreshPrompt({ ...refreshCommon, targetNpc: soraChanged });
console.log(JSON.stringify({
  name: 'prefix-refresh-two-targets-same-history',
  commonPrefixChars: commonPrefixChars(requestText(refreshSystem, refreshRyu), requestText(refreshSystem, refreshSora)),
}));
console.log(JSON.stringify({
  name: 'prefix-refresh-same-target-changed-dossier',
  commonPrefixChars: commonPrefixChars(requestText(refreshSystem, refreshSora), requestText(refreshSystem, refreshSoraChanged)),
}));
const ordinaryAHistory = 'Ryu and Sora finish morning lessons. Sora speaks brightly beside the hospice desk.';
const ordinaryBHistory = 'Ryu and Sora finish evening lessons. Sora answers softly beside the manor hearth.';
const ordinaryA = buildScannerPrompt({ transcript: ordinaryAHistory, currentTranscript: ordinaryAHistory, existingNpcs: [ryu, { ...sora, mood: 'cheerful', location: 'Hospice' }], userName: 'Lucien', charName: 'Narrator' });
const ordinaryB = buildScannerPrompt({ transcript: ordinaryBHistory, currentTranscript: ordinaryBHistory, existingNpcs: [ryu, { ...sora, mood: 'calm', location: 'Therin Manor' }], userName: 'Lucien', charName: 'Narrator' });
console.log(JSON.stringify({
  name: 'prefix-ordinary-consecutive-live-history-change',
  commonPrefixChars: commonPrefixChars(requestText(system, ordinaryA), requestText(system, ordinaryB)),
}));

const selected = { id: 'mara', name: 'Mara', present: true, personality: 'Patient and observant.', behaviorProfile: ['Keeps firm boundaries.'], speech: 'Speaks in concise formal sentences.', mannerisms: ['Squares the ledger before opening it.'], role: 'Surveyor', species: 'Human', goal: 'Finish the route survey.' };
const injection = buildInjection([selected], 'Mara discusses the survey.', 1, 3);
for (const required of ['Patient and observant', 'Keeps firm boundaries', 'concise formal sentences', 'Squares the ledger']) assert.ok(injection.includes(required), `accepted selected characterization missing: ${required}`);
console.log(JSON.stringify({ name: 'accepted-characterization-injection', chars: injection.length, estimatedTokens: estimateTokens(injection), requiredFieldsPresent: true }));

// Report-only: the opt-in one-pass narration capture instruction (default off), built by the
// production builder from the generation-time context (history up to the user's message; the reply
// does not exist yet). It rides in the roleplay extension prompt after the dossier injection, so the
// final extension prompt is both joined, as updateInjection sends it. Compared with the quick-scan
// request it replaces when a complete block arrives; no baseline is asserted.
const captureFixtures = [
  ...cases.map(fixture => ({ name: fixture.name, npcs: fixture.npcs, userName: 'Ari', generationTranscript: `USER: ${fixture.user}`, scanTranscript: `USER: ${fixture.user}\nASSISTANT: ${fixture.assistant}` })),
  { name: 'ordinary-two-npc-profiles', npcs: [ryu, { ...sora, mood: 'cheerful', location: 'Hospice' }], userName: 'Lucien', generationTranscript: ordinaryAHistory, scanTranscript: ordinaryAHistory },
  { name: 'rich-present-npc', npcs: [{ ...selected, mood: 'focused', location: 'Survey office' }], userName: 'Ari', generationTranscript: 'USER: Mara, how is the survey going?', scanTranscript: 'USER: Mara, how is the survey going?\nASSISTANT: Mara squares the ledger before opening it. "Slowly. The south route floods."' },
];
for (const fixture of captureFixtures) {
  const charName = fixture.userName === 'Ari' ? 'Character' : 'Narrator';
  const capture = buildNarrationCapturePrompt({ transcript: fixture.generationTranscript, existingNpcs: fixture.npcs, userName: fixture.userName, charName });
  const scanner = buildScannerPrompt({ transcript: fixture.scanTranscript, currentTranscript: fixture.scanTranscript, existingNpcs: fixture.npcs, userName: fixture.userName, charName });
  const dossierInjection = buildInjection(fixture.npcs, fixture.generationTranscript, 1, 3);
  const finalExtensionPrompt = [dossierInjection, capture].filter(Boolean).join('\n\n');
  // (1.2.17) As sent: the static rules early, the context after the dossier, leaving out what it repeats.
  const captureOptions = { transcript: fixture.generationTranscript, existingNpcs: fixture.npcs, userName: fixture.userName, charName };
  const parts = buildNarrationCaptureParts(captureOptions);
  const sentContext = buildNarrationCaptureParts({ ...captureOptions, dossierAbove: dossierInjection }).context;
  const compactRules = buildNarrationCaptureParts({ ...captureOptions, compactCapture: true }).rules;
  console.log(JSON.stringify({
    name: `narration-capture-${fixture.name}`,
    captureChars: capture.length,
    captureEstimatedTokens: estimateTokens(capture),
    replacedScannerCharsIncludingSystem: scanner.length + system.length,
    replacedScannerEstimatedInputTokens: estimateTokens(scanner) + estimateTokens(system),
    dossierInjectionChars: dossierInjection.length,
    finalExtensionPromptChars: finalExtensionPrompt.length,
    finalExtensionPromptEstimatedTokens: estimateTokens(finalExtensionPrompt),
    staticRulesEstimatedTokens: estimateTokens(parts.rules),
    compactRulesEstimatedTokens: estimateTokens(compactRules),
    contextEstimatedTokens: estimateTokens(parts.context),
    contextWithoutDossierRepeatsEstimatedTokens: estimateTokens(sentContext),
  }));
}
// Story Suite v2 (hosted only): the npc kind's grammar line and static line (Story Block's static
// part), and the tail with two present NPCs whose meters moved last reply, one unlocked note.
{
  const settingsCases = { builtIns: {}, withCustom: { customMeters: [{ name: 'Lust', min: 0, max: 100 }, { name: 'Respect', min: -50, max: 50 }], stages: [{ meter: 'trust', at: 20, name: 'Friend' }] } };
  for (const [name, settings] of Object.entries(settingsCases)) {
    const part = createNpcPart({
      settings: () => settings,
      present: () => ['Mira', 'Oren'],
      secretTexts: (who, ids) => (who === 'Mira' ? ids.map(id => ({ id, text: 'She is the lost heir of House Venn.' })) : []),
    });
    const grammar = part.kinds.npc.grammar;
    const staticLine = part.context.static();
    const meters = settings.customMeters ? { trust: 22, affection: 5, desire: 0, tension: -3, lust: 3, respect: 0 } : { trust: 22, affection: 5, desire: 0, tension: -3 };
    const state = { domains: { npc: { problems: [], npcs: {
      mira: { name: 'Mira', meters, stages: settings.stages ? { trust: 'Friend' } : {}, unlocked: ['sec_00000001'], turn: { reply: 4, from: {} } },
      oren: { name: 'Oren', meters: { ...meters, trust: -5 }, stages: {}, unlocked: [], turn: { reply: 4, from: {} } },
    } } } };
    const tail = part.context.tail({ state, chat: { length: 6 } }).lines.join('\n');
    console.log(JSON.stringify({
      name: `v2-npc-meters-${name}`,
      staticChars: grammar.length + 1 + staticLine.length,
      staticEstimatedTokens: estimateTokens(grammar) + estimateTokens(staticLine),
      tailChars: tail.length,
      tailEstimatedTokens: estimateTokens(tail),
    }));
  }
}
console.log('Estimator: ASCII/3.5 + non-ASCII*1.1, rounded per prompt component; not provider usage. Main scanner fixtures only; conditional focused passes/retries are additional requests.');
console.log('Narration capture (opt-in, default off): added to every armed roleplay request; the JSON block in each reply is extra roleplay output not counted here. A missing/broken block falls back to the scanner request.');
