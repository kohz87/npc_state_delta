// skill-tree: tiers of skills top to bottom, with connectors between tiers, a level badge on each skill,
// a check mark on the active ones, and locked skills greyed out. Clicking an unlocked skill runs
// `onSelect` with `{ skill: <id> }` when the screen gives a command.
//
// Skills of a tier sit in equal columns (`--ss-w-count` on the tier), so a connector can be drawn from
// column centre to column centre: from each skill it `requires` in the tier above, or — when no skill
// names its requirements — one trunk line between consecutive tiers.

import { clamp, fmt, h, iconNode, num, runCommand, s, setData, shell, str } from './dom.js';
import { defineWidget, resolveProps } from './props.js';

const MAX_TIERS = 20;
const MAX_SKILLS = 24;

const props = {
    tiers: { type: 'array', required: true, default: Object.freeze([]) },   // [{ title, skills: [{ id, name, icon, level, max, active, locked, requires }] }]
    onSelect: { type: 'string', default: '' },
    label: { type: 'string', default: 'Skills' },
};

/** Clean tiers: skills with string ids (first of each id kept across the tree). */
export function treeTiers(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).slice(0, MAX_TIERS).map(tier => {
        const item = tier && typeof tier === 'object' ? tier : {};
        const skills = [];
        for (const skill of Array.isArray(item.skills) ? item.skills.slice(0, MAX_SKILLS) : []) {
            if (!skill || typeof skill !== 'object') continue;
            const id = str(skill.id) || str(skill.name);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const level = num(skill.level, NaN);
            const max = num(skill.max, NaN);
            skills.push({
                id,
                name: str(skill.name) || id,
                icon: str(skill.icon),
                level: Number.isFinite(level) ? level : null,
                max: Number.isFinite(max) && max > 0 ? max : null,
                active: skill.active === true || skill.active === 'true',
                locked: skill.locked === true || skill.locked === 'true',
                requires: (Array.isArray(skill.requires) ? skill.requires : skill.requires ? [skill.requires] : []).map(str).filter(Boolean),
            });
        }
        return { title: str(item.title), skills };
    });
}

/** The centre of column `index` of `count`, in percent. */
export function columnCentre(index, count) {
    return Math.round(((index + 0.5) / Math.max(1, count)) * 10000) / 100;
}

/**
 * Connector lines between tier `upper` and `lower`: `{ x1, x2, state }` in percent, from each required
 * skill above to the skill that needs it; one trunk at 50% when `trunk` is set (no skill names
 * requirements anywhere in the tree).
 */
export function treeLinks(upper, lower, trunk) {
    if (trunk) return upper.skills.length && lower.skills.length ? [{ x1: 50, x2: 50, state: lower.skills.every(skill => skill.locked) ? 'locked' : 'open' }] : [];
    const links = [];
    lower.skills.forEach((skill, index) => {
        for (const need of skill.requires) {
            const from = upper.skills.findIndex(item => item.id === need);
            if (from < 0) continue;
            const parent = upper.skills[from];
            const learned = parent.active || (parent.level ?? 0) > 0;
            links.push({
                x1: columnCentre(from, upper.skills.length),
                x2: columnCentre(index, lower.skills.length),
                state: skill.locked ? 'locked' : learned ? 'learned' : 'open',
            });
        }
    });
    return links;
}

function skillState(skill) {
    if (skill.locked) return 'locked';
    if (skill.active) return 'active';
    return (skill.level ?? 0) > 0 ? 'learned' : 'available';
}

function render(el, input, api) {
    return shell(el, 'div', 'skill-tree', ({ doc, root, listen }) => {
        root.setAttribute('role', 'group');
        let p = resolveProps(props, input);
        let tiers = [];
        const skillOf = new Map();   // element → skill

        function update(next) {
            p = resolveProps(props, next);
            tiers = treeTiers(p.tiers);
            root.setAttribute('aria-label', p.label || 'Skills');
            skillOf.clear();
            const selectable = Boolean(p.onSelect) && typeof api?.command === 'function';
            const trunk = !tiers.some(tier => tier.skills.some(skill => skill.requires.length));
            const parts = [];
            tiers.forEach((tier, tierIndex) => {
                if (tierIndex > 0) {
                    const links = treeLinks(tiers[tierIndex - 1], tier, trunk);
                    const svg = s(doc, 'svg', { class: 'ss-w-tree-links', viewBox: '0 0 100 20', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
                    for (const link of links) {
                        const line = s(doc, 'line', { class: 'ss-w-tree-link', x1: fmt(link.x1), y1: 0, x2: fmt(link.x2), y2: 20, 'vector-effect': 'non-scaling-stroke' });
                        line.setAttribute('data-state', link.state);
                        svg.appendChild(line);
                    }
                    parts.push(svg);
                }
                const section = h(doc, 'section', 'ss-w-tree-tier');
                if (tier.title) section.appendChild(h(doc, 'h4', 'ss-w-tree-title', tier.title));
                section.setAttribute('aria-label', tier.title || `Tier ${tierIndex + 1}`);
                const row = h(doc, 'ul', 'ss-w-tree-skills');
                row.style.setProperty('--ss-w-count', String(clamp(tier.skills.length, 1, MAX_SKILLS)));
                for (const skill of tier.skills) {
                    const li = h(doc, 'li', 'ss-w-tree-cell');
                    const clickable = selectable && !skill.locked;
                    const node = h(doc, clickable ? 'button' : 'div', 'ss-w-tree-skill');
                    if (clickable) node.setAttribute('type', 'button');
                    const state = skillState(skill);
                    node.setAttribute('data-state', state);
                    setData(node, 'id', skill.id);
                    if (skill.locked) node.setAttribute('aria-disabled', 'true');
                    const glyph = iconNode(doc, skill.icon, 'ss-w-icon ss-w-tree-icon');
                    node.appendChild(glyph ?? h(doc, 'span', 'ss-w-icon ss-w-tree-icon ss-w-tree-blank'));
                    node.appendChild(h(doc, 'span', 'ss-w-tree-name', skill.name));
                    if (skill.level !== null) {
                        const levelText = skill.max ? `${fmt(skill.level)}/${fmt(skill.max)}` : fmt(skill.level);
                        const badge = h(doc, 'span', 'ss-w-tree-level', levelText);
                        badge.setAttribute('aria-hidden', 'true');
                        node.appendChild(badge);
                    }
                    if (skill.active) {
                        const check = h(doc, 'span', 'ss-w-tree-check');
                        check.setAttribute('aria-hidden', 'true');
                        check.appendChild(iconNode(doc, 'fa-solid fa-check'));
                        node.appendChild(check);
                    }
                    if (skill.locked) {
                        const lock = h(doc, 'span', 'ss-w-tree-lock');
                        lock.setAttribute('aria-hidden', 'true');
                        lock.appendChild(iconNode(doc, 'fa-solid fa-lock'));
                        node.appendChild(lock);
                    }
                    const spoken = [skill.name];
                    if (skill.level !== null) spoken.push(skill.max ? `level ${fmt(skill.level)} of ${fmt(skill.max)}` : `level ${fmt(skill.level)}`);
                    if (skill.active) spoken.push('active');
                    if (skill.locked) spoken.push('locked');
                    node.setAttribute('aria-label', spoken.join(', '));
                    node.setAttribute('title', spoken.join(', '));
                    if (!clickable) node.setAttribute('role', 'img');
                    skillOf.set(node, skill);
                    li.appendChild(node);
                    row.appendChild(li);
                }
                section.appendChild(row);
                parts.push(section);
            });
            if (!tiers.some(tier => tier.skills.length)) parts.push(h(doc, 'p', 'ss-w-empty-note', 'No skills yet.'));
            root.replaceChildren(...parts);
        }

        listen(root, 'click', event => {
            for (let node = event.target; node && node !== root; node = node.parentNode) {
                const skill = skillOf.get(node);
                if (!skill) continue;
                if (!skill.locked && node.tagName?.toLowerCase() === 'button') runCommand(api, p.onSelect, { skill: skill.id });
                return;
            }
        });

        update(input);
        return { update };
    });
}

export const skillTree = defineWidget({ props, primary: 'tiers', render });
