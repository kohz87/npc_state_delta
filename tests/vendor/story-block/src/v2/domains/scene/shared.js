// Helpers the scene's parts share: the "told" rule (a line the story wrote is not narrated again), the reader of one name or a
// list of names, the edit mark a reader's change carries, and the test for a line with a letter or a digit in it. Pure.

export const told = ctx => ctx.cause !== 'story';
export const nameList = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
export const HAS_WORD = /[\p{L}\p{N}]/u;

export function markEdit(ctx, result) {
    if (ctx.cause === 'ui') result.data = { ...result.data, edit: true };
    return result;
}
