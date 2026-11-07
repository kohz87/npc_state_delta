// The matrix runner (docs/v2/MATRIX.md): for each combination row it boots the real module definitions
// in createHost, registers them once, plays a scripted reply, runs each module's action and replays
// the chat cold, then the additional cases: missing query, malformed
// answer, feature off, unset clock, late registration, duplicate name, swipe, re-read and delete.
//
// What is compared is never a hand-written number: a module's facts after a swipe, a delete or a
// re-read must equal the facts of a fresh host that only played the replies that are left. A cold
// rebuild from the chat's records must equal the live state. A hostile peer (a stand-in that answers
// the real peer's query names badly) is the one stub here, and it stands in for a *peer*, never for the
// module under test.
//
// A result is { row, id, status, detail }, status: pass | fail | gap | na | skip.
//   gap:  a known gap, not a failure (RB does not yet go dormant without SD); `strict` fails it. A gap
//         closes by itself: once the host reports `status` in sdk.modules(), the same check is strict.
//   na:   the case does not apply to the row.
//   todo: the case applies, but today's host cannot express it yet (a row of its own once it can).
//   skip: a module the row needs is not checked out.

import { CASES, NOT_EXPRESSIBLE, ROWS } from './rows.js';
import { label, oneLine } from './run/host.js';
import { heldBack } from './run/checks.js';
import { basics } from './run/basics.js';
import { missingQuery, malformed, featureOff, unsetClock, disabledSd, lateRegistration, duplicateName } from './run/cases.js';
import { swipe, reread, deleteMessage } from './run/revisions.js';

// ---- the recorder ------------------------------------------------------------------------------------

function recorder(results, row, strict, lenient = null) {
    const add = (id, status, detail = '', raw = '') => results.push({ row: row.name, id, status, detail, ...(raw ? { raw } : {}) });
    return {
        add,
        async step(id, fn) {
            try {
                const out = await fn();
                if (out?.gap) add(id, strict ? 'fail' : 'gap', `${strict ? 'strict: ' : ''}${out.gap}`);
                else if (out?.na) add(id, 'na', out.na);
                else if (out?.todo) add(id, 'todo', out.todo);
                else add(id, 'pass', out?.note ?? '');
            } catch (error) {
                const why = oneLine(error?.message ?? error);
                // A negative row while the module that should be dormant still blocks generation: the others
                // cannot work, which is the known gap, not a second failure.
                if (lenient) add(id, strict ? 'fail' : 'gap', `${strict ? 'strict: ' : ''}${lenient}`, why);
                else add(id, 'fail', why);
            }
        },
    };
}

// ---- the whole run -----------------------------------------------------------------------------------

/**
 * Runs the rows. `options`: { loaded, missing?, broken? } (loadModules), `rows?` (names), `only?` (module key:
 * just the rows that include it), `cases?` (ids), `strict?` (a known gap fails), `onResult?`.
 * → { results, ok, counts }
 */
export async function runMatrix({ loaded = {}, missing = {}, broken = {}, rows = null, only = null, cases = null, strict = false, onResult = null } = {}) {
    const env = { loaded };
    const results = [];
    const selected = ROWS.filter(row => (!rows || rows.includes(row.name)) && (!only || row.modules.includes(only) || (only === 'sb')));
    for (const row of selected) {
        const blocked = row.modules.filter(key => !loaded[key]);
        if (blocked.length) {
            const rec = recorder(results, row, strict);
            for (const [id] of CASES) {
                const why = blocked.map(key => (broken[key] ? `${label(key)} does not load: ${oneLine(broken[key].message)}` : `${label(key)}: ${missing[key] ?? 'not checked out'}`)).join('; ');
                rec.add(id, blocked.some(key => broken[key]) ? 'fail' : 'skip', why);
            }
            continue;
        }
        const rec = recorder(results, row, strict, row.dormant.length ? await heldBack(env, row) : null);
        const wanted = id => !cases || cases.includes(id);
        const quiet = { add: (...args) => { if (wanted(args[0])) rec.add(...args); }, step: (id, fn) => (wanted(id) ? rec.step(id, fn) : undefined) };
        await basics(env, row, quiet);
        for (const run of [missingQuery, malformed, featureOff, unsetClock, disabledSd, lateRegistration, duplicateName, swipe, reread, deleteMessage]) await run(env, row, quiet);
    }
    if (onResult) for (const result of results) onResult(result);
    const counts = {};
    for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1;
    return { results, counts, ok: !results.some(result => result.status === 'fail'), notExpressible: NOT_EXPRESSIBLE };
}
