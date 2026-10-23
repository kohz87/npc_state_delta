// Story Suite v2: the `tab` mount (SPEC §13.4). Every usable screen that allows 'tab' becomes a tab in
// Story Block's tab bar, drawn from the head state the tab host hands its tabs (§6: render(el, view, api)).
//
// deps (see common.js) plus:
//   addTab   ({ id, title, icon, render(el, view, api) }) → optional remove function
//
// → { mount(el, screenId, opts) → handle, register() → ids, unregister() }

import { mountHead, screensFor } from './common.js';
import { iconFor } from '../icons/index.js';

export function createTabMount(deps) {
    if (typeof deps?.render !== 'function') throw new TypeError('The tab mount needs a render(el, screen, scope) function.');
    let removers = [];

    /** Draws a tab screen into `el` from `opts.state` (the tab host's view) or the head. */
    function mount(el, screenId, opts = {}) {
        return mountHead(deps, 'tab', el, screenId, opts);
    }

    function unregister() {
        for (const remove of removers) if (typeof remove === 'function') remove();
        removers = [];
    }

    /** Adds one tab per tab screen, in navigation order (`order`); calling it again replaces the earlier set. */
    function register() {
        if (typeof deps.addTab !== 'function') throw new TypeError('The tab mount needs an addTab function from the tab host.');
        unregister();
        const ids = [];
        for (const entry of screensFor(deps, 'tab')) {
            removers.push(deps.addTab({
                id: entry.id,
                title: entry.screen.title ?? entry.id,
                icon: iconFor(entry.id, entry.screen.icon) || 'fa-table-columns',
                ...(entry.screen.order !== undefined ? { order: entry.screen.order } : {}),
                render: (el, view, api) => mount(el, entry.id, {
                    ...(view?.state ? { state: view.state } : {}),
                    ...(api ? { api } : {}),
                }),
            }));
            ids.push(entry.id);
        }
        return ids;
    }

    return { mount, register, unregister };
}
