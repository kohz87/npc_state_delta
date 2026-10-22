// Story Block v2 testkit (docs/v2/SPEC.md §10): a fake SillyTavern context and a whole host on
// it. Modules vendor this folder with src/v2/ into tests/vendor/story-block/.

export { EVENT_TYPES, EXTENSION_PROMPT_ROLES, EXTENSION_PROMPT_TYPES, MAIN_PROMPT, aiMessage, createEventSource, createFakeContext, sharedPrefix, userMessage } from './fake-st.js';
export { applyOps, createFakeBus, createFakeStore } from './fakes.js';
export { createHost, hostAvailable } from './host.js';
