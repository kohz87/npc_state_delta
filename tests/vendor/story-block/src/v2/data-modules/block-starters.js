// The starters at the top of New block: three built-in drafts, kept in code like the RPG templates. Picking one fills the editor's form (fields, layout,
// card roles, tab name) and everything stays editable before Save. A starter is a draft, so the editor and buildBlock treat it like one the reader typed.
import { partKey } from './block-builder.js';
import { slugify } from '../packs/validate/core.js';

const text = (name, max, extra = {}) => ({ name, type: 'text', max, default: '', ...extra });
const number = (name, min, max, extra = {}) => ({ name, type: 'number', min, max, default: 0, ...extra });

// Every field and every part of an entry has the key the form gives it from its name.
const keyed = draft => {
    for (const field of draft.fields) {
        field.key ??= slugify(field.name).slice(0, 32).replace(/-+$/, '');
        for (const part of field.of ?? []) part.key ??= partKey(part.name);
    }
    return draft;
};

const STARTERS = [
    { id: 'quest-log', name: 'Quest log', about: 'A list of quests the story adds to.',
        draft: () => ({ name: 'Quest log', prompt: 'The quests the party has taken: add one when it is given, change its step or status as it moves, drop one that no longer matters.',
            fields: [{ key: 'quests', name: 'Quests', type: 'entries', max: 25, of: [
                text('Title', 60), text('Description', 240), text('Step', 120),
                { name: 'Status', type: 'choice', values: ['active', 'done', 'failed'], default: 'active' }, text('Giver', 60), text('Reward', 60)] }],
            functions: [], layout: 'cards', roles: { field: 'quests', title: 'title', status: 'status', step: 'step' },
            show: { tab: true, card: false, tabName: 'Quests', icon: 'ph-bookmark-simple' } }) },
    { id: 'reputation', name: 'Reputation by place', about: 'A number for each faction or town, drawn as bars.',
        draft: () => ({ name: 'Reputation', prompt: 'How well known and trusted the party is in each place.',
            fields: ['Bluewatch', 'River Confederacy', 'Shornmarch', 'Highmark'].map(name => number(name, -100, 100)),
            functions: [], layout: 'bars', show: { tab: true, card: false, tabName: 'Reputation', icon: 'ph-star' } }) },
    { id: 'membership', name: 'Membership card', about: 'One record: who, rank, dues.',
        draft: () => ({ name: 'Membership', prompt: 'The party\'s standing in one guild or order.',
            fields: [text('Member', 60), { name: 'Rank', type: 'choice', values: ['initiate', 'member', 'elder'], default: 'initiate' }, number('Dues owed', 0, 500),
                text('Joined', 60), text('Perk', 120)],
            functions: [], layout: 'fields', show: { tab: true, card: false, tabName: 'Membership', icon: 'ph-scroll' } }) },
];

/** → [{ id, name, about, draft() }]: a fresh draft each time. */
export const BLOCK_STARTERS = Object.freeze(STARTERS.map(item => Object.freeze({ ...item, draft: () => keyed(item.draft()) })));
export const STARTER_IDS = Object.freeze(BLOCK_STARTERS.map(item => item.id));
