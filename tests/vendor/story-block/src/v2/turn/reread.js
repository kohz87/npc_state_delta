// Story Suite v2: Re-read, moved out of createTurn unchanged: read a reply's <Changes> block again (and the safety net's stored lines),
// replace the reply's story with what it now says, hide the block, and tell the screens. `createReread(s, deps)` is given the turn's
// state holder `s` and the turn parts it calls (the capture flow's functions, the session's problem / trySave / planAgain); it never
// imports turn.js.

import { adoptLegacy, extractBlock, hideBlock, legacyRead, markOff } from '../capture.js';
import { replacedProofs, reusePlan } from '../evidence.js';
import { readRecord } from '../persist.js';

export function createReread(s, deps) {
    const { ctx, store, events, timeline, refusal, changeHeads, readBlock, strayProblems, capped, lateLines, assistRoom, nowLines, heldInReply, legacyProblem, storySeeds, afterCapture, captureEach, stepSeeds, withCaps, isPrelude, LATE, NOW, planAgain, problem, trySave } = deps;

    async function reread(index) {
        const chat = ctx?.chat ?? [];
        const message = Number.isInteger(index) ? chat[index] : undefined;
        if (!message) return refusal('NOT_FOUND', `There is no message ${index} in this chat.`);
        if (message.is_user) return refusal('REFUSED', 'This is the reader\'s own message; only replies hold story changes.');
        // (a reply a restore hid keeps its record, and can be read again; a system message of SillyTavern's has none)
        if (message.is_system && !readRecord(message)) return refusal('REFUSED', 'This is a system message; it holds no story changes.');
        if (s.session) return refusal('REFUSED', 'A reply is being written; Re-read once it is done.');
        if (!readRecord(message)) return refusal('REFUSED', 'This reply keeps no story record, so there is nothing to read again.');
        const base = store.before?.(index);
        if (!base) return refusal('FAILED', 'This chat has no story state yet.');
        const stored = String(message.mes ?? '');
        // A v1 envelope is read as the live capture reads it (an older reply that wrote its changes only there gets them now).
        const adopted = adoptLegacy(stored);
        const mes = adopted.text;
        const heads = changeHeads();
        const block = extractBlock(mes, 'Changes', null, { heads });
        const parsed = block === null ? { lines: [], problems: [] } : readBlock(index, block);
        const problems = [...parsed.problems, ...strayProblems(index, mes, heads, {}, parsed.lines.map(line => line.raw))];
        if (adopted.legacy === 'read' || legacyRead(mes)) problems.push(legacyProblem(index));
        const receipts = [];
        const lines = capped(index, parsed.lines, problems);
        // The safety net's stored lines (MODULES §F123): the previous reply's late ones, then this reply's
        // own, as the live capture ran them. Never a new model call.
        const own = lines.map(line => line.raw);
        const late = lateLines(index, own);
        const extra = assistRoom(index, [...late.map(line => ({ line, mark: LATE })), ...nowLines(mes, [...own, ...late.map(line => line.raw)], own).map(line => ({ line, mark: NOW }))], lines.length, problems);
        // A module held back (dormant, or a restore is pending) cannot read its lines again, and replacing the
        // reply's story without them would lose what it stored: nothing is replaced while one is involved.
        const waiting = heldInReply(message, [...lines, ...extra.map(item => item.line)]);
        if (waiting) return refusal(waiting.code, `Re-read is waiting for ${waiting.name}: ${waiting.reason} Nothing was changed.`);
        const swipe = message.swipe_id;
        let ops;
        let off = [];
        let steps = [];
        // `replacing`: the proof of the blocks this Re-read replaces (its story lines and its steps): ids of them may be held again by the blocks that replace
        // them. `reuse`: the occurrences those blocks have, given again per operation while the number of blocks of the operation is unchanged.
        let plan = null;
        const problemsFrom = problems.length;
        const reply = store.carrierSid?.(index) ? { index, sid: store.carrierSid(index) } : null;
        try {
            let after;
            // The Re-read is planned; when an operation has more or fewer blocks than it replaces it is planned again with none of that
            // operation's old occurrences given back (evidence.js reusePlan), and again while a plan finds another operation changed (the
            // retired set only grows). Every pass starts from the same inputs but that set: seeds, steps' seeds, plan and outputs are made anew.
            let retire = new Set();
            const bound = 32;     // (each pass retires at least one more operation, so a reply ends well before; a plan that does not is not stored)
            let settled = false;
            for (let pass = 0; pass <= bound; pass += 1) {
                receipts.length = 0;
                problems.length = problemsFrom;
                steps = [];
                const seeds = storySeeds(readRecord(message));
                const record = readRecord(message);
                // Native checkpoints name exact prefixes. An unchanged reply reusing the same roots must keep their
                // Sources too, or a fresh ordinal alone changes owner state and silently drops its native checkpoint.
                // Changed text and chats without published native work retain the ordinary allocation behavior.
                const preserveSources = timeline?.hasNativeChanges?.() === true
                    && record?.spans?.some(span => span.boundaries?.[0]?.payloadHash === store.payloadHashAt(index));
                plan = { blocks: [], pending: 0, replacing: replacedProofs(record), reuse: reusePlan(record, retire), preserveSources };
                const prechecks = (record?.receipts ?? [])
                    .filter(receipt => receipt.beforeGenerate === true && isPrelude(receipt.type))
                    .map(receipt => ({ type: receipt.type, payload: receipt.replan?.payload ?? {}, seed: receipt.seed }));
                const prepared = prechecks.length ? await afterCapture(index, { type: 'reread', problems, state: base, reply, plan, prechecks, onlyPrechecks: true }) : [];
                plan.blocks.push(...prepared.map(step => ({ n: step.ops.length, receipt: step.receipt, ...(step.block ? { block: step.block } : {}) })));
                receipts.push(...prepared.map(step => step.receipt));
                ({ ops, off, state: after } = await captureEach(index, lines, receipts, problems, prepared.at(-1)?.state ?? base, seeds, new Map(), null, plan));
                ops = [...prepared.flatMap(step => step.ops), ...ops];
                for (const mark of [LATE, NOW]) {
                    const group = extra.filter(item => item.mark === mark).map(item => item.line);
                    if (!group.length) continue;
                    const more = await captureEach(index, group, receipts, problems, after, seeds, new Map(), mark, plan);
                    ops = [...ops, ...more.ops];
                    off = [...new Set([...off, ...more.off])];
                    after = more.state;
                }
                // The reply's afterCapture steps, run again after its new story lines (none when none was kept).
                if (receipts.length) steps = await afterCapture(index, { type: 'reread', problems, state: after, reply, seeds: stepSeeds(readRecord(message)), plan });
                else steps = await afterCapture(index, { type: 'reread', problems, state: after, reply, seeds: stepSeeds(readRecord(message)), plan, alwaysOnly: true });
                const unsure = plan.reuse.ambiguous([...plan.blocks, ...steps]);
                if (!unsure.length) { settled = true; break; }
                retire = new Set([...retire, ...unsure]);
            }
            // A plan that still reports a changed operation is never stored.
            if (!settled) return refusal('CONFLICT', 'The reply could not be read again without taking blocks for ones that went; nothing was changed.');
            // B-b2-timeline-r2: the lines ran while the reader could act (a capture handler may wait). A
            // message deleted, another chat opened, the reply swiped or edited, or a reply begun in that
            // time: what was read is no longer this reply's, so nothing is stored (not even on the
            // message that now stands at `index`).
            const live = ctx?.chat ?? [];
            if (live[index] !== message || message.swipe_id !== swipe || String(message.mes ?? '') !== stored || s.session) {
                return refusal('CONFLICT', 'The chat changed while the reply was read again (a message was deleted, swiped, edited or added); nothing was changed. Press Re-read again.');
            }
            // A kept system step marked `replan` (B-a1-13) runs again on the new story changes, as it ran
            // before: a system step, its own seed.
            // A guarded block of a later reply is planned again on its own reply, keeping its ordinal (info.span).
            const rerun = (state, receipt, info = null) => planAgain(state, receipt, info, !Number.isInteger(info?.index) || info.index === index ? reply : null);
            store.replaceStory(index, { ops, receipts, rerun, settled: steps, blocks: plan.blocks });
        } catch (error) {
            return refusal('CONFLICT', `${error?.message ?? error}`);
        }
        // The lines it left in the story are listed in the hidden comment (capture.js), and every comment's
        // display lines are marked as this read found their features (markOff).
        const hidden = withCaps(markOff(hideBlock(mes, 'Changes', { heads, legacy: adopted.legacy === 'read' }), off, 0), 0, true);
        if (hidden !== stored) {
            message.mes = hidden;
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) message.swipes[message.swipe_id] = hidden;
            redraw(index, message);
        }
        timeline?.settle();
        if (timeline?.needsRecovery()) await timeline.recover();
        await trySave('after the Re-read');
        for (const receipt of [...receipts, ...steps.map(step => step.receipt)]) events?.emit('committed', { receipt });
        events?.emit('head', { index: store.headIndex(), reason: 'reread' });
        events?.emit('turn', { index, type: 'reread', receipts, steps: steps.map(step => step.receipt), problems, told: [] });
        return { ok: true, receipts, steps: steps.map(step => step.receipt), problems };
    }

    // Only the reply's text changed (its block hidden): SillyTavern's own save, told like any other.
    async function saveText() {
        try { await ctx.saveChat?.(); } catch (error) {
            problem({ code: 'SAVE_FAILED', message: `The reply could not be saved: ${error?.message ?? error}` });
        }
    }

    function redraw(index, message) {
        try { ctx.updateMessageBlock?.(index, message); } catch { /* not drawn yet: SillyTavern draws it from the saved text */ }
    }

    return { reread, saveText, redraw };
}
