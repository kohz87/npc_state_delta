// Makes a large portrait small enough to keep: a WebP, PNG or JPEG of up to PORTRAIT_LIMITS.source bytes is decoded in the browser,
// drawn with its long side at most PORTRAIT_LIMITS.side px and saved as WebP, trying less quality and then fewer pixels until it is
// at most PORTRAIT_LIMITS.bytes (the stored limit: NPC State Delta keeps a copy per chat). The same steps as Story Studio's portrait
// shrink (qualities 85, 70, 55, 40, 30 per cent; then 85 per cent of the side, down to 96 px), so a picture comes out alike from
// either. Where WebP cannot be saved (some browsers draw it as PNG), JPEG is saved instead.
//
// `fitPortrait(io, options)` is pure; `io` is `{ size() → { width, height }, encode(side, quality) → { bytes, type, width, height },
// close?() }` for one picture (the encoder portraits.js is given: a fake one in the Node tests, `browserImageIo` in the page).
// `browserImageIo(win)` → `bytes → io`: `createImageBitmap` and a canvas. It tells in plain words when the browser cannot read the
// file. A picture drawn with more than MAX_PIXELS is not decoded at all (its header says), so a small file cannot ask for gigabytes.

import { PORTRAIT_LIMITS } from './limits.js';

const QUALITIES = Object.freeze([0.85, 0.7, 0.55, 0.4, 0.3]);
const SMALLEST_SIDE = 96;
/** The most pixels a picture may have to be decoded (a bitmap takes four bytes each). */
export const MAX_PIXELS = 64 * 1000 * 1000;

const kb = bytes => Math.max(1, Math.round(bytes / 1024));

/** A problem with one picture, worded to follow the file's name: "<file> cannot be made small enough …". */
export class FitProblem extends Error {}

/** A picture's width and height from its header (`type`: 'webp' | 'png' | 'jpg', as portraits.js sniffImage says), or null where it cannot be read. */
export function imageSize(bytes, type) {
    if (!type) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    try {
        if (type === 'png') return bytes.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
        if (type === 'webp') {
            const tag = String.fromCharCode(...bytes.subarray(12, 16));
            if (tag === 'VP8X') return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) };
            if (tag === 'VP8L') { const bits = view.getUint32(21, true); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }; }
            if (tag === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        }
        if (type === 'jpg') {
            for (let at = 2; at + 9 < bytes.length;) {
                if (bytes[at] !== 0xff) { at += 1; continue; }
                const marker = bytes[at + 1];
                if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
                at += 2 + view.getUint16(at + 2);
            }
        }
    } catch { /* a damaged header reads as no size */ }
    return null;
}

/**
 * Fits the picture `io` holds into the portrait limits. → `{ bytes, type: 'webp' | 'jpg', width, height }`, or throws a FitProblem whose
 * message is plain words without the file's name (the caller names the file): the picture cannot be read, or cannot be made small enough.
 */
export async function fitPortrait(io, { maxBytes = PORTRAIT_LIMITS.bytes, maxSide = PORTRAIT_LIMITS.side } = {}) {
    const { width, height } = await io.size();
    if (!(width > 0 && height > 0)) throw new FitProblem('could not be read as a picture');
    let side = Math.min(maxSide, Math.max(width, height));
    for (;;) {
        for (const quality of QUALITIES) {
            const out = await io.encode(side, quality);
            if (out?.bytes?.length && out.bytes.length <= maxBytes) return out;
        }
        side = Math.floor(side * 0.85);
        if (side < SMALLEST_SIDE) throw new FitProblem(`cannot be made small enough: a portrait may be at most ${kb(maxBytes)} KB`);
    }
}

/** The browser's decoder and encoder: `win` is the page's window. → `bytes → io` (one picture; `close()` frees the decoded one). */
export function browserImageIo(win = globalThis) {
    return bytes => {
        let bitmap = null;
        const load = async () => {
            if (bitmap) return bitmap;
            if (typeof win.createImageBitmap !== 'function') throw new FitProblem('could not be read: this browser cannot read pictures');
            try { bitmap = await win.createImageBitmap(new win.Blob([bytes])); } catch { throw new FitProblem('could not be read as a picture'); }
            return bitmap;
        };
        const save = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
        return {
            async size() {
                const image = await load();
                return { width: image.width, height: image.height };
            },
            async encode(side, quality) {
                const image = await load();
                const scale = Math.min(1, side / Math.max(image.width, image.height));
                const canvas = win.document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                let blob = await save(canvas, 'image/webp', quality);
                if (!blob || blob.type !== 'image/webp') blob = await save(canvas, 'image/jpeg', quality);
                if (!blob) throw new FitProblem('could not be made smaller: this browser cannot save pictures');
                return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type === 'image/webp' ? 'webp' : 'jpg', width: canvas.width, height: canvas.height };
            },
            close() { bitmap?.close?.(); bitmap = null; },
        };
    };
}
