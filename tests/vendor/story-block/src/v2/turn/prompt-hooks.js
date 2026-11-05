// Story Suite v2: the prompt-time hooks, moved out of createTurn unchanged: GENERATION_STARTED (a quiet generation's instruction is
// remembered), and the two prompt-ready handlers (chat completion, text completion) that strip hidden blocks from the history and put
// Story Block's text back where the preset dropped it. `createPromptHooks(s, deps)` is given the turn's state holder `s` and the
// prompt-build parts it calls; it never imports turn.js.

import { QUIET_KEEP, QUIET_WAIT_MS, contentText, firstLine, mapContent, quietMark, restoreMissing, stripBattleMarker, textPattern } from './text.js';

export function createPromptHooks(s, deps) {
    const { isOwn, battleOn, stripHistory, backgroundPrompt, foreignPrompt, HAS_LEGACY, LEGACY_IN_PROMPT, holdsIn, normalizeType } = deps;

    /** GENERATION_STARTED: (type, { quiet_prompt, … }, dryRun). A quiet generation's instruction is remembered (claimQuiet). */
    function onGenerationStarted(type, params, dryRun) {
        if (dryRun === true || normalizeType(type) !== 'quiet') return;
        const mark = quietMark(params?.quiet_prompt);
        // (A group's generation starts again for its member: the same instruction is remembered once.)
        if (!mark || s.quiets.some(entry => !entry.claimed && entry.mark === mark)) return;
        s.quiets.push({ mark, claimed: 0 });
        if (s.quiets.length > QUIET_KEEP) s.quiets = s.quiets.slice(-QUIET_KEEP);
    }
    // A quiet generation's interceptor: the oldest started one whose interceptor has not run is this one. True when there was one.
    function claimQuiet() {
        const now = Date.now();
        s.quiets = s.quiets.filter(entry => !entry.claimed || now - entry.claimed < QUIET_WAIT_MS);
        const entry = s.quiets.find(item => !item.claimed);
        if (!entry) return false;
        entry.claimed = now;
        return true;
    }
    // A quiet generation's own prompt (it holds the instruction of one whose interceptor ran): forgotten once found, and true.
    function quietPrompt(holds) {
        const now = Date.now();
        const at = s.quiets.findIndex(entry => entry.claimed && now - entry.claimed < QUIET_WAIT_MS && holds(entry.mark));
        if (at < 0) return false;
        s.quiets.splice(at, 1);
        return true;
    }
    // Story Block's text as it is in the slots (and the pending reply's), each as a pattern: what a quiet prompt loses.
    const ownPatterns = () => [...new Set([s.slots.staticText, s.slots.tailText, s.session?.staticText, s.session?.tailText].filter(Boolean))].map(textPattern).filter(Boolean);

    /** CHAT_COMPLETION_PROMPT_READY: { chat, dryRun }. */
    function onPromptReady(eventData) {
        if (!eventData || eventData.dryRun === true || !Array.isArray(eventData.chat) || isOwn(eventData)) return;
        stripHistory(eventData.chat);
        if (quietPrompt(holdsIn(eventData.chat))) {
            const patterns = ownPatterns();
            for (let i = eventData.chat.length - 1; i >= 0; i -= 1) {
                const message = eventData.chat[i];
                const content = mapContent(message?.content, text => patterns.reduce((out, pattern) => out.replace(pattern, ''), text));
                if (content === message?.content || contentText(content) === contentText(message.content)) continue;
                if (contentText(content).trim()) message.content = content;
                else eventData.chat.splice(i, 1);
            }
            return;
        }
        if (foreignPrompt(holdsIn(eventData.chat))) return;
        if (backgroundPrompt() || !s.session || s.session.prompted) return;
        s.session.prompted = true;
        s.session.restored = restoreMissing(eventData.chat, s.session.staticText, s.session.tailText);
    }

    /** GENERATE_AFTER_COMBINE_PROMPTS (text completion): { prompt, dryRun }. */
    function onTextPromptReady(eventData) {
        if (!eventData || eventData.dryRun === true || typeof eventData.prompt !== 'string' || isOwn(eventData)) return;
        // Only the hidden form: the static text's own example block must stay.
        const hidden = new RegExp(`\\s*<!--\\s*STORY_SUITE_V2\\b[\\s\\S]*?-->`, 'g');
        eventData.prompt = eventData.prompt.replace(hidden, '');
        if (HAS_LEGACY.test(eventData.prompt)) eventData.prompt = eventData.prompt.replace(LEGACY_IN_PROMPT, '');
        if (battleOn()) eventData.prompt = stripBattleMarker(eventData.prompt);
        if (quietPrompt(mark => eventData.prompt.includes(mark))) {
            for (const pattern of ownPatterns()) eventData.prompt = eventData.prompt.replace(pattern, '');
            return;
        }
        if (foreignPrompt(mark => eventData.prompt.includes(mark))) return;
        if (backgroundPrompt() || !s.session || s.session.prompted) return;
        s.session.prompted = true;
        const missing = [s.session.staticText, s.session.tailText].filter(text => text && !eventData.prompt.includes(firstLine(text)));
        if (missing.length) {
            s.session.restored = missing.length === 2 ? 'both' : missing[0] === s.session.staticText ? 'static' : 'tail';
            if (missing.includes(s.session.staticText)) eventData.prompt = `${s.session.staticText}\n${eventData.prompt}`;
            if (missing.includes(s.session.tailText)) eventData.prompt = `${eventData.prompt}\n${s.session.tailText}`;
        }
    }

    return { onGenerationStarted, claimQuiet, onPromptReady, onTextPromptReady };
}
