// A pack as one zip (Story Studio's export): `pack.json` and a `portraits/` folder of the images its cast names.
//
// readPackZip(bytes) → `{ ok: true, text, files }` (`text` the pack.json, `files` the portraits as `[{ name, size, read() }]`, what
// installed.js `install` takes) or `{ ok: false, message }` in plain words. The zip is refused whole for anything the reader
// should not trust: what zip.js refuses (encrypted, zip64, several disks, a path with `..`, more than 4 MB unpacked), a zip with no
// pack.json, and any file other than pack.json and a portrait the pack's cast names (at `portraits/<file>`). Whether the pack
// itself is good, and whether each image is small enough and really an image, is checked as for a pack picked as files.

import { ZIP_LIMITS } from './limits.js';
import { ZipProblem, readZip } from './zip.js';

export const isZipFile = file => /\.zip$/i.test(file?.name ?? '') || /^application\/(?:x-)?zip(?:-compressed)?$/.test(file?.type ?? '');

export async function readPackZip(bytes, { limits = ZIP_LIMITS } = {}) {
    try {
        if (bytes.length > limits.archive) throw new ZipProblem(`The zip is larger than ${Math.round(limits.archive / 1024 / 1024)} MB.`);
        const entries = readZip(bytes, { limits });
        const packEntry = entries.find(entry => entry.name === 'pack.json');
        if (!packEntry) throw new ZipProblem('The zip has no pack.json at its top level.');
        const text = new TextDecoder('utf-8').decode(await packEntry.read());
        let named = new Set();
        try {
            const cast = JSON.parse(text.replace(/^﻿/, ''))?.content?.cast;
            if (Array.isArray(cast)) named = new Set(cast.map(person => person?.portrait).filter(name => typeof name === 'string'));
        } catch { /* a pack that is not JSON is refused by the install with its own message */ }
        const files = [];
        for (const entry of entries) {
            if (entry === packEntry) continue;
            const file = entry.name.startsWith('portraits/') ? entry.name.slice('portraits/'.length) : null;
            if (!file || file.includes('/') || !named.has(file)) throw new ZipProblem(`The zip holds "${entry.name}", which is not pack.json or a portrait the pack's cast names (portraits/<file>); nothing was imported.`);
            files.push({ name: file, size: entry.size, read: () => entry.read() });
        }
        return { ok: true, text, files };
    } catch (error) {
        if (error instanceof ZipProblem) return { ok: false, message: error.message };
        throw error;
    }
}
