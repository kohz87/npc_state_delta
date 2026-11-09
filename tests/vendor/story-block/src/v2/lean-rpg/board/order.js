// Shared group labels and log grouping for the board: keep split members and one area roll together.

export const memberBaseName = (member, realFoe) => String(realFoe?.name ?? String(member?.name ?? '')
    .replace(/ pack \d+$/u, '').replace(/ \d+$/u, ''));
export const pluralName = name => (!name ? '' : /s$/iu.test(name) ? name : `${name}s`);

/** Name one group for an area attack, retaining a lone foe's name and naming multiple packs together. */
export const areaGroupName = foe => {
    const name = String(foe?.name ?? ''), count = Number(foe?.count);
    if (count > 12) return /\bpacks$/iu.test(name) ? name : `${name} packs`;
    return count > 1 && count <= 5 ? pluralName(name) : name;
};

/** Group the contiguous bars of each new area attack without merging separate attacks or old rolls. */
export function areaLineGroups(lines) {
    const out = [];
    let groups = new Map();
    for (const line of lines) {
        if (!line.aoe) { groups = new Map(); out.push([line]); continue; }
        if (!line.aoeFollowup) groups = new Map();
        let group = groups.get(line.aoeGroup);
        if (!group) { group = []; groups.set(line.aoeGroup, group); out.push(group); }
        group.push(line);
    }
    return out;
}

/** Collapse order entries for virtual members of the same real slot, retaining the roll and its place. */
export function memberOrderEntries(order, members, realFoes = []) {
    const list = Array.isArray(members) ? members : [], seen = new Set(), out = [];
    for (const item of (Array.isArray(order) ? order : [])) {
        if (item?.party) { out.push(item); continue; }
        const slot = Number(item?.slot ?? String(item?.id ?? '').replace(/^f:/u, ''));
        const member = list.find(entry => Number(entry?.slot) === slot);
        if (!member || !Number.isInteger(member.group)) { out.push(item); continue; }
        const group = member.group;
        if (seen.has(group)) continue;
        seen.add(group);
        // A count-one foe is a real slot and retains its ordinary name.
        if (slot === group) { out.push(item); continue; }
        const groupMembers = list.filter(entry => entry?.group === group && entry.slot !== group);
        const real = (Array.isArray(realFoes) ? realFoes : []).find(foe => Number(foe?.slot) === group);
        // A single pack uses the real name unchanged; only multiple packs append "pack N".
        const base = real?.name ?? (member.pack ? (groupMembers.length === 1 ? String(member.name ?? '')
            : String(member.name ?? '').replace(/ pack \d+$/u, '')) : memberBaseName(member));
        const label = pluralName(String(base));
        const numbers = groupMembers.map(entry => entry.n).filter(Number.isInteger);
        const name = groupMembers.some(entry => entry.pack) || !numbers.length ? label : `${label} (${numbers.join(', ')})`;
        out.push({ ...item, name, group });
    }
    return out;
}
