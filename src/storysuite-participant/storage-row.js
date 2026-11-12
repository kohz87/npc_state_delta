// NPC State Delta settings, the Storage row (approved mockup B5): how many old dossier files there are, how many of them are unused and older than
// 30 days, and a Clean up button with a confirmation. Story Block answers which checkpoint files every chat and branch still uses (the query
// `timeline.referenced`); vault-sweep.js plans and removes. If ANY chat could not be read the answer is incomplete, the button is off with the
// reason, and nothing is ever removed. The final check and the deletion are ONE step inside the participant's exclusive queue (`exclusive`, the one
// checkpoint writes take), with the references read again inside it, so no checkpoint write can land between them. The open state must be readable, and a file that ANY lineage's index names is kept; a missing or unreadable index (or file) turns removal off. Nothing runs on its own except the first check when the panel opens (it never asks Data Maid); "Find older files" asks SillyTavern's Data Maid listing only when pressed, and removal needs the confirmation.
// All text goes in with textContent (no markup from text). `mount()` fills the settings slot `storage`; it does nothing without the slot.

import { createVaultSweep } from './vault-sweep.js';
import { CHECKPOINT_ID } from './checkpoint.js';

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
const validIds = value => Array.isArray(value) && value.every(id => typeof id === 'string' && CHECKPOINT_ID.test(id));

/** Every checkpoint id named anywhere in a lineage index (acks, prepared, returns, selected, base). */
function indexIds(value, out = new Set(), depth = 0) {
    if (typeof value === 'string') { if (CHECKPOINT_ID.test(value.trim())) out.add(value.trim()); }
    else if (value && typeof value === 'object' && depth < 8) for (const entry of Object.values(value)) indexIds(entry, out, depth + 1);
    return out;
}

/**
 * Story Block's journals do not name what a lineage index holds (acks, prepared, returns, selected, base), and a newer lineage can prepare an
 * older lineage's checkpoint. So the indexes of EVERY lineage found in the vault (each file carries its lineage) are read, and a candidate named by
 * ANY of them is kept. A file or index that cannot be read, or a lineage whose index is missing or null, means "unknown": `unknown` is true and
 * removal is off. A candidate with no lineage is kept. Returns { keep: ids that must NOT be removed, unknown }.
 */
async function indexProtected(vault, candidates) {
    const keep = new Set();
    const named = new Set();
    let unknown = false;
    const lineages = new Set();
    const bases = new Map();   // file -> the file it is a patch against (read from the file, not from the registry)
    try {
        const raw = await vault.list();
        const files = Array.isArray(raw) ? raw : Array.isArray(raw?.files) ? raw.files : [];
        const ids = new Set([...files.map(file => file?.id), ...candidates.map(file => file.id)].filter(id => typeof id === 'string'));
        for (const id of ids) {
            const isCandidate = candidates.some(file => file.id === id);
            try {
                const meta = typeof vault.describe === 'function' ? await vault.describe(id) : { lineage: (await vault.get(id))?.lineage, base: null };
                const lineage = meta?.lineage;
                if (meta?.base) bases.set(id, meta.base);
                if (typeof lineage === 'string' && lineage) lineages.add(lineage);
                else if (isCandidate) keep.add(id);
            } catch { if (isCandidate) keep.add(id); unknown = true; }
        }
    } catch { unknown = true; }
    for (const lineage of lineages) {
        try {
            const index = await vault.getIndex(lineage);
            if (index === null || index === undefined) unknown = true;
            else indexIds(index, named);
        } catch { unknown = true; }
    }
    for (const { id } of candidates) if (named.has(id)) keep.add(id);
    // A file that stays keeps its whole chain of bases, whatever the registry says (a second tab can lose a registry update).
    const candidateIds = new Set(candidates.map(file => file.id));
    for (const start of [...new Set([...bases.keys(), ...keep])].filter(id => !candidateIds.has(id) || keep.has(id))) {
        let at = bases.get(start);
        for (let steps = 0; at && steps < 64; steps += 1) { if (candidateIds.has(at)) keep.add(at); at = bases.get(at); }
    }
    return { keep, unknown };
}

/** Why clean-up is off, in the mockup's words. */
export function offReason(answer, plan, liveReadable = true) {
    if (plan?.code === 'VAULT_UNREADABLE') return 'Clean-up is off: the dossier files could not be checked, so it can\'t be sure which files are still used.';
    if (answer?.complete === true && !liveReadable) return 'Clean-up is off: the open dossier state could not be checked, so it can\'t be sure which files are still used.';
    const unreadable = Array.isArray(answer?.unreadable) ? answer.unreadable : [];
    if (!unreadable.length) return 'Clean-up is off: the chats could not be checked, so it can\'t be sure which files are still used.';
    const newer = unreadable.filter(item => /newer/i.test(String(item?.reason ?? item?.code ?? item ?? ''))).length;
    const count = unreadable.length;
    const extra = newer === 1 && count === 1 ? ' (it is from a newer version)'
        : newer === 1 ? ' (one is from a newer version)'
            : newer > 1 ? ` (${newer} are from a newer version)` : '';
    return `Clean-up is off: ${count === 1 ? '1 chat' : `${count} chats`} could not be read${extra}, so it can't be sure which files are still used.`;
}

export const INDEX_UNKNOWN = 'Clean-up is off: a dossier index could not be read, so it can\'t be sure which files are still used.';
export const COUNTS_LINE = 'Counts the chats SillyTavern lists; chats of deleted characters are not checked.';
export const DATA_MAID_LINE = 'This uses SillyTavern\'s Data Maid listing and replaces any Data Maid report you have open.';

export function createStorageRow({ doc, vault, ask, exclusive, live = () => null, now = () => Date.now(), warn = () => {} } = {}) {
    const capable = typeof vault?.list === 'function' && typeof vault?.remove === 'function';
    const sweeper = capable ? createVaultSweep({ vault, now }) : null;
    let card = null;
    let busy = false;
    let view = { kind: 'checking' };
    let checkId = 0;

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
    // A list that cannot prove it saw every file (plan.exact === false) shows its size as "at least".
    const totals = plan => el('p', 'npc-state-delta-storage-line', `Old dossier files: ${plan.exact === false ? 'at least ' : ''}${filesText(plan.totalFiles)}, ${sizeText(plan.totalBytes)}`);

    async function inspect() {
        let answer = null;
        try { answer = await ask(); } catch (error) { warn('The referenced-checkpoints query failed', error); }
        let current = null;
        try { current = live(); } catch { /* an unreadable open state cannot prove that files are unused */ }
        const liveReadable = current !== null && typeof current === 'object' && !Array.isArray(current);
        const complete = answer?.complete === true && validIds(answer.referenced) && liveReadable;
        const referenced = [answer?.referenced, current];
        let plan = await sweeper.plan({ referenced, complete });
        if (plan.canSweep && plan.candidates.length) {
            const { keep, unknown } = await indexProtected(vault, plan.candidates);
            if (unknown) return { kind: 'off', plan, reason: INDEX_UNKNOWN };
            if (keep.size) plan = await sweeper.plan({ referenced: [...referenced, [...keep]], complete });
        }
        return plan.canSweep ? { kind: 'ready', plan } : { kind: 'off', plan, reason: offReason(answer, plan, liveReadable) };
    }

    async function check() {
        const token = ++checkId;
        view = { kind: 'checking' };
        draw();
        const next = await inspect();
        if (token !== checkId) return;
        view = next;
        draw();
    }

    // Only on the press: the vault asks Data Maid; what it names joins the list, and the same check and rules apply.
    async function findOlder() {
        ++checkId;
        busy = true;
        draw();
        let note = '';
        try {
            const named = await vault.findOlder();
            note = `Data Maid named ${filesText(named)} like dossier files.`;
        } catch { note = 'The older files could not be listed. Nothing was changed.'; }
        busy = false;
        await check();
        view = { ...view, note };
        draw();
    }

    // The one line before the button, and the button (only for a vault that can ask).
    function findControls() {
        if (typeof vault?.findOlder !== 'function') return [];
        return [el('p', 'npc-state-delta-storage-muted', DATA_MAID_LINE), button('Find older files', 'npc-state-delta-storage-find', () => { void findOlder(); }, view.kind === 'working')];
    }

    async function run() {
        const confirmed = view.plan;
        ++checkId;
        busy = true;
        view = { kind: 'working', plan: confirmed };
        draw();
        // The confirmation may have stayed open while a chat or index changed. Inside the participant's exclusive queue (where checkpoint writes
        // run) the references are read again and, only if the candidates are the confirmed ones, the sweep runs: one step, no write between.
        let result = null;
        if (typeof exclusive === 'function') {
            try {
                result = await exclusive(async () => {
                    const fresh = await inspect();
                    const same = fresh.kind === 'ready' && fresh.plan.canSweep && JSON.stringify(fresh.plan.candidates) === JSON.stringify(confirmed.candidates);
                    return same ? { rowDone: await sweeper.sweep() } : { rowChanged: fresh };
                });
            } catch { result = null; }
        }
        if (result?.rowChanged) {
            busy = false;
            view = { ...result.rowChanged, note: 'The file check changed. Review the updated results.' };
            draw();
            return;
        }
        const done = result?.rowDone;
        if (!done) {
            busy = false;
            await check();
            view = { ...view, note: 'Nothing was removed. The dossier files could not be locked for the check; try again in a moment.' };
            draw();
            return;
        }
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
        card.append(totals(plan), el('p', 'npc-state-delta-storage-muted', COUNTS_LINE));
        if (view.kind === 'off') {
            card.append(button('Clean up', '', () => {}, true), el('p', 'npc-state-delta-storage-muted', view.reason));
            card.append(button('Check again', '', () => { void check(); }), ...findControls());
            if (view.note) card.append(el('p', 'npc-state-delta-storage-muted', view.note));
            return;
        }
        const old = el('p', 'npc-state-delta-storage-line', plan.count
            ? `${plan.count} of them (${sizeText(plan.bytes)}) are older than 30 days and no chat or branch uses them.`
            : 'None of them are both older than 30 days and unused.');
        card.append(old);
        if (view.kind === 'confirm') { card.append(dialog(plan)); return; }
        if (plan.count) card.append(button(`Clean up ${filesText(plan.count)} (${sizeText(plan.bytes)})`, 'npc-state-delta-storage-clean', () => { view = { kind: 'confirm', plan }; draw(); }, view.kind === 'working'));
        card.append(button('Check again', '', () => { void check(); }, view.kind === 'working'));
        card.append(...findControls());
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
