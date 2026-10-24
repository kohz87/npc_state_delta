// The `profile` settings field type (MODULES §G): a dropdown of SillyTavern's Connection Manager
// profiles plus "Same as chat", for the connection a module's sdk.callModel uses. It stores the
// profile's name ('' for the chat's connection). The list is read when the field is drawn
// (listProfiles: names only, never a profile's address or key). Built with textContent only.

import { listProfiles, profileName } from './model-call.js';

export const PROFILE_TEXT = Object.freeze({
    same: 'Same as chat',
    missing: '{name} (not found)',
    none: 'There are no connection profiles yet, so calls use the chat\'s connection. Make one in SillyTavern\'s Connection Manager to pick it here.',
    gone: 'The profile "{name}" is not in the Connection Manager any more; calls with it fail until you pick another.',
});

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));

/**
 * What the field shows for the stored `value`: { options: [{ value, label }], selected, note }. The first
 * option is "Same as chat" (''); then the profiles by name; a stored name no profile has any more stays
 * as an option ("… (not found)"), so it is not changed behind the reader's back. `note` is a plain
 * sentence, or '' when there is nothing to say: no Connection Manager, it is turned off, no profiles, or
 * the stored one is gone. `list` is listProfiles()'s answer (read from SillyTavern by default).
 */
export function profileChoices(value, list = listProfiles()) {
    const selected = profileName(value);
    const usable = list?.usable === true;
    const names = [];
    for (const profile of usable && Array.isArray(list.profiles) ? list.profiles : []) {
        const name = profileName(profile?.name);
        if (name && !names.includes(name)) names.push(name);
    }
    const options = [{ value: '', label: PROFILE_TEXT.same }, ...names.map(name => ({ value: name, label: name }))];
    const known = !selected || names.includes(selected);
    if (!known) options.push({ value: selected, label: fill(PROFILE_TEXT.missing, { name: selected }) });
    let note = '';
    if (!usable) note = String(list?.why || PROFILE_TEXT.none);
    else if (!names.length && !selected) note = PROFILE_TEXT.none;
    else if (!known) note = fill(PROFILE_TEXT.gone, { name: selected });
    return { options, selected, note };
}

/** The dropdown: a `select` of profileChoices(value); `onChange(name)` gets '' or a profile's name. */
export function profileSelect(doc, value, onChange, list = listProfiles()) {
    const { options, selected } = profileChoices(value, list);
    const select = doc.createElement('select');
    select.className = 'text_pole';
    for (const option of options) {
        const node = doc.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        select.appendChild(node);
    }
    select.value = selected;
    select.dataset.profile = 'true';
    select.addEventListener('change', () => onChange(profileName(select.value)));
    return select;
}

/** The note under the field's label (a `small`), or null when there is nothing to say. */
export function profileNote(doc, value, list = listProfiles()) {
    const { note } = profileChoices(value, list);
    if (!note) return null;
    const node = doc.createElement('small');
    node.className = 'story-suite-profile-note';
    node.textContent = note;
    return node;
}
