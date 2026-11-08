// Story Suite v2: the SillyTavern event handlers, moved out of createTurn unchanged: the reply received (its change lines read, captured and
// kept, then the afterReply / afterReceive hooks), the safety net's late and assist lines, a chat opened, renamed or rewound (deleted messages,
// swipes, a deleted swipe), the generation stopped or ended, and install / uninstall of the interceptor and the listeners. `createEvents(s, deps)`
// is given the turn's state holder `s` and the turn parts it uses; it never imports turn.js.

import {
    adoptLegacy, continuation, cutLine, defangMarker, extractBlock, hideBlock, markOff, parseChanges, withAssist,
} from '../capture.js';
import { cutAt } from '../../text.js';
import { readRecord, swipeLoading } from '../persist.js';
import { notWritten } from '../assist/extractor.js';
import { refusedWhy } from '../assist/safety.js';
import { within } from './text.js';
import { ensureModules } from '../sdk.js';
import { boardStep, heldForMessage, rememberHeld, pruneMissingBoard } from './held-board.js';
import { clearStart, pendingStart } from './fight-start.js';

export function createEvents(s, deps) {
    const { markIdle, clearPrompts, ctx, metadata = () => ctx?.chatMetadata, isCarrier, store, ensureInitial, problem, notify, stopChangedBoard, boardError, changeHeads, readBlock, strayProblems, legacyProblem, lateLines, captureLines, withCaps, timeline, trySave, saveText, redraw, events, registry, view, prepare, RPG_LOAD_WAIT_MS, rebuild, bus, hasCarrier, reconcileNow, REBUILD_REASONS, INTERCEPTOR_NAME, V1_KEYS, setPrompt, interceptor, onGenerationStarted, onPromptReady, onTextPromptReady, getApi } = deps;

    /** MESSAGE_RECEIVED: (messageId, type). */
    async function onMessageReceived(messageId) {
        const id = Number(messageId);
        const current = s.session;
        if (!current || !Number.isInteger(id) || id !== current.index) return null;
        s.heldBoard = null;
        s.session = null;
        markIdle();
        clearPrompts();
        const message = ctx?.chat?.[id];
        if (!isCarrier(message)) return null;
        s.boardCapture = boardStep(current)?.payload.board ?? null;
        // The turn's save window opens now, so the capture's lines are not saved one by one (400 ms each).
        const idle = store.saveIdle?.() === true;
        try {
            if (store.headIndex() !== id) store.rebuild();
            ensureInitial();
            if (store.headIndex() !== id) {
                problem({ index: id, code: 'FAILED', message: 'The reply is not the last message that keeps the story, so its changes were not read.' });
                return null;
            }
            const written = String(message.mes ?? '');
            // A Continue: SillyTavern wrote the old text again, cleaned up, so it can be shorter than it
            // was; where the added text starts is found, not counted, or its block is left bare.
            const at = typeof current.base === 'string' ? continuation(current.base, written) : null;
            // C2-7: a copy of the hidden comment's marker the model wrote itself is defanged first, so the
            // reply is read live as Re-read will read the saved message.
            // A v1 envelope (capture.js adoptLegacy): read as the reply's block when it has none, else taken out unread.
            const adopted = adoptLegacy(defangMarker(written, at?.from ?? 0), { at });
            const text = adopted.text;
            let edited = false;
            if (text !== written) {
                message.mes = text;
                if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = text;
                edited = true;
            }
            // The reader stopped it (GENERATION_STOPPED): an open block's unfinished last line is left out.
            const stopped = current.stopped === true;
            // Change lines written in the story near the block are read with it (capture.js strayLines).
            const heads = changeHeads();
            const block = extractBlock(text, 'Changes', at, { stopped, heads });
            const parsed = block === null ? { lines: [], problems: [] } : readBlock(id, block);
            const problems = [...parsed.problems, ...strayProblems(id, text, heads, { from: at?.from ?? 0, tail: at?.tail === true, stopped }, parsed.lines.map(line => line.raw))];
            if (adopted.legacy === 'read') problems.push(legacyProblem(id));
            const cut = block === null ? null : cutLine(text, 'Changes', at);
            if (cut) problems.push(problem({ index: id, line: cut, code: 'CUT_OFF', message: `The reply ended in the middle of the change line "${cutAt(cut, 80)}" (nothing after it on its line, and the block was not closed), so it was not used. Continue finishes it; or end the line and close the block by hand, then Re-read.` }));
            // The previous reply's safety-net lines that came after the reader sent (not for a Continue).
            const late = current.type === 'continue' ? [] : lateLines(id, parsed.lines.map(line => line.raw));
            const result = await captureLines(id, parsed.lines, at ? current.base : null, current.type, { late, prechecks: current.prechecks });
            problems.push(...result.problems);
            receivedHooks(id, current.type);

            // What this reply was told; a Continue keeps what the reply was told before.
            // (B-b2-timeline-9: read through readRecord, and only receipt IDs, whatever the chat holds.)
            const told = current.type === 'continue' ? readRecord(message)?.narrated ?? [] : [];
            const before = told.filter(id => typeof id === 'string');
            store.setNarrated(id, [...new Set([...before, ...current.untold, ...result.steps.filter(receipt => receipt.beforeGenerate === true).map(receipt => receipt.id)])], { reply: !(current.type === 'swipe' && id === 0) });   // (a swipe of the opening greeting is still a greeting)

            // Also with no block: the change lines left in the story are listed in the hidden comment, so a
            // Re-read leaves them too (B-a1-3, B-a1-10).
            let hidden = hideBlock(message.mes, 'Changes', { ...(at ?? {}), stopped, heads, legacy: adopted.legacy === 'read' });
            if (result.off.length) hidden = markOff(hidden, result.off, at?.from ?? 0);
            hidden = withCaps(hidden, at?.from ?? 0);
            if (hidden !== message.mes) {
                message.mes = hidden;
                if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = hidden;
                edited = true;
            }
            if (timeline?.needsRecovery()) {
                const anchored = await timeline.recover();
                if (!anchored.ok && !anchored.blockedBy) problem({ index: id, code: anchored.code, message: anchored.message });
            }
            s.deferred = false;
            // One write for the reply, its capture and the reader's actions after it (store.saveIdle).
            if (idle && store.dirty()) store.saveIdle();
            else if (store.dirty()) await trySave('after the reply');
            else if (edited) await saveText();
            // At MESSAGE_RECEIVED SillyTavern has not drawn the reply yet (it draws the text as saved), so
            // redrawing can fail; that is not a reason to lose the turn.
            if (edited) redraw(id, message);
            const turn = { index: id, type: current.type, receipts: result.receipts, steps: result.steps, problems, told: current.untold };
            events?.emit('turn', turn);
            afterReply(id, current.type, message, [...parsed.lines, ...late].map(line => line.raw));
            return turn;
        } catch (error) {
            problem({ index: id, code: 'FAILED', message: `The reply's changes could not be kept: ${error?.message ?? error}` });
            if (error?.code === 'BOARD_PRELUDE') {
                const staged = metadata()?.rpgFightBoard?.id === s.boardCapture?.id;
                s.session = current;
                s.heldBoard = { index: id, message, current, board: s.boardCapture, staged };
                // Give an otherwise empty reply its stable ID, then save the add-only recovery marker.
                const record = readRecord(message);
                if (!record) store.setNarrated(id, []);
                const sid = store.carrierSid(id);
                if (rememberHeld(metadata(), sid, current, staged)) {
                    store.touch?.();
                    await trySave('after holding the fight');
                }
                try { notify?.(error.message, 'story-block'); } catch { /* the problem remains visible */ }
            }
            return null;
        } finally {
            s.boardCapture = null;
        }
    }

    // If an input changed after the prompt left, keep the reply uncaptured until the reader restores it.
    function resumeHeldBoard() {
        const held = s.heldBoard;
        if (!held) return;
        const index = (ctx?.chat ?? []).indexOf(held.message);
        if (index < 0 || !heldForMessage(metadata(), held.message)) {
            s.heldBoard = null;
            if (s.session === held.current) s.session = null;
            return;
        }
        held.index = index;
        held.current.index = index;
        const sid = readRecord(held.message)?.sid;
        if (store.headIndex() !== index || metadata()?.rpgFightHeldDiscarded?.[sid]) return;
        if (!held.board || boardError(store.head(), held.board)) return;
        if (held.staged && metadata()?.rpgFightBoard?.id !== held.board.id) return;
        s.heldBoard = null;
        Promise.resolve().then(() => onMessageReceived(held.index));
    }

    function restoreHeldBoard() {
        if (s.heldBoard || !metadata()?.rpgFightHeld) return;
        const chat = ctx?.chat ?? [];
        for (let index = chat.length - 1; index >= 0; index -= 1) {
            const message = chat[index], saved = heldForMessage(metadata(), message);
            if (!saved) continue;
            const current = { ...structuredClone(saved.current), index };
            const board = boardStep(current).payload.board;
            s.session = current;
            s.heldBoard = { index, message, current, board, staged: saved.staged === true };
            problem({ index, code: 'BOARD_HELD', message: 'The fight reply is still waiting. Restore the sheet or gear, or discard the fight (Fight tab, Discard fight) and regenerate the reply.' });
            return;
        }
    }

    // afterReply (the assist extractor): a reply that came without change lines may get them from a
    // module after all. Not awaited; a failure is logged. `capture(text, { index, swipe })` runs the
    // lines as story captures on that reply when it is still the head on the same swipe.
    // (The Assist safety net runs after every reply; `lines` are the change lines its capture read.) A send
    // waits for these runs briefly (assistPending, ASSIST_WAIT_MS).
    function afterReply(index, type, message, lines = []) {
        const swipe = Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
        const runs = [];
        for (const { moduleId, fn } of registry.hookEntries('afterReply')) {
            runs.push(Promise.resolve()
                .then(() => fn({ index, swipe, type, lines: [...lines], mes: String(message?.mes ?? ''), capture: (text, at = { index, swipe }, opts = {}) => captureLate(at, text, opts) }))
                .catch(error => problem({ module: moduleId, index, code: 'FAILED', message: `afterReply failed: ${error?.message ?? error}` }))
                // C2-ext: what the hook made of the reply (the extractor read it, or failed to) can change
                // the reply's note, so the notes are drawn again.
                .finally(() => { if (store.headIndex() === index) events?.emit('head', { index }); }));
        }
        if (!runs.length) return;
        const all = Promise.allSettled(runs).then(() => { if (s.assistPending === all) s.assistPending = null; });
        s.assistPending = all;
    }

    // afterReceive: every reply that arrives, with or without change lines, once its lines have been read and before it is
    // saved (the RPG lets go of the plan it held for the reply). Nothing is asked of it; a failure is a Problem.
    function receivedHooks(index, type) {
        for (const { moduleId, fn } of registry.hookEntries('afterReceive')) {
            try { fn(view(), { index, type }); } catch (error) {
                problem({ module: moduleId, index, code: 'FAILED', message: `afterReceive failed: ${error?.message ?? error}` });
            }
        }
    }

    /** Change lines found after the reply (afterReply): captured on it and kept in its hidden block. */
    async function captureLate({ index, swipe } = {}, text = '', { assist = false, refused = [] } = {}) {
        const message = ctx?.chat?.[index];
        if (assist) return captureAssist({ index, swipe }, text, message, refused);
        if (!isCarrier(message) || store.headIndex() !== index || (Number.isInteger(message.swipe_id) ? message.swipe_id : 0) !== swipe || s.session) {
            return { receipts: [], problems: ['The reply changed before its late change lines arrived; they were not used.'] };
        }
        const parsed = readBlock(index, String(text ?? ''));
        const problems = [...parsed.problems];
        const result = await captureLines(index, parsed.lines, String(message.mes ?? ''), 'late');
        problems.push(...result.problems);
        if (parsed.lines.length) {
            // Kept in a hidden block of their own after the reply's, so Re-read finds them too (and what the
            // reply's comment holds besides its block, the lines left in the story, stays as it was).
            const base = String(message.mes ?? '');
            const from = base.trimEnd().length;
            const mes = withCaps(markOff(hideBlock(`${base}\n\n<Changes>\n${parsed.lines.map(line => line.raw).join('\n')}\n</Changes>`, 'Changes', { from }), result.off, from), from);
            message.mes = mes;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = mes;
        }
        if (store.dirty()) {
            if (store.saveIdle?.() !== true) await trySave('after the late change lines');
        } else if (parsed.lines.length) await saveText();
        if (parsed.lines.length) redraw(index, message);
        const turn = { index, type: 'late', receipts: result.receipts, steps: result.steps, problems, told: [] };
        events?.emit('turn', turn);
        return turn;
    }

    /**
     * The Assist safety net's lines for reply `index` (MODULES §F123). Still the head on the same swipe and
     * no send begun: run now as story lines marked `assist: 'now'`, after the reply's own, and kept in its
     * <Changes-assist> section. A send already begun (the brief wait is over): kept on the reply as
     * <Changes-assist-next>, through the stricter wall, for the next reply to apply after its own lines;
     * nothing changes now. Anything else (swiped, deleted, the next reply already in): not used.
     */
    async function captureAssist({ index, swipe }, text, message, refused = []) {
        const same = isCarrier(message) && store.headIndex() === index && (Number.isInteger(message.swipe_id) ? message.swipe_id : 0) === swipe;
        if (!same) return { receipts: [], problems: ['The reply changed before the safety net\'s lines arrived; they were not used.'], dropped: true };
        // Lines the safety net wrote that code refused (an unknown name for a place the map has, a time with no clock time): a
        // Problems line each, so the reader sees what was left out and why; they are not applied and not kept on the reply.
        const refusals = (Array.isArray(refused) ? refused : []).filter(item => typeof item?.line === 'string' && item.line)
            .map(item => problem({ index, line: item.line, code: 'REFUSED', message: `"${item.line}" was not used: ${String(item.why ?? '').slice(0, 240)}.` }));
        const heads = changeHeads();
        const mes = String(message.mes ?? '');
        const block = extractBlock(mes, 'Changes', null, { heads });
        const blockLines = block === null ? [] : parseChanges(block).lines.map(line => line.raw);
        const own = [...blockLines, ...lateLines(index, []).map(line => line.raw)];
        const parsed = parseChanges(String(text ?? '')).lines;
        const fresh = new Set(notWritten(parsed.map(line => line.raw), own, { scene: blockLines }));
        const kept = parsed.filter(line => fresh.has(line.raw) && !refusedWhy(line, null, { late: Boolean(s.session || s.replyBusy) }));
        const store1 = mes2 => {
            message.mes = mes2;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = mes2;
        };
        if (s.session || s.replyBusy) {
            if (!kept.length) return { receipts: [], problems: refusals, deferred: true };
            // Saved with the next reply (its own save writes the chat).
            store1(withAssist(mes, kept.map(line => line.raw), { next: true }));
            redraw(index, message);
            return { receipts: [], problems: refusals, deferred: true, lines: kept.map(line => line.raw) };
        }
        if (!kept.length) return { index, type: 'late', receipts: [], steps: [], problems: refusals, told: [] };
        const used = block === null ? 0 : readBlock(index, block).lines.length;
        const result = await captureLines(index, [], mes, 'late', { assist: kept, used });
        store1(withCaps(markOff(withAssist(mes, kept.map(line => line.raw)), result.off, mes.trimEnd().length), mes.trimEnd().length));
        if (store.dirty()) {
            if (store.saveIdle?.() !== true) await trySave('after the safety net\'s lines');
        } else await saveText();
        redraw(index, message);
        const turn = { index, type: 'late', receipts: result.receipts, steps: result.steps, problems: [...refusals, ...result.problems], told: [] };
        events?.emit('turn', turn);
        return turn;
    }

    /** CHAT_CHANGED: a new chat (or the same one reloaded). */
    async function onChatChanged() {
        // The old chat's session and prompts go at once, before anything is awaited: a generation started while the RPG's code loads is the new chat's.
        s.session = null;
        s.boardCapture = null;
        s.heldBoard = null;
        s.quiets = [];
        markIdle();
        clearPrompts();
        // The RPG's code, when this chat needs it (the feature is on, or it holds the RPG's records), before anything is replayed (rpg-lazy.js); a stalled
        // import is waited for only RPG_LOAD_WAIT_MS (the guard mark then says the code is missing, so a later load makes the chat look again).
        if (typeof prepare === 'function') { try { await within(prepare(), RPG_LOAD_WAIT_MS); } catch { /* the loader reports its own failure */ } }
        rebuild({ publish: false });
        const meta = metadata();
        const removedBoard = pruneMissingBoard(meta, ctx?.chat);
        const removedStart = Boolean(meta?.rpgFightStart && (!pendingStart(meta, ctx.chat)));
        if (removedStart) clearStart(meta);
        if (removedBoard || removedStart) {
            try { (ctx.saveMetadata ?? ctx.saveMetadataDebounced)?.call(ctx); } catch { /* saved on the next chat write */ }
        }
        timeline?.settle();
        // A1-2: read-backs of a write that timed out before a reload of the page go on.
        try { store.resume?.(); } catch { /* only a guard */ }
        // A cue left for the reply's save (runCues) whose reply will not come here: saved now (into its
        // own chat's file when this is another chat, the store's rescue).
        if (s.deferred) {
            s.deferred = false;
            if (store.dirty?.()) store.scheduleSave?.();
        }
        await ensureModules({ store, bus, registry, events });
        restoreHeldBoard();
        events?.emit('head', { index: store.headIndex(), reason: 'chat' });
    }

    /**
     * A reader's action in a chat that has a message but no state yet (sdk.command): the state starts on its first carrier now, as
     * onChatChanged would. SillyTavern shows a new chat's greeting before it tells of the chat (CHAT_CHANGED comes after its save, and
     * after every listener ahead of Story Block's), and a message added with no event Story Block reads (/sendas into an empty chat)
     * starts nothing. No open chat, or no carrier: nothing to start. → true when the chat has a state.
     */
    function seed() {
        if (store.head()) return true;
        // The libraries a chat needs come first, as for CHAT_CHANGED; only when one is on its way is a promise returned (→ Promise<boolean>), else the answer is at once.
        let waiting;
        if (typeof prepare === 'function') { try { waiting = prepare(); } catch { waiting = undefined; } }
        return waiting ? within(waiting, RPG_LOAD_WAIT_MS).then(seedNow, seedNow) : seedNow();
    }
    function seedNow() {
        if (store.head()) return true;
        let open = true;
        try { open = typeof ctx?.getCurrentChatId !== 'function' || !!ctx.getCurrentChatId(); } catch { open = true; }
        if (!open || !hasCarrier()) return false;
        rebuild();
        return !!store.head();
    }

    /**
     * CHAT_RENAMED: { oldFileName, newFileName } (file names with ".jsonl"). SillyTavern 1.19 renames the
     * file, reads the open chat back (CHAT_CHANGED), then tells this; a change not saved yet goes into the
     * renamed file (store.renamed, B-b2-timeline-r2-2). The server may clean the new name up (characters
     * it does not allow in a file name); when the open chat's ID is that name cleaned up, it is the one.
     */
    function onChatRenamed(data) {
        const name = value => String(value ?? '').trim().replace(/\.jsonl$/i, '');
        const from = name(data?.oldFileName);
        let to = name(data?.newFileName);
        if (!from || !to) return false;
        let open = null;
        try { open = typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : null; } catch { open = null; }
        const loose = id => String(id).replace(/[\/?<>\\:*|"\u0000-\u001f\u0080-\u009f]/g, '').replace(/[. ]+$/, '');
        if (typeof open === 'string' && open && open !== from && open !== to && loose(open) === loose(to)) to = open;
        return store.renamed?.(from, to) ?? false;
    }

    /**
     * Deleted messages, swipes, a greeting picked: the state is rebuilt from what is stored. `reason` ('delete', 'swipe',
     * 'edit'; anything else is none) rides on the head event for the public API's `story:rebuilt`.
     */
    async function onTimelineChanged(reason) {
        if (typeof prepare === 'function') { try { await within(prepare({ scan: false }), RPG_LOAD_WAIT_MS); } catch { /* the loader reports its own failure */ } }
        rebuild({ publish: false });
        resumeHeldBoard();
        restoreHeldBoard();
        reconcileNow();
        timeline?.settle();
        if (timeline?.needsRecovery()) await timeline.recover();
        // one head, after the steps that follow the change are planned again
        events?.emit('head', { index: store.headIndex(), ...(REBUILD_REASONS.has(reason) ? { reason } : {}) });
    }

    /**
     * A deleted swipe. SillyTavern tells of the deletion of the swipe being shown before it shows the next one (`extra` is
     * still the deleted swipe's; MESSAGE_SWIPED follows). The shown swipe is told by whose record it holds, not by its text
     * (persist.js swipeLoading): while it is in flux nothing is rebuilt, restamped, reconciled or published, so no record is
     * written and no head is told of; the swipe load that follows does all of it once. Any other swipe deletion is a
     * change on its own.
     */
    function onSwipeDeleted(detail) {
        const live = ctx?.chat ?? [];
        const at = Number.isInteger(detail) ? detail : detail?.messageId;
        const message = live[Number.isInteger(at) ? at : live.length - 1];
        const deleted = Number.isInteger(detail?.swipeId) ? detail.swipeId : null;
        if (swipeLoading(message, deleted)) return;
        return onTimelineChanged('delete');
    }

    /** GENERATION_STOPPED: the reader stopped the reply being written (its last line may be unfinished). */
    function onGenerationStopped() {
        if (s.session) s.session.stopped = true;
        onGenerationEnded();
    }

    /** GENERATION_ENDED / GENERATION_STOPPED: a spent note never reaches a later prompt. */
    function onGenerationEnded() {
        if (s.session?.prompted) clearPrompts();
        s.deferred = false;
        markIdle();
        // A save that failed and was not made good after the reply (or the reply never came): again soon.
        if (store.dirty()) store.scheduleSave();
    }

    function install({ globalName = INTERCEPTOR_NAME } = {}) {
        for (const [key, place] of V1_KEYS) setPrompt(key, '', place);
        clearPrompts();
        if (globalName) globalThis[globalName] = interceptor;
        // A module turned ready or dormant: guarded blocks of its are asked again (store.lifecycleChanged).
        s.offModules?.();
        s.offModules = events?.on?.('modules', () => {
            if (store.lifecycleChanged?.()) events?.emit('head', { index: store.headIndex(), reason: 'module' });
        }) ?? null;
        for (const off of s.offBoard) off();
        s.offBoard = ['committed', 'head'].flatMap(name => [events?.on?.(name, stopChangedBoard), events?.on?.(name, resumeHeldBoard)]).filter(Boolean);
        const source = ctx?.eventSource;
        const names = ctx?.eventTypes ?? ctx?.event_types ?? {};
        const on = (event, fn) => {
            if (!event || typeof source?.on !== 'function') return;
            source.on(event, fn);
            s.listeners.push([event, fn]);
        };
        on(names.GENERATION_STARTED, onGenerationStarted);
        on(names.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        on(names.GENERATE_AFTER_COMBINE_PROMPTS, onTextPromptReady);
        on(names.MESSAGE_RECEIVED, onMessageReceived);
        on(names.GENERATION_ENDED, onGenerationEnded);
        on(names.GENERATION_STOPPED, onGenerationStopped);
        on(names.CHAT_CHANGED, onChatChanged);
        on(names.CHAT_RENAMED, onChatRenamed);
        // MESSAGE_EDITED too: a record's swipe mark follows an edit (persist.js restamp), so a Continue
        // after it still finds the record.
        for (const [event, reason] of [[names.MESSAGE_DELETED, 'delete'], [names.MESSAGE_SWIPED, 'swipe'], [names.CHARACTER_FIRST_MESSAGE_SELECTED, 'swipe'], [names.MESSAGE_EDITED, 'edit']]) on(event, () => onTimelineChanged(reason));
        on(names.MESSAGE_SWIPE_DELETED, onSwipeDeleted);
        return getApi();
    }

    function uninstall({ globalName = INTERCEPTOR_NAME } = {}) {
        s.offModules?.();
        s.offModules = null;
        for (const off of s.offBoard) off();
        s.offBoard = [];
        const source = ctx?.eventSource;
        for (const [event, fn] of s.listeners) (source?.removeListener ?? source?.off)?.call(source, event, fn);
        s.listeners = [];
        if (globalName && globalThis[globalName] === interceptor) delete globalThis[globalName];
        clearPrompts();
        markIdle();
    }

    return { install, uninstall, onMessageReceived, onChatChanged, seed, onChatRenamed, onTimelineChanged, onGenerationEnded };
}
