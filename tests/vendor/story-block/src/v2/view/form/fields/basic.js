// The form engine's basic field renderers: switch, text, whole number and slider, with their labels, keys and
// the values they report when the reader makes a choice.

import { FORM_TEXT, fill, readInt } from '../schema.js';
import { cutAt } from '../../../../text.js';
import { button, h, named, setDisabled } from './shared.js';

// ---- switch ----------------------------------------------------------------------------------------

export function switchField(ctx) {
    const { doc } = ctx;
    const root = button(doc, 'ss-switch');
    root.setAttribute('role', 'switch');
    root.appendChild(h(doc, 'span', 'ss-switch-knob'));
    named(root, ctx);
    let on = Boolean(ctx.value);
    let locked = false;
    let off = false;
    const paint = () => {
        root.setAttribute('aria-checked', String(on));
        root.classList.toggle('ss-switch-on', on);
    };
    paint();
    root.addEventListener('click', () => {
        if (root.disabled || locked) return;
        on = !on;
        paint();
        ctx.onChange(on);
    });
    const handle = {
        el: root, input: root,
        get: () => on,
        set(value) { on = Boolean(value); paint(); },
        setDisabled(value) { off = Boolean(value); setDisabled(root, off || locked); },
        setReadOnly(value) { locked = Boolean(value); setDisabled(root, locked || off); },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

// ---- text and number -------------------------------------------------------------------------------

export function textField(ctx) {
    const { doc, field } = ctx;
    const multiline = field.multiline === true;
    const input = h(doc, multiline ? 'textarea' : 'input', 'ss-input ss-text');
    if (!multiline) input.type = 'text';
    else input.rows = Math.max(3, Math.min(8, Number(field.rows) || 4));
    const max = Number.isInteger(field.max) && field.max >= 0 ? field.max : null;
    if (max !== null && field.codepoints !== true) input.maxLength = max;
    named(input, ctx);
    input.value = String(ctx.value ?? '');
    const root = h(doc, 'div', 'ss-control');
    root.appendChild(input);
    let counter = null;
    if (multiline && max !== null) {
        counter = h(doc, 'small', 'ss-field-count');
        counter.setAttribute('aria-live', 'off');
        root.appendChild(counter);
    }
    const count = () => { if (counter) counter.textContent = fill(FORM_TEXT.count, { n: Array.from(input.value).length, max }); };
    count();
    input.addEventListener('input', () => {
        if (max !== null && field.codepoints === true) input.value = [...input.value].slice(0, max).join('');
        count();
    });
    input.addEventListener('change', () => {
        // A paste past the maximum is cut (the store cuts there too).
        const asked = input.value;
        let value = asked;
        if (max !== null && (field.codepoints === true ? [...value].length : value.length) > max) {
            value = field.codepoints === true ? [...value].slice(0, max).join('') : cutAt(value, max);
            input.value = value;
        }
        count();
        ctx.onChange(value, { typed: asked });
    });
    const handle = {
        el: root, input,
        get: () => input.value,
        set(value) { input.value = String(value ?? ''); count(); },
        setDisabled(value) { setDisabled(input, value); },
        setReadOnly(value) {
            input.readOnly = Boolean(value);
            if (value) input.setAttribute('aria-readonly', 'true');
            else input.removeAttribute('aria-readonly');
        },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

export function numberField(ctx) {
    const { doc, field } = ctx;
    const input = h(doc, 'input', 'ss-input ss-number');
    input.type = 'number';
    if (Number.isInteger(field.min)) input.min = String(field.min);
    if (Number.isInteger(field.max)) input.max = String(field.max);
    input.step = '1';
    input.inputMode = 'numeric';
    named(input, ctx);
    let shown = ctx.value;
    input.value = shown === null || shown === undefined ? '' : String(shown);
    input.addEventListener('change', () => {
        const typed = Number(String(input.value).trim());
        const next = readInt(input.value, field);
        if (next === null) {
            // Not a number: the value stays, is shown again, and the reader is told.
            input.value = shown === null || shown === undefined ? '' : String(shown);
            ctx.invalid(fill(FORM_TEXT.notWhole, { value: shown ?? '' }));
            return;
        }
        input.value = String(next);
        shown = next;
        ctx.onChange(next, { typed: Math.round(typed) });
    });
    const handle = {
        el: input, input,
        get: () => (String(input.value).trim() === '' ? null : Number(input.value)),
        set(value) {
            shown = value;
            input.value = value === null || value === undefined ? '' : String(value);
        },
        setDisabled(value) { setDisabled(input, value); },
        setReadOnly(value) {
            input.readOnly = Boolean(value);
            if (value) input.setAttribute('aria-readonly', 'true');
            else input.removeAttribute('aria-readonly');
        },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}

// ---- slider ----------------------------------------------------------------------------------------

export function sliderField(ctx) {
    const { doc, field } = ctx;
    const root = h(doc, 'div', 'ss-slider');
    const input = h(doc, 'input', 'ss-slider-input');
    input.type = 'range';
    // The range is the field's min and max; `sliderMax` (below `max`) is the range the slider offers while the value is
    // within it, for a field whose store allows far more than a slider can place (the range grows to a larger value).
    const top = value => (Number.isInteger(field.sliderMax) && field.sliderMax > field.min ? Math.min(field.max, Math.max(field.sliderMax, Number.isInteger(value) ? value : 0)) : field.max);
    input.min = String(field.min);
    input.max = String(top(ctx.value));
    // `step` (a whole number, default 1): a budget in steps of 50 is easier to place than one in steps of 1.
    input.step = String(Number.isInteger(field.step) && field.step >= 1 ? field.step : 1);
    named(input, ctx);
    const out = h(doc, 'output', 'ss-slider-value');
    out.setAttribute('aria-hidden', 'true');
    const clampNow = value => (Number.isInteger(value) ? Math.min(field.max, Math.max(field.min, value)) : field.min);
    // What the value is called: `format(n)` (a function: "60 pennies", "Automatic"), else the number and a short `unit` text.
    const say = n => {
        if (typeof field.format === 'function') {
            try {
                const text = field.format(n);
                if (typeof text === 'string' && text) return cutAt(text, 40);
            } catch { /* the number alone */ }
        }
        return `${n}${typeof field.unit === 'string' ? cutAt(field.unit, 8) : ''}`;
    };
    // The fill (0…1) is a custom property the track paints from; the value is shown beside it and spoken.
    const show = () => {
        const n = Number(input.value);
        const text = say(n);
        out.textContent = text;
        input.setAttribute('aria-valuetext', text);
        const max = Number(input.max);
        input.style.setProperty('--ss-fill', String(Math.round(((n - field.min) / (max - field.min)) * 10000) / 10000));
    };
    let off = false;
    let locked = false;
    input.value = String(clampNow(ctx.value));
    show();
    input.addEventListener('input', show);
    input.addEventListener('change', () => {
        show();
        ctx.onChange(Number(input.value), { typed: Number(input.value) });
    });
    root.append(input, out);
    const handle = {
        el: root, input,
        get: () => Number(input.value),
        set(value) {
            input.max = String(top(value));
            input.value = String(clampNow(value));
            show();
        },
        setDisabled(value) { off = Boolean(value); setDisabled(input, off || locked); },
        setReadOnly(value) { locked = Boolean(value); setDisabled(input, locked || off); },
        destroy() {},
    };
    handle.setDisabled(Boolean(ctx.disabled));
    handle.setReadOnly(Boolean(ctx.readOnly));
    return handle;
}
