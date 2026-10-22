// A scripted model for module tests (docs/v2/MODULES.md §G): pass it as createHost({ callModel }) and
// sdk.callModel (and Story Block's assist helpers) answer from it, with the host's real rules around it
// (one call per module, time limit, abort, FEATURE_OFF).
//
//   const model = createFakeModel(['Arc: the flooded vault', new Error('rate limited'), { hang: true }]);
//   const host = await createHost({ callModel: model, modules: [myModule] });
//   const result = await host.sdk.callModel({ feature: 'my-module.arc', prompt: 'Plan an arc.' });
//   model.calls[0] // → { prompt, maxTokens, profile, system }
//
// Each call takes the next answer in the script, else `fallback`:
// * a string: the model's text;
// * an Error: the call fails with it;
// * a function (call) → one of these (or a promise of one): computed from the call;
// * { text, delayMs }: the text after delayMs (a timer, aborted by the call's signal);
// * { hang: true }: no answer until the call is aborted (a time limit or the caller's signal).
// `model.calls` lists every call; `model.pending()` how many have not answered; `model.push(...answers)`
// adds to the script; `model.aborted` counts calls whose signal fired before they answered.

export function createFakeModel(script = [], { fallback = 'none' } = {}) {
    const queue = Array.isArray(script) ? [...script] : [script];
    const calls = [];
    let open = 0;
    const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    async function settle(answer, call, signal) {
        if (typeof answer === 'function') return settle(await answer(call), call, signal);
        if (answer instanceof Error) throw answer;
        if (typeof answer === 'string') return answer;
        if (answer && typeof answer === 'object' && (answer.hang || Number.isFinite(answer.delayMs))) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) { model.aborted += 1; reject(abortError()); return; }
                const timer = answer.hang ? null : setTimeout(() => resolve(String(answer.text ?? '')), answer.delayMs);
                signal?.addEventListener?.('abort', () => {
                    if (timer !== null) clearTimeout(timer);
                    model.aborted += 1;
                    reject(abortError());
                }, { once: true });
            });
        }
        if (answer && typeof answer === 'object' && typeof answer.text === 'string') return answer.text;
        return String(answer ?? '');
    }
    async function model(prompt, { maxTokens, profile = '', system = '', signal = null } = {}) {
        const call = { prompt: String(prompt), maxTokens, profile, system };
        calls.push(call);
        const answer = queue.length ? queue.shift() : fallback;
        open += 1;
        try {
            return await settle(answer, call, signal);
        } finally {
            open -= 1;
        }
    }
    model.calls = calls;
    model.aborted = 0;
    model.pending = () => open;
    model.push = (...answers) => { queue.push(...answers); return model; };
    return model;
}
