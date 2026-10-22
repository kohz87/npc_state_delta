// A fake SillyTavern context for unit tests (docs/v2/SPEC.md §10): no network, no real
// SillyTavern. It keeps a chat array shaped like SillyTavern's (swipes, swipe_info[n].extra,
// extra), records saveChat and setExtensionPrompt, has an event source with SillyTavern's own
// event names, and simulates a generation the way SillyTavern runs one: the interceptor, the
// prompt built from the extension prompts (the in-prompt ones dropped when the preset has no
// Main Prompt), prompt-ready, then the reply added and MESSAGE_RECEIVED.
//
// Where SillyTavern's behaviour matters it is copied, not idealized: a new swipe keeps a copy
// of the message's extra (SillyTavern only drops `memory` and `display_text`), swiping to an
// existing swipe restores that swipe's extra, Regenerate deletes the old reply first.

export const EVENT_TYPES = Object.freeze({
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHAT_RENAMED: 'chat_renamed',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
});
export const EXTENSION_PROMPT_TYPES = Object.freeze({ NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 });
export const EXTENSION_PROMPT_ROLES = Object.freeze({ SYSTEM: 0, USER: 1, ASSISTANT: 2 });
export const MAIN_PROMPT = 'Write the next reply in this story.';

const clone = value => (value === undefined ? undefined : structuredClone(value));

/** SillyTavern's event source: on/off/once/makeFirst; emit awaits each listener in order. */
export function createEventSource() {
    const listeners = new Map();
    const list = event => {
        if (!listeners.has(event)) listeners.set(event, []);
        return listeners.get(event);
    };
    const source = {
        emitted: [],
        on(event, fn) { list(event).push(fn); },
        makeFirst(event, fn) { list(event).unshift(fn); },
        once(event, fn) {
            const wrapped = async (...args) => { source.removeListener(event, wrapped); return fn(...args); };
            list(event).push(wrapped);
        },
        removeListener(event, fn) {
            const fns = list(event);
            const index = fns.indexOf(fn);
            if (index >= 0) fns.splice(index, 1);
        },
        listenerCount: event => list(event).length,
        async emit(event, ...args) {
            source.emitted.push([event, ...args]);
            for (const fn of [...list(event)]) await fn(...args);
        },
    };
    source.off = source.removeListener;
    return source;
}

/** A reply or greeting as SillyTavern keeps it. */
export function aiMessage(text, { name = 'Narrator', extra = {}, isSystem = false } = {}) {
    return {
        name, is_user: false, is_system: isSystem, mes: String(text), send_date: '',
        swipe_id: 0, swipes: [String(text)], swipe_info: [{ send_date: '', extra: clone(extra) }], extra: clone(extra),
    };
}

export function userMessage(text, { name = 'You' } = {}) {
    return { name, is_user: true, is_system: false, mes: String(text), send_date: '', extra: {} };
}

/** How much of two requests is an identical start: { chars, percent } (§5's cache check). */
export function sharedPrefix(a, b) {
    const text = request => (typeof request === 'string' ? request : JSON.stringify(request ?? ''));
    const left = text(a);
    const right = text(b);
    let chars = 0;
    while (chars < left.length && chars < right.length && left[chars] === right[chars]) chars += 1;
    const longest = Math.max(left.length, right.length) || 1;
    return { chars, percent: Math.round((chars / longest) * 1000) / 10 };
}

/**
 * The fake. `options`: { chat?: Message[] (default: one greeting), greeting?, chatId?,
 * mainApi? ('openai' = chat completion, anything else = text completion), mainPrompt? (false:
 * the preset has no Main Prompt), interceptorName?, extensionSettings?, user?, char? }.
 * Returns the fake (see the returned object's comments); `fake.ctx` is what getContext() gives.
 */
export function createFakeContext(options = {}) {
    const {
        greeting = 'The story begins.',
        chatId = 'chat-1',
        mainApi = 'openai',
        mainPrompt = true,
        interceptorName = 'storyBlockGenerationInterceptor',
        extensionSettings = {},
        user = 'You',
        char = 'Narrator',
    } = options;
    const eventSource = createEventSource();
    const prompts = {};
    const fake = {
        /** Every saveChat: a deep copy of the chat as saved. */
        saves: [],
        /** Every setExtensionPrompt call: { key, value, position, depth, scan, role }. */
        promptLog: [],
        /** Every request built: { type, chat | prompt }. */
        requests: [],
        /** Every updateMessageBlock call: message index. */
        rendered: [],
        settingsSaves: 0,
        failSaves: 0,
        /** Set to use this function as the interceptor (else globalThis[interceptorName]). */
        interceptor: null,
        mainPrompt,
        eventSource,
    };
    const ctx = {
        chat: options.chat ? clone(options.chat) : [aiMessage(greeting, { name: char })],
        chatId,
        name1: user,
        name2: char,
        mainApi,
        chatMetadata: {},
        extensionSettings,
        extension_settings: extensionSettings,
        eventSource,
        eventTypes: EVENT_TYPES,
        event_types: EVENT_TYPES,
        extension_prompt_types: EXTENSION_PROMPT_TYPES,
        extension_prompt_roles: EXTENSION_PROMPT_ROLES,
        getCurrentChatId: () => ctx.chatId,
        // SillyTavern's branchChat (bookmarks.js; not on the real getContext()): chat[0..mesId] becomes a
        // new chat that is opened; the old one is kept in `fake.chats` with the branch named on its message.
        async branchChat(mesId) {
            const index = Number(mesId);
            if (!Number.isInteger(index) || index < 0 || index >= ctx.chat.length) return null;
            const name = `${ctx.chatId} - Branch #${Object.keys(fake.chats).length + 1}`;
            const message = ctx.chat[index];
            message.extra = message.extra ?? {};
            (message.extra.branches ??= []).push(name);
            fake.chats[ctx.chatId] = clone(ctx.chat);
            const branch = clone(ctx.chat.slice(0, index + 1));
            await fake.loadChat(branch, name);
            return name;
        },
        substituteParams: text => String(text ?? '').replace(/\{\{user\}\}/gi, ctx.name1).replace(/\{\{char\}\}/gi, ctx.name2)
            .replace(/<USER>/gi, ctx.name1).replace(/<BOT>|<CHAR>/gi, ctx.name2),
        async saveChat() {
            if (fake.failSaves > 0) {
                fake.failSaves -= 1;
                throw new Error('The chat could not be saved (fake failure).');
            }
            fake.saves.push(clone(ctx.chat));
        },
        saveSettingsDebounced() { fake.settingsSaves += 1; },
        setExtensionPrompt(key, value, position, depth, scan = false, role = 0) {
            prompts[key] = { value: String(value ?? ''), position, depth, scan, role };
            fake.promptLog.push({ key, ...prompts[key] });
        },
        updateMessageBlock(index) { fake.rendered.push(Number(index)); },
    };
    fake.ctx = ctx;

    const emit = (event, ...args) => eventSource.emit(event, ...args);
    // SillyTavern runs its macros over extension prompts.
    const promptText = place => Object.keys(prompts).sort()
        .filter(key => prompts[key].value && prompts[key].position === (place === 'in-prompt' ? EXTENSION_PROMPT_TYPES.IN_PROMPT : EXTENSION_PROMPT_TYPES.IN_CHAT))
        .map(key => ctx.substituteParams(prompts[key].value));

    function buildRequest(type) {
        const history = ctx.chat.filter(message => !(type === 'swipe' && message === ctx.chat.at(-1)));
        if (ctx.mainApi === 'openai') {
            const chat = [];
            // In-prompt extension prompts sit next to the Main Prompt; a preset without it drops them.
            if (fake.mainPrompt) chat.push({ role: 'system', content: [MAIN_PROMPT, ...promptText('in-prompt')].join('\n') });
            for (const message of history) chat.push({ role: message.is_user ? 'user' : message.is_system ? 'system' : 'assistant', content: message.mes });
            const tail = promptText('in-chat');
            if (tail.length) {
                const at = type === 'continue' ? chat.length - 1 : chat.length;
                chat.splice(at, 0, { role: 'system', content: tail.join('\n') });
            }
            return { chat, dryRun: false };
        }
        const lines = [MAIN_PROMPT, ...promptText('in-prompt')];
        for (const message of history) lines.push(`${message.name}: ${message.mes}`);
        lines.push(...promptText('in-chat'));
        if (type !== 'continue') lines.push(`${ctx.name2}:`);
        return { prompt: lines.join('\n'), dryRun: false };
    }

    Object.assign(fake, {
        /** The current text of an extension prompt key ('' when unset). */
        prompt: key => prompts[key]?.value ?? '',
        prompts: () => clone(prompts),
        /** The last saved copy of the chat, or null. */
        saved: () => clone(fake.saves.at(-1) ?? null),
        addMessage(message) {
            ctx.chat.push(message);
            return ctx.chat.length - 1;
        },
        addUser(text) { return fake.addMessage(userMessage(text, { name: ctx.name1 })); },

        /**
         * One generation as SillyTavern runs it. `type`: normal | swipe | regenerate | continue |
         * quiet | impersonate. `reply`: the model's text (for continue, the text added).
         * Returns { request, reply, index, aborted? } (index: where the reply landed, or -1; aborted:
         * an interceptor stopped it, so no request was built).
         */
        // `stopped`: the reader pressed Stop while it was written (GENERATION_STOPPED comes before the
        // partial reply is received, as SillyTavern's stopGeneration does).
        async generate(type = 'normal', { reply = '', dryRun = false, stopped = false } = {}) {
            const last = ctx.chat.length - 1;
            if (type === 'regenerate' && ctx.chat[last] && !ctx.chat[last].is_user) {
                ctx.chat.pop();
                await emit(EVENT_TYPES.MESSAGE_DELETED, ctx.chat.length);
            }
            if (type === 'swipe') {
                const message = ctx.chat[last];
                if (!message || message.is_user) throw new Error('fake: nothing to swipe');
                // A new swipe slot; the extra is kept (SillyTavern drops only memory/display_text).
                message.swipes.push('');
                message.swipe_info.push({ send_date: '', extra: {} });
                message.swipe_id = message.swipes.length - 1;
                message.mes = '';
                delete message.extra?.memory;
                delete message.extra?.display_text;
                await emit(EVENT_TYPES.MESSAGE_SWIPED, last);
            }
            await emit(EVENT_TYPES.GENERATION_STARTED, type, {}, dryRun);
            const interceptor = fake.interceptor ?? globalThis[interceptorName];
            // An interceptor may stop the generation (SillyTavern's abort argument): nothing is sent.
            // A dry run runs none (SillyTavern 1.19's Generate: `if (!dryRun) runGenerationInterceptors`).
            let aborted = false;
            if (typeof interceptor === 'function' && !dryRun) await interceptor(clone(ctx.chat), 8192, () => { aborted = true; }, type);
            if (aborted) {
                await emit(EVENT_TYPES.GENERATION_STOPPED);
                return { request: null, reply: '', index: -1, aborted: true };
            }
            const request = buildRequest(type);
            request.dryRun = dryRun;
            await emit(ctx.mainApi === 'openai' ? EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY : EVENT_TYPES.GENERATE_AFTER_COMBINE_PROMPTS, request);
            fake.requests.push({ type, ...clone(request) });
            if (dryRun) return { request, reply: '', index: -1 };
            let index = -1;
            if (type === 'normal' || type === 'regenerate') {
                index = fake.addMessage(aiMessage(reply, { name: ctx.name2 }));
            } else if (type === 'swipe' || type === 'continue') {
                index = ctx.chat.length - 1;
                const message = ctx.chat[index];
                // A Continue: SillyTavern's copy of the old text plus the added text, cleaned up as a whole
                // (cleanUpMessage: spaces at line ends dropped, trimmed with trim_spaces, on by default).
                message.mes = type === 'continue' ? `${message.mes}${reply}`.replace(/[^\S\r\n]+$/gm, '').trim() : String(reply);
                message.swipes[message.swipe_id] = message.mes;
                message.swipe_info[message.swipe_id] = { ...message.swipe_info[message.swipe_id], extra: clone(message.extra ?? {}) };
            }
            if (stopped) await emit(EVENT_TYPES.GENERATION_STOPPED);
            if (index >= 0) await emit(EVENT_TYPES.MESSAGE_RECEIVED, index, type);
            if (type !== 'quiet' && !stopped) await emit(EVENT_TYPES.GENERATION_ENDED, ctx.chat.length);
            return { request, reply, index };
        },
        /** The user sends `text`; the model answers `reply`. */
        async send(text, { reply = '', stopped = false } = {}) {
            fake.addUser(text);
            await emit(EVENT_TYPES.MESSAGE_SENT, ctx.chat.length - 1);
            return fake.generate('normal', { reply, stopped });
        },
        /** The reader swipes message `index` to its existing swipe `swipeId`. */
        async swipeTo(index, swipeId) {
            const message = ctx.chat[index];
            message.swipe_id = swipeId;
            message.mes = message.swipes[swipeId];
            message.extra = clone(message.swipe_info?.[swipeId]?.extra ?? {});
            await emit(EVENT_TYPES.MESSAGE_SWIPED, index);
        },
        async deleteMessage(index) {
            ctx.chat.splice(index, 1);
            await emit(EVENT_TYPES.MESSAGE_DELETED, ctx.chat.length);
        },
        async editMessage(index, text) {
            const message = ctx.chat[index];
            message.mes = String(text);
            if (Array.isArray(message.swipes)) message.swipes[message.swipe_id ?? 0] = message.mes;
            await emit(EVENT_TYPES.MESSAGE_EDITED, index);
        },
        /** Chats left behind by a branch: { [chatId]: messages as they were }. */
        chats: {},
        /** Opens another chat (or reopens this one from what was saved). */
        async loadChat(chat, id = ctx.chatId) {
            ctx.chat = clone(chat);
            ctx.chatId = id;
            await emit(EVENT_TYPES.CHAT_CHANGED, id);
        },
    });
    return fake;
}
