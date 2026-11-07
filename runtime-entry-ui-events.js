/* NPC State Delta - present-card event helpers (role: runtime-entry-ui-events). The present-card activation
   guard, launcher-dossier event bridge and closest-target lookup split from index.js. Built once per module
   instance with the controller bindings it calls, so the activation memory stays per instance. */

export function createUiCaptureParts(deps) {
    const { currentNpcById } = deps;
    let lastPresentCardActivation = { npcId: '', at: 0 };
    function eventTargetClosest(event, selector) {
        const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
        for (const node of path) {
            if (typeof node?.matches === 'function' && node.matches(selector)) return node;
        }
        return typeof event?.target?.closest === 'function' ? event.target.closest(selector) : null;
    }


    // Present-cast cards open the same launcher dossier page as the floating launcher.
    function openLauncherDossier(npcId) {
        const id = String(npcId || '').trim();
        if (!id || !currentNpcById(id)) return false;
        const request = { npcId: id, handled: false };
        document.dispatchEvent?.(new CustomEvent('npc-state-delta:open-dossier', { detail: request }));
        if (!request.handled) globalThis.toastr?.warning?.('NPC State Delta dossier UI is still mounting.');
        return request.handled;
    }

    function activatePresentCardFromEvent(event) {
        const card = eventTargetClosest(event, '.npc-state-delta-present-card, .npc-state-delta-present-chip, .npc-state-delta-present-cell');
        if (!card) return false;
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return false;
        const npcId = String(card.dataset?.npcId || '').trim();
        if (!npcId) return false;
        const now = Date.now();
        if (lastPresentCardActivation.npcId === npcId && now - lastPresentCardActivation.at < 650) {
            event.preventDefault?.();
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            return true;
        }
        lastPresentCardActivation = { npcId, at: now };
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        event.stopPropagation?.();
        openLauncherDossier(npcId);
        return true;
    }

    return { eventTargetClosest, openLauncherDossier, activatePresentCardFromEvent };
}
