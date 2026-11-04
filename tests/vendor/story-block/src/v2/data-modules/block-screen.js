/** A pinned definition's tab is an ordinary host screen backed by the shared block widget. */
export function blockTabScreen(definition) {
    if (!definition?.show?.tab) return null;
    const suffix = definition.pack === 'chat' ? definition.slug : `${definition.pack}/${definition.slug}`;
    const pack = definition.pack === 'chat' ? 'chat' : `dm:${definition.id}`;
    // A block that says show.into is a section of that tab (view/tab-merge.js), so it comes as a layout node, not a template.
    if (definition.show.into) return { id: `story-block/block/${suffix}`, title: definition.name, icon: definition.show.icon, mounts: ['screen', 'tab'], order: 206,
        layout: { root: { type: 'story-block.block', props: { module: definition.id } } }, tab: definition.show.into, pack };
    return { id: `story-block/block/${suffix}`, title: definition.show.tabName, icon: definition.show.icon,
        mounts: ['screen', 'tab'], order: 206,
        template: `<ss-widget name="story-block.block" data-props='{"module":"${definition.id}"}'></ss-widget>`,
        pack };
}
