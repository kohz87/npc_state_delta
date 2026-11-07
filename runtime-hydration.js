/* NPC State Delta chat-state hydration (role: chat-state-hydration). The owner of a chat's loaded
   state: state normalization and cache access, server freshness and write gates, sidecar loading,
   dirty marks and native-change notices. Split into runtime-hydration-state.js,
   runtime-hydration-freshness.js and runtime-hydration-load.js; this factory keeps the public part. */

import { installHydrationState } from './runtime-hydration-state.js';
import { installHydrationFreshness } from './runtime-hydration-freshness.js';
import { installHydrationLoad } from './runtime-hydration-load.js';

export function createHydrationPart(rt, deps) {
    const api = {};
    installHydrationState(api, rt, deps);
    installHydrationFreshness(api, rt, deps);
    installHydrationLoad(api, rt, deps);
    return { freshChatState: api.freshChatState, normalizeChatState: api.normalizeChatState, getChatState: api.getChatState, setChatState: api.setChatState, workingCopyAdoption: api.workingCopyAdoption, hydratedRevision: api.hydratedRevision, updateHydratedStateMeta: api.updateHydratedStateMeta, recordFreshnessEvent: api.recordFreshnessEvent, localWorkingStateDirty: api.localWorkingStateDirty, reconcileCrossSessionWriteConflict: api.reconcileCrossSessionWriteConflict, ensureHydratedStateFresh: api.ensureHydratedStateFresh, ensureFreshMutationBoundary: api.ensureFreshMutationBoundary, runFreshMutation: api.runFreshMutation, chatHydrationStatus: api.chatHydrationStatus, assertChatHydratedForWrite: api.assertChatHydratedForWrite, requireReadyChatMutation: api.requireReadyChatMutation, holdRetiredLocalWork: api.holdRetiredLocalWork, ensureChatStateLoaded: api.ensureChatStateLoaded, markStateDirty: api.markStateDirty, announceNativeChange: api.announceNativeChange, quietly: api.quietly };
}
