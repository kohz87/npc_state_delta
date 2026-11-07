// Story Suite v2: the saver's write gate. `answered` gives up a save after the timeout and `exclusive`
// starts one write only after the previous one has settled, in the same tick as its checks.

export function createIo({ timers, timeout, state }) {
    // `start(signal)`'s promise, failed after `timeout` ms without an answer (and `signal` aborted).
    // `onTimeout()` is told when it is given up that way.
    function answered(start, onTimeout = null) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let job;
        try { job = Promise.resolve(start(controller?.signal)); } catch (error) { return Promise.reject(error); }
        if (!(timeout > 0)) return job;
        return new Promise((resolve, reject) => {
            const timer = timers.setTimeout(() => {
                try { controller?.abort(); } catch { /* nothing to abort */ }
                try { onTimeout?.(); } catch { /* only a note */ }
                reject(new Error(`the server did not answer within ${Math.round(timeout / 1000)} seconds`));
            }, timeout);
            timer?.unref?.();
            job.then(value => {
                timers.clearTimeout(timer);
                resolve(value);
            }, error => {
                timers.clearTimeout(timer);
                reject(error);
            });
        });
    }

    // One write at a time. `fn` runs in the same tick as the last wait ends: nothing can come between
    // what it checks and the write it starts.
    async function exclusive(fn) {
        while (state.running) await state.running.catch(() => {});
        let job;
        try { job = Promise.resolve(fn()); } catch (error) { job = Promise.reject(error); }
        state.running = job;
        try { return await job; } finally { if (state.running === job) state.running = null; }
    }

    return { answered, exclusive };
}
