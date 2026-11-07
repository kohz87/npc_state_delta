// Story Suite v2: the small values and error helpers every part of the command bus shares (limits, the error
// `ctx.fail` throws, `isRecord`, and the reply and ID helpers). commands.js keeps the public names and re-exports
// them, so importers still take MAX_DEPTH, CommandError, headReply and newId from commands.js.

export const MAX_DEPTH = 8;
export const CAUSES = ['ui', 'story', 'system'];
export const CODE = /^[A-Z][A-Z0-9_]*$/;
export const MAX_PREVIEWS = 16;
export const ID_PREFIX = /^[a-z][a-z0-9]*$/;
export const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
// Mixed into the receipt's seed for ctx.id's own stream (any odd constant; fixed, so IDs replay).
export const ID_STREAM = 0x5bd1e995;

/** The error `ctx.fail` throws; the bus turns it into { ok: false, code, message }. */
export class CommandError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'CommandError';
        this.code = code;
    }
}

export function fail(code, message) {
    throw new CommandError(code, message);
}

export function asCommandError(type, error) {
    if (error instanceof CommandError) return error;
    return new CommandError('FAILED', `Something went wrong in ${type}: ${error?.message ?? String(error)}`);
}

export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// `{ index, sid }` frozen, or null without a usable sid.
export function replyOf(index, sid) {
    return Number.isInteger(index) && index >= 0 && typeof sid === 'string' && sid ? Object.freeze({ index, sid }) : null;
}

/**
 * The reply a command outside a capture is stored on (`ctx.reply`): the head carrier, store.append's,
 * with the record ID its record has or will get (store.carrierSid). null for a store that cannot say.
 */
export function headReply(store) {
    try {
        const index = typeof store?.headIndex === 'function' ? store.headIndex() : -1;
        return typeof store?.carrierSid === 'function' && Number.isInteger(index) && index >= 0 ? replyOf(index, store.carrierSid(index)) : null;
    } catch {
        return null;
    }
}

/** The reply at carrier `index` (`ctx.reply` for a read as of that reply), or null when the store cannot say. */
export function replyAt(store, index) {
    try { return typeof store?.carrierSid === 'function' ? replyOf(index, store.carrierSid(index)) : null; } catch { return null; }
}

/** `<prefix>_<8 base36>` from crypto (SPEC §2.1), for receipt IDs when no `id` option is given. */
export function newId(prefix, cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.getRandomValues !== 'function') throw new Error('This browser has no crypto random source for IDs.');
    const chars = [];
    const bytes = new Uint8Array(16);
    while (chars.length < 8) {
        cryptoApi.getRandomValues(bytes);
        // 252 = 7 × 36: bytes at or above it are thrown away so every character is equally likely.
        for (const byte of bytes) if (byte < 252 && chars.length < 8) chars.push((byte % 36).toString(36));
    }
    return `${prefix}_${chars.join('')}`;
}
