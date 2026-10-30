/** A pinned definition's tab is an ordinary host screen backed by the shared block widget. */
export function blockTabScreen(definition) {
    if (!definition?.show?.tab) return null;
    const suffix = definition.pack === 'chat' ? definition.slug : `${definition.pack}/${definition.slug}`;
    return { id: `story-block/block/${suffix}`, title: definition.show.tabName, icon: definition.show.icon,
        mounts: ['screen', 'tab'], order: 206,
        template: `<ss-widget name="story-block.block" data-props='{"module":"${definition.id}"}'></ss-widget>`,
        pack: definition.pack === 'chat' ? 'chat' : `dm:${definition.id}` };
}
