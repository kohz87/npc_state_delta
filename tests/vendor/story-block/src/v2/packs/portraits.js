// Pack portraits: the image files beside a pack.json that its cast entries name (`portrait`), kept outside settings.
//
// Where they live: SillyTavern's user files (`/api/files/upload`, shown at `/user/files/<name>`), one file per portrait named
// `storysuite-portrait-<pack>-<hash>.<webp|png|jpg>` (the hash is of the picture's bytes, so a changed picture is a new file and
// no browser shows the old one). The pack itself is in the server's settings, so its portraits sit on the server too and follow
// it to every device; a browser-only store (IndexedDB) would leave the phone without them. Only a small index stays in settings
// (`storySuite.portraits[pack][file] = { stored, bytes }`): which stored file is which name of which pack.
//
// Limits (limits.js PORTRAIT_LIMITS): webp, png or jpeg, at most 150 KB each once stored, at most 32 per pack. A file is taken only
// when a cast entry names it and really is one of the three types (read from its first bytes, not its name); the others are refused
// one by one with a reason, and the pack is imported all the same. A picture of up to 10 MB may be picked: one over 150 KB is made
// smaller in the browser first (portrait-fit.js: long side at most 1200 px, WebP, quality stepped down until it fits) and a file that
// cannot be read, or will not fit at the lowest step, is refused. A picture already at most 150 KB is stored as it is, byte for byte
// (WebP, PNG or JPEG), never re-encoded.
//
// `files` (injected; st-adapter.js stPortraitFiles): `{ put(name, bytes), remove(name), exists(names) → { name: bool }, url(name) }`.
// Without it nothing can be stored and every picked image is refused with that reason.
// `imageIo` (injected; portrait-fit.js browserImageIo, a fake one in the Node tests): `bytes → { size(), encode(side, quality), close?() }`.
// Without it a picture over 150 KB is refused as before (there is no decoder to make it smaller).

import { PORTRAIT_LIMITS } from './limits.js';
import { FitProblem, MAX_PIXELS, fitPortrait, imageSize } from './portrait-fit.js';

export const PORTRAIT_TYPES = Object.freeze({ webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg' });
const PREFIX = 'storysuite-portrait-';
const SAFE_NAME = /^storysuite-portrait-([a-z0-9]+(?:-[a-z0-9]+)*)-[0-9a-f]{8}\.(?:webp|png|jpg)$/;
const kb = bytes => Math.max(1, Math.round(bytes / 1024));
const mb = bytes => `${(Math.round((bytes / 1048576) * 10) / 10).toString()} MB`;

/** 'webp' | 'png' | 'jpg' from a picture's first bytes, or null: the file's name does not decide. */
export function sniffImage(bytes) {
    if (!bytes || bytes.length < 12) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    const word = (at, text) => [...text].every((char, n) => bytes[at + n] === char.charCodeAt(0));
    if (word(0, 'RIFF') && word(8, 'WEBP')) return 'webp';
    return null;
}

/** FNV-1a of the bytes as 8 hex digits. */
function hashOf(bytes) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i += 1) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * `settings`: `{ read() → the storySuite settings object, save() }`. `files`: see above, or null. `imageIo`: see above, or null.
 * Returns `{ url, list, apply, forget, verify }`.
 */
export function createPortraits({ settings, files = null, imageIo = null } = {}) {
    if (!settings || typeof settings.read !== 'function') throw new Error('createPortraits needs settings.read().');
    // Stored files a check found gone (in memory only): their portraits answer null until the pack is imported with them again.
    const gone = new Set();

    const root = () => {
        const value = settings.read();
        if (!isObject(value.portraits)) value.portraits = {};
        return value.portraits;
    };
    const of = (packId, create = false) => {
        const all = root();
        if (!isObject(all[packId])) {
            if (!create) return {};
            all[packId] = {};
        }
        return all[packId];
    };
    const save = () => settings.save?.();
    // A stored name that is ours for this pack and nothing else (the index lives in a file a reader can edit by hand).
    const mine = (packId, stored) => typeof stored === 'string' && SAFE_NAME.exec(stored)?.[1] === packId;
    const used = (packId, stored, except = null) => Object.entries(of(packId)).some(([file, entry]) => file !== except && entry?.stored === stored);
    async function release(packId, stored, except) {
        if (!mine(packId, stored) || used(packId, stored, except)) return;
        gone.delete(stored);
        try { await files?.remove(stored); } catch { /* a file that is already gone is what was wanted */ }
    }

    // The most a picked file may be: the source limit where it can be made smaller, else the stored limit.
    const pickLimit = () => (typeof imageIo === 'function' ? PORTRAIT_LIMITS.source : PORTRAIT_LIMITS.bytes);
    const tooBig = (file, size) => (typeof imageIo === 'function'
        ? `${file} is ${mb(size)}; a portrait may be picked at up to ${mb(PORTRAIT_LIMITS.source)} (it is made smaller to fit ${kb(PORTRAIT_LIMITS.bytes)} KB).`
        : `${file} is ${kb(size)} KB; a portrait may be at most ${kb(PORTRAIT_LIMITS.bytes)} KB (compress it and pick it again).`);
    // A picture over the stored limit, made smaller: → { bytes, type } or a refusal text (the file's name first).
    async function smaller(file, bytes, type) {
        const header = imageSize(bytes, type);
        if (header && header.width * header.height > MAX_PIXELS) return { refusal: `${file} has ${header.width} × ${header.height} pixels, which is too many to make smaller here (at most ${Math.round(MAX_PIXELS / 1e6)} million).` };
        let io;
        try {
            io = imageIo(bytes);
            const out = await fitPortrait(io);
            return { bytes: out.bytes, type: out.type };
        } catch (error) {
            return { refusal: error instanceof FitProblem ? `${file} ${error.message}.` : `${file} could not be made smaller (${error?.message ?? error}).` };
        } finally {
            try { io?.close?.(); } catch { /* the decoded picture is freed anyway */ }
        }
    }

    return {
        /** The safe image URL of a pack's portrait file, or null (not stored, not this pack's, or found missing). */
        url(packId, file) {
            if (!files || typeof packId !== 'string' || typeof file !== 'string') return null;
            const entry = of(packId)[file];
            if (!isObject(entry) || !mine(packId, entry.stored) || gone.has(entry.stored)) return null;
            const url = files.url(entry.stored);
            return typeof url === 'string' && url ? url : null;
        },

        /** The portrait files stored for a pack, as `[{ file, bytes }]` in name order. */
        list(packId) {
            return Object.entries(of(packId)).filter(([, entry]) => isObject(entry) && mine(packId, entry.stored)).map(([file, entry]) => ({ file, bytes: Number(entry.bytes) || 0 })).sort((a, b) => (a.file < b.file ? -1 : 1));
        },

        /**
         * Brings a pack's portraits in line with its (just validated) cast and the images picked with it: stores the picked images its
         * entries name, refuses the others one by one, drops stored portraits the pack no longer names. A picture picked again
         * replaces the stored one; a stored one not picked this time stays while the pack still names it.
         * `picked`: `[{ name, size, read() → Uint8Array }]`. → `{ stored: [file], refused: [{ file, message }], missing: [file], dropped: n }`
         * (`missing`: files the cast names that have no picture yet).
         */
        async apply(pack, picked = []) {
            const named = new Set((pack.content?.cast ?? []).map(person => person.portrait).filter(Boolean));
            const report = { stored: [], refused: [], missing: [], dropped: 0 };
            const seen = new Set();
            for (const item of Array.isArray(picked) ? picked : []) {
                const file = String(item?.name ?? '');
                const refuse = message => report.refused.push({ file, message });
                if (seen.has(file)) { refuse(`${file} was picked twice; the first one was used.`); continue; }
                seen.add(file);
                if (!named.has(file)) { refuse(`${file} is not named by any person in this pack (no cast entry has "portrait": "${file}"), so it was left out.`); continue; }
                const size = Number(item.size);
                if (Number.isFinite(size) && size > pickLimit()) { refuse(tooBig(file, size)); continue; }
                let bytes;
                try { bytes = await item.read(); } catch { refuse(`${file} could not be read.`); continue; }
                if (!(bytes instanceof Uint8Array) || !bytes.length) { refuse(`${file} is empty.`); continue; }
                if (bytes.length > pickLimit()) { refuse(tooBig(file, bytes.length)); continue; }
                let type = sniffImage(bytes);
                if (!type) { refuse(`${file} is not a WebP, PNG or JPEG image.`); continue; }
                if (!files) { refuse(`${file} could not be saved: SillyTavern's file storage is not available here.`); continue; }
                // Over the stored limit: made smaller first (a picture at most that big is kept exactly as it came).
                if (bytes.length > PORTRAIT_LIMITS.bytes) {
                    const fit = await smaller(file, bytes, type);
                    if (fit.refusal) { refuse(fit.refusal); continue; }
                    ({ bytes, type } = fit);
                }
                const stored = `${PREFIX}${pack.id}-${hashOf(bytes)}.${type}`;
                const before = of(pack.id)[file];
                try {
                    if (!(isObject(before) && before.stored === stored && !gone.has(stored))) await files.put(stored, bytes);
                } catch (error) {
                    refuse(`${file} could not be saved (${error?.message ?? error}).`);
                    continue;
                }
                gone.delete(stored);
                of(pack.id, true)[file] = { stored, bytes: bytes.length };
                report.stored.push(file);
                if (isObject(before) && before.stored !== stored) await release(pack.id, before.stored, file);
            }
            // What the pack no longer names leaves with its file.
            const index = of(pack.id);
            for (const file of Object.keys(index)) {
                if (named.has(file)) continue;
                const entry = index[file];
                delete index[file];
                report.dropped += 1;
                await release(pack.id, entry?.stored, file);
            }
            if (!Object.keys(index).length) delete root()[pack.id];
            report.missing = [...named].filter(file => !isObject(of(pack.id)[file])).sort();
            if (report.stored.length || report.dropped) save();
            return report;
        },

        /** Removes every portrait of a pack (the pack was removed). */
        async forget(packId) {
            const index = of(packId);
            const stored = [...new Set(Object.values(index).map(entry => entry?.stored))];
            delete root()[packId];
            for (const name of stored) {
                if (!mine(packId, name)) continue;
                gone.delete(name);
                try { await files?.remove(name); } catch { /* already gone */ }
            }
            if (stored.length) save();
        },

        /** Asks the file store which stored portraits are still there; the missing ones answer null until imported again. */
        async verify() {
            if (!files || typeof files.exists !== 'function') return 0;
            const names = [...new Set(Object.entries(root()).flatMap(([packId, index]) => Object.values(isObject(index) ? index : {}).map(entry => entry?.stored).filter(name => mine(packId, name))))];
            if (!names.length) return 0;
            let found;
            try { found = await files.exists(names); } catch { return 0; }
            gone.clear();
            for (const name of names) if (found?.[name] === false) gone.add(name);
            return gone.size;
        },
    };
}
