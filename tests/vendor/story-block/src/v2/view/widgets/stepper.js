// stepper: a number input with − / + buttons, kept inside [min, max] on a step grid and under a points
// budget (a wizard's stat points). It fills a draft, never the state (SPEC §13.6): every change goes to
// `api.onDraft(name, value)`; the dialog's submit command enforces the rules again in code.
//
// `budget` is the points left *now*, with the stepper at `value`. Each step up costs `cost` points and
// each step down refunds them, so + is disabled when the budget is spent. When the dialog passes new
// props (a recomputed budget after any stepper changed), the stepper starts counting from them.
// Instead of `budget`, a shared pool: `pool` is every point the steppers may spend together and
// `spent` what they spend now, this one included (`"spent": {{ sum(draft.points) }}`), so the budget is
// `pool − spent` without a query to work it out.

import { clamp, fmt, h, num, setTone, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';

const EPSILON = 1e-9;

const props = {
    name: { type: 'string', required: true, default: '' },     // the draft field
    value: { type: 'number', default: 0 },
    min: { type: 'number', default: 0 },
    max: { type: 'number', default: null },                     // null: no maximum
    step: { type: 'number', default: 1 },
    budget: { type: 'number', default: null },                  // null: no budget
    pool: { type: 'number', default: null },                    // shared budget, used when `budget` is null
    spent: { type: 'number', default: 0 },                      // points spent from the pool, this stepper's included
    cost: { type: 'number', default: 1 },                       // points per step up
    label: { type: 'string', default: '' },
    budgetLabel: { type: 'string', default: 'Points left' },
    showBudget: { type: 'boolean', default: true },             // false: the budget still limits the stepper, but the line under it is left out
    tone: { type: 'string', default: 'neutral' },
    disabled: { type: 'boolean', default: false },
};

const tidy = value => Math.round(value * 1e6) / 1e6;

/**
 * The stepper's limits for a starting point: `{ lo, hi, step, cost }`. `hi` is the lower of `max` and
 * what the budget can buy from `value` (never below `value` itself, so a value already over budget is
 * kept, just not raised).
 */
export function stepperLimits({ value, min, max, step, budget, cost }) {
    const s = num(step, 1) > 0 ? num(step, 1) : 1;
    const c = num(cost, 1) >= 0 ? num(cost, 1) : 1;
    const lo = num(min, 0);
    let hi = max === null || max === undefined ? Infinity : Math.max(lo, num(max, Infinity));
    if (budget !== null && budget !== undefined && c > 0) {
        const steps = Math.floor(num(budget, 0) / c + EPSILON);
        hi = Math.min(hi, Math.max(value, value + steps * s));
    }
    return { lo, hi, step: s, cost: c };
}

/** The points left now: `budget` when given, else `pool − spent`, else null (no budget). */
export function stepperBudget({ budget = null, pool = null, spent = 0 } = {}) {
    if (budget !== null && budget !== undefined) return budget;
    if (pool === null || pool === undefined) return null;
    return tidy(num(pool, 0) - num(spent, 0));
}

/** A typed or stepped value snapped to the step grid from `lo` and clamped into [lo, hi]. */
export function stepperClamp(raw, { lo, hi, step }) {
    const value = num(raw, lo);
    const snapped = lo + Math.round((value - lo) / step) * step;
    return clamp(tidy(snapped), lo, hi);
}

/** Points left after moving from `base` to `value` (null without a budget). */
export function stepperRemaining(base, value, budget, { step, cost }) {
    if (budget === null || budget === undefined) return null;
    return tidy(num(budget, 0) - ((value - base) / step) * cost);
}

function render(el, input, api) {
    return shell(el, 'div', 'stepper', ({ doc, root, listen }) => {
        root.setAttribute('role', 'group');
        const label = h(doc, 'span', 'ss-w-stepper-label');
        label.setAttribute('aria-hidden', 'true');
        const row = h(doc, 'div', 'ss-w-stepper-row');
        const dec = h(doc, 'button', 'ss-w-stepper-btn ss-w-stepper-dec', '−');
        const inc = h(doc, 'button', 'ss-w-stepper-btn ss-w-stepper-inc', '+');
        dec.setAttribute('type', 'button');
        inc.setAttribute('type', 'button');
        const field = h(doc, 'input', 'ss-w-stepper-input');
        field.setAttribute('type', 'number');
        field.setAttribute('inputmode', 'decimal');
        row.append(dec, field, inc);
        const budgetNote = h(doc, 'span', 'ss-w-stepper-budget');
        budgetNote.setAttribute('aria-live', 'polite');
        root.append(label, row, budgetNote);

        let p = resolveProps(props, input);
        let base = 0;
        let limits = stepperLimits({ value: 0, min: 0, max: null, step: 1, budget: null, cost: 1 });
        let value = 0;

        function paint() {
            field.value = fmt(value);
            field.setAttribute('aria-valuenow', fmt(value));
            const remaining = stepperRemaining(base, value, p.budget, limits);
            dec.disabled = p.disabled || value - limits.step < limits.lo - EPSILON;
            inc.disabled = p.disabled || value + limits.step > limits.hi + EPSILON;
            field.disabled = p.disabled;
            root.classList.toggle('ss-w-spent', remaining !== null && remaining < limits.cost);
            budgetNote.hidden = remaining === null || !p.showBudget;
            budgetNote.textContent = remaining === null || !p.showBudget ? '' : `${p.budgetLabel || 'Points left'}: ${fmt(remaining)}`;
        }

        function set(raw) {
            const next = stepperClamp(raw, limits);
            const changed = next !== value;
            value = next;
            paint();
            if (changed && p.name && typeof api?.onDraft === 'function') {
                try { api.onDraft(p.name, value); } catch { /* the dialog reports its own problems */ }
            }
        }

        function update(next) {
            p = resolveProps(props, next);
            p.budget = stepperBudget(p);
            const name = str(p.label) || str(p.name) || 'Value';
            setTone(root, p.tone);
            root.setAttribute('aria-label', name);
            label.textContent = p.label;
            label.hidden = !p.label;
            field.setAttribute('aria-label', name);
            dec.setAttribute('aria-label', `Decrease ${name}`);
            inc.setAttribute('aria-label', `Increase ${name}`);
            const start = num(p.value, 0);
            limits = stepperLimits({ ...p, value: start });
            base = clamp(start, limits.lo, Math.max(limits.lo, limits.hi));
            limits = stepperLimits({ ...p, value: base });
            value = base;
            field.setAttribute('min', fmt(limits.lo));
            if (Number.isFinite(limits.hi)) field.setAttribute('max', fmt(limits.hi));
            else field.removeAttribute('max');
            field.setAttribute('step', fmt(limits.step));
            paint();
        }

        listen(dec, 'click', () => { if (!p.disabled) set(value - limits.step); });
        listen(inc, 'click', () => { if (!p.disabled) set(value + limits.step); });
        listen(field, 'change', () => set(field.value));
        listen(field, 'keydown', event => {
            const big = limits.step * 10;
            const target = {
                ArrowUp: value + limits.step,
                ArrowDown: value - limits.step,
                PageUp: value + big,
                PageDown: value - big,
                Home: limits.lo,
                End: Number.isFinite(limits.hi) ? limits.hi : null,
            }[event.key];
            if (target === undefined || target === null) {
                if (event.key === 'Enter') set(field.value);
                return;
            }
            event.preventDefault?.();
            if (!p.disabled) set(target);
        });

        update(input);
        return { update };
    });
}

export const stepper = defineWidget({ props, primary: 'value', render });
