// What the foe pre-check's prompt may add from the world, read once per send and handed to precheckPrompt as plain strings:
// the story's rank scale (the source `rpg.rank` reads: the pack's `ranks` record) and a short line for each person the message
// or the reply before it names (NPC State Delta's `npc.known` / `npc.dossier`, when it answers). Read only: nothing is written and
// nothing is asked of a model. The prompt is only the INPUT of the Assist call, whose vetted result is what gets recorded, so
// replay never rebuilds this text and never depends on live NPC state.
import { bandsOf, packLevelsOf } from '../levels.js';

/** Bounds, in code points: people per prompt, parts of one line, and the whole line. */
export const KNOWN_LIMITS = Object.freeze({ people: 3, name: 40, role: 60, summary: 100, line: 170, scan: 80 });

const cut = (value, max) => [...String(value ?? '').replace(/\s+/gu, ' ').trim()].slice(0, max).join('').trim();
export const wordsOf = text => String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const ask = (query, name, args) => { try { return typeof query === 'function' ? query(name, args) : null; } catch { return null; } };

/** The scale as one line, "Ranks: F 1-9, E 10-19", or '' when the story has no ranks. */
export function rankScale(query) {
    const ranks = bandsOf(packLevelsOf(ask(query, 'packs.content', { kind: 'rpg' }))?.ranks);
    return ranks.length ? `Ranks: ${ranks.map(rank => `${cut(rank.name, 24)} ${rank.from}-${rank.to}`).join(', ')}` : '';
}

// Whether the words of `name` occur, whole and in a row, among `seen` (the message and the reply before it, as words).
export function occurs(name, seen) {
    const wanted = wordsOf(name);
    if (!wanted.length) return false;
    for (let at = 0; at + wanted.length <= seen.length; at += 1) if (wanted.every((word, i) => seen[at + i] === word)) return true;
    return false;
}

/** At most KNOWN_LIMITS.people lines "Name: role; short summary" for the dossiers whose name or alias the text names; [] without NSD or a match. */
export function knownLines(query, ...texts) {
    const names = ask(query, 'npc.known', {});
    if (!Array.isArray(names)) return [];
    const seen = texts.flatMap(wordsOf);
    const lines = [];
    for (const name of names.slice(0, KNOWN_LIMITS.scan)) {
        if (lines.length >= KNOWN_LIMITS.people) break;
        if (typeof name !== 'string') continue;
        const dossier = ask(query, 'npc.dossier', { name });
        if (!dossier || typeof dossier !== 'object') continue;
        const aliases = Array.isArray(dossier.aliases) ? dossier.aliases.filter(alias => typeof alias === 'string') : [];
        if (![name, ...aliases].some(label => occurs(label, seen))) continue;
        const detail = [cut(dossier.role, KNOWN_LIMITS.role), cut(dossier.background, KNOWN_LIMITS.summary)].filter(Boolean).join('; ');
        if (detail) lines.push(cut(`${cut(name, KNOWN_LIMITS.name)}: ${detail}`, KNOWN_LIMITS.line));
    }
    return lines;
}
