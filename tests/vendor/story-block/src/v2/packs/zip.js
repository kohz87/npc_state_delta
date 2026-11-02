// A small zip reader (pure; no dependency): the central directory, then each file stored or deflated.
//
// readZip(bytes, { limits }) → `[{ name, size, read() → Promise<Uint8Array> }]`, the files in the order the zip lists them (folders are
// left out). It refuses, with a `ZipProblem` whose message is plain words: a file that is not a zip, damaged, encrypted, zip64 or
// spread over several disks, a method other than stored or deflate, a path that is absolute, uses `\` or climbs out with `..`, a name
// listed twice, more entries than `limits.entries`, a file larger than `limits.entry`, a deflated file over 256 KB that claims to
// unpack to more than `limits.ratio` times its packed size, more than `limits.unpacked` bytes unpacked in all (by the sizes the zip
// declares, and again while unpacking, so a zip that lies about its sizes cannot fill memory). Files are unpacked one at a time, when
// `read()` is called, so only one file's bytes are unpacked at once. `read()` checks the CRC.
// Deflate is the browser's own `DecompressionStream('deflate-raw')`.

import { ZIP_LIMITS } from './limits.js';

export class ZipProblem extends Error {}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const damaged = () => new ZipProblem('The zip file is damaged.');
const mb = bytes => Math.round(bytes / 1024 / 1024);
// Files up to this size are never held to the ratio: text packs well, and a small file cannot hurt.
const RATIO_FROM = 256 * 1024;

let table = null;
/** CRC-32 of the bytes (what a zip stores for each file). */
export function crc32(bytes) {
    if (!table) {
        table = new Uint32Array(256);
        for (let n = 0; n < 256; n += 1) {
            let c = n;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(data, size) {
    if (typeof DecompressionStream !== 'function' || typeof Blob !== 'function') throw new ZipProblem('This browser cannot unpack zip files; pick pack.json and the images instead.');
    const out = new Uint8Array(size);
    let at = 0;
    try {
        const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (at + value.length > size) {
                reader.cancel().catch(() => {});
                throw new ZipProblem('A file in the zip is larger than the zip says it is.');
            }
            out.set(value, at);
            at += value.length;
        }
    } catch (error) {
        if (error instanceof ZipProblem) throw error;
        throw damaged();
    }
    if (at !== size) throw damaged();
    return out;
}

const unsafePath = name => !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some(part => part === '..');

export function readZip(input, { limits = ZIP_LIMITS } = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 22) throw new ZipProblem('This is not a zip file.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
        if (view.getUint32(at, true) === EOCD && at + 22 + view.getUint16(at + 20, true) <= bytes.length) { end = at; break; }
    }
    if (end < 0) throw new ZipProblem('This is not a zip file.');
    const disk = view.getUint16(end + 4, true);
    const dirDisk = view.getUint16(end + 6, true);
    const onDisk = view.getUint16(end + 8, true);
    const total = view.getUint16(end + 10, true);
    const dirSize = view.getUint32(end + 12, true);
    const dirAt = view.getUint32(end + 16, true);
    if ((end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR) || total === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) throw new ZipProblem('Zip64 zip files are not supported; export the pack again as an ordinary zip.');
    if (disk !== 0 || dirDisk !== 0 || onDisk !== total) throw new ZipProblem('Zip files split over several disks are not supported.');
    if (total > limits.entries) throw new ZipProblem(`The zip holds ${total} entries; at most ${limits.entries} are allowed.`);
    if (dirAt + dirSize > end) throw damaged();

    const entries = [];
    const seen = new Set();
    let unpacked = 0;
    let at = dirAt;
    const text = new TextDecoder('utf-8');
    for (let n = 0; n < total; n += 1) {
        if (at + 46 > end || view.getUint32(at, true) !== CENTRAL) throw damaged();
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        const packed = view.getUint32(at + 20, true);
        const size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const startDisk = view.getUint16(at + 34, true);
        const local = view.getUint32(at + 42, true);
        if (at + 46 + nameLength + extraLength + commentLength > end) throw damaged();
        const name = text.decode(bytes.subarray(at + 46, at + 46 + nameLength));
        at += 46 + nameLength + extraLength + commentLength;
        if (unsafePath(name.replace(/\/$/, ''))) throw new ZipProblem(`The zip has a path that is not allowed ("${name.slice(0, 60)}"): paths may not start with / or climb out with "..".`);
        if (flags & 1 || method === 99) throw new ZipProblem('Encrypted zip files are not supported; export the pack again without a password.');
        if (packed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ZipProblem('Zip64 zip files are not supported; export the pack again as an ordinary zip.');
        if (startDisk !== 0) throw new ZipProblem('Zip files split over several disks are not supported.');
        if (name.endsWith('/')) continue;
        if (method !== 0 && method !== 8) throw new ZipProblem(`"${name}" is packed in a way this reader does not know (only stored and deflate are supported).`);
        if (seen.has(name)) throw new ZipProblem(`The zip lists "${name}" twice.`);
        seen.add(name);
        if (limits.entry && size > limits.entry) throw new ZipProblem(`"${name.slice(0, 60)}" in the zip is larger than ${mb(limits.entry)} MB.`);
        if (limits.ratio && method === 8 && size > RATIO_FROM && size > packed * limits.ratio) throw new ZipProblem(`"${name.slice(0, 60)}" in the zip claims to unpack to far more than it is packed from (over ${limits.ratio} times); the zip is refused.`);
        unpacked += size;
        if (unpacked > limits.unpacked) throw new ZipProblem(`The zip unpacks to more than ${mb(limits.unpacked)} MB; that is too much for a pack.`);
        entries.push({
            name, size,
            async read() {
                if (local + 30 > dirAt || view.getUint32(local, true) !== LOCAL) throw damaged();
                const from = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
                if (from + packed > dirAt) throw damaged();
                const data = bytes.subarray(from, from + packed);
                let out;
                if (method === 0) {
                    if (packed !== size) throw damaged();
                    out = data.slice();
                } else out = await inflate(data, size);
                if (crc32(out) !== crc) throw damaged();
                return out;
            },
        });
    }
    return entries;
}
