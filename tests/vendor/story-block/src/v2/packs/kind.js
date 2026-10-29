// A plain tag for installed world and Story Block packs.
const WORLD = ['places', 'routes', 'markets'];

export function packTag(pack) {
    if (!pack || typeof pack !== 'object') return 'Pack';
    const capabilities = Array.isArray(pack.requires?.capabilities) ? pack.requires.capabilities : [];
    if (capabilities.some(name => name === 'story-director' || name === 'director')) return 'World pack · Story Director';
    if (capabilities.some(name => ['story-block', 'inventory', 'scene'].includes(name))) return 'Story Block pack';
    const content = pack.content ?? {};
    if (pack.calendar || pack.weather || WORLD.some(kind => Array.isArray(content[kind]) && content[kind].length)) return 'World pack · Story Director';
    return Object.values(content).some(list => Array.isArray(list) && list.length) || pack.start || pack.currency || pack.economy || Object.keys(pack.theme ?? {}).length ? 'Story Block pack' : 'Pack';
}
