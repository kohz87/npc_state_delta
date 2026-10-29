// The Assist section's body (UI stage, step 3d): Story Block's two optional helpers on the form engine, in the concept's
// Assist page. Both make one cheap extra model call, and both are off until the reader turns them on:
//
// * Extra calls: the Connection Manager profile both helpers use (a cheaper model, say) and Story Suite's "one call at a time per
//   connection" switch (a host setting that used to sit in the Story Suite fold).
// * Checks: the pre-roll, "Roll checks before the reply": the check is rolled first, from the reader's message.
// * Safety net: reads the finished reply for change lines it forgot (time, place, who is here, weather, quest progress, wounds, an
//   item handed over). Its own profile, and the kinds it may write as chips. The value wall is stated plainly: coin, new items,
//   XP, loot and healing have no chip and are never written, whatever is stored; a line that arrives after the reader has already
//   sent the next message waits for the next reply and may not add anything but someone arriving. (There is no setting for that:
//   the code decides it, so the page only states it.)
// * Recent runs: what the helpers did lately (the old Assist panel, assist/section.js).
//
// The two switches are Features (MODULES §F100): they are written through the feature store, the one the Features page writes
// through, so the two pages always agree (a switch here redraws the other pages, and the Features page's redraws this). The profiles
// and the kinds are Story Block's settings (`assistProfile`, `assistExtractorProfile`, `assistExtractorKinds`), written through the
// same store as before. A row that cannot work now is **drawn and locked, with the reason**, never hidden: the safety net's profile
// and kinds while it is off, the pre-roll while no module keeps checks, the shared profile while both helpers are off, a profile
// select while the Connection Manager has no profile to pick.

import { SETTING, SCHEMA } from '../../assist/common.js';
import { KIND_CHOICES, allowedKinds } from '../../assist/safety.js';
import { renderAssistSection } from '../../assist/section.js';
import { CORE_FEATURE } from '../../features.js';
import { HOST_SETTINGS_SCHEMA } from '../../sdk.js';
import { renderSettingsForm } from '../form/form.js';
import { matchesSearch } from '../form/schema.js';
import { sectionBlock } from '../form/fields.js';
import { showAndFocus } from '../scroll.js';

/** Story Block's module id, and the fold key of its Assist group, which `openSettings({ fold })` has always taken for these settings. */
export const ASSIST_MODULE = 'story-block';
export const ASSIST_FOLD = `${ASSIST_MODULE}::group:Assist`;
/** The host setting this page draws (the Story Suite fold no longer does). */
export const ASSIST_HOST_KEYS = Object.freeze(['callQueue']);

export const ASSIST_TEXT = Object.freeze({
    callsTitle: 'Extra calls',
    checksTitle: 'Checks',
    netTitle: 'Safety net',
    runsTitle: 'Recent runs',
    runsHint: 'what the helpers did lately',
    profile: 'Connection for extra calls',
    preroll: 'Roll checks before the reply',
    net: 'Read changes the reply forgot',
    netProfile: 'Connection for the safety net',
    kinds: 'The safety net may write',
    kindsHelp: 'Pick the kinds of line it may add.',
    wall: 'Never coin, new items, XP, loot or healing. Those chips do not exist: the safety net never writes them, whatever is stored.',
    late: 'If it finishes after you have already sent your next message, its lines wait for the next reply and may not add anything new but someone arriving.',
    bothOff: 'Off while both helpers are off',
    netOff: 'Off while the safety net is off',
    noFeatures: 'Not available here',
});

const ids = Object.freeze({ preroll: CORE_FEATURE.preroll, net: CORE_FEATURE.extractor });

/**
 * The page's schema and the places its switches live. `featureOf(id)` is the feature store's entry now (label, describe,
 * available, why, on), `on(id)` whether it is on. → { schema, sources }. The order is the page's: Extra calls, Checks, Safety net.
 */
export function assistSchema({ featureOf, on, hostSettings, features }) {
    const feature = id => featureOf(id) ?? null;
    const usable = id => Boolean(feature(id)) && feature(id).available !== false;
    const switchFor = (id, label, group) => ({
        type: 'bool', group, label, help: feature(id)?.describe ?? '',
        readOnly: () => !features || !usable(id),
        lockText: () => (!features ? ASSIST_TEXT.noFeatures : feature(id)?.why || ASSIST_TEXT.noFeatures),
    });
    const calls = ASSIST_TEXT.callsTitle;
    const schema = {
        [SETTING.profile]: {
            ...SCHEMA[SETTING.profile], group: calls, label: ASSIST_TEXT.profile,
            readOnly: () => !on(ids.preroll) && !on(ids.net), lockText: ASSIST_TEXT.bothOff,
        },
        callQueue: { ...HOST_SETTINGS_SCHEMA.callQueue, group: calls },
        [ids.preroll]: switchFor(ids.preroll, ASSIST_TEXT.preroll, ASSIST_TEXT.checksTitle),
        [ids.net]: switchFor(ids.net, ASSIST_TEXT.net, ASSIST_TEXT.netTitle),
        [SETTING.extractorProfile]: {
            ...SCHEMA[SETTING.extractorProfile], group: ASSIST_TEXT.netTitle, label: ASSIST_TEXT.netProfile,
            readOnly: () => !on(ids.net), lockText: ASSIST_TEXT.netOff,
        },
        [SETTING.extractorKinds]: {
            type: 'text', form: 'chips', group: ASSIST_TEXT.netTitle, label: ASSIST_TEXT.kinds, help: ASSIST_TEXT.kindsHelp,
            options: KIND_CHOICES, read: text => [...allowedKinds(text)],
            readOnly: () => !on(ids.net), lockText: ASSIST_TEXT.netOff,
        },
    };
    const sources = {
        callQueue: { get: () => hostSettings().callQueue === true, set: value => hostSettings.set(null, 'callQueue', value) },
    };
    for (const id of Object.values(ids)) {
        sources[id] = {
            get: () => on(id) && usable(id),
            set: value => (features && usable(id) ? features.set(id, value) : undefined),
        };
    }
    return { schema, sources };
}

/** The Assist body: `(pane, ctx) → { filter, refresh, destroy, has, open }` (bodies.js). */
export function assistBody(pane, ctx) {
    const { registry, settings, features = null, sdk = null, profiles = null } = ctx.options;
    const def = typeof registry?.settingsDefs === 'function' ? registry.settingsDefs().find(item => item.moduleId === ASSIST_MODULE) : null;
    const hasPart = Boolean(def?.schema && Object.hasOwn(def.schema, SETTING.profile));
    const list = () => { try { return typeof features?.list === 'function' ? features.list() : []; } catch { return []; } };
    const featureOf = id => list().find(feature => feature.id === id);
    const on = id => { try { return typeof features?.on === 'function' ? features.on(id) === true : featureOf(id)?.on === true; } catch { return false; } };
    const hostSettings = Object.assign(() => settings(null), { set: settings.set });
    const { schema, sources } = hasPart ? assistSchema({ featureOf, on, hostSettings, features }) : { schema: {}, sources: {} };
    const form = renderSettingsForm(pane, {
        moduleId: ASSIST_MODULE, schema, settings, doc: ctx.doc, quiet: true, className: 'ss-assist-page', sources, profiles,
        onChange: () => ctx.changed?.(),
    });
    // What the helpers did lately: the old panel (a status read from the part, with its own Refresh), in a card of its own.
    const runs = sectionBlock(ctx.doc, { title: ASSIST_TEXT.runsTitle, hint: ASSIST_TEXT.runsHint });
    runs.el.classList.add('ss-assist-runs-card');
    const drawRuns = () => {
        runs.body.replaceChildren();
        renderAssistSection(runs.body, () => {
            try { return sdk?.query?.('assist.status') ?? { runs: [] }; } catch { return { runs: [] }; }
        });
    };
    if (hasPart) {
        drawRuns();
        pane.appendChild(runs.el);
    }
    // The value wall, stated plainly under the kinds (the code decides it; there is nothing to set).
    if (hasPart && form.field(SETTING.extractorKinds)) {
        const card = form.field(SETTING.extractorKinds).row.parentNode;
        for (const text of [ASSIST_TEXT.wall, ASSIST_TEXT.late]) {
            const line = ctx.doc.createElement('p');
            line.className = 'ss-assist-wall';
            line.textContent = text;
            card.appendChild(line);
        }
    }
    const first = () => {
        const key = form.keys()[0];
        return key ? form.field(key).row.querySelector('input, select, textarea, button') : null;
    };
    return {
        filter(text) {
            const shown = form.filter(text);
            const match = hasPart && matchesSearch('assist.runs', { label: ASSIST_TEXT.runsTitle, help: ASSIST_TEXT.runsHint }, 'Assist', text);
            runs.setHidden(!match);
            return shown + (hasPart && match && String(text ?? '').trim() ? 1 : 0);
        },
        refresh() {
            form.refresh();
            if (hasPart) drawRuns();
        },
        destroy() {
            form.destroy();
            runs.el.remove();
        },
        has: key => key === ASSIST_FOLD,
        open() {
            const input = first();
            return showAndFocus(input, 'center');
        },
    };
}
