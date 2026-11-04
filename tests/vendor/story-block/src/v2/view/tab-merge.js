// Screens that name the same `tab` are one tab: each draws as a section of it, in `order` (then the order given). A pack screen says
// `tab: "reputation", tabTitle: "Reputation"`; a block says `show.into: "reputation"`. Pure: screens in, screens out.
//
// The merged screen is `story-block/tab/<tab>`, titled by the first `tabTitle` given (else the first screen's title), with the first icon given, in the bar
// if any member is, at the lowest `order` of its members, on the mounts the members share between them (never a card). Each section is its screen's
// layout under a header with the screen's title; a section whose layout is a story-block.fields node or a block widget draws its own header.
// A screen that has a template (not a layout), or only a card mount, stays as it is: it cannot be a section.
import { FIELDS_WIDGET, HEADING_WIDGET } from '../data-modules/fields-widget.js';

export const MERGED_PREFIX = 'story-block/tab/';
const SELF_HEADED = new Set([FIELDS_WIDGET, 'story-block.block']);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether a screen can be a section of a shared tab. */
const sectionable = screen => isRecord(screen) && typeof screen.tab === 'string' && screen.tab && isRecord(screen.layout?.root)
    && !(Array.isArray(screen.mounts) && screen.mounts.length && screen.mounts.every(mount => mount === 'card'));

/**
 * mergeTabs(screens) → screens: the members of each tab replaced (at the place of the first) by one merged screen. A screen keeps its own `pack`;
 * the merged one belongs to the pack of its first member. Screens without a tab (or that cannot be sections) pass through, minus the tab keys.
 */
export function mergeTabs(screens) {
    const groups = new Map();
    for (const screen of screens) if (sectionable(screen)) {
        if (!groups.has(screen.tab)) groups.set(screen.tab, []);
        groups.get(screen.tab).push(screen);
    }
    const out = [];
    const done = new Set();
    for (const screen of screens) {
        if (!isRecord(screen)) { out.push(screen); continue; }
        if (!sectionable(screen)) {
            const { tab, tabTitle, ...plain } = screen;
            out.push(plain);
            continue;
        }
        if (done.has(screen.tab)) continue;
        done.add(screen.tab);
        const members = groups.get(screen.tab).map((member, at) => ({ member, at }))
            .sort((a, b) => (a.member.order ?? Infinity) - (b.member.order ?? Infinity) || a.at - b.at).map(entry => entry.member);
        const given = (key, test = value => typeof value === 'string' && value) => members.map(member => member[key]).find(test);
        const mounts = [...new Set(members.flatMap(member => (Array.isArray(member.mounts) ? member.mounts : ['tab']).filter(mount => mount !== 'card')))];
        const children = members.flatMap(member => {
            const root = member.layout.root;
            const heading = SELF_HEADED.has(root.type) || !member.title ? [] : [{ type: HEADING_WIDGET, props: { title: member.title } }];
            return [...heading, root];
        });
        const orders = members.map(member => member.order).filter(value => typeof value === 'number' && Number.isFinite(value));
        const merged = {
            id: `${MERGED_PREFIX}${screen.tab}`,
            title: given('tabTitle') ?? given('title') ?? screen.tab,
            ...(given('icon') ? { icon: given('icon') } : {}),
            mounts: mounts.length ? mounts : ['tab'],
            ...(orders.length ? { order: Math.min(...orders) } : {}),
            ...(members.some(member => member.bar === true) ? { bar: true } : {}),
            layout: { root: { type: 'col', children } },
            pack: screen.pack,
        };
        out.push(merged);
    }
    return out;
}
