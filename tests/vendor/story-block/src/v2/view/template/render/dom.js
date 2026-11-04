// Story Suite v2: the template renderer's DOM access (moved out of render.js unchanged). A DOM member is read as the element's own
// interface has it, never as a <form>'s control of that name or id would shadow it, so a template cannot stop a form drawing or
// leave it busy. Also: whether a control is disabled, and which elements a control name is prefixed on.

// A DOM member as the element's own interface has it, never a <form>'s control of that name or id: the
// prototype chain first (the browser's members live there), then the element's own property (the test
// DOM keeps some on the instance).
function descriptorOf(el, name) {
    for (let proto = Object.getPrototypeOf(el); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        const found = Object.getOwnPropertyDescriptor(proto, name);
        if (found) return found;
    }
    return Object.getOwnPropertyDescriptor(el, name) ?? null;
}
export function dom(el, name) {
    const found = descriptorOf(el, name);
    if (!found) return undefined;
    return found.get ? found.get.call(el) : found.value;
}
export function setDom(el, name, value) {
    const found = descriptorOf(el, name);
    if (found?.set) found.set.call(el, value);
    else el[name] = value;
}
export const call = (el, name, ...args) => dom(el, name).apply(el, args);

// A control the reader cannot use (`:disabled`, so a disabled fieldset counts); a <form> never is.
export function isDisabled(el) {
    try {
        const matches = dom(el, 'matches');
        if (typeof matches === 'function') return Boolean(matches.call(el, ':disabled'));
    } catch { /* a DOM without :disabled (the tests'): the property below */ }
    return dom(el, 'disabled') === true;
}

// The elements a control `name` is prefixed on (the form-associated ones a <form> exposes by name).
export const CONTROLS = new Set(['input', 'select', 'textarea', 'button', 'fieldset', 'output', 'object']);
