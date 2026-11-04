// The after-reply extractor, Assist's safety net (SPEC §0.5, §4.2, MODULES §F100, §F123): when it is
// on, one cheap model call reads each finished reply after its capture, with the reply's own change lines
// and the grammar of the kinds the reader allows (`assistExtractorKinds`), and proposes only the lines
// the story clearly told but its block did not write (time passing, a new place, who came or went, the
// weather, quest progress or a turn-in, wounds, an item handed over). Code then keeps only what the value
// wall lets through (safety.js: never coin, new items, XP, loot or heals), drops a line the block already
// has (C-1's matching, capture.js sameChangeLine, and the same op, kind and name) or a place, time or weather
// line when the block set that kind, and hands the rest to
// the host's capture, which checks each like a story line and marks it as the extractor's. The output is
// stored with the reply (capture.js withAssist), so replay, swipes and Re-read never call the model again.
// Never for quiet or impersonate generations, never for a continue (its reply was read when it first
// arrived), once per carrier and swipe. It is told the scene's place, the map's place names near it and the story's
// date and time (where.js), and its lines that name a known place by an invented name, or set a time with no clock
// time, are refused with a Problems line on the reply.

import { OPS, extractBlock, parseChanges, sameChangeLine, stripBlock, withoutReasoning } from '../capture.js';
import { BACKGROUND, SETTING, TIMEOUT_MS, clip, estimateTokens, normalizeType, withTimeout } from './common.js';
import { DEFAULT_KINDS, allowedKinds, refusedWhy } from './safety.js';
import { mapPlaces, whereLines, whereNow, whereWhy } from './where.js';

export const REPLY_LIMIT = 6000;
export const MAX_LINES = 24;
export const ANSWER_TOKENS = 400;

// Static for a chat: the head, then the kinds' grammar (fixed while the same modules are on), then
// the reply last.
export const EXTRACTOR_HEAD = [
    'You read one reply from an interactive story and list what changed in it that its own change lines missed, as change lines, one per line:',
    'op kind Name[ — text][ | label: value]',
    'op: + new or gained, - gone or lost, ~ changed, ! happened, ? asks code to decide (a check the reply stopped at).',
    'Use only these kinds:',
].join('\n');
export const EXTRACTOR_FOOT = [
    'Write a line only for what the reply clearly tells and its own lines (below) do not already say, with numbers only where it gives them. If nothing is missing, answer: none',
    'A place line uses the exact name of a known place whenever the reply is at one the map has (known places are listed below). A time line needs a clock time like the story date and time below (~ time <date>, 9:30 am sets it; ! time +2h moves it on): "midday" and "mid-morning" are not times, so write no time line unless the reply gives a clock time or a stretch. A line with an unknown name for a known place, or a time without a clock time, is refused.',
    'Answer with the lines only, between <Changes> and </Changes>.',
].join('\n');
export const WHERE_HEAD = 'Where and when the scene is:';
export const WRITTEN_HEAD = 'The reply\'s own lines:';
export const REPLY_HEAD = 'The reply:';

/** The kind word a grammar line is about (`+ item Name | qty: 1` → 'item'), or null. */
export function grammarKind(line) {
    const match = /^\s*[+\-~!?]\s*(\p{L}[\p{L}\p{N}_-]*)/u.exec(String(line ?? ''));
    return match ? match[1].toLowerCase() : null;
}

/**
 * The extractor's prompt for `reply` (the story text, block removed), the kinds' grammar lines and the
 * reply's own change lines (`written`, raw): the head and grammar first (fixed while the same kinds are
 * on, for a provider's prompt cache), then where and when the scene is (`around`, where.js whereNow: the
 * place, the known places near it, the story date and time; left out when nothing is known), then the
 * reply's lines, then the reply.
 */
export function extractorPrompt(reply, grammar, written = [], around = null) {
    const kinds = grammar.map(line => `- ${String(line).trim()}`).join('\n');
    const own = written.length ? written.map(line => clip(line, 200)).join('\n') : 'none';
    const where = whereLines(around);
    return `${EXTRACTOR_HEAD}\n${kinds}\n${EXTRACTOR_FOOT}\n\n${where.length ? `${WHERE_HEAD}\n${where.join('\n')}\n\n` : ''}${WRITTEN_HEAD}\n${own}\n\n${REPLY_HEAD}\n"""\n${clip(reply, REPLY_LIMIT)}\n"""`;
}

// Two lines are one change when C-1 calls them the same line, or when they share op, kind and name
// (a `- item Pelt` the block wrote is not handed over twice because the extractor added a label).
const nameKey = line => `${line.op} ${String(line.kind ?? '').toLowerCase()} ${String(line.name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()}`;
// Kinds that describe the whole scene, one value at a time: where it is, when, and its weather. Once the
// reply's own block sets one of them, the safety net's line of that kind for the same reply is not used,
// whatever name it gives: another wording of the same place would read as a move and leave everyone present
// behind, and a second `! time` would move the clock on twice. A late line (the reply before's, applied after
// the next reply's own lines) that sets a value the next reply set again is older and not used either; but a
// late `! time` (time that passed in the reply before) still adds.
export const SCENE_KINDS = Object.freeze(['place', 'time', 'weather']);
const sceneKind = line => {
    const kind = String(line?.kind ?? '').toLowerCase();
    return SCENE_KINDS.includes(kind) ? kind : null;
};
/**
 * The raw lines of `lines` (raw[]) the reply's `written` lines (raw[]) do not already hold (nor repeat among
 * themselves), and none of a scene kind (SCENE_KINDS) that `scene` (raw[], default `written`: the lines that set the
 * scene, never an older reply's late lines) already sets. `late`: `lines` are late lines; a `! time` among them is kept.
 */
export function notWritten(lines, written, { scene = written, late = false } = {}) {
    const parsed = parseChanges(written.join('\n')).lines;
    const same = new Set(written.map(sameChangeLine));
    const names = new Set(parsed.map(nameKey));
    const set = new Set(parseChanges(scene.join('\n')).lines.map(sceneKind).filter(Boolean));
    const out = [];
    for (const raw of lines) {
        const line = parseChanges(raw).lines[0];
        const kind = sceneKind(line);
        const sceneSet = kind !== null && set.has(kind) && !(late && line.op === '!' && kind === 'time');
        if (!line || same.has(sameChangeLine(raw)) || names.has(nameKey(line)) || sceneSet) continue;
        same.add(sameChangeLine(raw));
        names.add(nameKey(line));
        out.push(raw);
    }
    return out;
}

/**
 * The extractor's answer read with Story Block's change-line parser: { lines: raw[], dropped, refused } where
 * `lines` are the change lines of a kind in `kinds` (at most MAX_LINES) that the value wall lets through
 * (`allow`, safety.js allowedKinds; none given: the wall alone, which still refuses coin, items, XP, jobs and teachers), `refused` the ones it stopped ([{ line, why }]),
 * and `dropped` counts every line not kept (unknown kinds, lines that are not change lines, refused). A refused entry
 * with `problem: true` is one the reader is told of (an unknown name for a known place, a time with no clock time;
 * `check` = { places (where.js mapPlaces), here }); the wall's own refusals are not.
 */
export function parseExtractorAnswer(answer, kinds, allow = null, check = {}) {
    const known = new Set(kinds);
    const text = String(answer ?? '');
    const { lines, problems } = parseChanges(extractBlock(text) ?? text);
    const kept = [];
    const refused = [];
    let dropped = problems.length;
    for (const line of lines) {
        const why = refusedWhy(line, allow);
        if (why) {
            refused.push({ line: line.raw, why });
            dropped += 1;
        } else if (!OPS.includes(line.op) || !known.has(line.kind) || kept.length >= MAX_LINES) dropped += 1;
        else {
            // A place the map has under an invented name, or a time with no clock time (where.js): refused, and told as a Problem.
            const lost = whereWhy(line, check ?? {});
            if (lost) {
                refused.push({ line: line.raw, why: lost, problem: true });
                dropped += 1;
            } else kept.push(line.raw);
        }
    }
    return { lines: kept, dropped, refused };
}

/** The grammar lines of the kinds `allow` (allowedKinds) names any op of. */
export function allowedGrammar(lines, allow) {
    const kinds = new Set([...allow].map(key => key.split(' ')[1]));
    return lines.filter(line => kinds.has(grammarKind(line)));
}

/**
 * The extractor. `deps`: { callModel(prompt, { maxTokens, profile }) → text, settings() → the module's
 * settings, grammar() → the kinds' one-line grammars (module-id order), capture(text, { index, swipe })
 * → the host's capture of extra change lines for that carrier, chatId(), log, warn, timeoutMs, timer,
 * where() → { here: { name, kind, region }, places: [{ name, aliases?, region?, x?, y? }], time: text }: the scene's
 * place, the map's places and the story's date and time; each part may be missing, and a throwing where is none }.
 * Returns { afterReply(reply) }.
 */
export function createExtractor({ callModel, settings, grammar, capture, chatId, log, warn, timeoutMs = TIMEOUT_MS, timer, where = null }) {
    // Carriers and swipes already read (whatever came of it), by chat.
    const done = new Set();

    // Each entry names its chat (`chat`), so a reply's note can tell the extractor failed on it.
    function note(outcome, entry = {}) {
        let chat = '';
        try { chat = String(chatId?.() ?? ''); } catch { chat = ''; }
        const item = log.add({ helper: 'extractor', outcome, chat, ...entry });
        if (['failed', 'timeout'].includes(outcome)) warn(`the reply's changes were not read: ${entry.message}`);
        return item;
    }

    /**
     * afterReply({ index, swipe, type, mes, lines?, capture? }): `mes` is the reply as stored (its block
     * hidden), `lines` the change lines its capture read (raw; else read from `mes`). Runs after every
     * captured reply while the safety net is on; resolves to what `capture` returned, or null when it did
     * not run or found nothing missing. `reply.capture(text, at, { assist: true })` (the host's, per reply)
     * wins over the one given at creation. Never throws.
     */
    async function afterReply(reply = {}) {
        try {
            const values = settings();
            if (values?.[SETTING.extractor] !== true) return null;
            const type = normalizeType(reply.type);
            if (BACKGROUND.includes(type) || type === 'continue') return null;
            const index = Number(reply.index);
            const swipe = Number.isInteger(reply.swipe) ? reply.swipe : 0;
            if (!Number.isInteger(index) || index < 0) return null;
            const mes = String(reply.mes ?? reply.text ?? '');
            // The story as capture reads it: closed reasoning (<think>…</think>) is not story.
            const story = stripBlock(withoutReasoning(mes)).trim();
            if (!story) return null;
            const key = `${chatId() ?? ''}|${index}|${swipe}`;
            if (done.has(key)) return null;
            done.add(key);
            const at = { index, swipe };
            const allow = allowedKinds(values?.[SETTING.extractorKinds] ?? DEFAULT_KINDS);
            const all = (grammar() ?? []).map(line => String(line ?? '').trim()).filter(line => grammarKind(line));
            const lines = allowedGrammar(all, allow);
            if (!lines.length) {
                note('skipped', { ...at, message: all.length ? 'none of the allowed kinds is on' : 'no change-line kinds are known' });
                return null;
            }
            const feed = typeof reply.capture === 'function' ? reply.capture : capture;
            if (typeof feed !== 'function') {
                note('failed', { ...at, message: 'Story Block offers no capture for extra lines' });
                return null;
            }
            const written = Array.isArray(reply.lines) ? reply.lines.map(String)
                : parseChanges(extractBlock(mes) ?? '').lines.map(line => line.raw);
            let seen = null;
            try { seen = typeof where === 'function' ? where() : null; } catch { seen = null; }
            const places = mapPlaces(seen?.places);
            const around = whereNow({ here: seen?.here, places, time: seen?.time });
            const check = { places, here: around.here?.name ?? '' };
            const prompt = extractorPrompt(story, lines, written, around);
            const profile = String(values?.[SETTING.extractorProfile] ?? '').trim() || String(values?.[SETTING.profile] ?? '');
            let answer;
            try {
                answer = await withTimeout(() => callModel(prompt, { maxTokens: ANSWER_TOKENS, profile, helper: 'extractor' }), timeoutMs, timer);
            } catch (error) {
                note(error?.code === 'TIMEOUT' ? 'timeout' : 'failed', { ...at, message: error?.message ?? String(error) });
                return null;
            }
            const parsed = parseExtractorAnswer(answer, [...new Set(lines.map(grammarKind))], allow, check);
            // `written` mixes the block's lines with the reply before's late ones, so the scene kinds are left to the host's
            // capture (turn.js captureAssist), which knows which lines are the block's; here only repeats are dropped.
            const missing = notWritten(parsed.lines, written, { scene: [] });
            // What it wrote that the reader is told was refused (Problems on the reply): never applied.
            const refused = parsed.refused.filter(item => item.problem).map(({ line, why }) => ({ line, why }));
            if (!missing.length && !refused.length) {
                note('nothing', { ...at, dropped: parsed.dropped, tokens: estimateTokens(prompt) });
                return null;
            }
            const result = await feed(missing.join('\n'), at, { assist: true, ...(refused.length ? { refused } : {}) });
            if (!missing.length) {
                note('nothing', { ...at, dropped: parsed.dropped, tokens: estimateTokens(prompt), message: `${refused.length === 1 ? 'a line was' : `${refused.length} lines were`} refused` });
                return result ?? null;
            }
            note('lines', { ...at, lines: missing.length, dropped: parsed.dropped, tokens: estimateTokens(prompt), ...(result?.deferred ? { message: 'applied on the next reply' } : {}) });
            return result ?? null;
        } catch (error) {
            note('failed', { index: reply?.index ?? null, swipe: reply?.swipe ?? null, message: error?.message ?? String(error) });
            return null;
        }
    }

    return { afterReply };
}
