// badge: an icon with an optional counter, e.g. a status effect with the turns it has left, a stack of
// buffs, unread notes. With `onSelect` it is a button that runs that command with `{ badge: <id> }`.

import { fmt, h, iconNode, num, runCommand, setData, setTone, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';

const props = {
    icon: { type: 'string', default: '' },
    label: { type: 'string', required: true, default: '' },   // what it is ("Poisoned"); spoken and shown as a tooltip
    counter: { type: 'number', default: null },               // null: no counter
    unit: { type: 'string', default: '' },                    // spoken after the counter ("turns left")
    max: { type: 'number', default: 99 },                     // a larger counter shows as "99+"
    tone: { type: 'string', default: 'neutral' },
    showLabel: { type: 'boolean', default: false },
    id: { type: 'string', default: '' },
    kind: { type: 'string', default: '' },
    onSelect: { type: 'string', default: '' },
};

/** The counter as shown: "3", "99+", or '' for none. */
export function counterText(counter, max = 99) {
    if (counter === null || counter === undefined || !Number.isFinite(counter)) return '';
    const cap = num(max, 99);
    return cap > 0 && counter > cap ? `${fmt(cap)}+` : fmt(counter);
}

function render(el, input, api) {
    let host = el;
    let current = null;
    let p = resolveProps(props, input);

    // The root is a button only with a command; a change of that rebuilds it.
    function build() {
        const clickable = Boolean(p.onSelect) && typeof api?.command === 'function';
        current = shell(host, clickable ? 'button' : 'span', 'badge', ({ doc, root, listen }) => {
            if (clickable) {
                root.setAttribute('type', 'button');
                listen(root, 'click', () => runCommand(api, p.onSelect, { badge: p.id || p.label }));
            } else root.setAttribute('role', 'img');
            const iconSlot = h(doc, 'span', 'ss-w-badge-icon');
            const label = h(doc, 'span', 'ss-w-badge-label');
            const count = h(doc, 'span', 'ss-w-badge-count');
            label.setAttribute('aria-hidden', 'true');
            count.setAttribute('aria-hidden', 'true');
            root.append(iconSlot, label, count);
            function update() {
                setTone(root, p.tone);
                setData(root, 'kind', p.kind);
                const glyph = iconNode(doc, p.icon);
                iconSlot.replaceChildren(...(glyph ? [glyph] : []));
                iconSlot.hidden = !glyph;
                label.textContent = p.label;
                label.hidden = !p.showLabel && Boolean(glyph);
                const shown = counterText(p.counter, p.max);
                count.textContent = shown;
                count.hidden = !shown;
                root.classList.toggle('ss-w-has-count', Boolean(shown));
                const spoken = [str(p.label) || 'Badge'];
                if (shown) spoken.push([fmt(p.counter), str(p.unit)].filter(Boolean).join(' '));
                root.setAttribute('aria-label', spoken.join(': '));
                root.setAttribute('title', spoken.join(': '));
            }
            update();
            return { update };
        });
        current.clickable = clickable;
    }

    build();
    return {
        update(next) {
            if (!current) return;
            p = resolveProps(props, next);
            const clickable = Boolean(p.onSelect) && typeof api?.command === 'function';
            if (clickable !== current.clickable) {
                current.destroy();
                build();
            } else current.update();
        },
        destroy() {
            current?.destroy();
            current = null;
            host = null;
        },
    };
}

export const badge = defineWidget({ props, primary: 'counter', render });
