// NPC State Delta, old checkpoint clean-up: a dry-run plan and the explicit sweep that follows it. A checkpoint file is removable only when
// the caller proves that every chat, lineage index and save point was read (`complete: true`), the file is not in that referenced set, and it
// is strictly older than the grace period (30 days by default). An incomplete scan, missing references, invalid metadata or an unreadable
// vault means no deletion. Sweeping consumes one complete plan; it never plans while deleting.
//
// The vault seam for the settings step:
//   list()       -> [{ id, size, modifiedAt }] or { files: [...] }, where `id` is a checkpoint id and `modifiedAt` is milliseconds
//   remove(id)   -> deletes that checkpoint file; false means it refused or the file was already gone
// Tests use a memory stand-in; no storage is touched by this module.

import { CHECKPOINT_ID } from './checkpoint.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_KEEP_NEWER_THAN_MS = 30 * DAY_MS;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function timestampOf(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : NaN;
    }
    return NaN;
}

function sizeOf(value) {
    const size = Number(value);
    return Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
}

function collectReferences(value, out, seen) {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') {
        const id = value.trim();
        if (id) out.add(id);
        return true;
    }
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return true;
    seen.add(value);
    if (value instanceof Map) {
        for (const [key, entry] of value) {
            if (typeof key === 'string' && CHECKPOINT_ID.test(key.trim())) out.add(key.trim());
            collectReferences(entry, out, seen);
        }
        return true;
    }
    if (value instanceof Set || Array.isArray(value)) {
        for (const entry of value) collectReferences(entry, out, seen);
        return true;
    }
    if (isRecord(value)) {
        for (const [key, entry] of Object.entries(value)) {
            if (CHECKPOINT_ID.test(key.trim())) out.add(key.trim());
            collectReferences(entry, out, seen);
        }
        return true;
    }
    return false;
}

/** A Set of ids from a flat list, a lineage index, or nested chat/index/save-point categories; null when the reference shape is unusable. */
function referencedIds(value) {
    if (value === undefined || value === null) return null;
    const ids = new Set();
    return collectReferences(value, ids, new WeakSet()) ? ids : null;
}

function checkpointFiles(raw) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.files) ? raw.files : null;
    if (!list) return null;
    const files = new Map();
    for (const entry of list) {
        if (!isRecord(entry)) continue;
        const id = String(entry.id ?? entry.checkpoint ?? '').trim();
        if (!CHECKPOINT_ID.test(id)) continue;
        const size = sizeOf(entry.size ?? entry.bytes);
        const modifiedAt = timestampOf(entry.modifiedAt ?? entry.mtimeMs ?? entry.mtime ?? entry.updatedAt);
        const prior = files.get(id);
        if (!prior) {
            files.set(id, { id, bytes: size, modifiedAt });
            continue;
        }
        // Duplicate listings cannot make a file look older than any listing proves.
        const known = Number.isFinite(prior.modifiedAt) && Number.isFinite(modifiedAt);
        files.set(id, { id, bytes: Math.max(prior.bytes, size), modifiedAt: known ? Math.max(prior.modifiedAt, modifiedAt) : NaN });
    }
    return files;
}

function totalsOf(files, exact = true) {
    let bytes = 0;
    for (const file of files.values()) bytes += file.bytes;
    return { totalFiles: files.size, totalBytes: bytes, exact };
}

function report({ ok, complete, canSweep, code = 'OK', message = '', totalFiles = 0, totalBytes = 0, exact = true, candidates = [], keepNewerThanMs = DEFAULT_KEEP_NEWER_THAN_MS }) {
    const bytes = candidates.reduce((sum, file) => sum + file.bytes, 0);
    return { ok, complete, canSweep, code, message, totalFiles, totalBytes, exact, candidates, count: candidates.length, bytes, keepNewerThanMs };
}

function refusal(code, message, totals = {}, keepNewerThanMs = DEFAULT_KEEP_NEWER_THAN_MS) {
    return report({ ok: false, complete: false, canSweep: false, code, message, ...totals, keepNewerThanMs });
}

export function createVaultSweep({ vault, now = () => Date.now(), keepNewerThanMs = DEFAULT_KEEP_NEWER_THAN_MS } = {}) {
    if (!vault || typeof vault.list !== 'function' || typeof vault.remove !== 'function') {
        throw new TypeError('vault-sweep needs a vault with list() and remove(id).');
    }
    let generation = 0;
    let planned = null;

    function remember(token, next, details = {}) {
        if (token === generation) planned = { ...next, ...details };
        return next;
    }

    return {
        /** A dry run. It reports the complete storage totals and the candidates it would remove, but calls neither remove nor delete. */
        async plan({ referenced, complete = false, keepNewerThanMs: requestedGrace = keepNewerThanMs } = {}) {
            const token = generation + 1;
            generation = token;
            planned = null;

            let raw;
            try {
                raw = await vault.list();
            } catch (error) {
                return remember(token, refusal('VAULT_UNREADABLE', String(error?.message || error || 'The checkpoint vault could not be read.')));
            }
            const files = checkpointFiles(raw);
            if (!files) return remember(token, refusal('VAULT_UNREADABLE', 'The checkpoint vault did not return a file list.'));
            // A list that says `complete: false` cannot prove it saw every file: the totals are "at least", and only the files it names (by name, age
            // and references) can ever be candidates.
            const totals = totalsOf(files, raw?.complete !== false);
            if (token !== generation) return refusal('SUPERSEDED', 'A newer clean-up check replaced this one.', totals, requestedGrace);

            if (typeof requestedGrace !== 'number' || !Number.isFinite(requestedGrace) || requestedGrace < 0) {
                return remember(token, refusal('INVALID_GRACE', 'The grace period must be a non-negative number of milliseconds.', totals, DEFAULT_KEEP_NEWER_THAN_MS));
            }
            if (complete !== true) {
                return remember(token, refusal('INCOMPLETE', 'Clean-up is off because not every chat, lineage index and save point could be read.', totals, requestedGrace));
            }
            const references = referencedIds(referenced);
            if (!references) {
                return remember(token, refusal('REFERENCES_REQUIRED', 'Clean-up needs the set of checkpoint ids still used by chats and branches.', totals, requestedGrace));
            }
            const nowMs = timestampOf(now());
            if (!Number.isFinite(nowMs)) {
                return remember(token, refusal('INVALID_CLOCK', 'The current time could not be read.', totals, requestedGrace));
            }

            const candidates = [...files.values()]
                .filter(file => Number.isFinite(file.modifiedAt)
                    && nowMs - file.modifiedAt > requestedGrace
                    && !references.has(file.id))
                .sort((a, b) => a.modifiedAt - b.modifiedAt || a.id.localeCompare(b.id))
                .map(file => ({ id: file.id, bytes: file.bytes, modifiedAt: file.modifiedAt }));
            const next = report({
                ok: true, complete: true, canSweep: true, ...totals,
                candidates: candidates.map(file => ({ ...file })), keepNewerThanMs: requestedGrace,
            });
            return remember(token, next, {
                candidates: candidates.map(file => Object.freeze(file)),
                referenced: new Set(references),
            });
        },

        /** Executes the last complete plan exactly once. An incomplete, superseded or already-consumed plan deletes nothing. */
        async sweep() {
            const plan = planned;
            planned = null;
            if (!plan || plan.complete !== true || plan.canSweep !== true) {
                return refusal(plan?.code || 'NO_COMPLETE_PLAN', plan?.message || 'Run a complete clean-up check before removing old dossier files.', {
                    totalFiles: plan?.totalFiles || 0,
                    totalBytes: plan?.totalBytes || 0,
                }, plan?.keepNewerThanMs ?? keepNewerThanMs);
            }

            const deleted = [];
            const skipped = [];
            const failed = [];
            for (const file of plan.candidates) {
                if (plan.referenced.has(file.id)) {
                    skipped.push(file.id);
                    continue;
                }
                try {
                    const outcome = await vault.remove(file.id, { referenced: plan.referenced });
                    if (outcome === false) skipped.push(file.id);
                    else deleted.push(file);
                } catch (error) {
                    failed.push({ id: file.id, message: String(error?.message || error || 'The file could not be removed.') });
                }
            }
            const removedBytes = deleted.reduce((sum, file) => sum + file.bytes, 0);
            return {
                ok: failed.length === 0,
                complete: true,
                canSweep: false,
                code: failed.length ? 'PARTIAL_REMOVAL' : 'OK',
                message: failed.length ? 'Some old dossier files could not be removed.' : '',
                totalFiles: plan.totalFiles,
                totalBytes: plan.totalBytes,
                deleted: deleted.map(file => file.id),
                skipped,
                failed,
                count: deleted.length,
                bytes: removedBytes,
                keepNewerThanMs: plan.keepNewerThanMs,
            };
        },
    };
}
