// The scanner request every dossier pass sends (scan, relationship evaluator, Refresh, backfill and
// dossier import): one dispatch through scanner-routing.js, JSON parsing, and one compact retry when
// the reply is cut off or malformed. (cleanup step 10) Moved out of index.js unchanged.
import { dispatchScannerRequest, scannerRoutingError } from '../scanner-routing.js';
import { IMPORTANT_MEMORY_LIMIT, parseScanJson } from '../core.js';

export const SCAN_RESPONSE_LENGTH = 1800;
export const FULL_SCAN_RESPONSE_LENGTH = 3200;
export const RELATIONSHIP_RESPONSE_LENGTH = 900;
export const BACKFILL_RESPONSE_LENGTH = 3200;
export const JSON_RETRY_RESPONSE_LENGTH = 5200;

export function isTruncatedScannerJsonError(error) {
    const text = [error?.message, error?.cause?.message]
        .filter(Boolean)
        .join(' ');
    return /unterminated string|unexpected end of json input|unexpected end of data|end of json input/i.test(text);
}

// A reply with no JSON object at all is usually a provider/host message or a model refusal rather
// than broken JSON. Surface a short, whitespace-collapsed excerpt so the cause is visible; never the
// whole provider response.
const NON_JSON_REPLY_EXCERPT_CHARS = 200;
function nonJsonReplyExcerpt(raw) {
    if (raw && typeof raw === 'object') return '';
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.includes('{')) return '';
    return text.length > NON_JSON_REPLY_EXCERPT_CHARS ? `${text.slice(0, NON_JSON_REPLY_EXCERPT_CHARS)}…` : text;
}

export function compactRetryPrompt(prompt, label = 'scanner', reason = 'malformed') {
    const cause = reason === 'truncated'
        ? 'Your previous response ended before the JSON was complete.'
        : 'Your previous response was not valid JSON. Rebuild it from the beginning with correct commas, colons, quotes, arrays, and objects.';
    const targetedMemoryLimit = /(?:backfill|chat refresh)/i.test(String(label || '')) ? IMPORTANT_MEMORY_LIMIT : 3;
    return `${prompt}

CRITICAL COMPACT JSON RETRY (${label}): ${cause} Return the full JSON object again from the beginning. Use MINIFIED JSON only. Keep every value concise; shorten prose instead of risking truncation. Omit unsupported optional facts rather than explaining them. Compact rather than append: appearance under 500 characters, personality 280, speech 240, behaviorProfile at most 6 short point-form rules, background/relationship summary 280-320, mannerisms at most 4 DISTINCT short items, key relationships one entry per counterpart, memories at most ${targetedMemoryLimit} distinct events, memoryRetention at most 5 distinct events. Close every quoted string, array, and object. No markdown, no commentary, no code fence.`;
}

// (rule NSDFOLLOW-1, 12 Nov) Field-level salvage of slipped key quotes, tried only after parseScanJson's own repairs failed, so a
// reply that parsed before parses exactly as before. Each fix is made where JSON.parse stopped, so the parser's own reading says
// which text is a key: a key whose closing quote slipped behind its value ("moodV:0,"moodA":...) gets it back with that same value,
// a key whose quote slipped onto its string value ("mood:"weary",...) likewise; a slipped key whose value is not a plain number,
// true, false or null is dropped whole (never a guessed value); a bare or half-quoted key (moodV":0) is quoted; a comma right
// before a closing brace is removed. Returns { parsed, repairs: [plain words] }, or null when the reply still does not parse.
const SALVAGE_STEPS_MAX = 40;
const JSON_KEY = '[A-Za-z_$][\\w$-]*';
const SLIPPED_SCALAR = new RegExp(`^(${JSON_KEY})\\s*:\\s*(-?\\d+(?:\\.\\d+)?|true|false|null)\\s*,\\s*$`);
const SLIPPED_OPEN = new RegExp(`^(${JSON_KEY})\\s*:\\s*$`);
const SLIPPED_OTHER = new RegExp(`^(${JSON_KEY})\\s*:[^{}\\[\\]]{0,80},\\s*$`);
const BARE_KEY = new RegExp(`^(${JSON_KEY})"?\\s*:`);
function salvageStep(text, error) {
    const message = String(error?.message || '');
    const at = Number(message.match(/position\s+(\d+)/i)?.[1] ?? -1);
    if (!Number.isInteger(at) || at < 0 || at > text.length) return null;
    const before = index => { let i = index; while (i >= 0 && /\s/.test(text[i])) i -= 1; return i; };
    if (/expected ':' after property name/i.test(message)) {
        const end = before(at - 1);
        if (text[end] !== '"') return null;
        const start = text.lastIndexOf('"', end - 1);
        if (start < 1 || text[start - 1] === '\\' || !['{', ','].includes(text[before(start - 1)])) return null;
        const inner = text.slice(start + 1, end);
        const head = text.slice(0, start);
        const tail = text.slice(end + 1);
        let found = inner.match(SLIPPED_SCALAR);
        if (found) return { text: `${head}"${found[1]}":${found[2]},"${tail}`, note: `${found[1]} (closing quote restored)` };
        found = inner.match(SLIPPED_OPEN);
        if (found && /^[^"\\\n]{0,600}"\s*[,}]/.test(tail)) return { text: `${head}"${found[1]}":"${tail}`, note: `${found[1]} (closing quote restored)` };
        found = inner.match(SLIPPED_OTHER);
        if (found) return { text: `${head}"${tail}`, note: `${found[1]} (unreadable value, dropped)` };
        return null;
    }
    if (/expected double-quoted property name/i.test(message)) {
        if (text[at] === '}') {
            const comma = before(at - 1);
            return text[comma] === ',' ? { text: `${text.slice(0, comma)}${text.slice(comma + 1)}`, note: 'a comma before } (removed)' } : null;
        }
        const found = text.slice(at).match(BARE_KEY);
        if (found) return { text: `${text.slice(0, at)}"${found[1]}"${text.slice(at + found[1].length).replace(/^"/, '')}`, note: `${found[1]} (key quoted)` };
    }
    return null;
}
export function salvageScannerJson(raw) {
    if (raw && typeof raw === 'object') return null;
    let text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    text = text.slice(first, last + 1);
    const repairs = [];
    for (let step = 0; step <= SALVAGE_STEPS_MAX; step += 1) {
        try {
            JSON.parse(text);
            return repairs.length ? { parsed: parseScanJson(text), repairs } : null;
        } catch (error) {
            const fixed = step < SALVAGE_STEPS_MAX ? salvageStep(text, error) : null;
            if (!fixed) return null;
            text = fixed.text;
            repairs.push(fixed.note);
        }
    }
    return null;
}

export async function generateParsedNpcJson(ctx, {
    systemPrompt,
    prompt,
    responseLength,
    label = 'scanner',
    requestScope,
}) {
    if (!requestScope) throw scannerRoutingError('A scanner request needs an owning operation.', 'NPC_SCANNER_ROUTE_CANCELLED');
    const invoke = async (retry = false, retryReason = 'malformed') => {
        const raw = await dispatchScannerRequest(ctx, {
            systemPrompt,
            prompt: retry ? compactRetryPrompt(prompt, label, retryReason) : prompt,
            quietToLoud: false,
            instructOverride: true,
            responseLength: retry ? Math.max(JSON_RETRY_RESPONSE_LENGTH, Number(responseLength) || 0) : responseLength,
            trimNames: false,
        }, { ...requestScope, label: retry ? `${label} (JSON retry)` : label });
        try {
            return { parsed: parseScanJson(raw), raw, retried: retry };
        } catch (error) {
            const salvaged = salvageScannerJson(raw);
            if (salvaged) {
                console.warn(`[NPC State Delta] Problems: ${label} returned JSON with broken keys; repaired without a retry: ${salvaged.repairs.join(', ')}.`);
                return { parsed: salvaged.parsed, raw, retried: retry, repairs: salvaged.repairs };
            }
            const truncated = isTruncatedScannerJsonError(error);
            const reply = nonJsonReplyExcerpt(raw);
            if (!retry) {
                console.warn(`[NPC State Delta] ${label} returned invalid JSON; retrying once with a compact correction prompt.`, {
                    responseChars: String(raw ?? '').length,
                    truncated,
                    error: error?.message || String(error),
                    ...(reply ? { textReply: reply } : {}),
                });
                return invoke(true, truncated ? 'truncated' : 'malformed');
            }
            const wrapped = new Error(truncated
                ? `${label} JSON was truncated twice; the model did not finish its JSON response. ${error?.message || error}`
                : reply
                    ? `${label} received a text reply instead of JSON twice. The provider/model said: "${reply}" This usually means the provider blocked or refused the request, the request exceeded the model's context, or the selected connection profile is not using a chat model that follows JSON instructions.`
                    : `${label} returned malformed JSON twice; the model did not produce a valid dossier object. ${error?.message || error}`);
            wrapped.cause = error;
            throw wrapped;
        }
    };
    return invoke(false);
}
