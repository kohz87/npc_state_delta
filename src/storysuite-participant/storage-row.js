// NPC State Delta settings, the Storage row (approved mockup B5): how many old dossier files there are, how many of them are unused and older than
// 30 days, and a Clean up button with a confirmation. Story Block answers which checkpoint files every chat and branch still uses (the query
// `timeline.referenced`); vault-sweep.js plans and removes. If ANY chat could not be read the answer is incomplete, the button is off with the
// reason, and nothing is ever removed. Nothing runs on its own except the first check when the panel opens; removal needs the confirmation.
// All text goes in with textContent (no markup from text). `mount()` fills the settings slot `storage`; it does nothing without the slot.

import { createVaultSweep } from './vault-sweep.js';

export const REFERENCED_QUERY = 'timeline.referenced';
const SLOT = '[data-delta-settings-slot="storage"]';

/** "36 MB", "420 KB": whole MB from 1 MB up (one decimal under 10 MB), KB below. */
export function sizeText(bytes) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n >= 1024 * 1024) {
        const mb = n / (1024 * 1024);
        return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
    }
    return `${Math.max(n > 0 ? 1 : 0, Math.round(n / 1024))} KB`;
}
const filesText = n => `${n} ${n === 1 ? 'file' : 'files'}`;

/** Why clean-up is off, in the mockup's words. */
export function offReason(answer) {
    const unreadable = Array.isArray(answer?.unreadable) ? answer.unreadable : [];
    if (!unreadable.length) return 'Clean-up is off: the chats could not be checked, so it can\'t be sure which files are still used.';
    const newer = unreadable.filter(item => /newer/i.test(String(item?.reason ?? item?.code ?? item ?? ''))).length;
    const count = unreadable.length;
    const extra = newer === 1 && count === 1 ? ' (it is from a newer version)'
        : newer === 1 ? ' (one is from a newer version)'
            : newer > 1 ? ` (${newer} are from a newer version)` : '';
    return `Clean-up is off: ${count === 1 ? '1 chat' : `${count} chats`} could not be read${extra}, so it can't be sure which files are still used.`;
}

export function createStorageRow({ doc, vault, ask, live = () => null, now = () => Date.now(), warn = () => {} } = {}) {
    const capable = typeof vault?.list === 'function' && typeof vault?.remove === 'function';
    const sweeper = capable ? createVaultSweep({ vault, now }) : null;
    let card = null;
    let busy = false;
    let view = { kind: 'checking' };

    const el = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, className, onClick, disabled = false) => {
        const node = el('button', `menu_button npc-state-delta-storage-btn ${className}`.trim(), label);
        node.type = 'button';
        node.disabled = disabled || busy;
        node.addEventListener('click', onClick);
        return node;
    };
    const totals = plan => el('p', 'npc-state-delta-storage-line', `Old dossier files: ${filesText(plan.totalFiles)}, ${sizeText(plan.totalBytes)}`);

    async function check() {
        view = { kind: 'checking' };
        draw();
        let answer = null;
        try { answer = await ask(); } catch (error) { warn('The referenced-checkpoints query failed', error); }
        const referenced = [answer?.referenced, live()];
        const plan = await sweeper.plan({ referenced, complete: answer?.complete === true });
        view = plan.canSweep ? { kind: 'ready', plan } : { kind: 'off', plan, reason: offReason(answer) };
        draw();
    }

    async function run() {
        busy = true;
        view = { kind: 'working', plan: view.plan };
        draw();
        const done = await sweeper.sweep();
        busy = false;
        await check();
        if (!done.ok) {
            view = { ...view, note: done.failed?.length ? 'Some files could not be removed. Check again to see what is left.' : done.message };
            draw();
        }
    }

    function dialog(plan) {
        const box = el('div', 'npc-state-delta-storage-dialog');
        box.setAttribute('role', 'dialog');
        box.append(
            el('h4', '', `Remove ${plan.count} old dossier ${plan.count === 1 ? 'file' : 'files'} (${sizeText(plan.bytes)})?`),
            el('p', '', 'No chat or branch uses these files, and each is older than 30 days. Dossiers in your chats are not changed. If you later restore an old chat from a backup, its dossiers may need to start from the chat.'),
        );
        const buttons = el('div', 'npc-state-delta-storage-buttons');
        buttons.append(
            button(`Remove ${filesText(plan.count)}`, 'npc-state-delta-storage-remove', () => { void run(); }),
            button('Cancel', '', () => { view = { kind: 'ready', plan }; draw(); }),
        );
        box.append(buttons);
        return box;
    }

    function draw() {
        if (!card) return;
        card.replaceChildren(el('span', 'npc-state-delta-storage-head', 'Storage'));
        const { plan } = view;
        if (view.kind === 'checking') {
            card.append(el('p', 'npc-state-delta-storage-line', 'Checking which dossier files are still used…'));
            return;
        }
        card.append(totals(plan));
        if (view.kind === 'off') {
            card.append(button('Clean up', '', () => {}, true), el('p', 'npc-state-delta-storage-muted', view.reason));
            card.append(button('Check again', '', () => { void check(); }));
            return;
        }
        const old = el('p', 'npc-state-delta-storage-line', plan.count
            ? `${plan.count} of them (${sizeText(plan.bytes)}) are older than 30 days and no chat or branch uses them.`
            : 'None of them are both older than 30 days and unused.');
        card.append(old);
        if (view.kind === 'confirm') { card.append(dialog(plan)); return; }
        if (plan.count) card.append(button(`Clean up ${filesText(plan.count)} (${sizeText(plan.bytes)})`, 'npc-state-delta-storage-clean', () => { view = { kind: 'confirm', plan }; draw(); }, view.kind === 'working'));
        card.append(button('Check again', '', () => { void check(); }, view.kind === 'working'));
        card.append(el('p', 'npc-state-delta-storage-muted', 'Only files that no chat or branch on this install uses, and older than 30 days, are removed.'));
        if (view.note) card.append(el('p', 'npc-state-delta-storage-muted', view.note));
    }

    return {
        /** Puts the row in the settings slot and runs the first check; false when there is no slot (or no document) yet. */
        mount(root = doc) {
            const slot = capable ? root?.querySelector?.(SLOT) : null;
            if (!slot) return false;
            if (card?.isConnected) return true;
            card = el('div', 'npc-state-delta-storage');
            slot.append(card);
            void check();
            return true;
        },
        unmount() { card?.remove?.(); card = null; },
        check,
        state: () => view,
    };
}
