// The only part of assist that touches SillyTavern. Everything is read when called, never at import,
// so the rest of the part (and its tests) loads without SillyTavern.
//
// What it uses of `SillyTavern.getContext()`:
// * `generateRaw` for a model call on the current connection: the object form
//   `generateRaw({ prompt, responseLength })` (SillyTavern 1.13+), or the older positional form
//   `generateRaw(prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength)`.
//   generateRaw sends the prompt as it is, with no chat, card or extension prompts, and does not run
//   the generation interceptors, so Story Block's own notes never reach it.
// * `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens)` and
//   `extensionSettings.connectionManager.profiles` when a connection profile is named in the settings.
// * `chat` and `getCurrentChatId()` (which message the reader sent, in which chat).

const context = () => globalThis.SillyTavern?.getContext?.() ?? null;

/** SillyTavern's chat array (empty without SillyTavern). */
export function stChat() {
    const chat = context()?.chat;
    return Array.isArray(chat) ? chat : [];
}

/** The open chat's id ('' when there is none). */
export function stChatId() {
    const ctx = context();
    try {
        return String(ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? '');
    } catch {
        return '';
    }
}

/** The connection profile called `name` (case and outer spaces ignored), or null. */
export function findProfile(ctx, name) {
    const list = ctx?.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(list)) return null;
    const key = String(name ?? '').trim().toLowerCase();
    return list.find(profile => String(profile?.name ?? '').trim().toLowerCase() === key) ?? null;
}

// What a request service or generateRaw answers: a string, { content }, or a chat completion body.
export function answerText(out) {
    if (typeof out === 'string') return out;
    if (typeof out?.content === 'string') return out.content;
    if (typeof out?.text === 'string') return out.text;
    const choice = out?.choices?.[0];
    if (typeof choice?.message?.content === 'string') return choice.message.content;
    if (typeof choice?.text === 'string') return choice.text;
    return '';
}

/**
 * One model call: `prompt` → the model's text. `options`: { maxTokens = 200, profile = '' }. With a
 * profile name the call goes through that Connection Manager profile; a missing profile is an error
 * (the reader picked a cheaper model on purpose, so the current one is not used in its place).
 * Throws with a plain sentence when the call cannot be made.
 */
export async function stCallModel(prompt, { maxTokens = 200, profile = '' } = {}) {
    const ctx = context();
    if (!ctx) throw new Error('SillyTavern is not available.');
    const name = String(profile ?? '').trim();
    if (name) {
        const service = ctx.ConnectionManagerRequestService;
        if (typeof service?.sendRequest !== 'function') throw new Error(`This SillyTavern has no Connection Manager, so the profile "${name}" cannot be used.`);
        const found = findProfile(ctx, name);
        if (!found?.id) throw new Error(`There is no connection profile called "${name}".`);
        return answerText(await service.sendRequest(found.id, [{ role: 'user', content: String(prompt) }], maxTokens));
    }
    const raw = ctx.generateRaw;
    if (typeof raw !== 'function') throw new Error('This SillyTavern cannot make a separate model call (no generateRaw).');
    const out = raw.length >= 2
        ? await raw.call(ctx, String(prompt), '', false, false, '', maxTokens)
        : await raw.call(ctx, { prompt: String(prompt), responseLength: maxTokens });
    return answerText(out);
}
