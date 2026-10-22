// portrait: a character's picture in a frame (the persona avatar for the PC, NSD's `npc.portrait` for
// others, MODULES §F11), falling back to the name's initials when there is no picture, the URL is not
// a data:image, https: or same-origin root path, or the picture fails to load.

import { h, initials, safeImageUrl, setTone, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';

export const FRAMES = Object.freeze(['circle', 'rounded', 'square', 'hex', 'diamond', 'none']);
export const SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

const props = {
    src: { type: 'string', default: '' },
    name: { type: 'string', default: '' },
    frame: { type: 'string', default: 'circle' },
    size: { type: 'string', default: 'md' },
    tone: { type: 'string', default: 'neutral' },
    caption: { type: 'string', default: '' },
};

function render(el, input) {
    return shell(el, 'figure', 'portrait', ({ doc, root, listen }) => {
        const frame = h(doc, 'div', 'ss-w-portrait-frame');
        const img = h(doc, 'img', 'ss-w-portrait-img');
        img.setAttribute('alt', '');
        img.setAttribute('draggable', 'false');
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.setAttribute('referrerpolicy', 'no-referrer');
        const letters = h(doc, 'span', 'ss-w-portrait-initials');
        letters.setAttribute('aria-hidden', 'true');
        frame.append(img, letters);
        const caption = h(doc, 'figcaption', 'ss-w-portrait-caption');
        root.append(frame, caption);
        let failed = '';

        const showFallback = on => {
            img.hidden = on;
            letters.hidden = !on;
            root.classList.toggle('ss-w-fallback', on);
        };
        listen(img, 'error', () => {
            failed = img.getAttribute('src') ?? '';
            showFallback(true);
        });

        function update(next) {
            const p = resolveProps(props, next);
            for (const name of FRAMES) root.classList.remove(`ss-w-frame-${name}`);
            for (const name of SIZES) root.classList.remove(`ss-w-size-${name}`);
            root.classList.add(`ss-w-frame-${FRAMES.includes(p.frame) ? p.frame : 'circle'}`);
            root.classList.add(`ss-w-size-${SIZES.includes(p.size) ? p.size : 'md'}`);
            setTone(root, p.tone);
            const name = str(p.name);
            frame.setAttribute('role', 'img');
            frame.setAttribute('aria-label', name ? `Portrait of ${name}` : 'Portrait');
            letters.textContent = initials(name);
            caption.textContent = p.caption;
            caption.hidden = !p.caption;
            const url = safeImageUrl(p.src);
            if (url && url !== failed) {
                if (img.getAttribute('src') !== url) img.setAttribute('src', url);
                showFallback(false);
            } else {
                if (!url) img.removeAttribute('src');
                showFallback(true);
            }
        }

        update(input);
        return { update };
    });
}

export const portrait = defineWidget({ props, primary: 'src', render });
