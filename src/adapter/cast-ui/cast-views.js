// The game view's Cast screen: the drawn-view registry, tab-pane ownership check, redraw listener helpers, and the frozen
// widget/screen definitions mounted by Story Block. Redraws delegate to the cast render part and keep the same view lifecycle.

export function createCastViews(session, deps, { bindCastActions, renderDossiers }) {
    const {
        CAST_SCREEN_ID, CAST_SCREEN_ORDER, CAST_TAB_ID, CAST_WIDGET, doc, DOSSIERS_ICON, DOSSIERS_TITLE, warn,
    } = deps;
    const castViews = new Set(); // the game view's Cast screens (CAST_WIDGET) drawn now

    // Story Block's tab host has ONE pane for every module's tab (host-ui.js createTabHost marks it
    // with the shown tab's id). Delta may draw into it on its own only while it still shows the Cast
    // tab and still holds what Delta drew there; otherwise it is another module's tab now.
    function castStillShown(el) {
        if (el?.dataset?.tabId !== CAST_TAB_ID) return false;
        const drawn = el.__npcStateDeltaV2CastNode;
        if (drawn) return drawn.parentNode === el;
        return typeof el.__npcStateDeltaV2CastPane === 'string' && el.innerHTML.startsWith(el.__npcStateDeltaV2CastPane);
    }

    // ---- the Cast in the game view ----

    // Each drawn Cast screen again (Delta's page events: a cast drawn in the chat, Delta on or off);
    // one no longer on the page is let go.
    function redrawCastViews() {
        for (const box of castViews) {
            if (box.isConnected === false) {
                castViews.delete(box);
                continue;
            }
            try { renderDossiers(box, { track: false }); } catch (error) { warn('Story Suite v2 Dossiers screen failed', error); }
        }
    }

    // CAST_WIDGET: render(el, props, api) → { update, destroy }. Props are the screen's data (npc.cast,
    // npc.present), passed only so the widget redraws when they change; what it draws is renderCast's.
    const castWidget = Object.freeze({
        props: Object.freeze({}),
        validate: () => [],
        render(el) {
            const owner = el?.ownerDocument ?? doc;
            if (typeof owner?.createElement !== 'function') return { update() {}, destroy() {} };
            const box = owner.createElement('div');
            box.className = 'npc-state-delta-v2-cast-view';
            el.append(box);
            castViews.add(box);
            bindCastActions(box);
            const draw = () => {
                try { renderDossiers(box, { track: false }); } catch (error) { warn('Story Suite v2 Dossiers screen failed', error); }
            };
            draw();
            return {
                update: draw,
                destroy() {
                    castViews.delete(box);
                    box.remove?.();
                },
            };
        },
    });

    const castScreen = Object.freeze({
        id: CAST_SCREEN_ID,
        title: DOSSIERS_TITLE,
        icon: DOSSIERS_ICON,
        mounts: Object.freeze(['screen']),
        order: CAST_SCREEN_ORDER,
        data: Object.freeze({ cast: Object.freeze({ query: 'npc.cast' }), present: Object.freeze({ query: 'npc.present' }) }),
        template: `<ss-widget name="${CAST_WIDGET}" data-props='{"cast":{{ q.cast }},"present":{{ q.present }}}'></ss-widget>`,
        css: '.npc-state-delta-v2-cast-view { display: block; }',
    });

    return { castStillShown, redrawCastViews, castWidget, castScreen };
}
