// Present NPCs view, display only: what each present NPC is like now (labelled Mood, Condition and
// Outfit lines, 1.2.3; one "mood · condition · outfit" line in 1.2.2) on each present card,
// and Story Block's NPC Inner Chatter shown as bubbles beside the speakers' cards. Everything
// here is pure except fillPresentSceneText, which writes the shaped strings into slots with
// textContent. Nothing reads or writes dossier state, prompts, scans or saved data; without Story
// Block the now line comes from Delta's own tracked mood/condition/outfit and no chatter shows.
import { normalizeName, npcNamedInText } from './core-mechanics.js';
import { trimAtWord } from './suite-handshake.js';

// Each labelled now line shows up to NOW_PART_MAX characters (the card clamps it to two lines) and
// carries up to NOW_TITLE_MAX in its tooltip, so a long mood or outfit stays readable.
export const NOW_PART_MAX = 160;
export const NOW_TITLE_MAX = 400;
export const NOW_PARTS = Object.freeze([['mood', 'Mood'], ['condition', 'Condition'], ['outfit', 'Outfit']]);
export const CHATTER_LINE_MAX = 240;
export const CHATTER_LINE_LIMIT = 12;

const plain = value => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/g, ' ').trim() : '');

/** Tags of the enabled Story Block blocks shown as `display` ('scene', 'chatter'), in list order. */
export function storyBlockTags(blocks, display) {
    try {
        const tags = (Array.isArray(blocks) ? blocks : [])
            .filter(block => block && block.enabled !== false && block.display === display)
            .map(block => plain(block.tag))
            .filter(Boolean);
        return [...new Set(tags)];
    } catch {
        return [];
    }
}

// `---`, `***`, `___` between turns, and a block's own `[placeholder]` echoed back.
const RULE = /^(?:[-*_]\s*){3,}$/;
const PLACEHOLDER = /^\[[\s\S]*\]$/;
const QUOTES_AT_ENDS = /^["“”'‘’«»]+|["“”'‘’«»]+$/g;
const EMPHASIS_AT_ENDS = /^[*_~]+|[*_~]+$/g;
const NOT_A_NAME = /^(?:notes?|example|tone|edit|ooc|warning|summary|context|rules?|output|format|scene|time|location|thoughts?|npc inner chatter|inner chatter|chatter|others?)$/i;
// A sentence with a colon ("Then she said: run") starts with one of these; a name does not.
const NOT_A_FIRST_WORD = new Set([
    'i', 'he', 'she', 'they', 'we', 'you', 'it', 'his', 'her', 'their', 'our', 'my', 'your',
    'then', 'but', 'and', 'so', 'when', 'if', 'now', 'still', 'just', 'later', 'meanwhile',
    'suddenly', 'finally', 'also', 'yes', 'no', 'well', 'oh', 'this', 'that', 'there', 'here',
    'what', 'why', 'how', 'who', 'only', 'even', 'because', 'once', 'after', 'before',
]);

function stripBullet(line) {
    return String(line)
        .replace(/^\s*(?:[-–—•+>]+\s*|\*\s+(?=\S))/u, '')
        .replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+/u, '');
}

function cleanSpeaker(head) {
    return plain(String(head).replace(/[*_]+/g, '').replace(QUOTES_AT_ENDS, ''));
}

function nameLike(name) {
    if (!name || name.length > 64 || !/^\p{L}/u.test(name) || NOT_A_NAME.test(name)) return false;
    if (/["“”]/.test(name)) return false;
    const words = name.split(/\s+/);
    return words.length <= 6 && !NOT_A_FIRST_WORD.has(words[0].toLowerCase());
}

function cleanLine(text) {
    return plain(String(text).replace(EMPHASIS_AT_ENDS, '').trim().replace(QUOTES_AT_ENDS, '').replace(EMPHASIS_AT_ENDS, ''));
}

/** One speaker head and line from `Name: line` (bold names, quotes and bullets tolerated), or null. */
function readSpeakerLine(raw) {
    const rest = stripBullet(raw);
    const colon = rest.search(/[:：]/);
    if (colon <= 0 || colon > 64) return null;
    const head = rest.slice(0, colon);
    let text = rest.slice(colon + 1);
    // `**Astra:** text`: the bold closes after the colon.
    const open = /^\s*(\*{1,3}|_{1,3})/.exec(head);
    if (open && text.startsWith(open[1])) text = text.slice(open[1].length);
    if (text && !/^\s/.test(text)) return null;
    const speaker = cleanSpeaker(head);
    if (!nameLike(speaker)) return null;
    const line = cleanLine(text);
    return line ? { speaker, line } : null;
}

/**
 * NPC Inner Chatter as [{ speaker, line }] in the block's order: one `Name: line` per line. A
 * line that is not a speaker line continues the speaker above it; rules, placeholders and text
 * before the first speaker are left out. Never throws.
 */
export function parseChatterLines(text) {
    try {
        const out = [];
        for (const raw of String(text ?? '').split(/\r?\n/)) {
            const trimmed = raw.trim();
            if (!trimmed || RULE.test(trimmed) || PLACEHOLDER.test(trimmed)) continue;
            const entry = readSpeakerLine(trimmed);
            if (entry) {
                if (out.length >= CHATTER_LINE_LIMIT) break;
                out.push(entry);
                continue;
            }
            const more = cleanLine(stripBullet(trimmed));
            if (out.length && more) out[out.length - 1].line = `${out[out.length - 1].line} ${more}`;
        }
        return out.map(entry => ({ speaker: entry.speaker, line: trimAtWord(entry.line, CHATTER_LINE_MAX) }));
    } catch {
        return [];
    }
}

const WS_FIELDS = Object.freeze({
    outfit: 'outfit', clothing: 'outfit', clothes: 'outfit', attire: 'outfit', dress: 'outfit',
    mood: 'mood', emotion: 'mood', expression: 'mood', demeanor: 'mood', demeanour: 'mood',
    condition: 'condition', 'visible condition': 'condition', status: 'condition', state: 'condition',
    injuries: 'condition', health: 'condition',
});
const WS_HEADER = /^\s*(?:[-*•]\s+)?(?:\*\*\s*(.+?)\s*:\s*\*\*|\*\*\s*(.+?)\s*\*\*\s*:)\s*$/u;
const WS_FIELD = /^\s*[-*•]\s+(?:\*{1,2}|_{1,2})?\s*([\p{L}][\p{L} ]{0,30}?)\s*:\s*(?:\*{1,2}|_{1,2})?\s*(.*)$/u;

function fieldValue(value) {
    const text = cleanLine(value);
    return !text || PLACEHOLDER.test(text) ? '' : text;
}

/**
 * The people of a World State block (Megumin Suite's / Story Block's layout): a `**Name:**` line
 * followed by `* *Outfit:* …`, `* *Mood:* …`, `* *Visible Condition:* …` bullets. Returns
 * [{ name, mood, condition, outfit }] in order, first section per name. Never throws.
 */
export function parseWorldStateNpcs(text) {
    try {
        const sections = [];
        let current = null;
        for (const raw of String(text ?? '').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            if (RULE.test(line)) { current = null; continue; }
            const header = WS_HEADER.exec(line);
            if (header) {
                const name = plain(String(header[1] ?? header[2] ?? '').replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+/u, '').replace(/[*_]+/g, ''));
                current = name && !PLACEHOLDER.test(name) ? { name, mood: '', condition: '', outfit: '' } : null;
                if (current) sections.push(current);
                continue;
            }
            const field = current ? WS_FIELD.exec(line) : null;
            const key = field ? WS_FIELDS[plain(field[1]).toLowerCase()] : '';
            if (key && !current[key]) current[key] = fieldValue(field[2]);
        }
        const seen = new Set();
        return sections.filter(section => {
            const key = normalizeName(section.name);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    } catch {
        return [];
    }
}

/**
 * The present card a speaker or World State name belongs to, or ''. An exact (case-insensitive)
 * name or alias of exactly one card first, then Delta's usual name recognition (npcNamedInText:
 * a distinctive part of the name, not titles or role words) when exactly one card matches.
 */
export function matchPresentCard(name, cards = [], roster = []) {
    try {
        const key = normalizeName(name);
        if (!key) return '';
        const list = (Array.isArray(cards) ? cards : []).filter(card => card && plain(card.id) && plain(card.name));
        const exact = list.filter(card => [card.name, ...(Array.isArray(card.aliases) ? card.aliases : [])].some(label => normalizeName(label) === key));
        if (exact.length) return exact.length === 1 ? plain(exact[0].id) : '';
        const everyone = Array.isArray(roster) && roster.length ? roster : list;
        const named = list.filter(card => npcNamedInText(card, String(name), everyone));
        return named.length === 1 ? plain(named[0].id) : '';
    } catch {
        return '';
    }
}

/** The labelled now lines with a value, in order: [{ key, label, text, title }], cut at a word. */
export function nowParts(source = {}) {
    const values = source && typeof source === 'object' ? source : {};
    return NOW_PARTS.map(([key, label]) => {
        const value = plain(values[key]);
        return value ? { key, label, text: trimAtWord(value, NOW_PART_MAX), title: trimAtWord(value, NOW_TITLE_MAX) } : null;
    }).filter(Boolean);
}

/** 'speech' when two or more people speak in the chatter, 'thought' for one, '' for none. */
export function chatterBubbleKind(lines = []) {
    const speakers = new Set((Array.isArray(lines) ? lines : []).map(entry => normalizeName(entry?.speaker)).filter(Boolean));
    if (!speakers.size) return '';
    return speakers.size >= 2 ? 'speech' : 'thought';
}

function signatureOf(value) {
    const text = JSON.stringify(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * Everything the present view shows beyond the cards themselves.
 * `cards`: [{ id, name, aliases, mood, condition, outfit }] (Delta's own tracked values).
 * `sceneText`: Story Block's World State for the latest reply, used only when `sceneOwned`.
 * `chatterText`: Story Block's NPC Inner Chatter for the latest reply.
 * Returns { now: { [id]: { parts: [{ key, label, text, title }], source } }, kind,
 * byCard: { [id]: [{ order, text }] },
 * others: [{ order, speaker, text }], texts: [string], signature } where every `text`/`speaker`
 * is an index into `texts`. Never throws.
 */
export function presentSceneModel({ cards = [], roster = [], sceneText = '', sceneOwned = false, chatterText = '' } = {}) {
    const texts = [];
    const slot = value => texts.push(String(value)) - 1;
    const model = { now: {}, kind: '', byCard: {}, others: [], texts, signature: '' };
    try {
        const list = (Array.isArray(cards) ? cards : []).filter(card => card && plain(card.id));
        const world = sceneOwned && sceneText ? parseWorldStateNpcs(sceneText) : [];
        const fromWorld = new Map();
        for (const section of world) {
            const id = matchPresentCard(section.name, list, roster);
            if (id && !fromWorld.has(id) && (section.mood || section.condition || section.outfit)) fromWorld.set(id, section);
        }
        for (const card of list) {
            const id = plain(card.id);
            const section = fromWorld.get(id);
            const parts = nowParts(section || card);
            if (parts.length) {
                model.now[id] = {
                    parts: parts.map(part => ({ key: part.key, label: part.label, text: slot(part.text), title: slot(part.title) })),
                    source: section ? 'world-state' : 'dossier',
                };
            }
        }
        const lines = parseChatterLines(chatterText);
        model.kind = chatterBubbleKind(lines);
        lines.forEach((entry, index) => {
            const id = matchPresentCard(entry.speaker, list, roster);
            const order = index + 1;
            if (id) (model.byCard[id] ||= []).push({ order, text: slot(entry.line) });
            else model.others.push({ order, speaker: slot(entry.speaker), text: slot(entry.line) });
        });
    } catch (error) {
        console.warn('[NPC State Delta] present scene could not be shaped', error);
        model.now = {};
        model.kind = '';
        model.byCard = {};
        model.others = [];
        texts.length = 0;
    }
    model.signature = signatureOf([model.now, model.kind, model.byCard, model.others, texts]);
    return model;
}

const escapeAttr = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const slotHtml = (tag, className, index) => `<${tag} class="${className}" data-delta-text="${Number(index)}"></${tag}>`;

/**
 * The empty now lines for a card (filled by fillPresentSceneText), or ''. Each line is its label
 * plus a text slot; the line's tooltip slot receives the full text.
 */
export function nowSlotHtml(model, id) {
    const now = model?.now?.[id];
    if (!now?.parts?.length) return '';
    const lines = now.parts.map(part => `<span class="npc-state-delta-present-now-part npc-state-delta-present-now-${escapeAttr(part.key)}" data-delta-title="${Number(part.title)}"><span class="npc-state-delta-present-now-label">${escapeAttr(part.label)}:</span> ${slotHtml('span', 'npc-state-delta-present-now-text', part.text)}</span>`).join('');
    return `<span class="${now.source === 'world-state' ? 'npc-state-delta-present-now npc-state-delta-present-now-world' : 'npc-state-delta-present-now'}">${lines}</span>`;
}

/** The bubbles beside one card: structure only, the text arrives through textContent. */
export function chatterSlotsHtml(model, id) {
    const lines = model?.byCard?.[id];
    if (!lines?.length) return '';
    const speech = model.kind === 'speech';
    const bubbles = lines.map(line => `<p class="npc-state-delta-bubble">${speech ? `<span class="npc-state-delta-bubble-order" aria-hidden="true">${Number(line.order)}</span>` : ''}${slotHtml('span', 'npc-state-delta-bubble-text', line.text)}</p>`).join('');
    return `<div class="npc-state-delta-chatter ${speech ? 'npc-state-delta-chatter-speech' : 'npc-state-delta-chatter-thought'}" aria-label="${speech ? 'Whispered' : 'Thinking'}">${bubbles}</div>`;
}

/** The "Others" line under the cards for chatter from names that match no present card, or ''. */
export function othersSlotsHtml(model) {
    if (!model?.others?.length) return '';
    const items = model.others.map(other => `<span class="npc-state-delta-chatter-other">${model.kind === 'speech' ? `<span class="npc-state-delta-bubble-order" aria-hidden="true">${Number(other.order)}</span>` : ''}${slotHtml('b', 'npc-state-delta-chatter-speaker', other.speaker)}${slotHtml('span', 'npc-state-delta-chatter-said', other.text)}</span>`).join('');
    return `<p class="npc-state-delta-chatter-others ${model.kind === 'speech' ? 'npc-state-delta-chatter-speech' : 'npc-state-delta-chatter-thought'}"><span class="npc-state-delta-kicker">Others</span>${items}</p>`;
}

/** The roster attribute that ties rendered slots to their model. */
export function sceneAttr(model) {
    return model?.signature ? ` data-delta-scene="${escapeAttr(model.signature)}"` : '';
}

const models = new Map();
const MODEL_LIMIT = 16;

/** Keep a model so the slots rendered from it can be filled after the markup is inserted. */
export function rememberPresentScene(model) {
    if (!model?.signature) return model;
    models.delete(model.signature);
    models.set(model.signature, model);
    while (models.size > MODEL_LIMIT) models.delete(models.keys().next().value);
    return model;
}

/**
 * Write each remembered model's strings into its slots under `root` with textContent (never as
 * markup), and the now lines' full text into their title attribute. Only changed text is written.
 * Returns the number of slots written. Never throws.
 */
export function fillPresentSceneText(root) {
    let written = 0;
    try {
        if (!root) return 0;
        const sections = [
            ...(root.matches?.('[data-delta-scene]') ? [root] : []),
            ...(root.querySelectorAll?.('[data-delta-scene]') || []),
        ];
        for (const section of sections) {
            const model = models.get(section.getAttribute?.('data-delta-scene') ?? section.dataset?.deltaScene);
            if (!model) continue;
            for (const node of section.querySelectorAll?.('[data-delta-text]') || []) {
                const value = model.texts[Number(node.getAttribute?.('data-delta-text') ?? node.dataset?.deltaText)] ?? '';
                if (node.textContent !== value) {
                    node.textContent = value;
                    written += 1;
                }
            }
            for (const node of section.querySelectorAll?.('[data-delta-title]') || []) {
                const value = model.texts[Number(node.getAttribute?.('data-delta-title') ?? node.dataset?.deltaTitle)] ?? '';
                if ((node.getAttribute?.('title') ?? node.title) !== value) {
                    if (typeof node.setAttribute === 'function') node.setAttribute('title', value);
                    else node.title = value;
                    written += 1;
                }
            }
        }
    } catch (error) {
        console.warn('[NPC State Delta] present scene text could not be filled', error);
    }
    return written;
}
