/* NPC State Delta reply-scan reply identity (role: reply-scan-reply). The parent key and in-place-rewrite check for a
   reply, the removal of current-scene fields from earlier-only windows, and the first-scan window rule. Split from
   runtime-scan.js with the factory holding the same getChatKey closure reference. */

import { chatContext as getContext } from './runtime-scan-helpers.js';
import { chatLineage, lineageCheckpointKey } from './branch.js';

export function createScanReplyPart(deps) {
    const { getChatKey } = deps;

    // (1.2.9) Other extensions write into a reply just after it arrives: Story Block tidying its
    // blocks, RPG Battle its Party sheet, Story Director a closing line. That is the same reply
    // rewritten in place, not a new branch: its position and every message before it are unchanged.
    // Treating it as a different reply left the one-pass capture block waiting, never merged.
    function replyParentKey(messageId) {
        return messageId > 0 ? lineageCheckpointKey(chatLineage(getContext().chat || []), messageId - 1) : 'root';
    }
    function sameReplyRewritten(chatKey, messageId, parentKey) {
        if (getChatKey() !== chatKey || !Number.isInteger(messageId)) return false;
        const message = getContext().chat?.[messageId];
        return Boolean(message && !message.is_user && !message.is_system) && replyParentKey(messageId) === parentKey;
    }

    // Current presence, mood and location belong to the latest scene: an earlier-only window never sets them.
    function stripLiveSceneFields(parsed) {
        const rows = [...(Array.isArray(parsed?.npcs) ? parsed.npcs : []), ...(Array.isArray(parsed?.profileUpdates) ? parsed.profileUpdates : [])];
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            for (const key of ['present', 'worldActive', 'world_active', 'activeOffscreen', 'active_offscreen', 'mood', 'moodState', 'mood_state', 'clearMood', 'clear_mood', 'location', 'locationState', 'location_state', 'clearLocation', 'clear_location']) delete row[key];
        }
    }

    // A chat counts as new (its first scan reads from the start) only when nothing was ever applied to it: no scan, no dossier
    // or candidate, and a history short enough for one window. An imported or cleared chat, or a long chat with no sidecar,
    // reads the latest reply only.
    const NEW_CHAT_MAX_REPLIES = 15;
    function chatNeverScanned(state, messageId) {
        if (Number(state?.scanCount || 0) > 0 || (state?.npcs || []).length || (state?.candidates || []).length) return false;
        const chat = getContext().chat || [];
        let replies = 0;
        for (let i = 0; i <= Math.min(messageId, chat.length - 1); i += 1) if (chat[i] && !chat[i].is_system && !chat[i].is_user) replies += 1;
        return replies <= NEW_CHAT_MAX_REPLIES;
    }

    return { replyParentKey, sameReplyRewritten, stripLiveSceneFields, chatNeverScanned };
}
