import { getContext } from '../../../extensions.js';
import { createDestructiveSettlementController } from './destructive-settlement-core.js';

const REGISTRY_KEY = '__NPCStateDeltaDestructiveSettlement';

function npcStateDeltaApi() {
    return globalThis.NPCStateDelta || globalThis.window?.NPCStateDelta || null;
}

function activeChatKey() {
    return String(npcStateDeltaApi()?.uiStatus?.()?.chatKey || 'no-chat');
}

function hostSwipeActive() {
    return String(npcStateDeltaApi()?.uiStatus?.()?.swipeState || 'none') !== 'none';
}

function buildController() {
    const reconcile = options => {
        const api = npcStateDeltaApi();
        if (!api?.reconcile) throw new Error('NPC State Delta reconcile API is unavailable.');
        return api.reconcile(options);
    };
    return createDestructiveSettlementController({
        getChat: () => getContext().chat || [],
        getChatKey: activeChatKey,
        isSwipeActive: hostSwipeActive,
        reconcile,
        probe: reconcile,
        onTimeout: pending => {
            console.warn(`[NPC State Delta] ${pending.operation} event did not settle into a changed SillyTavern chat lineage within 5000ms; canonical dossier state was preserved rather than rolling back against stale host data.`);
        },
        onError: error => {
            console.warn('[NPC State Delta] settled destructive branch reconciliation failed', error);
        },
    });
}

function registerDestructiveSettlement() {
    if (globalThis[REGISTRY_KEY]?.controller) return globalThis[REGISTRY_KEY].controller;
    const ctx = getContext();
    const events = ctx.eventTypes || ctx.event_types || {};
    const source = ctx.eventSource;
    const controller = buildController();

    if (source?.on) {
        if (events.MESSAGE_DELETED) {
            source.on(events.MESSAGE_DELETED, messageId => {
                controller.schedule('delete', Number.isInteger(messageId) ? messageId : null, 'message-deleted');
            });
        }
        if (events.MESSAGE_EDITED) {
            source.on(events.MESSAGE_EDITED, messageId => {
                controller.schedule('edit', Number.isInteger(messageId) ? messageId : null, 'message-edited');
            });
        }
        if (events.CHAT_CHANGED) source.on(events.CHAT_CHANGED, () => controller.cancel());
    }

    globalThis[REGISTRY_KEY] = Object.freeze({
        controller,
        status: () => controller.status(),
    });
    return controller;
}

registerDestructiveSettlement();

export function destructiveSettlementStatus() {
    return globalThis[REGISTRY_KEY]?.controller?.status?.() || { pending: false };
}
