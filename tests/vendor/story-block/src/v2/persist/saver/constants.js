// Story Suite v2: the save batching and timed-out-save read-back intervals used by createSaver.

export const RECHECK_MS = Object.freeze([10000, 20000, 40000, 80000, 160000]);
// The turn's save (`idle()`, docs/v2/PERFORMANCE.md "Long chats"): the reply's capture and the reader's actions
// after it go out in one write, IDLE_MS after the last of them, and never later than IDLE_MAX_MS after the
// first one not yet saved.
export const IDLE_MS = 1500;
export const IDLE_MAX_MS = 8000;
// After the turn's save, other parties keep changing the story for a while: a module's forwards (through
// `sdk.command`) and the timeline participant's catch-up, seconds apart with model calls between, each of them
// saving the whole chat 400 ms / IDLE_MS after itself. For FOLLOW_MS after a turn's (or late) save, such a
// change joins one late window instead: saved LATE_MS after the last of them, and never later than
// LATE_MAX_MS after the first one not yet saved. A generation starting ends the phase.
export const LATE_MS = 6000;
export const LATE_MAX_MS = 15000;
export const FOLLOW_MS = 30000;
