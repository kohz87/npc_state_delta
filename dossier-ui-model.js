/* NPC State Delta dossier surface: dossier record lookups and presentation projections. */
import { appearanceFingerprint, currentPresentationText, normalizeAppearanceModel, resolveNpcAppearance } from './appearance.js';
import { formatBirthDate } from './birthday.js';
import { escapeHtml } from './src/util/html.js';
import { normalizeMemoryStamps } from './core-record-shared.js';
import { portraitSrc } from './src/portrait-file.js';

function plain(value, fallback = '') {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || fallback;
}

function stringList(value, limit = 12) {
    return (Array.isArray(value) ? value : [])
        .map(item => plain(item))
        .filter(Boolean)
        .slice(0, limit);
}

function relationshipValue(value) {
    return Math.max(-100, Math.min(100, Math.round(Number(value) || 0)));
}

const RELATIONSHIP_AXES = Object.freeze([['trust', 'Trust'], ['affection', 'Affection'], ['desire', 'Desire'], ['tension', 'Tension']]);

function wholeNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

// Reply numbers (1.2.3). A change recorded with its reply's chat message index shows "reply #N", the
// numbering Story Block shows (the greeting is reply #0). A record from before 1.2.3 has only Delta's
// own scan counter, which drifts from the chat with swipes and rescans; it keeps its old "turn N".
const LEGACY_TURN_NOTE = "Delta's own scan count, recorded before 1.2.3; it is not the reply number";

export function changeStamp(record = {}) {
    const message = wholeNumber(record?.message);
    if (message !== null) {
        return { message, legacy: false, text: `reply #${message}`, label: `Reply #${message}`, mark: `#${message}`, title: `Changed at reply #${message}` };
    }
    const turn = record?.turn === null || record?.turn === undefined || record?.turn === '' ? NaN : Number(record.turn);
    if (!Number.isFinite(turn)) return { message: null, legacy: false, text: '', label: '', mark: '', title: '' };
    return { message: null, legacy: true, text: `turn ${turn}`, label: `Turn ${turn}`, mark: `T${turn}`, title: `Changed at turn ${turn} (${LEGACY_TURN_NOTE})` };
}

// The dossier header: the latest assistant reply's message index, as Story Block's "reply #N".
export function replyHeaderLabel(projection = {}) {
    if (!projection?.chatKey || projection.chatKey === 'no-chat') return 'No chat';
    if (projection.hydrationStatus && projection.hydrationStatus !== 'ready') return projection.hydrationStatus === 'error' ? 'Unavailable' : 'Loading…';
    const reply = wholeNumber(projection.reply);
    return reply === null ? 'No replies yet' : `Reply #${reply}`;
}

function stampHtml(stamp, tag = 'small', className = '') {
    if (!stamp.label) return '';
    const classes = [className, stamp.legacy ? 'delta-legacy-turn' : ''].filter(Boolean).join(' ');
    return `<${tag}${classes ? ` class="${classes}"` : ''}${stamp.legacy ? ` title="${escapeHtml(stamp.title)}"` : ''}>${escapeHtml(stamp.label)}</${tag}>`;
}

function relationshipChangeProjection(change = {}) {
    const source = change && typeof change === 'object' ? change : {};
    const delta = source.delta && typeof source.delta === 'object' ? source.delta : {};
    const turn = Number.isFinite(Number(source.turn)) ? Number(source.turn) : null;
    const message = wholeNumber(source.message);
    return {
        impact: plain(source.impact, 'none').toLocaleLowerCase(),
        delta: Object.fromEntries(RELATIONSHIP_AXES.map(([axis]) => [axis, Math.round(Number(delta[axis]) || 0)])),
        reason: plain(source.reason),
        turn,
        message,
        when: changeStamp({ turn, message }).label,
    };
}

const FIELD_CHANGE_LABELS = Object.freeze({
    mood: 'Mood', location: 'Location', goal: 'Goal', status: 'Condition', homeBase: 'Home Base', age: 'Age',
    apparentAge: 'Apparent age', lifeState: 'Life state', personality: 'Personality', speech: 'Speech',
    behaviorProfile: 'Behavioral Levers', mannerisms: 'Mannerisms', appearance: 'Appearance', relationship: 'Relationship',
    relationshipSummary: 'Player Dynamic', background: 'Background', keyRelationships: 'Bonds', memories: 'Memories', birthDate: 'Birthday',
});

// Latest is still decided by Delta's turn counter; the reply number shows only when every field of
// that latest change carries the same one (a change from before 1.2.3 has none).
function fieldChangesProjection(value, messageValue) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const messages = messageValue && typeof messageValue === 'object' && !Array.isArray(messageValue) ? messageValue : {};
    const turns = Object.fromEntries(Object.keys(FIELD_CHANGE_LABELS)
        .map(field => [field, Number(source[field])])
        .filter(([, turn]) => Number.isInteger(turn) && turn >= 0));
    const latestTurn = Object.values(turns).reduce((max, turn) => Math.max(max, turn), -1);
    const latest = latestTurn >= 0 ? Object.keys(turns).filter(field => turns[field] === latestTurn) : [];
    const latestMessages = [...new Set(latest.map(field => wholeNumber(messages[field])))];
    return {
        latestTurn: latestTurn >= 0 ? latestTurn : null,
        latest,
        message: latestMessages.length === 1 ? latestMessages[0] : null,
    };
}

function portraitAppearanceChanged(npc = {}, shown = null) {
    const recorded = shown ? shown.fingerprint : plain(npc?.portrait?.appearanceFingerprint);
    const src = shown ? shown.src : plain(portraitSrc(npc?.portrait));
    if (!recorded || !src) return false;
    const current = appearanceFingerprint(npc, { version: recorded.startsWith('a1:') ? 1 : 2 });
    return Boolean(current) && current !== recorded;
}

function portraitSource(npc = {}, portraitAssets = {}) {
    const direct = npc?.portrait && typeof npc.portrait === 'object' ? npc.portrait : {};
    const asset = portraitAssets?.[npc?.id] && typeof portraitAssets[npc.id] === 'object' ? portraitAssets[npc.id] : {};
    return plain(portraitSrc(direct) || portraitSrc(asset));
}

export function dossierLifeBucket(npc = {}) {
    const reason = plain(npc?.archiveReason).toLocaleLowerCase();
    const lifeState = plain(npc?.lifeState).toLocaleLowerCase();
    if (reason === 'deceased' || lifeState === 'dead' || lifeState === 'deceased') return 'dead';
    if (npc?.archived === true) return 'archived';
    return 'active';
}

export function dossierStatusLabel(npc = {}) {
    const bucket = dossierLifeBucket(npc);
    if (bucket === 'dead') return 'Deceased';
    if (bucket === 'archived') return plain(npc?.archiveReason).toLocaleLowerCase() === 'stale' ? 'Archived · stale' : 'Archived';
    if (npc?.present === true) return 'In chat';
    if (npc?.worldActive === true) return 'Active off-screen';
    return 'Off-screen';
}

export function dossierIndexProjection(npc = {}, portraitAssets = {}) {
    return {
        id: plain(npc?.id),
        name: plain(npc?.name, 'Unnamed NPC'),
        aliases: stringList(npc?.aliases, 12),
        role: plain(npc?.role),
        species: plain(npc?.species),
        gender: plain(npc?.gender),
        homeBase: plain(npc?.homeBase),
        apparentAge: plain(npc?.apparentAge),
        location: plain(npc?.location),
        status: plain(npc?.status),
        present: npc?.present === true,
        worldActive: npc?.worldActive === true,
        archived: npc?.archived === true,
        archiveReason: plain(npc?.archiveReason),
        lifeState: plain(npc?.lifeState, 'unknown'),
        bucket: dossierLifeBucket(npc),
        statusLabel: dossierStatusLabel(npc),
        portrait: portraitSource(npc, portraitAssets),
        updatedAt: Number(npc?.updatedAt) || 0,
    };
}

// The displayed portrait follows the current appearance form when that form has its own image;
// otherwise it is the main portrait. Form images are read-only view data here.
function displayedPortrait(npc = {}, portraitAssets = {}, formPortraits = {}) {
    const form = plain(npc?.currentForm);
    const formImage = form ? Object.entries(formPortraits || {}).find(([name]) => name.toLocaleLowerCase() === form.toLocaleLowerCase())?.[1] : null;
    if (formImage?.dataUrl) return { src: plain(formImage.dataUrl), fingerprint: plain(formImage.appearanceFingerprint), form, fromForm: true };
    return { src: portraitSource(npc, portraitAssets), fingerprint: plain(npc?.portrait?.appearanceFingerprint), form: plain(npc?.portrait?.appearanceForm), fromForm: false };
}

// (cleanup step 7) With `customFieldNames` (the configured names), only those custom fields are shown,
// as the injection and the suite profile show them; without it, every stored one (older callers).
function shownCustomFields(npc, customFieldNames) {
    const stored = Object.entries(npc?.customFields && typeof npc.customFields === 'object' ? npc.customFields : {});
    const configured = Array.isArray(customFieldNames) ? customFieldNames.map(name => plain(name).toLowerCase()).filter(Boolean) : null;
    return stored
        .filter(([name]) => !configured || configured.includes(plain(name).toLowerCase()))
        .map(([name, value]) => [plain(name), plain(value)]).filter(([name, value]) => name && value).slice(0, 12);
}

export function dossierDetailProjection(npc = {}, portraitAssets = {}, formPortraits = {}, { customFieldNames } = {}) {
    const rel = npc?.relationship && typeof npc.relationship === 'object' ? npc.relationship : {};
    const shown = displayedPortrait(npc, portraitAssets, formPortraits);
    return {
        ...dossierIndexProjection(npc, portraitAssets),
        portrait: shown.src,
        portraitFromForm: shown.fromForm,
        formPortraits: Object.fromEntries(Object.entries(formPortraits || {}).filter(([, image]) => image?.dataUrl).map(([name, image]) => [name, plain(image.dataUrl)])),
        age: plain(npc?.age),
        appearance: resolveNpcAppearance(npc),
        appearanceModel: normalizeAppearanceModel(npc, { locked: Array.isArray(npc?.manualProfileFields) && npc.manualProfileFields.includes('appearance') }),
        currentPresentation: currentPresentationText(npc),
        birthday: formatBirthDate(npc?.birthDate),
        birthdaySource: plain(npc?.birthDateSource),
        personality: plain(npc?.personality),
        behaviorProfile: stringList(npc?.behaviorProfile, 10),
        speech: plain(npc?.speech),
        mannerisms: stringList(npc?.mannerisms, 10),
        background: plain(npc?.background),
        memories: stringList(npc?.memories, 8),
        memoryStamps: normalizeMemoryStamps(npc?.memoryStamps, npc?.memories) ?? {},
        keyRelationships: stringList(npc?.keyRelationships, 12),
        customFields: shownCustomFields(npc, customFieldNames),
        relationshipSummary: plain(npc?.relationshipSummary),
        lastRelationshipChange: relationshipChangeProjection(npc?.lastRelationshipChange),
        fieldChanges: fieldChangesProjection(npc?.fieldChanges, npc?.fieldChangeMessages),
        portraitAppearanceChanged: portraitAppearanceChanged(npc, shown),
        portraitForm: shown.form,
        recentRelationshipChanges: (Array.isArray(npc?.relationshipEventHistory) ? npc.relationshipEventHistory : [])
            .slice(-12)   // the card shows three, after it leaves out this reply's own event (dossier-ui-relationship.js)
            .reverse()
            .map(event => ({
                impact: plain(event?.impact, 'ordinary').toLocaleLowerCase(),
                reason: plain(event?.reason),
                turn: Number.isFinite(Number(event?.turn)) ? Number(event.turn) : null,
                message: wholeNumber(event?.message),
                // The axes the event had evidence for: the stored history keeps the tier, the evidence and the reason, no signed numbers.
                axes: RELATIONSHIP_AXES.filter(([axis]) => plain(event?.evidence?.[axis])).map(([, label]) => label),
            }))
            .filter(event => event.reason),
        relationship: {
            trust: relationshipValue(rel.trust),
            affection: relationshipValue(rel.affection),
            desire: relationshipValue(rel.desire),
            tension: relationshipValue(rel.tension),
        },
        mood: plain(npc?.mood),
        goal: plain(npc?.goal),
        lifeStateCertainty: plain(npc?.lifeStateCertainty),
        lifeStateReason: plain(npc?.lifeStateReason),
    };
}

export { plain, stringList, relationshipValue, RELATIONSHIP_AXES, wholeNumber, stampHtml, FIELD_CHANGE_LABELS };
