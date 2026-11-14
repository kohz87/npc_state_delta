/* NPC State Delta dossier surface: constants shared by the split UI modules. */
export const ROOT_ID = 'npc_state_delta_dossier_root';
export const OPEN_REQUEST_GUARD = '__npcStateDeltaOpenDossierRequests';
export const STYLE_ID = 'npc_state_delta_dossier_stage1_styles';
export const SETTINGS_ID = 'npc_state_delta_settings';
export const OBSERVER_RETRY_MS = 750;
export const OBSERVER_RETRY_LIMIT = 80;
// Refresh asks (settings mutations, focus, pins) are coalesced: quiet time before one check, the longest an ask may wait, and the re-check gap while a reply streams.
export const REFRESH_DEBOUNCE_MS = 250;
export const REFRESH_MAX_WAIT_MS = 1500;
export const REFRESH_STREAM_RECHECK_MS = 700;
// A generation that never reports its end (an aborted stream) holds the panel's refresh back at most this long; then it checks anyway.
export const REFRESH_STREAM_MAX_MS = 200000;
