// Shared turn-order labels for the board and its battle log: a split slot rolled once, so show its members together.

export const memberBaseName = (member, realFoe) => String(realFoe?.name ?? String(member?.name ?? '')
    .replace(/ pack \d+$/u, '').replace(/ \d+$/u, ''));
export const pluralName = name => (!name ? '' : /s$/iu.test(name) ? name : `${name}s`);

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
