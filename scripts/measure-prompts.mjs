import assert from 'node:assert/strict';
import { buildScannerPrompt, buildInjection } from '../core.js';

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
const system = "You are NPC State Delta's isolated dossier scanner. Use only the supplied scanner payload. Return only the requested JSON object.";
for (const fixture of cases) {
  const transcript = `USER: ${fixture.user}\nASSISTANT: ${fixture.assistant}`;
  const prompt = buildScannerPrompt({ transcript, currentTranscript: transcript, existingNpcs: fixture.npcs, userName: 'Ari', charName: 'Character' });
  console.log(JSON.stringify({ name: fixture.name, charsIncludingSystem: prompt.length + system.length, estimatedInputTokens: estimateTokens(prompt) + estimateTokens(system) }));
}
const selected = { id: 'mara', name: 'Mara', present: true, personality: 'Patient and observant.', behaviorProfile: ['Keeps firm boundaries.'], speech: 'Speaks in concise formal sentences.', mannerisms: ['Squares the ledger before opening it.'], role: 'Surveyor', species: 'Human', goal: 'Finish the route survey.' };
const injection = buildInjection([selected], 'Mara discusses the survey.', 1, 3);
for (const required of ['Patient and observant', 'Keeps firm boundaries', 'concise formal sentences', 'Squares the ledger']) assert.ok(injection.includes(required), `accepted selected characterization missing: ${required}`);
console.log(JSON.stringify({ name: 'accepted-characterization-injection', chars: injection.length, estimatedTokens: estimateTokens(injection), requiredFieldsPresent: true }));
console.log('Estimator: ASCII/3.5 + non-ASCII*1.1, rounded per prompt component; not provider usage. Main scanner fixtures only; conditional focused passes/retries are additional requests.');
