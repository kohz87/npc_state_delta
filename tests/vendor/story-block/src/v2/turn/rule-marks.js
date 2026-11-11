// Story Suite v2: rule marks, a per-reply list of the rules a reply was captured under (`rules` on its record). A rule that changes what a
// story line does (a new write a line never made before) must not reach an old reply when it is run again (Re-read, edit, rebuild), so the
// first live capture marks a new reply with every current rule, and a module reads the list, read-only, as `ctx.carrier.rules` in its apply.
// A reply captured before the rule has no mark and keeps the old behaviour. The list is bookkeeping, not a replay input (replay.js).
// New rule: add a name and its line test to RULE_LINES below; nothing else in the host changes.

import { adoptLegacy, assistSections, extractBlock, parseChanges } from '../capture.js';
import { activeDefinition } from '../data-modules/adapters.js';
import { withKind } from '../data-modules/part/act.js';
import { resolveModule } from '../data-modules/part/views.js';

const DEATH = /(?<![\p{L}\p{N}])(?:died|dies|dead|death|killed|slain|murdered|perished)(?![\p{L}\p{N}])/iu;

/** Any `+ party` line counts, however it parsed. */
const partyJoin = line => (line?.kind === 'party' && line.op === '+') || /^\s*\+\s*party(?![\p{L}\p{N}])/iu.test(String(line?.raw ?? ''));

/** Rule name -> does this parsed change line fall under it? */
export const RULE_LINES = Object.freeze({
    // `? roll Name | skill | difficulty | die`: story checks (lean-rpg/checks). A reply with no mark keeps what it did before: the line is not used.
    checks: line => line?.kind === 'roll',
    // `- key Name | died`: a death counts for anyone, not only a pinned key person (Story Director keypeople). Same words as its death test.
    // `+ party Name`: the room for a companion's blocks (data-modules dmRoom: 20 own, 28 in all) and the party limit counting only active members. Any `+ party` line counts, however it parsed.
    partyRoom: partyJoin,
    // The party holds 4 active members, the reader's character included (lean-rpg/names.js PARTY_ACTIVE; a reply with only `partyRoom` keeps 8). Same lines as `partyRoom`.
    partyFour: partyJoin,
    diedAny: line => line?.kind === 'key' && line.op === '-' && [line.text, ...Object.keys(line.labels ?? {}), ...Object.values(line.labels ?? {})].some(part => DEATH.test(String(part ?? ''))),
    // `+/~/- world Event | factions: A, B`: Story Director names unknown factions from an event's tags (feat/faction-from-events). Any world line counts, so an old reply with one never gains the new creation on Re-read.
    factionTags: line => line?.kind === 'world',
});

/** A narrator's set-slot line, using normalized labels and the same omitted-kind inference as the handler. */
export function foeLine(line, state = null) {
    if (line?.kind !== 'dm' || line.op !== '+') return false;
    const named = Object.hasOwn(line.labels ?? {}, 'kind');
    if (named && !/^set-slot-\d$/u.test(String(line.labels.kind))) return false;
    // Prior text may have used an older definition; a kind-less line could have been a foe, so do not change its rule.
    if (!state) return true;
    try {
        const definition = activeDefinition(state, resolveModule(state, line.name));
        if (definition?.role !== 'foes') return false;
        const kind = named ? line.labels.kind : withKind(definition, line).kind;
        return /^set-slot-\d$/u.test(String(kind ?? '')) && !!definition.kinds[kind]?.labels?.level;
    } catch { return false; }
}

export const MAX_RULE_MARKS = 8;
const NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;

/** The marks a record keeps: known names only, sorted, no repeats, at most MAX_RULE_MARKS. Anything else in the field is ignored. */
export function ruleMarksOf(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(name => typeof name === 'string' && NAME.test(name) && Object.hasOwn(RULE_LINES, name)))].sort().slice(0, MAX_RULE_MARKS);
}

/** The rules the parsed change lines fall under. */
export function ruleMarksFor(lines) {
    return Object.keys(RULE_LINES).filter(name => (lines ?? []).some(line => RULE_LINES[name](line))).sort();
}

/** Rules that cannot be newly marked on an existing reply without changing its earlier lines on Re-read. */
export function previousMarks(before, heads, late = []) {
    if (before === undefined) return { foe: false, rules: [], first: true }; // A new reply or swipe: its first capture marks it with every rule.
    if (typeof before !== 'string') return { foe: true, rules: Object.keys(RULE_LINES) }; // Unknown previous text: stay conservative.
    const text = adoptLegacy(before).text;
    const block = extractBlock(text, 'Changes', null, { heads });
    const lines = [...parseChanges(block ?? '').lines, ...parseChanges(assistSections(text).now.join('\n')).lines, ...late];
    return { foe: lines.some(line => foeLine(line)), rules: ruleMarksFor(lines) };
}

/** Every rule a new reply is marked with at its first capture, whether or not it has such a line yet. */
export const allRuleNames = () => Object.keys(RULE_LINES).sort();

/** Only replies seen being created here may gain their first mark after their initial capture. */
export function createMarkHistory() {
    const fresh = new WeakMap();
    return (message, sid, type, before, heads, late) => {
        const valid = message && typeof message === 'object' && typeof sid === 'string';
        if (type !== 'continue' && type !== 'late') {
            if (valid) {
                const ids = fresh.get(message) ?? new Set();
                ids.add(sid);
                fresh.set(message, ids);
            }
            return previousMarks(undefined, heads);
        }
        if (!valid || !fresh.get(message)?.has(sid)) return { foe: true, rules: Object.keys(RULE_LINES) };
        return previousMarks(before, heads, late);
    };
}
