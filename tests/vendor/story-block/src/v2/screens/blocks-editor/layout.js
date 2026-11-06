// The block editor's layout chips, card-role controls, status colours and preview (moved out of
// screens/blocks-editor.js; editor.js calls this part).

import { LAYOUTS, TONES, exampleValues, statusTones } from '../../data-modules/block-layout.js';
import { buildBlock, defaultTone } from '../../data-modules/block-builder.js';
import { fill } from '../../strings.js';
import { S, LAYOUT_NAMES, TONE_NAMES } from './constants.js';

export function createLayoutPart({ node, button, control, collect, refresh, draw, setSpot, draft, meta, renderPreview, tabs, used, resolve }) {
    let previewHandle = null, paintPreview = () => {};
    // Layout (three chips, one line on where the choice came from, the reason a chip is off), the card roles and status colours of a list of cards, and the preview.
    function paintLayout(form) {
        const now = resolve(), { shape, effective } = now;
        const section = node('section', 'ss-block-layout', '', form);
        node('h4', 'ss-section-label', S.layout, section);
        const chips = node('div', 'ss-block-chips', '', section);
        for (const layout of LAYOUTS) {
            const item = button(chips, LAYOUT_NAMES[layout], () => { collect(); draft.layout = layout; meta.layoutBy = 'chosen'; meta.layoutNote = ''; draw(); },
                `ss-button ss-chip${effective === layout ? ' ss-chip-on' : ''}`);
            item.disabled = !shape.fits[layout].ok;
            item.setAttribute('aria-pressed', String(effective === layout));
        }
        const why = meta.layoutNote || (meta.layoutBy === 'chosen' ? `${S.whyChosen}${shape.why}` : meta.layoutBy === 'starter' ? `${fill(S.whyStarter, { name: meta.starterName })}${shape.why}` : shape.why);
        const line = node('p', 'ss-block-hint ss-block-layout-why', why, section); line.setAttribute('role', 'status');
        if (!shape.suggested) { /* (an empty form: the line above is the only reason) */ } else {
            for (const layout of LAYOUTS) if (!shape.fits[layout].ok) node('p', 'ss-block-hint ss-block-layout-reason', `${LAYOUT_NAMES[layout]}: ${shape.fits[layout].reason}`, section);
        }
        const layoutError = node('small', 'ss-block-control-error', '', section); layoutError.setAttribute('role', 'alert'); setSpot('layout', layoutError);
        if (now.roles) {
            const roles = node('div', 'ss-block-roles', '', section);
            node('h5', 'ss-block-parts-title', S.cardRoles, roles);
            const lists = draft.fields.filter(field => field.type === 'entries' && field.of.some(part => part.type === 'text'));
            const field = lists.find(item => item.key === now.roles.field) ?? lists[0];
            const partsOf = type => field.of.filter(part => part.type === type).map(part => ({ value: part.key, label: part.name || part.key }));
            const set = (key, value) => { draft.roles = { ...(draft.roles ?? now.roles), [key]: value }; meta.rolesAuthor = true; meta.rolesGuessed = false; };
            if (lists.length > 1) {
                const list = control(roles, S.roleList, field.key, { type: 'choice', options: lists.map(item => ({ value: item.key, label: item.name || item.key })) },
                    value => { if (value !== draft.roles?.field) { draft.roles = { field: value }; meta.rolesAuthor = false; } }, 'roles:field');
                list.input.addEventListener('change', refresh);
            }
            const pick = (label, key, options, spot) => {
                const handle = control(roles, label, now.roles[key], { type: 'choice', options }, value => { if (value !== now.roles[key]) set(key, value); }, spot);
                handle.input.addEventListener('change', refresh);
            };
            const none = { value: '', label: S.roleNone };
            pick(S.roleTitle, 'title', partsOf('text'), 'roles:title');
            pick(S.roleStatus, 'status', [none, ...partsOf('choice')], 'roles:status');
            pick(S.roleStep, 'step', [none, ...partsOf('text').filter(option => option.value !== now.roles.title)], 'roles:step');
            if (meta.rolesGuessed) node('small', 'ss-block-hint', S.rolesGuessed, roles);
            const others = field.of.filter(part => ![now.roles.title, now.roles.status, now.roles.step].includes(part.key));
            const description = others.find(part => part.type === 'text'), rest = others.filter(part => part !== description);
            const also = [description ? `${description.name} under the title` : '', rest.length ? `${rest.map(part => part.name).join(', ')} in a small line` : ''].filter(Boolean).join(', and ');
            if (also) node('small', 'ss-block-hint', fill(S.rolesAlso, { text: `${also}.` }), roles);
            const tones = statusTones(draft, now.roles);
            if (tones.length) {
                const colours = node('div', 'ss-block-tones', '', roles);
                node('h5', 'ss-block-parts-title', S.statusColours, colours);
                for (const { value, tone } of tones) {
                    const rowTone = node('div', 'ss-block-tone-row', '', colours);
                    node('span', `ss-pill ss-block-tone ss-block-tone-${tone}`, value, rowTone);
                    const choice = control(rowTone, value, tone, { type: 'choice', options: TONES.map(each => ({ value: each, label: TONE_NAMES[each] })) }, next => {
                        if (next === (draft.tones?.[value] ?? defaultTone(value))) return;
                        if (next === defaultTone(value)) { delete draft.tones?.[value]; if (draft.tones && !Object.keys(draft.tones).length) delete draft.tones; } else (draft.tones ??= {})[value] = next;
                    }, `tone:${value}`);
                    choice.input.addEventListener('change', refresh);
                }
            }
        }
        // (the preview is a child of the form itself, so that it can stay in view below the fields above it)
        const preview = node('section', 'ss-block-preview ss-glass', '', form);
        node('h4', 'ss-section-label', S.preview, preview);
        const body = node('div', 'ss-block-preview-body', '', preview), where = node('small', 'ss-block-hint', '', preview);
        paintPreview = () => {
            try { previewHandle?.destroy?.(); } catch { /* (a preview is only a picture) */ }
            previewHandle = null; body.replaceChildren(); where.textContent = '';
            if (!draft.fields.length) { node('p', 'ss-block-hint', S.previewNothing, body); return; }
            const live = resolve();
            const built = buildBlock({ ...draft, ...(live.effective ? { layout: live.effective } : {}), ...(live.roles ? { roles: live.roles } : {}) }, { used });
            const definition = built.definition;
            if (!definition) { node('p', 'ss-block-hint', S.previewBroken, body); return; }
            const values = exampleValues(definition);
            try { previewHandle = renderPreview ? renderPreview(body, { definition, values, layout: definition.layout ?? 'fields' }) : sketch(body, definition, values); } catch { sketch(body, definition, values); }
            node('small', 'ss-block-hint', S.previewExample, body);
            const show = definition.show;
            where.textContent = !show.tab ? '' : show.into ? fill(S.previewInto, { tab: tabs.find(tab => tab.id === show.into)?.title ?? show.into }) : fill(S.previewOwn, { name: show.tabName });
        };
        paintPreview();
    }
    // The plain sketch of a block in each layout, used until the host hands in its own drawing: cards with a status chip, bars, lines.
    function sketch(parent, definition, values) {
        const wrap = node('div', `ss-block-sketch ss-block-sketch-${definition.layout ?? 'fields'}`, '', parent);
        const roles = definition.roles;
        for (const [key, schema] of Object.entries(definition.state)) {
            if (definition.layout === 'cards' && schema.type === 'entries' && roles?.field === key) {
                const tone = value => definition.tones?.[value] ?? defaultTone(value);
                const done = [];
                for (const entry of values[key]) {
                    const state = roles.status ? entry[roles.status] : null, finished = state !== null && ['done', 'failed'].includes(tone(state));
                    // (a finished card waits for the fold below the active ones)
                    const box = node('div', 'ss-block-sketch-card', '', finished ? null : wrap);
                    const head = node('div', 'ss-block-sketch-head', '', box);
                    node('b', '', entry[roles.title], head);
                    if (state !== null) node('span', `ss-pill ss-block-tone ss-block-tone-${tone(state)}`, state, head);
                    if (roles.step && entry[roles.step]) node('small', 'ss-block-hint', entry[roles.step], box);
                    if (finished) done.push(box);
                }
                if (done.length) {
                    const fold = node('details', 'ss-block-sketch-fold', '', wrap);
                    node('summary', '', fill(S.previewMore, { n: done.length }), fold);
                    for (const card of done) fold.appendChild(card);
                }
            } else if (definition.layout === 'bars' && schema.type === 'int') {
                const line = node('div', 'ss-block-sketch-bar', '', wrap);
                node('span', '', `${schema.label ?? key} ${values[key]}`, line);
                const track = node('span', 'ss-block-sketch-track', '', line);
                const bar = node('span', 'ss-block-sketch-fill', '', track);
                bar.setAttribute('style', `width:${Math.round(100 * (values[key] - schema.min) / Math.max(1, schema.max - schema.min))}%`);
            } else {
                const line = node('div', 'ss-block-sketch-line', '', wrap);
                node('span', 'ss-block-hint', schema.label ?? key, line);
                node('span', '', schema.type === 'entries' ? `${values[key].length}` : String(values[key]), line);
            }
        }
        return null;
    }
    return { paintLayout, paintPreview: () => paintPreview() };
}
