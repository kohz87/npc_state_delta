// The matrix report (docs/v2/MATRIX.md): a table of rows by cases, the notes under it and a summary line.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CASES } from './rows.js';
import { MATRIX_VERSION } from './version.js';

const MARK = { pass: 'ok', fail: 'FAIL', gap: 'gap', todo: 'todo', na: 'n/a', skip: 'skip' };

/** Rows by cases as a Markdown table (`results` from runMatrix). */
export function formatTable(results) {
    const rows = [...new Set(results.map(result => result.row))];
    const ids = CASES.map(([id]) => id).filter(id => results.some(result => result.id === id));
    const head = ['Combination', ...ids.map(id => CASES.find(([key]) => key === id)[1])];
    const lines = [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (i ? ':-:' : '---')).join(' | ')} |`];
    for (const row of rows) {
        const cells = ids.map(id => {
            const result = results.find(entry => entry.row === row && entry.id === id);
            return result ? MARK[result.status] : '-';
        });
        lines.push(`| ${row} | ${cells.join(' | ')} |`);
    }
    return lines.join('\n');
}

/**
 * Everything that is not "ok", one line each: status, row, the cases and why; cases of a row with the same
 * status and reason share a line. "n/a" (the case does not apply to the row) is left out unless `verbose`;
 * `verbose` also shows what a known gap hides (the failure the step would have had).
 */
export function formatDetails(results, { verbose = false } = {}) {
    const groups = new Map();
    for (const result of results) {
        if (result.status === 'pass' || (result.status === 'na' && !verbose)) continue;
        const key = `${result.status}\n${result.row}\n${result.detail}${verbose && result.raw ? ` [would fail: ${result.raw}]` : ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(CASES.find(([id]) => id === result.id)?.[1] ?? result.id);
    }
    return [...groups].map(([key, names]) => {
        const [status, row, detail] = key.split('\n');
        return `${MARK[status].padEnd(4)} ${row} / ${names.join(', ')}: ${detail}`;
    }).join('\n');
}

export function summaryLine({ counts, ok }) {
    const parts = ['pass', 'gap', 'todo', 'na', 'skip', 'fail'].filter(status => counts[status]).map(status => `${counts[status]} ${MARK[status]}`);
    return `${ok ? 'matrix ok' : 'matrix FAILED'}: ${parts.join(', ')}`;
}

/**
 * Which testkit this run used, for the top of a report: the vendored VERSION when this folder was
 * copied into a module (tests/vendor/story-block/), else "checkout" with the Story Block version.
 */
export function describeTestkit() {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const vendored = fileURLToPath(new URL('../../VERSION', import.meta.url));
    try {
        if (existsSync(vendored) && existsSync(fileURLToPath(new URL('../../testkit/host.js', import.meta.url)))) {
            const lines = readFileSync(vendored, 'utf8').trim().split('\n');
            return `${lines.slice(0, 2).join(', ')} (vendored), matrix ${MATRIX_VERSION}`;
        }
        const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
        return `Story Block ${pkg.version} (checkout), matrix ${MATRIX_VERSION}`;
    } catch {
        return `matrix ${MATRIX_VERSION} (${here})`;
    }
}
