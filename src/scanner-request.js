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
