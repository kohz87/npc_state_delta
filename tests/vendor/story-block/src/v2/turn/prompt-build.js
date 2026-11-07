// Story Suite v2: what is built and decided before the reply, moved out of createTurn unchanged: the beforeGenerate cues, what
// modules send under their own keys, the two prompt texts, the canGenerate question and what a hold-back does, the too-small notice,
// the generation interceptor, and the history stripped of hidden blocks. `createPromptBuild(s, deps)` is given the turn's state
// holder `s` and the turn parts it uses; it never imports turn.js.

import { extractBlock, hasHidden, hasLegacy, stripBlock } from '../capture.js';
import { HOST_MODULE } from '../registry.js';
import { assemble, contextNotice, estimateTokens } from '../prompt.js';
import { ensureModules, makeView } from '../sdk.js';
import { cutAt } from '../../text.js';
import { CORE_FEATURE } from '../features.js';
import { RESOLVE as RPG_RESOLVE } from '../lean-rpg/names.js';
import { NO_ROLLS_LINE, receiptCue } from '../lean-rpg/cue.js';
import { holdStart } from './fight-start.js';
import { readRecord } from '../persist.js';
import { hashText } from '../assist/common.js';
import { boardFailure, boardStartState } from './held-board.js';
import { TIMED_OUT, defuseMacros, firstLine, mapContent, stripBattleMarker, substituteNames, within } from './text.js';

// The most a module's hook may keep whole in the tail (`{ text, keep: true }` lines): two meeting cues and a rumor fit; more is droppable.
export const KEPT_LINES_MAX = 4;
export const KEPT_CHARS_MAX = 4000;

export function createPromptBuild(s, deps) {
    const { ctx, metadata, store, bus, registry, settings, events, timeline, onBlocked, notify, initial, prepare, hostSettings, viewReader, view, contextNow, hasCarrier, lastCarrier, isPrelude, markBusy, markIdle, setPrompts, clearPrompts, problem, trySave, held, claimQuiet, FOREGROUND, HOOK_TIMEOUT_MS, ASSIST_WAIT_MS, RPG_LOAD_WAIT_MS, OWN_PROMPT_PARTS, OWN_PROMPT_CHARS, STRIP_CACHE, HAS_BLOCK, HAS_LEGACY, hookTimeout, normalizeType } = deps;
    let toldRestore = null;
    let recovering = null;

    function recoverOnce() {
        const holder = metadata();
        if (recovering?.holder === holder || !timeline?.needsRecovery()) return;
        const attempt = { holder };
        recovering = attempt;
        try {
            Promise.resolve(timeline.recover()).then(() => {
                if (recovering === attempt) recovering = null;
            }, error => {
                if (recovering === attempt) recovering = null;
                problem({ code: 'FAILED', message: `The restore could not be checked: ${error?.message ?? error}` });
            });
        } catch (error) {
            if (recovering === attempt) recovering = null;
            problem({ code: 'FAILED', message: `The restore could not be checked: ${error?.message ?? error}` });
        }
    }

    // beforeGenerate (§4.1 step 3): each hook may return lines for the tail, or commands to
    // commit now as `system` receipts: string[] | { lines?: string[], commands?: [{ type, payload }] }.
    // A Continue (the same reply goes on) commits nothing (B3-9): hooks are told `{ type, dryRun,
    // commit: false }` and their commands are not run. A dry run (SillyTavern counting tokens) never
    // gets here: SillyTavern 1.19 runs no interceptor for one (Generate: `if (!dryRun)`), so the
    // interceptor's own generation is never a dry run (r2-1).
    async function runCues(type = 'normal', { dryRun = false } = {}) {
        const cues = {};
        let committed = false;
        const prechecks = [];
        let previewState = null;
        const requested = [];
        const commit = !dryRun && type !== 'continue';
        // `again`: an earlier attempt at this reply was never captured (a retried interceptor), so a hook may reuse its work.
        const again = s.session !== null;
        for (const { moduleId, fn } of registry.hookEntries('beforeGenerate')) {
            let out;
            const limit = hookTimeout(fn);
            try { out = await within(fn(view(), { type, dryRun, commit, again }), limit); } catch (error) {
                problem({ module: moduleId, code: 'FAILED', message: `beforeGenerate failed: ${error?.message ?? error}` });
                continue;
            }
            if (out === TIMED_OUT) {
                problem({ module: moduleId, code: 'TIMEOUT', message: `beforeGenerate did not answer within ${limit / 1000} s; the reply went on without its notes.` });
                continue;
            }
            if (out?.fightStart?.opening && out.fightStart.original) {
                const chat = ctx?.chat ?? [], last = chat.at(-1);
                if (!last?.is_user || readRecord(chat.at(-2))?.sid !== out.fightStart.anchor
                    || hashText(String(last.mes ?? '').trim()) !== out.fightStart.message) {
                    return { blocked: { moduleId, reason: 'The chat changed while the fight was being prepared.' } };
                }
                const result = bus.run(RPG_RESOLVE, out.fightStart.opening, { cause: 'system' });
                if (result?.ok && result.receipt?.data?.v2?.result?.opened?.length) {
                    const pending = holdStart(metadata(), ctx?.chat, { mode: 'new', original: out.fightStart.original,
                        opening: { payload: out.fightStart.opening, seed: result.receipt.seed }, result: result.receipt.data.v2.result });
                    if (pending) return { blocked: { moduleId, reason: 'Choose how to play the waiting fight.', fightStart: true } };
                }
                // If the opening cannot be prepared, the ordinary planner remains available.
                out = { ...out, commands: [...(out.commands ?? []), { type: RPG_RESOLVE, payload: out.fightStart.original }] };
            }
            // A merged hook (domains/index.js mergeParts) keeps the answers of the parts that did answer and reports the others.
            for (const entry of Array.isArray(out?.problems) ? out.problems : []) problem({ module: moduleId, code: entry.code, message: entry.message });
            const lines = Array.isArray(out) ? out : Array.isArray(out?.lines) ? out.lines : [];
            // The RPG's rolls and its "no rolls" line outrank ordinary tail notes when the tail is trimmed (prompt.js).
            // A hook may give a line as `{ text, keep: true }`: kept whole whatever the budget says (prompt.js `pinned`), like the no-rolls line.
            // A module keeps at most KEPT_LINES_MAX lines and KEPT_CHARS_MAX characters this way (code points); a kept line over that
            // is passed as an ordinary line, which the budget may drop, so one module can never spend the whole tail.
            let keptLines = 0, keptChars = 0;
            const given = lines.map(line => {
                if (typeof line === 'string') return line === NO_ROLLS_LINE ? { text: line, keep: true } : line;
                if (!(line && typeof line === 'object' && typeof line.text === 'string' && line.text.trim())) return null;
                if (line.keep !== true) return line.text;
                const size = [...line.text].length;
                if (keptLines >= KEPT_LINES_MAX || keptChars + size > KEPT_CHARS_MAX) return line.text;
                keptLines += 1; keptChars += size;
                return { text: line.text, keep: true };
            }).filter(line => line !== null);
            if (given.length) cues[moduleId] = given;
            for (const command of commit && Array.isArray(out?.commands) ? out.commands : []) {
                // A prelude (Assist's roll, the RPG's rolls) is previewed for the prompt, without writing on the
                // previous reply. Completion runs the same seed on the generated reply; only that transaction is stored.
                if (isPrelude(command?.type)) {
                    requested.push({ moduleId, type: command.type, payload: command.payload ?? {}, seed: command.seed });
                    continue;
                }
                const result = await bus.command(command?.type, command?.payload ?? {}, { cause: 'system' });
                if (result?.ok) {
                    committed = true;
                    events?.emit('committed', { receipt: result.receipt });
                } else problem({ module: moduleId, code: result?.code ?? 'FAILED', message: `The cue "${command?.type}" was not committed: ${result?.message ?? 'unknown error'}` });
            }
        }
        // Other cues may settle a fight or change a modifier. Preview on the state they leave,
        // which is also the state the generated reply's prelude will start from.
        for (const { moduleId, type: preludeType, payload, seed } of requested) {
            if (preludeType === RPG_RESOLVE && payload?.board?.setup?.opening) {
                const checked = boardStartState(bus, store.head(), payload.board);
                if (checked.error) return { blocked: { moduleId, reason: checked.error } };
            }
            const prior = s.session?.prechecks?.find(step => step.type === preludeType && JSON.stringify(step.payload) === JSON.stringify(payload));
            const result = bus.run(preludeType, payload, { cause: 'system', ...(previewState ? { state: previewState } : {}), ...(prior || seed !== undefined ? { seed: prior?.seed ?? seed } : {}) });
            if (result?.ok) {
                // The RPG's rolls move bars (hits, heals, skill costs): the tail's block lines are read from the state they leave, so they say what the cue says.
                if (preludeType === RPG_RESOLVE && result.state) previewState = result.state;
                prechecks.push({ type: preludeType, payload, seed: result.receipt.seed });
                // A prelude that says it is not for the narrator (`narrate: false`, the RPG's no-rolls note) is stored with the reply and told to no one.
                if (result.receipt.narrate === false) continue;
                const told = `[Happened]\n${receiptCue(result.receipt)}`;
                cues[moduleId] = [...(cues[moduleId] ?? []), preludeType === RPG_RESOLVE ? { text: told, keep: true, ...(payload?.board ? { board: true } : {}) } : told];
            } else if (preludeType === RPG_RESOLVE && payload?.board) {
                const reason = boardFailure('The fight could not be prepared:', result?.message);
                problem({ module: moduleId, code: result?.code ?? 'FAILED', message: reason });
                return { blocked: { moduleId, reason } };
            } else problem({ module: moduleId, code: result?.code ?? 'FAILED', message: `The cue "${preludeType}" was not prepared: ${result?.message ?? 'unknown error'}` });
        }
        // Saved with the reply (MESSAGE_RECEIVED), not now: each save writes the whole chat file, and the
        // reply's save comes moments later with these cues in it. A reply that never comes still has them
        // saved: GENERATION_ENDED / GENERATION_STOPPED and CHAT_CHANGED save what is unsaved.
        if (committed) {
            store.deferSave?.();
            s.deferred = true;
        }
        return { cues, prechecks, previewState };
    }

    // What modules send with the reply on their own, under their own prompt keys (SPEC §5: NPC State
    // Delta's dossiers): each `ownPrompt(view)` hook's [{ label, text }] (one { label, text } or a string
    // also do), read at once (a promise is not waited for), names filled in as SillyTavern fills them.
    // It is counted, never sent by Story Block: the share of the context (prompt.js contextFit) and the
    // settings' prompt size count it. A hook that throws or answers nothing counts nothing; the size is a
    // report, never a reason to hold the reply back. → [{ module, label, place: 'own', text, tokens }]
    function sentByModules(current) {
        const out = [];
        for (const { moduleId, fn } of registry.hookEntries('ownPrompt')) {
            let answer;
            try { answer = fn(current); } catch { continue; }
            if (typeof answer?.then === 'function') {
                answer.then?.(() => {}, () => {});
                continue;
            }
            const list = typeof answer === 'string' ? [{ text: answer }] : Array.isArray(answer) ? answer : answer && typeof answer === 'object' ? [answer] : [];
            const name = registry.module(moduleId)?.name ?? moduleId;
            for (const item of list.slice(0, OWN_PROMPT_PARTS)) {
                const raw = typeof item === 'string' ? item : item?.text;
                if (typeof raw !== 'string' || !raw.trim()) continue;
                const text = substituteNames(cutAt(raw, OWN_PROMPT_CHARS), ctx);
                const label = typeof item?.label === 'string' && item.label.trim() ? cutAt(item.label.replace(/\s+/g, ' ').trim(), 80) : name;
                out.push({ module: moduleId, label, place: 'own', text, tokens: estimateTokens(text) });
            }
        }
        return out;
    }

    function build(cues = {}, state = null) {
        const untold = store.untold();
        // (`state`: the state the reply's prelude rolls leave, when it has one; the tail's lines are made from it)
        const current = state ? makeView({ store, registry, settings, chat: ctx?.chat, active: viewReader, state }) : view();
        const own = sentByModules(current);
        const ownTokens = own.reduce((sum, part) => sum + part.tokens, 0);
        const result = assemble({ registry, view: current, untold, settings: hostSettings(), cues, substitute: text => substituteNames(text, ctx), context: contextNow(), ownTokens, rolled: state !== null });
        for (const message of result.problems) problem({ code: 'FAILED', message });
        return { ...result, own, untold };
    }

    /** SillyTavern's generate interceptor: (chat, contextSize, abort, type). */
    // canGenerate (MODULES §F12): every module may hold a story generation back, e.g. until the
    // player character exists. `false` or { ok: false, reason, action? } blocks; the first one is the answer.
    // A hook that throws, or does not answer within HOOK_TIMEOUT_MS, is logged and does not block
    // (a bug must not lock the reader out). `all` asks every module (Home's "Before you start"): the
    // list of those that hold back, nothing logged (it is asked again on each redraw).
    // A module that is dormant, or held by a restore barrier, is not asked at all (registry.hookEntries leaves
    // it out): its veto is suppressed, never answered false, since one refusal stops the whole story.
    async function askCanGenerate({ all = false, type = 'normal' } = {}) {
        const found = [];
        // A restore barrier (registry.setRestore) holds the story back for everyone until every part agrees;
        // the hooks of the modules it holds are not asked (registry.hookEntries leaves them out).
        const barrier = registry.restore?.();
        if (barrier?.state === 'pending') {
            const entry = { moduleId: HOST_MODULE, reason: registry.lifecycle?.(HOST_MODULE)?.reason ?? 'A restore is in progress.' };
            if (!all) return entry;
            found.push({ ...entry, name: registry.module(HOST_MODULE)?.name ?? HOST_MODULE, action: false, canOpen: false });
        }
        for (const { moduleId, fn } of registry.hookEntries('canGenerate')) {
            let answer;
            try { answer = await within(fn(view(), { type, commit: !all }), HOOK_TIMEOUT_MS); } catch (error) {
                if (!all) problem({ module: moduleId, code: 'FAILED', message: `canGenerate failed: ${error?.message ?? error}` });
                continue;
            }
            if (answer === TIMED_OUT) {
                if (!all) problem({ module: moduleId, code: 'TIMEOUT', message: `canGenerate did not answer within ${HOOK_TIMEOUT_MS / 1000} s; the story went on.` });
                continue;
            }
            if (answer === false || (answer && typeof answer === 'object' && answer.ok === false)) {
                const name = registry.module(moduleId)?.name ?? moduleId;
                const reason = typeof answer?.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : `${name} is not ready for the story to go on yet.`;
                const entry = { moduleId, reason, ...(answer?.fightStart === true ? { fightStart: true } : {}) };
                if (all) {
                    // The button's words (a module's `action`, flattened, ≤ 40 code points), or false for none.
                    const action = answer?.action === false ? false
                        : typeof answer?.action === 'string' ? Array.from(answer.action.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()).slice(0, 40).join('').trim() : '';
                    entry.name = name;
                    entry.action = action;
                    entry.canOpen = action !== false && typeof onBlockedOf(moduleId) === 'function';
                } else return entry;
                found.push(entry);
            }
        }
        return all ? found : null;
    }
    const blockedBy = type => askCanGenerate({ type });

    // A module's own onBlocked hook (what it does when it held the story back: an example module opens the
    // character wizard). → true when it ran without throwing.
    // C3-2: through the off-aware hook list, so a hook whose feature is off is never called (nor offered).
    const onBlockedOf = moduleId => registry.hookEntries('onBlocked').find(entry => entry.moduleId === moduleId)?.fn ?? null;
    function runOnBlocked(moduleId, reason) {
        const fn = onBlockedOf(moduleId);
        if (typeof fn !== 'function') return false;
        try {
            fn(reason, moduleId);
            return true;
        } catch (error) {
            problem({ module: moduleId, code: 'FAILED', message: `onBlocked failed: ${error?.message ?? error}` });
            return false;
        }
    }

    // `keepSession`: the held fight reply's session is put back once the block is told (it is still captured).
    function block({ moduleId, reason, fightStart = false, keepSession = false }, abort) {
        const held = keepSession ? s.session : null;
        s.session = null;
        markIdle();
        clearPrompts();
        const restoring = moduleId === HOST_MODULE && registry.restore?.().state === 'pending';
        const holder = restoring ? metadata() : null;
        const epoch = restoring ? registry.restoreEpoch?.() : null;
        const tell = restoring && (toldRestore?.holder !== holder || toldRestore?.epoch !== epoch);
        if (tell) {
            toldRestore = { holder, epoch };
            problem({ code: 'RESTORE_PENDING', message: `The reply was not sent. ${reason}` });
        }
        try { abort?.(true); } catch (error) { console.warn('[Story Suite] the generation could not be stopped', error); }
        if (fightStart) {
            try { Promise.resolve(ctx?.saveChat?.()).catch(() => {}); } catch { /* the next chat write saves it */ }
            try { (ctx?.saveMetadata ?? ctx?.saveMetadataDebounced)?.call(ctx); } catch { /* the next chat write saves it */ }
            events?.emit('head', { index: store.headIndex(), reason: 'fight-start' });
            return;
        }
        if (!restoring || tell) {
            try { notify?.(reason, moduleId); } catch { /* a missing toastr is not an error */ }
        }
        runOnBlocked(moduleId, reason);
        if (typeof onBlocked === 'function') {
            try { onBlocked(reason, moduleId); } catch (error) {
                problem({ module: moduleId, code: 'FAILED', message: `onBlocked failed: ${error?.message ?? error}` });
            }
        }
        s.blocks.push({ moduleId, reason });
        if (keepSession) s.session = held;
    }

    // The static part alone is over Story Suite's share of the context: told once per chat (a toast and the
    // Problems list); the reply still goes out with it.
    function tellTooSmall(fit) {
        if (!fit?.tooSmall) return;
        let chatId = null;
        try { chatId = typeof ctx?.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx?.chatId; } catch { chatId = null; }
        const key = String(chatId ?? '');
        if (s.toldSmall.has(key)) return;
        s.toldSmall.add(key);
        const reason = contextNotice(fit);
        problem({ code: 'CONTEXT_SMALL', message: reason });
        try { notify?.(reason, null); } catch { /* a missing toastr is not an error */ }
    }

    async function interceptor(_chat, contextSize, abort, type) {
        const kind = normalizeType(type);
        if (!FOREGROUND.includes(kind)) {
            // A quiet generation whose instruction is known is told apart at its own prompt-ready, which loses Story Block's text
            // there (quietPrompt, below): the slots keep the reply's text for the reply's own prompt, whichever of the two is built first.
            const known = kind === 'quiet' && claimQuiet();
            if (known && s.session && !s.session.prompted) return;
            // Any other (an impersonation, a quiet generation with no instruction told): a prompt built while the reply's own is
            // pending must not carry its text; the reply's prompt gets it back at that prompt's prompt-ready (below).
            // A reply already on its way keeps its session, so it is still captured.
            if (s.session && !s.session.prompted) s.session.background += 1;
            clearPrompts();
            return;
        }
        if (!ctx?.chat) return;
        // The feature switched on a moment ago: its code is waited for (no pass over the chat; onChatChanged did that).
        if (typeof prepare === 'function') { try { const waiting = prepare({ scan: false }); if (waiting) await within(waiting, RPG_LOAD_WAIT_MS); } catch { /* the loader reports its own failure */ } }
        // The safety net still reading the last reply: waited for briefly, so its lines are in this prompt.
        if (s.assistPending) await within(s.assistPending, ASSIST_WAIT_MS);
        markBusy();
        if (Number.isFinite(Number(contextSize)) && Number(contextSize) > 0) s.lastSize = Number(contextSize);
        // B-b2-timeline-r2-1: never a dry run (SillyTavern runs interceptors only for real generations).
        // It is not read from GENERATION_STARTED: another caller's dry run (token counting) can start
        // between this generation's GENERATION_STARTED and this call, and would cost the reply its capture.
        try {
            // What is waiting for the turn's idle save goes with the reply's own save (it is on its way);
            // without idle saves it is written now.
            if (store.idleSaves?.()) {
                if (store.dirty()) store.deferSave?.();
            } else await trySave('before the reply');
            // A Regenerate removes the old reply before this runs, without an event for it.
            if (store.headIndex() !== lastCarrier()) store.rebuild();
            // Stored packs not yet checked (the checker is late or failed): no state is started from a pack-less read and no prompt goes out; it is said once and the reply stops.
            if (hasCarrier()) {
                const why = held();
                if (why) { block({ moduleId: HOST_MODULE, reason: why }, abort); return; }
                store.ensureInitial(initial());
            }
            // A pending barrier may need settling after a head change. Healthy sends do not settle here.
            if (registry.restore?.().state === 'pending') {
                timeline?.settle();
                if (registry.restore?.().state === 'pending') {
                    recoverOnce();
                    const waiting = await blockedBy(kind);
                    if (waiting) { block({ ...waiting, keepSession: Boolean(s.heldBoard) }, abort); return; }
                }
            }
            await ensureModules({ store, bus, registry, events });
            if (s.heldBoard) {
                block({ moduleId: 'story-block', reason: 'Restore the fight sheet or gear, or discard the fight and regenerate the held reply.', keepSession: true }, abort);
                return;
            }
            const blocked = await blockedBy(kind);
            if (blocked) {
                block(blocked, abort);
                return;
            }
            const { cues, prechecks, previewState, blocked: cueBlocked } = await runCues(kind);
            if (cueBlocked) { block(cueBlocked, abort); return; }
            const built = build(cues, previewState);
            tellTooSmall(built.fit);
            const chat = ctx.chat;
            const last = chat.length - 1;
            const index = kind === 'swipe' || kind === 'continue' ? last : chat.length;
            s.session = {
                type: kind,
                prechecks,
                index,
                untold: built.untold.map(receipt => receipt.id),
                staticText: defuseMacros(built.staticText),
                tailText: defuseMacros(built.tailText),
                parts: built.parts,
                // A Continue's reply was captured before: only blocks the continuation adds to this
                // text are read (capture.js continuation()).
                base: kind === 'continue' ? String(chat[last]?.mes ?? '') : null,
                prompted: false,
                background: 0,
                restored: '',
            };
            s.abortBoard = abort;
            setPrompts(s.session.staticText, s.session.tailText);
        } catch (error) {
            s.session = null;
            markIdle();
            clearPrompts();
            problem({ code: 'FAILED', message: `The reply's notes could not be built: ${error?.message ?? error}` });
        }
    }

    function strippedText(text) {
        if (!HAS_BLOCK.test(text) && !HAS_LEGACY.test(text)) return text;
        let out = s.stripped.get(text);
        if (out === undefined) {
            // (A hidden comment may hold only lines left in the story, B-a1-3: it goes too. So does a v1 envelope.)
            out = extractBlock(text) === null && !hasHidden(text) && !hasLegacy(text) ? text : stripBlock(text);
            if (s.stripped.size >= STRIP_CACHE) s.stripped.delete(s.stripped.keys().next().value);
            s.stripped.set(text, out);
        }
        return out;
    }
    // Only while the RPG is on: with it off a reply's text goes into the prompt as it always did.
    const battleOn = () => registry.featureOn?.(CORE_FEATURE.leanRpg) === true;
    function stripHistory(chat) {
        const strip = battleOn() ? text => stripBattleMarker(strippedText(text)) : strippedText;
        for (const message of chat) {
            if (message?.role !== 'assistant') continue;
            const content = mapContent(message.content, strip);
            if (content !== message.content) message.content = content;
        }
    }

    // A background prompt seen while the reply's own is pending: its slots were emptied for it;
    // fill them again for the reply. True when this prompt was the background one.
    function backgroundPrompt() {
        if (!s.session || s.session.prompted || s.session.background <= 0) return false;
        s.session.background -= 1;
        if (!s.session.background) setPrompts(s.session.staticText, s.session.tailText);
        return true;
    }

    // Another caller's prompt built while the reply's own is pending (generateRaw: SillyTavern runs no interceptor for it and puts
    // no extension prompt in it, yet tells its prompt-ready like the reply's): it holds neither of the slots' texts, which the
    // reply's own prompt always does while they are set. It is left alone and the reply's own prompt is still waited for.
    function foreignPrompt(holds) {
        if (!s.session || s.session.prompted || s.session.background > 0) return false;
        const marks = [s.session.staticText, s.session.tailText].map(firstLine).filter(Boolean);
        return marks.length > 0 && !marks.some(holds);
    }

    return { runCues, build, askCanGenerate, runOnBlocked, interceptor, battleOn, stripHistory, backgroundPrompt, foreignPrompt };
}
