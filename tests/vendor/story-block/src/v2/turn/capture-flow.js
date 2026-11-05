// Story Suite v2: the capture flow, moved out of createTurn unchanged: a reply's change lines read from its block, the ones the model
// wrote in the story or the safety net kept (stray, late, now), run one by one as their owner's capture command within the line cap,
// the afterCapture steps, the seeds and order a Re-read gives them, and the held-module check. `createCaptureFlow(s, deps)` is given the
// turn's state holder `s` and the turn parts it uses (the session's `problem`); it never imports turn.js.

import { MAX_CHANGE_LINES, makeView } from '../sdk.js';
import {
    LEGACY_PROBLEM, assistSections, grammarHeads, markCaps, parseChanges, sameChangeLine, strayLines, stripBlock,
} from '../capture.js';
import { cutAt } from '../../text.js';
import { refusedWhy } from '../assist/safety.js';
import { notWritten } from '../assist/extractor.js';
import { CHATTER_MAX, displayLines, readDisplayLine } from '../extras.js';
import { receiptWithCue } from '../lean-rpg/cue.js';
import { CAPTURE_PREFIX, HOST_MODULE } from '../registry.js';
import { within, TIMED_OUT } from './text.js';
import { occurrenceOf, operationKey } from '../evidence.js';
import { hash, readRecord } from '../persist.js';
import { LEAN_RPG_FEATURE, practiceFromRollsOnly } from '../lean-rpg/names.js';

export function createCaptureFlow(s, deps) {
    const { ctx, store, bus, registry, settings, events, hostSettings, view, viewReader, lateReader, problem, isCarrier, PRACTICE_LINE, HOOK_TIMEOUT_MS } = deps;

    // Runs the reply's change lines; returns { receipts, problems }.
    // Each line runs on the state the lines before it left (bus.run's `state`), as its owner's
    // capture handler (bus.run's `capture`), and is stored on the reply before the next one runs.
    // A reply holds at most maxChangeLines change lines; the rest are one Problem (pushed to `found`).
    const lineCap = () => (Number.isInteger(hostSettings()?.maxChangeLines) && hostSettings().maxChangeLines > 0 ? hostSettings().maxChangeLines : MAX_CHANGE_LINES);

    // A block's lines read, at most maxChangeLines of them, change lines or not; the rest are one Problem.
    function readBlock(index, text) {
        const cap = lineCap();
        const parsed = parseChanges(text, { max: cap });
        const problems = parsed.problems.map(line => problem({ index, code: 'UNREADABLE', message: line }));
        if (parsed.over) {
            const { count, total, first } = parsed.over;
            problems.push(problem({ index, code: 'TOO_MANY', message: `The reply has ${total} change lines; only the first ${cap} were read, so ${count} ${count === 1 ? 'line was' : 'lines were'} not used (from "${cutAt(first, 60)}").` }));
        }
        return { lines: parsed.lines, problems };
    }

    // The heads of the kinds the reply may write ("! encounter", "+ quest"), for the change lines a
    // model writes in the story near the block (capture.js strayLines). Read at each capture, so a
    // feature turned off takes its kinds' heads with it.
    function changeHeads() {
        try { return grammarHeads(registry.contexts().flatMap(context => context.kinds ?? [])); } catch { return new Set(); }
    }
    // The story's change lines that were not taken (too far up, written another way) as Problems.
    // (A line that repeats one the reply's block holds, `read` (raw), was used: it is not told.)
    function strayProblems(index, text, heads, options, read = []) {
        const used = new Set(read.map(sameChangeLine));
        return strayLines(text, heads, options).problems.filter(({ line }) => !used.has(sameChangeLine(line)))
            .map(({ line, reason }) => problem({ index, line, code: 'STRAY', message: `"${line}" was not used: ${reason}.` }));
    }
    // The one Problem of a reply whose changes were read from a v1 envelope (capture.js adoptLegacy).
    const legacyProblem = index => problem({ index, code: 'LEGACY_FORMAT', message: LEGACY_PROBLEM });

    function capped(index, all, found) {
        const cap = lineCap();
        if (all.length > cap) {
            const more = all.length - cap;
            found.push(problem({ index, code: 'TOO_MANY', message: `The reply has ${all.length} change lines; only the first ${cap} were read, so ${more} ${more === 1 ? 'line was' : 'lines were'} not used (from "${cutAt(all[cap].raw, 60)}").` }));
        }
        return all.slice(0, cap);
    }

    // The Assist safety net's marks on its receipts and Problems (MODULES §F123).
    const NOW = 'now';
    const LATE = 'late';
    // The safety net's lines that fit the reply's cap after `used` lines; the rest are one Problem.
    function assistRoom(index, items, used, found) {
        const room = Math.max(0, lineCap() - used);
        if (items.length > room) {
            const more = items.length - room;
            found.push(problem({ index, code: 'TOO_MANY', assist: items[room].mark, message: `(assist) The reply's lines fill its cap of ${lineCap()}, so ${more} safety-net ${more === 1 ? 'line was' : 'lines were'} not used (from "${cutAt(items[room].line.raw, 60)}").` }));
        }
        return items.slice(0, room);
    }

    // The previous reply's safety-net lines read after the reader had sent (its <Changes-assist-next>),
    // for reply `index` (not a Continue's): parsed, through the stricter wall for late lines, without the
    // ones the reply's own lines (`own`, raw) already hold.
    function lateLines(index, own = []) {
        const chat = ctx?.chat ?? [];
        const from = chat.slice(0, Math.max(0, index)).findLastIndex(isCarrier);
        if (from < 0 || lateReader?.faded().has(from)) return [];
        const stored = assistSections(String(chat[from]?.mes ?? '')).next;
        if (!stored.length) return [];
        const safe = parseChanges(stored.join('\n')).lines.filter(line => !refusedWhy(line, null, { late: true }));
        const keep = new Set(notWritten(safe.map(line => line.raw), own, { late: true }));
        return safe.filter(line => keep.has(line.raw));
    }

    // A reply's own safety-net lines (its <Changes-assist>), parsed, without the ones `own` already holds, nor
    // a place, time or weather `block` (the reply's own block lines, raw) set (extractor.js SCENE_KINDS).
    function nowLines(mes, own = [], block = own) {
        const stored = assistSections(String(mes ?? '')).now;
        if (!stored.length) return [];
        const parsed = parseChanges(stored.join('\n')).lines.filter(line => !refusedWhy(line, null));
        const keep = new Set(notWritten(parsed.map(line => line.raw), own, { scene: block }));
        return parsed.filter(line => keep.has(line.raw));
    }

    // How many lines of each display kind `mes` already shows (extras.js displayLines, the rule the card
    // draws by): lines a Continue or the extractor adds count after these against the cap (F115), so a
    // choice past it is told as one of the original reply's would be.
    const shownIn = mes => new Map(Object.entries(displayLines(mes, { entryOf: word => registry.capture(word), max: lineCap() }))
        .map(([kind, values]) => [kind, values.length]));

    // `before`: the reply's text before these lines were added (a Continue's, the extractor's), or null.
    // `type`: the generation's (normal, swipe, regenerate, continue) or 'late' (the extractor's lines).
    // `late` / `assist` (MODULES §F123): the Assist safety net's lines, run after the reply's own as story
    // lines marked as its (late: read from the reply before, after the reader had sent), within the same
    // cap per reply (`used`: lines the reply already read in an earlier call).
    async function captureLines(index, all, before = null, type = 'normal', { late = [], assist = [], used = 0, prechecks = [] } = {}) {
        const receipts = [];
        const found = [];
        const lines = capped(index, all, found);
        const extra = assistRoom(index, [...late.map(line => ({ line, mark: LATE })), ...assist.map(line => ({ line, mark: NOW }))], used + lines.length, found);
        const shown = typeof before === 'string' ? shownIn(before) : new Map();
        // One write of the reply's record for all its lines and its afterCapture steps (store.batch).
        let off = [];
        let steps = [];
        await (store.batch ?? (fn => fn()))(async () => {
            // The seeded pre-roll precedes this reply's story lines, as it did in the prompt.
            // Its Source is now this reply's; the previous reply is never changed.
            const prepared = prechecks.length ? await afterCapture(index, { type, problems: found, prechecks, onlyPrechecks: true }) : [];
            ({ off } = await captureEach(index, lines, receipts, found, null, null, shown));
            for (const mark of [LATE, NOW]) {
                const group = extra.filter(item => item.mark === mark).map(item => item.line);
                if (group.length) off = [...new Set([...off, ...(await captureEach(index, group, receipts, found, null, null, shown, mark)).off])];
            }
            // A pre-roll is part of this reply even when its narration has no Changes block.
            if (receipts.length || prepared.length) steps = [...prepared, ...await afterCapture(index, { type, problems: found })];
            // A reply with no story lines runs only the hooks that opted in (`hook.always === true`).
            else steps = await afterCapture(index, { type, problems: found, alwaysOnly: true });
        });
        return { receipts, problems: found, off, steps: steps.map(step => step.receipt) };
    }

    /**
     * afterCapture (SPEC §4.2 step 3): once the reply's story lines have run, each module's
     * `afterCapture(view, { index, type })` hook may return `{ commands: [{ type, payload }] }` to run as
     * `system` steps on the scene the reply ended up in (a turn-in its line read before the reply's own
     * `~ place` line). A step is stored on the reply right after its story lines, as part of that reply, its
     * receipt marked `afterCapture` (and `replan`), so a swipe or delete of the reply takes it back and a
     * Re-read runs the hook again on the new story lines. A Continue runs it again after the Continue's
     * lines. A hook that fails or takes longer than HOOK_TIMEOUT_MS, or a step that is refused, is a Problem.
     * Live (no `state`): each step is appended to the head as it runs. A Re-read passes `state` (the reply's
     * state after its new story lines), `reply` and `seeds` (the old steps' seeds by type, in order): nothing
     * is stored, and the steps come back as [{ ops, receipt, block? }] for store.replaceStory (`block`: what a
     * guarded step hands over, REPLAY.md; `plan` counts the guarded blocks the Re-read has planned so far, so
     * each gets its own ordinal). The same runner stores Assist's seeded pre-roll prelude with
     * `beforeGenerate: true`; Re-read plans that prelude before the story lines and replaces it too.
     */
    async function afterCapture(index, { type = 'normal', problems = [], state = null, reply = null, seeds = null, plan = null, prechecks = [], onlyPrechecks = false, alwaysOnly = false } = {}) {
        const steps = [];
        const live = state === null;
        let now = live ? store.head() : state;
        // A Re-read has stored nothing yet: the proof its lines and earlier steps planned is what the hooks and steps see.
        const planned = () => (live || !plan ? [] : [...plan.blocks.flatMap(piece => piece.block?.evidence ?? []), ...steps.flatMap(step => step.block?.evidence ?? [])]);
        // The reply's own receipts as far as this run knows them (`info.receipts`, read only when a hook asks): the store's for a live reply, a Re-read's planned ones.
        const replyReceipts = () => (live ? (store.receipts?.() ?? []).filter(entry => entry.index === index).map(entry => entry.receipt) : [...(plan?.blocks ?? []).map(piece => piece.receipt), ...steps.map(step => step.receipt)].filter(Boolean)).map(receiptWithCue);
        const hooks = [
            ...(prechecks.length ? [{ moduleId: HOST_MODULE, precheck: true, fn: () => ({ commands: prechecks }) }] : []),
            ...(onlyPrechecks ? [] : registry.hookEntries('afterCapture').filter(entry => !alwaysOnly || entry.fn.always === true)),
        ];
        for (const { moduleId, fn, precheck = false } of hooks) {
            const seen = live ? view() : makeView({ store, registry, settings, chat: ctx?.chat, active: viewReader, state: now, reply, pendingProofs: () => planned().map(proof => ({ proof, block: null })) });
            let out;
            try { out = await within(fn(seen, Object.defineProperty({ index, type, ...(alwaysOnly ? { always: true } : {}) }, 'receipts', { get: replyReceipts })), HOOK_TIMEOUT_MS); } catch (error) {
                problems.push(problem({ module: moduleId, index, code: 'FAILED', message: `afterCapture failed: ${error?.message ?? error}` }));
                continue;
            }
            if (out === TIMED_OUT) {
                problems.push(problem({ module: moduleId, index, code: 'TIMEOUT', message: `afterCapture did not answer within ${HOOK_TIMEOUT_MS / 1000} s; its steps after the reply's lines were not run.` }));
                continue;
            }
            for (const command of Array.isArray(out?.commands) ? out.commands : []) {
                const payload = command?.payload ?? {};
                const seed = command.seed ?? seeds?.(command?.type);
                const taking = plan ? occurrenceFor(plan, command?.type, payload) : null;
                const result = bus.run(command?.type, payload, { cause: 'system', state: live ? store.head() : now, ...(reply ? { reply: plan ? { ...reply, ...(taking.span && (plan.preserveSources || occurrenceOf(taking.span) === null) ? { ordinal: taking.span.source.ordinal } : {}), pending: plan.pending, opsBefore: plan.blocks.reduce((sum, piece) => sum + (Number.isInteger(piece.n) ? piece.n : 0), 0) + steps.reduce((sum, step) => sum + (Array.isArray(step.ops) ? step.ops.length : 0), 0) } : reply } : {}), ...(plan ? { planned: planned(), replacing: plan.replacing, reusing: taking.span, ...(Number.isInteger(taking.value) ? { occurrence: taking.value } : {}) } : {}), ...(seed === undefined ? {} : { seed }) });
                if (!result?.ok) {
                    problems.push(problem({ module: moduleId, index, code: result?.code ?? 'FAILED', message: `The step "${command?.type}" after the reply's lines was not run: ${result?.message ?? 'unknown error'}` }));
                    continue;
                }
                // Done, but not all of what was asked (a clamp, a line of the story that was not used): the step says why, and it goes to the Problems list.
                if (typeof result.problem === 'string' && result.problem) problems.push(problem({ module: moduleId, index, code: 'LIMITED', message: result.problem }));
                let replan = result.receipt.replan;
                if (!replan) { try { replan = { payload: structuredClone(payload) }; } catch { replan = undefined; } }
                const receipt = { ...result.receipt, afterCapture: true, ...(precheck ? { beforeGenerate: true } : {}), ...(replan ? { replan } : {}) };
                if (live) {
                    store.append({ ops: result.ops, receipt, ...(result.block ? { block: result.block } : {}) });
                    now = store.head();
                    events?.emit('committed', { receipt });
                } else {
                    now = result.state;
                    if (result.block && plan) {
                        plan.pending += 1;
                        if (taking.key) plan.reuse.commit(taking.key, result.block.occurrence);
                    }
                }
                steps.push({ ops: result.ops, receipt, state: now, ...(result.block ? { block: result.block } : {}) });
            }
        }
        return steps;
    }

    // The occurrence a block of a Re-read that does `type` with `payload` takes (evidence.js reusePlan): the number of a block it replaces, else the next unused.
    function occurrenceFor(plan, type, payload) {
        try {
            const key = operationKey(type, payload);
            return { key, value: plan.reuse.peek(key), span: plan.reuse.span(key) };
        } catch { return { key: null, value: undefined }; }
    }

    // For a Re-read: each afterCapture step run again gets the seed of the old one of its type, in order.
    function stepSeeds(record) {
        const stored = (Array.isArray(record?.receipts) ? record.receipts : [])
            .filter(receipt => receipt?.cause === 'system' && receipt.afterCapture === true && Number.isInteger(receipt.seed));
        const used = new Set();
        return type => {
            const at = stored.findIndex((receipt, n) => !used.has(n) && receipt.type === type);
            if (at < 0) return undefined;
            used.add(at);
            return stored[at].seed;
        };
    }

    // The reply's lines in the order they run: as written, except a line of a kind with `after` (registry captureEntry) goes behind the
    // reply's last line of the kinds it names, so it reads what those lines set up. The others keep their order, and so do the moved ones.
    function linesInOrder(lines) {
        const kinds = lines.map(line => registry.capture(line.kind));
        if (!kinds.some(entry => entry?.after)) return lines;
        const key = (line, at) => {
            const after = kinds[at]?.after;
            const last = after ? kinds.reduce((found, entry, other) => (other > at && after.includes(entry?.kind) ? other : found), -1) : -1;
            return last < 0 ? [at, 0] : [last, at + 1];
        };
        return lines.map((line, at) => ({ line, order: key(line, at) }))
            .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
            .map(item => item.line);
    }

    // Runs `lines` as story captures on carrier `index`, each on the state the one before left. Stored on
    // the head as they go (append), or, with `base` (a Re-read), run on that state and returned as
    // { ops } for store.replaceStory, nothing stored.
    // `plan` ({ blocks: [], pending: 0 }, a Re-read's, shared by its calls): the guarded blocks planned so far
    // (REPLAY.md), so each line's block gets the next ordinal and replaceStory stores each as a block of its own.
    // How many Inner chatter lines this reply could show, kept in its hidden comment when the reader's setting is not the
    // usual 3 (capture.js markCaps): the reply shows the same lines whatever the setting becomes. Every reply without a
    // mark was read at 3.
    function keptCaps() {
        let entry = null;
        try { entry = registry.capture('chatter'); } catch { entry = null; }
        const cap = entry && !entry.off ? entry.display?.perReply : undefined;
        return Number.isInteger(cap) && cap > 0 && cap !== CHATTER_MAX ? { chatter: cap } : {};
    }
    const withCaps = (mes, from = 0, always = false) => {
        const caps = keptCaps();
        return always || Object.keys(caps).length ? markCaps(mes, caps, from) : mes;
    };

    async function captureEach(index, lines, receipts, found, base = null, seeds = null, shown = new Map(), assist = null, plan = null) {
        const collected = [];
        const firstProblem = found.length;
        lines = linesInOrder(lines);
        // Display kinds (written words) whose lines were read while their feature was off (capture.js markOff).
        const off = new Set();
        let state = base ?? store.head();
        // ctx.carrier and ctx.chat for the capture handlers (MODULES §F2's capture context).
        const message = ctx?.chat?.[index];
        // `sid`: the reply's record ID, which stays with the reply when earlier messages are deleted.
        const carrier = { index, swipe: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0, sid: store.carrierSid?.(index) ?? null };
        // The practice rule recorded with the reply: skill practice comes only from rolls (data-modules/part.js refuses a story practice-N line). A reply
        // captured live under the rule (the RPG on, Rolls automatic) that has such a line is marked; a Re-read or an edit goes by the mark the reply
        // already has, so an older reply keeps the practice lines it was told with.
        if (readRecord(message)?.practiceRule === 'rolls') carrier.practiceRule = 'rolls';
        else if (base === null && lines.some(line => PRACTICE_LINE.test(line.raw ?? '')) && practiceFromRollsOnly(registry.featureOn?.(LEAN_RPG_FEATURE) === true, settings?.('story-block'))) {
            try { store.setPracticeRule?.(index); carrier.practiceRule = 'rolls'; } catch { /* an unmarked reply is judged as before */ }
        }
        // The message right before the reply (system messages aside), and only when it is the reader's: a reply that
        // follows another reply has no message of the reader's to quote (proof, EVIDENCE.md).
        const before = (ctx?.chat ?? []).slice(0, index).findLast(item => !item?.is_system);
        const reader = before?.is_user ? before : null;
        const chat = { lastUser: String(reader?.mes ?? ''), reply: stripBlock(String(message?.mes ?? ''), 'Changes', { heads: changeHeads() }) };
        // A Re-read (a2-3): the reply as it stands now, for bookkeeping its kept blocks wrote (ctx.standing).
        let standing = null;
        if (base) { try { standing = store.at(index); } catch { standing = null; } }
        // (and what the reply's own receipts recorded, ctx.standingReceipts: the rows a join or a return seeded)
        const standingReceipts = base ? (readRecord(message)?.receipts ?? null) : null;
        // `shown`: how many lines of each display kind this reply has shown so far (their cap per reply).
        for (const line of lines) {
            const entry = registry.capture(line.kind);
            if (!entry) {
                found.push(problem({ index, line: line.raw, code: 'UNKNOWN_KIND', message: `No module keeps "${line.kind}", so "${line.raw}" was not used.` }));
                continue;
            }
            const mark = lineMark(line.raw);
            const seed = seeds?.(entry.kind, mark);
            // C3-4: a Re-read runs a line that made a change before (its receipt gives the seed) even
            // while its feature is off, so turning a feature off never takes away what it already did.
            const again = base !== null && seed !== undefined;
            // A kind whose feature the reader turned off (MODULES §F100): not an error, just not used.
            if (entry.off && !again) {
                const label = registry.feature?.(entry.feature)?.label ?? entry.feature;
                found.push(problem({ module: entry.moduleId, index, line: line.raw, code: 'FEATURE_OFF', quiet: true, message: `"${line.raw}" was not used: ${label} is turned off (feature off).` }));
                // B-a1-5: a display line told as not used stays unshown when the feature is turned on
                // later; a Re-read reads it again.
                if (entry.display) off.add(line.kind);
                continue;
            }
            // A display kind (Choices, Inner chatter; extras.js): read for the reader alone. No command
            // runs and nothing is stored; what is shown is read again from the reply's hidden block, by
            // the same rule (readDisplayLine), so only what the rule refuses is told here.
            if (entry.display) {
                const read = readDisplayLine(entry, line, shown);
                if (!read.ok) found.push(problem({ module: entry.moduleId, index, line: line.raw, code: read.code, message: `"${line.raw}" was not used: ${read.message}.` }));
                continue;
            }
            let result;
            try {
                const operation = { type: `${CAPTURE_PREFIX}${entry.kind}`, payload: { ...line, kind: entry.kind, word: line.kind } };
                const taking = plan ? occurrenceFor(plan, operation.type, operation.payload) : null;
                const run = opts => bus.run(operation.type, operation.payload, { cause: 'story', state, capture: entry, carrier: plan ? { ...carrier, ...(taking.span && (plan.preserveSources || occurrenceOf(taking.span) === null) ? { ordinal: taking.span.source.ordinal } : {}), pending: plan.pending, opsBefore: plan.blocks.reduce((sum, piece) => sum + (Number.isInteger(piece.n) ? piece.n : 0), 0) } : carrier, chat, standing, standingReceipts, ...(plan ? { planned: plan.blocks.flatMap(piece => piece.block?.evidence ?? []), replacing: plan.replacing, reusing: taking.span, ...(Number.isInteger(taking.value) ? { occurrence: taking.value } : {}) } : {}), ...(seed === undefined ? {} : { seed }), ...opts });
                result = entry.off ? await run({ capture: { ...entry, off: false }, again: true }) : await run();
                // Refused by a feature that is off (a command it called, ctx.feature): run as it ran before.
                if (again && !entry.off && result?.code === 'FEATURE_OFF') result = await run({ again: true });
                // The receipt remembers which line made it (`line`), so a Re-read can give the line its seed again.
                // The safety net's lines are marked as its (receipt `assist`: 'now' | 'late', and the line).
                if (result?.ok) result = { ...result, receipt: { ...result.receipt, line: mark, ...(assist ? { assist, assistLine: cutAt(line.raw, 200) } : {}) } };
                if (result?.ok && base) {
                    collected.push(...result.ops);
                    if (plan) {
                        plan.blocks.push({ n: result.ops.length, receipt: result.receipt, ...(result.block ? { block: result.block } : {}) });
                        if (result.block) {
                            plan.pending += 1;
                            if (taking.key) plan.reuse.commit(taking.key, result.block.occurrence);
                        }
                    }
                } else if (result?.ok) store.append({ ops: result.ops, receipt: result.receipt, ...(result.block ? { block: result.block } : {}) });
            } catch (error) {
                result = { ok: false, code: 'FAILED', message: error?.message ?? String(error) };
            }
            if (!result?.ok) {
                // A line refused because a feature the reader turned off answered it (another module's
                // command it called, MODULES §F100): listed quietly, like a line of a kind that is off.
                found.push(problem({ module: entry.moduleId, index, line: line.raw, code: result?.code ?? 'FAILED', message: `"${line.raw}" was not used: ${result?.message ?? 'unknown error'}`, ...(result?.code === 'FEATURE_OFF' ? { quiet: true } : {}) }));
                continue;
            }
            state = result.state ?? (base ? state : store.head());
            receipts.push(result.receipt);
            // Used, but not all of it (a clamp): the owner says why, and that goes to the Problems list.
            if (typeof result.problem === 'string' && result.problem) {
                found.push(problem({ module: entry.moduleId, index, line: line.raw, code: 'LIMITED', message: result.problem }));
            }
            if (!base) events?.emit('committed', { receipt: result.receipt });
        }
        // What the safety net's lines met is marked as its in the Problems list.
        if (assist) {
            for (const item of found.slice(firstProblem)) {
                if (item.assist) continue;
                item.assist = assist;
                item.message = `(assist${assist === LATE ? ', from the previous reply' : ''}) ${item.message}`;
            }
        }
        return { ops: collected, off: [...off], state };
    }

    // A change line's mark: a hash of its text without spaces (hiding the block breaks up "--" with one).
    const lineMark = raw => hash(String(raw ?? '').replace(/\s+/g, ''));

    // For a Re-read (r2-3): each line run again gets the seed of the story receipt it made before, so the
    // records it makes keep their IDs and the reader's later actions on them still fit. The reply's story
    // receipts are taken in order, a line matching the next one of its kind made by the same line text
    // (`line`, lineMark); a line that made none before (it failed, was changed, or is new) gets a fresh
    // seed. → (kind, mark) => seed | undefined.
    function storySeeds(record) {
        const stored = (Array.isArray(record?.receipts) ? record.receipts : [])
            .filter(receipt => receipt?.cause === 'story' && typeof receipt.line === 'string' && Number.isInteger(receipt.seed));
        let next = 0;
        return (kind, mark) => {
            const at = stored.findIndex((receipt, n) => n >= next && receipt.type === `${CAPTURE_PREFIX}${kind}` && receipt.line === mark);
            if (at < 0) return undefined;
            next = at + 1;
            return stored[at].seed;
        };
    }

    /**
     * Re-read (F40): reads reply `index`'s <Changes> block again, as its shown swipe has it now, and
     * replaces the story changes stored on it the way a fresh capture would (store.replaceStory): its
     * `story` receipts go, the lines run again on the state before the reply, and the reader's own
     * actions and system steps on it stay after them (their claims too). Later replies are checked
     * again on top; if one of them no longer fits, nothing changes. Refused for the reader's messages,
     * system messages, messages that hold no story record, and while a reply is being written.
     * Saves once and emits `turn` ({ index, type: 'reread', receipts, problems, told: [] }).
     * → { ok: true, receipts, problems } | { ok: false, code, message }.
     */
    // The first module held back (registry.heldModules) that the reply carries lines, receipts or ops of, as
    // { code, name, reason }, else null. `lines`: the change lines about to be read again.
    function heldInReply(message, lines) {
        const held = new Set(registry.heldModules?.() ?? []);
        if (!held.size) return null;
        const record = readRecord(message);
        const found = new Set();
        for (const line of lines) {
            const owner = registry.captureOwner?.(line?.kind);
            if (owner) found.add(owner);
        }
        for (const receipt of record?.receipts ?? []) if (typeof receipt?.module === 'string') found.add(receipt.module);
        for (const op of record?.ops ?? []) {
            const owner = typeof op?.path === 'string' ? registry.domainOwner?.(/^\/domains\/([^/]+)/.exec(op.path)?.[1] ?? '') : null;
            if (owner) found.add(owner);
        }
        const id = [...held].sort().find(item => found.has(item));
        if (!id) return null;
        const life = registry.lifecycle?.(id);
        return { code: life?.status === 'restore-pending' ? 'RESTORE_PENDING' : 'DEPENDENCY_UNAVAILABLE', name: registry.module?.(id)?.name ?? id, reason: life?.reason ?? 'It is not running.' };
    }

    return { changeHeads, readBlock, strayProblems, legacyProblem, capped, assistRoom, lateLines, nowLines, captureLines, afterCapture, stepSeeds, captureEach, storySeeds, heldInReply, withCaps, LATE, NOW };
}
