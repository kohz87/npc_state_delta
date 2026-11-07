// The form engine's shared field helpers: a small element, a button, the label hooks every control uses, the
// disabled state, and the page's fresh control ids.

function h(doc, tag, className = '', text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null && text !== '') node.textContent = String(text);
    return node;
}
const button = (doc, className, label) => {
    const node = h(doc, 'button', className);
    node.setAttribute('type', 'button');
    if (label) node.setAttribute('aria-label', label);
    return node;
};
let serial = 0;
/** A fresh id for a control or a message ("ss-f3-budget"): ids are unique per page, not per form. */
export const newId = hint => `ss-f${(serial += 1)}-${String(hint ?? 'x').replace(/[^\w-]/g, '_')}`;

// What every control takes from its ctx: the name, the disabled and read-only states.
function named(node, ctx) {
    if (ctx.labelledBy) node.setAttribute('aria-labelledby', ctx.labelledBy);
    else if (ctx.ariaLabel) node.setAttribute('aria-label', ctx.ariaLabel);
}
function setDisabled(node, on) {
    node.disabled = Boolean(on);
    if (on) node.setAttribute('aria-disabled', 'true');
    else node.removeAttribute('aria-disabled');
}

export { button, h, named, setDisabled };
