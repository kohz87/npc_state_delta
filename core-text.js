/* NPC State Delta scan text and JSON helpers: evidence extraction and stripping, scanner JSON repair and parsing,
   narration-capture reading, and the clean* text helpers. A pure part of core-mechanics.js (same owner, moved
   without change); core-mechanics.js re-exports every name it exported before. Imports nothing, so it never forms a cycle. */

export function normalizeName(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function plainUiEvidence(value) {
    return String(value || '')
        .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, ' ')
        .replace(/<\/?details\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function collectTaggedBodies(source, tag) {
    const out = [];
    const escaped = String(tag || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) return out;
    const complete = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}\\s*>`, 'gi');
    for (const match of String(source || '').matchAll(complete)) {
        const body = plainUiEvidence(match[1]);
        if (body) out.push(body);
    }
    return out;
}

function meguminBlockEvidence(blockBody) {
    const parts = [];
    for (const body of collectTaggedBodies(blockBody, 'World_State')) parts.push(`World State: ${body}`);
    for (const body of collectTaggedBodies(blockBody, 'NPC_Inner_Chatter')) parts.push(`NPC Inner Chatter: ${body}`);

    // A cut-off reply can leave the final useful block without a closing tag. Megumin's own
    // renderer keeps such partial blocks visible; preserve the same evidence boundary here,
    // but only when that useful tag is the last opened child in the envelope.
    for (const [tag, label] of [['World_State', 'World State'], ['NPC_Inner_Chatter', 'NPC Inner Chatter']]) {
        const open = new RegExp(`<${tag}\\b[^>]*>`, 'ig');
        const matches = [...String(blockBody || '').matchAll(open)];
        if (!matches.length) continue;
        const last = matches[matches.length - 1];
        const tail = String(blockBody || '').slice(last.index + last[0].length);
        if (new RegExp(`<\\/${tag}\\s*>`, 'i').test(tail)) continue;
        if (/<[A-Za-z][A-Za-z0-9_:-]*\b[^>]*>/.test(tail)) continue;
        const body = plainUiEvidence(tail);
        if (body) parts.push(`${label}: ${body}`);
    }
    return parts.join(' ');
}

function replaceMeguminMasterBlocks(source) {
    let text = String(source || '');
    text = text.replace(/<Blocks\b[^>]*>([\s\S]*?)<\/Blocks\s*>/gi, (_whole, body) => {
        const evidence = meguminBlockEvidence(body);
        return evidence ? ` ${evidence} ` : ' ';
    });
    // Truncated master envelope at end of message.
    text = text.replace(/<Blocks\b[^>]*>([\s\S]*)$/gi, (_whole, body) => {
        const evidence = meguminBlockEvidence(body);
        return evidence ? ` ${evidence} ` : ' ';
    });
    return text;
}

function replaceStandaloneMeguminEvidence(source) {
    let text = String(source || '');
    for (const [tag, label] of [['World_State', 'World State'], ['NPC_Inner_Chatter', 'NPC Inner Chatter']]) {
        const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi');
        text = text.replace(re, (_whole, body) => {
            const evidence = plainUiEvidence(body);
            return evidence ? ` ${label}: ${evidence} ` : ' ';
        });
    }
    // These are model/UI control surfaces, not story evidence. Normally they are inside the
    // master <Blocks> envelope and are removed above; stripping standalone copies keeps custom
    // or custom or alternate Megumin prompt layouts from contaminating dossier scans.
    for (const tag of ['Story_Tracker', 'CYOA', 'Bonds', 'Character_Sheet', 'New_NPC', 'NPC_Update']) {
        const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
        text = text.replace(re, ' ');
    }
    return text;
}

export function hasCompactMeguminWorldState(text) {
    const source = String(text || '');
    const bodies = [];
    for (const body of collectTaggedBodies(source, 'World_State')) bodies.push(body);
    for (const details of source.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gi)) {
        const inner = String(details[1] || '');
        const summary = String(inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/\bworld\s*state\b/i.test(summary)) bodies.push(plainUiEvidence(inner));
    }
    return bodies.some(body => /\bTime\s*&\s*Loc\s*:/i.test(body) && /\bNPCs\s+Present\s*:/i.test(body));
}

// Story Block hides its blocks (World State among them) in one comment at the end of a reply:
// `<!-- STORY_BLOCKS_V1\n<Blocks>…</Blocks>\n-->`. Unwrapping it to the inner <Blocks> lets the
// World State inside be read exactly as a plain Megumin <Blocks> is; every other comment is still
// stripped as markup. A reply cut off mid-envelope ends where the next comment begins. The `\b`
// keeps STORY_BLOCKS_V1_CUT and STORY_BLOCKS_V1_CONTEXT_* out.
const STORY_BLOCKS_ENVELOPE = /<!--\s*STORY_BLOCKS_V1\b((?:(?!<!--)[\s\S])*?)(?:-->|(?=<!--)|$)/gi;

function unwrapStoryBlocksEnvelope(source) {
    return String(source || '').replace(STORY_BLOCKS_ENVELOPE, (_whole, body) => ` ${body} `);
}

export function stripUiNoise(text) {
    let source = unwrapStoryBlocksEnvelope(extractNarrationCapture(text).text)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

    // Megumin Suite beta (2026-08-18+) emits one <Blocks> envelope. Preserve only the two
    // sections NPC State Delta intentionally treats as story evidence; discard CYOA, Bonds, sheets,
    // NPC Bank dossiers/updates, Story Tracker, and unknown/custom children by removing the
    // entire envelope after extracting World State + NPC Inner Chatter.
    source = replaceMeguminMasterBlocks(source);
    source = replaceStandaloneMeguminEvidence(source);

    // Some Megumin layouts place high-value identity/state evidence inside <details> blocks.
    // Preserve those evidence-bearing details while dropping unrelated collapsible UI.
    const withRelevantDetails = source.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (_whole, inner) => {
        const summaryMatch = String(inner).match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
        const summary = String(summaryMatch?.[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const isWorldState = /\bworld\s*state\b/i.test(summary);
        const isInnerChatter = /\bnpc\s*inner\s*chatter\b/i.test(summary);
        if (!isWorldState && !isInnerChatter) return ' ';
        const body = plainUiEvidence(inner);
        const label = isWorldState ? 'World State' : 'NPC Inner Chatter';
        return body ? ` ${label}: ${body} ` : ' ';
    });

    return withRelevantDetails
        .replace(/<[^>]+>/g, ' ')
        .replace(/```[\s\S]*?```/g, match => match.replace(/```\w*/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
}



/**
 * (1.2.12) A message's story alone: its narration and dialogue, without the World State, Inner
 * Chatter or any other block. Who takes part in a relationship moment is named here; a name that
 * only appears in a World State's lists (Off-Screen above all) is no part in the scene.
 */
export function storyProse(text) {
    let source = unwrapStoryBlocksEnvelope(extractNarrationCapture(text).text)
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
        .replace(/<Blocks\b[^>]*>[\s\S]*?(?:<\/Blocks\s*>|$)/gi, ' ')
        .replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, ' ');
    for (const tag of ['World_State', 'NPC_Inner_Chatter', 'Story_Tracker', 'CYOA', 'Bonds', 'Character_Sheet', 'New_NPC', 'NPC_Update']) {
        source = source.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi'), ' ');
    }
    return source
        .replace(/<[^>]+>/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripTrailingJsonCommas(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; out += ch; continue; }
        if (ch === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j += 1;
            if (text[j] === '}' || text[j] === ']') continue;
        }
        out += ch;
    }
    return out;
}

function quoteBareJsonKeys(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    let expectingKey = false;
    for (let i = 0; i < text.length;) {
        const ch = text[i];
        if (inString) {
            out += ch;
            i += 1;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; out += ch; i += 1; expectingKey = false; continue; }
        if (ch === '{' || ch === ',') {
            out += ch; i += 1; expectingKey = true; continue;
        }
        if (expectingKey && /\s/.test(ch)) { out += ch; i += 1; continue; }
        if (expectingKey && /[A-Za-z_$]/.test(ch)) {
            let j = i + 1;
            while (j < text.length && /[A-Za-z0-9_$-]/.test(text[j])) j += 1;
            let k = j;
            while (k < text.length && /\s/.test(text[k])) k += 1;
            if (text[k] === ':') {
                out += `"${text.slice(i, j)}"`;
                i = j;
                expectingKey = false;
                continue;
            }
        }
        if (!/\s/.test(ch)) expectingKey = false;
        out += ch; i += 1;
    }
    return out;
}

function repairScannerJsonText(text) {
    return quoteBareJsonKeys(stripTrailingJsonCommas(text));
}

function jsonParseErrorPosition(error) {
    const match = String(error?.message || '').match(/position\s+(\d+)/i);
    return match ? Number(match[1]) : -1;
}

function isInsideJsonStringAt(text, index) {
    let inString = false;
    let escaped = false;
    for (let i = 0; i < index && i < text.length; i += 1) {
        const ch = text[i];
        if (!inString) {
            if (ch === '"') inString = true;
            continue;
        }
        if (escaped) {
            escaped = false;
        } else if (ch === '\\') {
            escaped = true;
        } else if (ch === '"') {
            inString = false;
        }
    }
    return inString;
}

function repairMissingJsonSeparator(text, error) {
    const message = String(error?.message || '');
    const arraySeparator = /expected ',' or '\]' after array element/i.test(message);
    const objectSeparator = /expected ',' or '\}' after property value/i.test(message);
    if (!arraySeparator && !objectSeparator) return text;

    let position = jsonParseErrorPosition(error);
    if (!Number.isInteger(position) || position < 0 || position > text.length) return text;
    while (position < text.length && /\s/.test(text[position])) position += 1;
    if (position >= text.length || isInsideJsonStringAt(text, position)) return text;

    let previous = position - 1;
    while (previous >= 0 && /\s/.test(text[previous])) previous -= 1;
    if (previous < 0) return text;

    const previousChar = text[previous];
    const nextChar = text[position];
    const canEndValue = /["}\]0-9el]/i.test(previousChar);
    const canStartArrayValue = /["{\[0-9tfn-]/i.test(nextChar);
    const canStartObjectKey = nextChar === '"';
    if (!canEndValue) return text;
    if (arraySeparator && !canStartArrayValue) return text;
    if (objectSeparator && !canStartObjectKey) return text;

    return `${text.slice(0, position)},${text.slice(position)}`;
}

function parseWithScannerRepairs(text, firstError) {
    let candidate = repairScannerJsonText(text);
    let lastError = firstError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            return JSON.parse(candidate);
        } catch (error) {
            lastError = error;
            const repaired = repairMissingJsonSeparator(candidate, error);
            if (repaired === candidate) break;
            candidate = repaired;
        }
    }
    const error = new Error(`Scanner returned malformed JSON: ${lastError.message}`);
    error.cause = firstError;
    throw error;
}

// One-pass narration capture (opt-in). The roleplay model ends its reply with the quick-scan JSON
// inside a hidden comment; the block is removed from the stored message before any lineage key or
// transcript reads it. The block never reaches past the start of another extension's block (an HTML
// comment such as Story Block's <!-- STORY_SUITE_V2 envelope, Story Block's <Changes> block, or any
// tag after a blank line), so their text stays whole whichever comes first, even when Delta's block
// is never closed. Within that bound a closing `-->` at the very end wins, so one inside the JSON
// cannot split the block. The tag and trailing-fence near-misses are accepted only from a reply asked
// for the block.
const NARRATION_CAPTURE_COMMENT = /<!--\s*npc_state_delta\b((?:(?!<!--|<changes\b|\n[ \t]*\n[ \t]*<)[\s\S])*?)-->\s*$|<!--\s*npc_state_delta\b((?:(?!<!--|<changes\b|\n[ \t]*\n[ \t]*<)[\s\S])*?)-->|<!--\s*npc_state_delta\b((?:(?!<!--|<changes\b|\n[ \t]*\n[ \t]*<)[\s\S])*)/gi;
const NARRATION_CAPTURE_NEAR_MISS = /<npc_state_delta\b[^>]*>((?:(?!<!--|<changes\b|\n[ \t]*\n[ \t]*<)[\s\S])*?)(?:<\/npc_state_delta>|(?=<!--|<changes\b|\n[ \t]*\n[ \t]*<)|$)|```(?:json)?\s*(\{\s*"npcs"(?:(?!```)[\s\S])*)```\s*$/gi;
const NARRATION_CAPTURE_CLOSED = /(?:-->|<\/npc_state_delta>|```)\s*$/i;

function removeNarrationCaptureBlocks(source, pattern, found) {
    return source.replace(pattern, (whole, ...groups) => {
        found.raw = String(groups.slice(0, -2).find(group => group !== undefined) ?? '').trim();
        found.status = NARRATION_CAPTURE_CLOSED.test(whole) ? 'found' : 'unterminated';
        return '';
    });
}

export function extractNarrationCapture(text, { lenient = false } = {}) {
    const source = String(text ?? '');
    const found = { raw: '', status: 'none' };
    const clean = removeNarrationCaptureBlocks(lenient ? removeNarrationCaptureBlocks(source, NARRATION_CAPTURE_NEAR_MISS, found) : source, NARRATION_CAPTURE_COMMENT, found);
    return found.status === 'none' ? { text: source, ...found } : { text: clean.replace(/\s+$/, ''), ...found };
}

export function parseNarrationCapture(raw) {
    if (!String(raw ?? '').trim()) return null;
    try { return parseScanJson(raw); } catch { return null; }
}

// Scan row keys: trim, "Name" -> name, "home_base" -> homeBase; a clean key in the row wins, colliding variants stay as sent.
const cleanScanKey = key => {
    const t = key.trim().replace(/[_-]+([a-z0-9])/gi, (_, c) => c.toUpperCase());
    return /^[A-Z0-9]+$/.test(t) ? t.toLowerCase() : t.charAt(0).toLowerCase() + t.slice(1);
};
function normaliseScanRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const keys = Object.keys(row), hits = {};
    for (const key of keys) hits[cleanScanKey(key)] = (hits[cleanScanKey(key)] || 0) + 1;
    return Object.fromEntries(keys.map(key => { const to = cleanScanKey(key); return [to && hits[to] === 1 && !keys.includes(to) ? to : key, row[key]]; }));
}
export const normaliseScanKeys = parsed => {
    for (const list of ['npcs', 'profileUpdates', 'profile_updates', 'keyRelationshipEdges', 'key_relationship_edges']) parsed[list] &&= Array.isArray(parsed[list]) ? parsed[list].map(normaliseScanRow) : parsed[list];
    return parsed;
};

export function parseScanJson(raw) {
    if (raw && typeof raw === 'object') return raw;
    let text = String(raw ?? '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) text = text.slice(first, last + 1);

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (firstError) {
        parsed = parseWithScannerRepairs(text, firstError);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Scanner response is not a JSON object.');
    }
    if (!Array.isArray(parsed.npcs)) parsed.npcs = [];
    return normaliseScanKeys(parsed);
}

export function cleanText(value, max = 1200) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

// (stage 73) The scanner's transcripts label messages "[m12] ..." so evidence can cite them; the model sometimes also appends the
// citation to ordinary fields ("... distressed demeanor [m1, m2]"). stripMessageCitations removes such citation groups anywhere in a
// text, with the space/punctuation they leave: `[m1]`, `[m1, m2]`, `[m3-m5]`, `[m3\u20135]`, `(m1, m2)`, `[message 12]`, `[messages 3, 4]`,
// `[message 12 \u00b7 user]`. Only groups made entirely of citation tokens go; "[Rank F]", "(the left notched)" and an "m" inside a word stay.
// Lowercase only (the transcripts write "m" and "message"): a room "[M3]" stays.
const CITE_TOKEN = 'm\\d+(?:\\s*[-\u2013\u2014]\\s*m?\\d+)?';
const CITE_NUMS = '\\d+(?:\\s*[-\u2013\u2014]\\s*\\d+)?(?:\\s*(?:,|;|&|and)\\s*\\d+(?:\\s*[-\u2013\u2014]\\s*\\d+)?)*';
const CITE_GROUP = new RegExp(
    `[\\[(]\\s*(?:(?:${CITE_TOKEN})(?:\\s*(?:,|;|&|and)\\s*(?:${CITE_TOKEN}))*|messages?\\s*#?\\s*${CITE_NUMS}(?:\\s*[\u00b7\u2022|:]\\s*[A-Za-z]+)?)\\s*[\\])]`, 'g');
export function stripMessageCitations(value) {
    if (typeof value !== 'string' || !/[\[(]\s*(?:m\d|messages?\b)/.test(value)) return value;
    const MARK = '\u0000';
    const marked = value.replace(CITE_GROUP, MARK);
    if (marked === value) return value;
    return marked
        .replace(/[ \t\r\n]*\u0000(?:[ \t\r\n]*\u0000)*[ \t\r\n]*/g, (match, offset, whole) => {
            const next = whole.slice(offset + match.length)[0];
            if (offset === 0 || next === undefined || /[.,;:!?)\]]/.test(next)) return '';
            return ' ';
        })
        .replace(/[,;]\s*$/, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

export function cleanTextBoundary(value, max = 1200, { ellipsis = true } = {}) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    const cap = Math.max(0, Math.floor(Number(max) || 0));
    if (!text || cap <= 0) return '';
    if (text.length <= cap) return text;
    const reserve = ellipsis && cap > 1 ? 1 : 0;
    const prefix = text.slice(0, Math.max(1, cap - reserve));
    let sentenceCut = -1;
    for (const match of prefix.matchAll(/[.!?](?=\s|$)/g)) sentenceCut = match.index + 1;
    if (sentenceCut >= Math.floor(cap * 0.45)) return prefix.slice(0, sentenceCut).trim();
    let clauseCut = -1;
    for (const match of prefix.matchAll(/[;,](?=\s|$)/g)) clauseCut = match.index;
    if (clauseCut >= Math.floor(cap * 0.45)) return prefix.slice(0, clauseCut).replace(/[|/;,\s]+$/g, '').trim();
    const wordCut = prefix.lastIndexOf(' ');
    if (wordCut <= 0) return '';
    const clipped = prefix.slice(0, wordCut).replace(/[|/;,\s]+$/g, '').trim();
    return clipped && ellipsis ? `${clipped}…` : clipped;
}

export function cleanList(value, maxItems = 8, maxChars = 240) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const item of value) {
        const cleaned = cleanText(item, maxChars);
        const key = normalizeName(cleaned);
        if (!cleaned || !key || seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
        if (out.length >= maxItems) break;
    }
    return out;
}

// (cleanup step 12, I-7) Model-facing dossier context at the stored cap. A value longer than that
// (a locked field keeps more) is cut at a word boundary, never mid-word.
export function cleanWords(value, max) {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    const cut = text.slice(0, max + 1).lastIndexOf(' ');
    return text.slice(0, cut > 0 ? cut : max).trimEnd();
}

export function cleanWordsList(value, maxItems, maxChars) {
    return cleanList(Array.isArray(value) ? value.map(item => cleanWords(item, maxChars)) : value, maxItems, maxChars);
}
