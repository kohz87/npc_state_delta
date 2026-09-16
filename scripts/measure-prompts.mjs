import assert from 'node:assert/strict';
import { buildScannerPrompt, buildProfileRefreshPrompt, buildInjection } from '../core.js';

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
console.log('Estimator: ASCII/3.5 + non-ASCII*1.1, rounded per prompt component; not provider usage. Main scanner fixtures only; conditional focused passes/retries are additional requests.');
