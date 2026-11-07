// The NPC meter prompt line, tail and redaction. A pure part of npc-meters.js (same owner, moved without change);
// npc-meters.js re-exports every public name it exported before. Never imports npc-meters.js.
import { BUILT_IN_METERS, IMPACT_TIERS, FEATURE_PRESETS, RECENT_MESSAGES, SECRET_TEXT_MAX, TAIL_SECRETS_PER_NPC, isInt, clean, bandWord } from './npc-meters-config.js';
import { meterValue } from './npc-meters-slice.js';

export function createNpcPrompt({
    call, hooks, storedSettings, tierCaps, featureOn, defsFrom, setupFor, rungsFor, rulesFor,
}, { sliceOf, presentKeys }) {
    // ---- the prompt (SPEC §5) ----

    /**
     * One line: how to write an npc line and which meters there are, plus each meter's rule while the
     * presets feature is on. Changes only with the settings (and the presets in use).
     */
    function staticText() {
        const settings = storedSettings();
        const caps = tierCaps();
        const custom = settings.custom.map(def => `, ${def.id} (${def.min}..${def.max})`).join('');
        const base = `NPC meters: ${BUILT_IN_METERS.map(def => def.id).join(', ')} (-100..100)${custom}. When the scene changes how someone feels: ~ npc Name | meter: +N, -N or =N. Code clamps each meter, moves it at most ${settings.changeCap} a reply and sets the stages; never write a stage.${caps ? ` Add | impact: ordinary|meaningful|major|extreme (the most a move can be: ${IMPACT_TIERS.map(tier => caps[tier]).join('/')}; =N moves toward N; none given: ordinary).` : ''}`;
        const rules = featureOn(FEATURE_PRESETS) ? settings.custom.filter(def => def.describe).map(def => `${def.id} ${def.describe}`) : [];
        return rules.length ? `${base} Meter rules: ${rules.join('; ')}.` : base;
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
    const HIDDEN_LINE = new RegExp(`^(.+?)(?:, ${HIDDEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}| \\(hidden\\)): .*$`, 'gm');

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
        let order = 0;
        for (const key of Object.keys(npcs).sort()) {
            if (!here.has(key)) continue;
            const record = npcs[key];
            // Where the window's reply was (its index, kept beside a record ID).
            const where = isInt(record.turn?.at) ? record.turn.at : record.turn?.reply;
            if (isInt(where) && where >= length - RECENT_MESSAGES) {
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
        const optional = hidden.map((item, i) => (i ? item.short : `${HIDDEN_ONCE}\n${item.short}`));
        return { lines: [...lines, ...notes], optional };
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
