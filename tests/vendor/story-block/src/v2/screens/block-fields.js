// The widgets a data module's screen layout can name to show its own fields as a block does (data-modules/fields-widget.js says how they are asked for):
//   story-block.fields   a map of numbers or a record card of the module's fields (the module's name, or `title`, is the header);
//   story-block.heading  a section header (`title`), used where several screens share one tab (view/tab-merge.js).
import { h, shell } from '../view/widgets/dom.js';
import { FIELDS_WIDGET, HEADING_WIDGET } from '../data-modules/fields-widget.js';
import { drawNumberMap, drawRecordCard, numberRows } from './block-layouts.js';
import { humanize } from '../view/widgets/dom.js';
import { dmOwn } from '../data-modules/schema.js';

const ask = (api, name, args) => { try { return api?.query?.(name, args); } catch { return null; } };
const cap = value => value.charAt(0).toUpperCase() + value.slice(1);
const text = value => (typeof value === 'string' ? value : '');

export function createFieldsWidgets() {
    const memory = new Map();
    const fields = {
        props: {}, primary: null, validate: () => [],
        render(el, props, api) {
            return shell(el, 'div', 'block-fields', ({ doc, root }) => {
                let handles = [], current = props, alive = true;
                const clear = () => { for (const handle of handles) handle.destroy?.(); handles = []; root.replaceChildren(); };
                function draw() {
                    if (!alive) return;
                    clear();
                    const module = text(current?.module);
                    const row = (ask(api, 'dataModules.setup') ?? []).find(entry => entry.module === module && entry.pinnedDefinition);
                    const definition = row?.pinnedDefinition;
                    if (!definition || definition.scope !== 'chat') return;
                    const values = (ask(api, 'dataModules.view', { module }) ?? {}).chat ?? {};
                    const screen = el.closest?.('[data-ss-screen]') ?? doc;
                    const env = { doc, api, handles, memory, after: mark => {
                        const pencil = [...screen.querySelectorAll('.ss-w-editable-pencil')].find(node => Object.entries(mark ?? {}).every(([name, value]) => node.getAttribute(`data-block-${name}`) === String(value ?? '')));
                        pencil?.focus?.();
                    } };
                    const names = Array.isArray(current.fields) ? current.fields : current.field !== undefined ? [current.field] : [];
                    if (!names.length || names.some(name => !dmOwn(definition.state, name))) return;
                    const title = text(current.title) || definition.name;
                    const first = definition.state[names[0]];
                    const map = current.as === 'map' || (current.as === undefined && first.type === 'map');
                    if (map) {
                        const rows = numberRows({ definition, module, values, ...(first.type === 'map' ? { field: names[0] } : { fields: names }),
                            names: typeof current.names === 'object' && current.names ? current.names : {} });
                        drawNumberMap(env, root, { title, rows, memoryKey: `${module}:${names.join(',')}` });
                        return;
                    }
                    const labels = current.labels ?? {}, units = current.units ?? {}, tones = current.tones ?? {};
                    const lines = names.map(name => ({ field: name, label: text(labels[name]) || definition.state[name].label || cap(humanize(name)), schema: definition.state[name],
                        value: values[name] ?? definition.state[name].default, tones: tones[name], unit: text(units[name]) }));
                    drawRecordCard(env, root, { title, lines, module });
                }
                draw();
                return { update(next) { current = next; draw(); }, destroy() { alive = false; clear(); } };
            });
        },
    };
    const heading = {
        props: {}, primary: null, validate: () => [],
        render(el, props) {
            return shell(el, 'div', 'block-heading', ({ doc, root }) => {
                const draw = current => { root.replaceChildren(h(doc, 'h4', 'ss-section-label', text(current?.title))); };
                draw(props);
                return { update: draw, destroy() {} };
            });
        },
    };
    return { [FIELDS_WIDGET]: fields, [HEADING_WIDGET]: heading };
}
