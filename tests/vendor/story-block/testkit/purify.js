// stPurify(html, config): a stand-in for SillyTavern's DOMPurify (`SillyTavern.libs.DOMPurify.sanitize`)
// as Story Block calls it on a screen template (compileTemplate(html, { sanitize })), for module tests.
// It does what the live one was seen to do to templates (live test, 2026-10-22): an <input>'s and a
// <button>'s `type` is dropped (a radio or checkbox then draws as a text box showing its value), as are
// event attributes and script-like elements; data-* attributes, `{{ }}` and the rest pass. Use it to
// check that a screen still works after the host's sanitiser:
//
//   compileTemplate(screen.template, { sanitize: stPurify })
//
// Not a security filter: Story Block's own allow-list runs after it, as after the real one.

import { parseHtml, serializeHtml } from '../src/v2/view/template/html.js';

const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template']);

function scrub(nodes) {
    const out = [];
    for (const node of nodes) {
        if (node.type === 'text') {
            out.push(node);
            continue;
        }
        if (DROPPED_TAGS.has(node.tag)) continue;
        const control = !node.svg && (node.tag === 'input' || node.tag === 'button');
        const attrs = node.attrs.filter(([name]) => {
            const lower = name.toLowerCase();
            if (lower.startsWith('on')) return false;
            return !(control && lower === 'type');
        });
        out.push({ ...node, attrs, children: scrub(node.children ?? []) });
    }
    return out;
}

export function stPurify(html, _config = {}) {
    return serializeHtml(scrub(parseHtml(String(html ?? ''))));
}
