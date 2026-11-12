// The NPC meter prompt line, tail and redaction. A pure part of npc-meters.js (same owner, moved without change);
// npc-meters.js re-exports every public name it exported before. Never imports npc-meters.js.
import { BUILT_IN_METERS, IMPACT_TIERS, FEATURE_GATE, FEATURE_PRESETS, FEATURE_MOOD_PULL, FEATURE_NOTES, RECENT_MESSAGES, SECRET_TEXT_MAX, TAIL_SECRETS_PER_NPC, isInt, clean, bandWord, readLeaf } from './npc-meters-config.js';
import { meterValue } from './npc-meters-slice.js';
import { APPROACH_KINDS, gateCue } from '../npc-meters-gate.js';
import { readEvent } from './npc-meters-pacing.js';
import { moodWord, normalizeMood } from '../npc-mood.js';
import { notesTail } from './npc-notes-kinds.js';

export function createNpcPrompt({
    call, hooks, storedSettings, tierCaps, tierAllowance, featureOn, defsFrom, setupFor, rungsFor, rulesFor,
}, { sliceOf, presentKeys }) {
    // ---- the prompt (SPEC §5) ----

    // "; each person can have only one major a day", from the reader's allowance (nothing when there is no limit on majors).
    function majorPerDay() {
        const room = tierAllowance()?.major;
        if (room === null || room === undefined) return '';
        return `; each person can have ${room === 1 ? 'only one major a day' : room === 0 ? 'no major' : `at most ${room} majors a day`}`;
    }
    /**
     * One line: how to write an npc line and which meters there are, plus each meter's rule while the
     * presets feature is on. Changes only with the settings (and the presets in use).
     */
    function staticText() {
        const settings = storedSettings();
        const caps = tierCaps();
        const custom = settings.custom.map(def => `, ${def.id} (${def.min}..${def.max})`).join('');
        const base = `NPC meters: ${BUILT_IN_METERS.map(def => def.id).join(', ')} (-100..100)${custom}. When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most ${settings.changeCap} a reply and sets the stages; never write a stage.${caps ? ` Add | impact: ordinary (a kind word, most moments) | meaningful (a real favour, a shared secret) | major (saved from danger, a betrayal) | extreme (a life-changing turning point, very rare). Most moments are ordinary${majorPerDay()}. The most a move can be: ${IMPACT_TIERS.map(tier => caps[tier]).join('/')}; =N moves toward N; none given: ordinary.` : ''}`;
        // Behind the anti-lever feature only (off: the line is as it was): the optional approach label.
        const via = featureOn(FEATURE_GATE) ? ` Add | via: ${APPROACH_KINDS.join(', ')} when the move is one of those approaches; the same approach to the same person again soon gives less, then backfires.` : '';
        const rules = featureOn(FEATURE_PRESETS) ? settings.custom.filter(def => def.describe).map(def => `${def.id} ${def.describe}`) : [];
        return rules.length ? `${base}${via} Meter rules: ${rules.join('; ')}.` : `${base}${via}`;
    }

    // How far a locked note is from opening (smaller is nearer): its meter's gap, else a story event's fixed middle.
    const EVENT_DISTANCE = 100;
    function openingDistance(rule, record, byId) {
        const def = typeof rule.meter === 'string' ? byId.get(rule.meter) : null;
        if (def && isInt(rule.at)) {
            const value = meterValue(record, def);
            return Math.max(0, rule.at < 0 ? value - rule.at : rule.at - value);
        }
        return EVENT_DISTANCE;
    }

    // The tail's words for a note: an opened one is the player's to know; a locked one shapes how the NPC acts.
    const KNOWN = 'known to the player now; may come out';
    const HIDDEN = 'hidden: never state or reveal; let it shape how they act';
    // (lean) The wording is said once, on the nearest locked note, and each note then reads "Name (hidden): text".
    const HIDDEN_ONCE = 'Lines marked (hidden) are secrets: never state or reveal them; let them shape how that person acts.';
    // One short cue, with the notes feature on (whoever is in the scene): the block is written, just before <Blocks>, even when <Blocks> is empty.
    // Sent as a kept line ({ text, keep: true }): the host's tail budget (the run used 550 tokens) drops this module's optional lines first,
    // and its section is last, so as an optional line the cue never reached a prompt. The host counts kept lines in tail order against one
    // shared cap (120 tokens): Story Director's pulse and Initiative lines (counted first) and its pinned hook cues ([Earlier days], [Names]) and
    // Story Block's own cues are never displaced, this section comes after them. The cue comes first, what the cap leaves goes to Pull and Mood; a kept
    // line that no longer fits is an ordinary line (the first of this section's lines dropped). Needs Story Block 2.31.1+ (older hosts drop object lines).
    const CHANGES_CUE = 'Whenever anything changed, write the <Changes> block (just before <Blocks>, which still ends the reply), even if <Blocks> is empty; a lie, secret, taste, tie or turning point gets its own line.';
    const HIDDEN_LINE = new RegExp(`^(.+?)(?:, ${HIDDEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}| \\(hidden\\)): .*$`, 'gm');

    // Mood and pull for present people (feature mood-pull): "Mood: Mira alarmed, cornered; Tomas wary." and
    // "Pull: Mira wants closure (the stolen letter, 3 days)". At most PULL_PEOPLE people each; sent as kept lines (see tail()). A mood of all zeros says nothing.
    const PULL_PEOPLE = 3;
    // What Pull and Mood may take of the shared kept cap (120) after the pulse (about 24), Initiative (about 19) and the cue (49): about 28 tokens.
    const FELT_KEPT_TOKENS = 28;
    const PULL_WORDS = { belonging: 'belonging', closure: 'closure', awe: 'awe' };
    function moodPullLines(npcs, here) {
        const moods = [];
        const pulls = [];
        for (const key of Object.keys(npcs).sort()) {
            if (!here.has(key)) continue;
            const record = npcs[key];
            const mood = normalizeMood(readLeaf(record.mood));
            if (mood && (mood.v || mood.a || mood.d) && moods.length < PULL_PEOPLE) {
                const control = mood.d <= -2 ? ', cornered' : mood.d >= 2 ? ', in control' : '';
                moods.push(`${record.name} ${moodWord(mood).toLowerCase()}${control}`);
            }
            const pull = readLeaf(record.pull);
            if (pull && PULL_WORDS[pull.kind] && pulls.length < PULL_PEOPLE) {
                const days = isInt(record.day) && isInt(pull.since) ? Math.max(0, record.day - pull.since) : 0;
                pulls.push(`${record.name}: ${PULL_WORDS[pull.kind]} (${clean(pull.cause, 60)}${days > 0 ? `, ${days} ${days === 1 ? 'day' : 'days'}` : ''})`);
            }
        }
        // Kept: the first person's Pull, then Mood, while they fit FELT_KEPT_TOKENS together; every other person, and any line over it, is optional.
        const keptLines = [];
        const rest = [];
        let used = 0;
        for (const [label, list] of [['Pull', pulls], ['Mood', moods]]) {
            if (!list.length) continue;
            const first = `${label}: ${list[0]}.`;
            const size = Math.ceil(first.length / 4);
            if (used + size <= FELT_KEPT_TOKENS) { keptLines.push(first); used += size; } else rest.push(first);
            if (list.length > 1) rest.push(`${label}: ${list.slice(1).join('; ')}.`);
        }
        return { kept: keptLines, rest };
    }

    /**
     * Present NPCs' meters when they moved lately (band words where a meter has them), and their notes: an
     * opened one as known to the player (a line), a locked one as hidden (optional lines, nearest to opening
     * first, so the host's budget drops the farthest first).
     */
    function tail(view) {
        const state = view?.state;
        const { npcs } = sliceOf(state);
        const settings = storedSettings();
        const defs = defsFrom(settings);
        const byId = new Map(defs.map(def => [def.id, def]));
        const length = Number.isInteger(view?.chat?.length) ? view.chat.length : 0;
        const here = presentKeys(npcs);
        const moved = [];
        const notes = [];
        const hidden = [];
        const cues = [];
        let order = 0;
        for (const key of Object.keys(npcs).sort()) {
            if (!here.has(key)) continue;
            const record = npcs[key];
            // Where the window's reply was (its index, kept beside a record ID).
            const where = isInt(record.turn?.at) ? record.turn.at : record.turn?.reply;
            const recent = isInt(where) && where >= length - RECENT_MESSAGES;
            // The gate's cue: only while this reply's own story line fired it (the last event is the reply's), one short line, optional.
            const event = recent && featureOn(FEATURE_GATE) ? readEvent(record.lastEvent) : null;
            const fired = event && event.at === record.turn?.reply ? event.events.findLast(item => item.gate) : null;
            if (fired) cues.push(gateCue({ mode: fired.gate.mode, via: fired.via, name: record.name }));
            if (recent) {
                const parts = defs.map(def => {
                    const stage = record.stages?.[def.id];
                    const value = meterValue(record, def);
                    return `${def.id} ${bandWord(def.bands, value) || value}${stage ? ` (${stage})` : ''}`;
                });
                const rank = record.rank !== undefined ? rungsFor(settings, setupFor(record.name)).find(step => step.key === record.rank)?.name : null;
                moved.push(`${record.name}${rank ? ` (${rank})` : ''} ${parts.join(', ')}`);
            }
            const rules = rulesFor(record.name, [record.name]).filter(rule => rule && typeof rule.id === 'string');
            if (!rules.length) continue;
            const opened = new Set(Array.isArray(record.unlocked) ? record.unlocked : []);
            const given = call(hooks.secretTexts, [], record.name, rules.map(rule => rule.id));
            const textOf = new Map((Array.isArray(given) ? given : []).map(item => [item?.id, clean(item?.text, SECRET_TEXT_MAX)]));
            let known = 0;
            for (const rule of rules) {
                const text = textOf.get(rule.id);
                if (!text) continue;
                if (opened.has(rule.id)) {
                    if (known < TAIL_SECRETS_PER_NPC) { notes.push(`${record.name}, ${KNOWN}: ${text}`); known += 1; }
                } else {
                    hidden.push({ distance: openingDistance(rule, record, byId), order: order += 1, short: `${record.name} (hidden): ${text}` });
                }
            }
        }
        const lines = [];
        if (moved.length) lines.push(`NPC meters now: ${moved.join('; ')}.`);
        hidden.sort((a, b) => a.distance - b.distance || a.order - b.order);
        // The wording rides on the nearest note (the host drops the farthest first, so it stays while any note does).
        const optional = [...cues, ...hidden.map((item, i) => (i ? item.short : `${HIDDEN_ONCE}\n${item.short}`))];
        // Notes (npc-notes-kinds.js): at most two lines a person and four in all, after the meters and opened notes (optional).
        if (featureOn(FEATURE_NOTES)) {
            const noted = notesTail(npcs, { present: Object.keys(npcs).sort().filter(key => here.has(key)) });
            // A secret note line (a lie told) with no locked meter note before it carries the (hidden) wording itself.
            const first = hidden.length ? -1 : noted.findIndex(line => / \(hidden\): /.test(line));
            if (first >= 0) noted[first] = `${HIDDEN_ONCE}\n${noted[first]}`;
            optional.push(...noted);
        }
        // The last required lines (the host writes this section's optional lines after them), in this order: the cue, then Pull, then Mood.
        // The cue goes first so it keeps the shared kept cap exactly as before (it is a reminder of the reply's form: the model drifts into ending
        // on an empty <Blocks> and dropping <Changes>, which loses state). Pull and Mood take what the cap leaves, the first person's only (about 28
        // tokens); the other people's, and a line that does not fit that, are optional lines (after the notes), never required ones.
        // As optional lines of this last-sorted section the host's tail budget cut Pull and Mood from every prompt of run 3. Kept lines share the
        // host's one cap after Story Director's and Story Block's own, which come earlier in tail order and keep theirs; over the cap a line is
        // an ordinary one, so these lines never displace another module's kept or pinned line.
        const felt = featureOn(FEATURE_MOOD_PULL) ? moodPullLines(npcs, here) : { kept: [], rest: [] };
        const cue = featureOn(FEATURE_NOTES) ? [{ text: CHANGES_CUE, keep: true }] : [];
        optional.push(...felt.rest);
        return { lines: [...lines, ...notes, ...cue, ...felt.kept.map(text => ({ text, keep: true }))], optional };
    }

    /**
     * The same text as a reader sees it in "What's sent each reply": a locked note's line becomes
     * "Mira: 1 hidden note", never its text. Everything else is as sent. (Offered to Story Block as the
     * module's `hooks.redactSent`, for the view that draws and copies the sent text; SillyTavern's own prompt view still shows all.)
     */
    function redact(text) {
        // Every locked line of the whole text, wherever it stands; each other line (and every line break) is left as it is.
        return String(text ?? '').replace(HIDDEN_LINE, '$1: 1 hidden note');
    }

    return { staticText, tail, redact };
}
