// Story Director and pack lookups for the Story Suite v2 adapter. A pure part of src/adapter/queries.js
// (same owner, moved without change); queries.js re-exports every public name it exported before.
import { storyMinuteText } from '../../calendar.js';
import { CAST_QUERY, KEY_PEOPLE_QUERY } from '../npc-meters.js';
import { normalizeKeyPeople } from '../key-people.js';
import { normalizeCast } from '../cast-dossier.js';
import { safeImageUrl } from './queries-dossier.js';

// Story Block's query for a pack portrait's image URL (read only): packs.portrait({ pack, file }) → a safe URL or null.
const PORTRAIT_QUERY = 'packs.portrait';
// Story Block 2.18.0's query for a pack cast member's signature gear line (read only): packs.castGear({ name }) → { name, line: "Gear: A, B", items } or null.
const CAST_GEAR_QUERY = 'packs.castGear';
const KEY_PEOPLE_FEATURE = 'story-director.key-people';

export function createDirectorQueriesPart(session, deps, { hostFeature }) {
    const { KEY_PIN_COMMAND, WORLD_FEATURE } = deps;

    // Whether Story Director's World screen shows the present cast (its feature on); a host without the
    // Features API: whether Story Director is registered.
    function worldShown() {
        if (!session.hosted) return false;
        const on = hostFeature(WORLD_FEATURE);
        if (on !== undefined) return on === true;
        try { return (session.sdkRef?.modules?.() ?? []).some(module => module?.id === 'story-director'); } catch { return false; }
    }

    // Story Director's key people (`director.keyPeople`, read only) as it answers, or null: not hosted, no Story Director,
    // or one without the query. Null means "no key people anywhere", never an error.
    function keyPeopleAnswer() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
        try {
            const answer = session.sdkRef.query(KEY_PEOPLE_QUERY, {});
            return Array.isArray(answer) ? answer : null;
        } catch {
            return null;
        }
    }
    // Whether the key list can be trusted: true when Story Director is not registered on the host (read from the host's modules, as
    // worldShown does, never from an error code: then there is simply no key list), or when it answers a list or null (its feature off);
    // false when a registered Story Director throws or answers a non-list, or when the host cannot say. The stale pass deletes nothing while false.
    function keyPeopleReadable() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return true;
        try {
            if (!(session.sdkRef.modules?.() ?? []).some(module => module?.id === 'story-director')) return true;
        } catch { return false; }
        try {
            const answer = session.sdkRef.query(KEY_PEOPLE_QUERY, {});
            return answer === null || answer === undefined || Array.isArray(answer);
        } catch {
            return false;
        }
    }
    // The memory of key people's last absences (npc.keyAway; the slice's `keyAway`), {} when there is none or no host.
    function keyAwayMemory() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return {};
        try {
            const memory = session.sdkRef.query('npc.keyAway', {});
            return memory && typeof memory === 'object' && !Array.isArray(memory) ? memory : {};
        } catch {
            return {};
        }
    }
    // The living cast (Story Director's `director.cast`, read only): the cleaned answer with its dates written on Story Director's
    // calendar, or null (not hosted, no Story Director, or one without the query). Null means "no cast anywhere".
    function castAnswer() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
        try {
            const answer = session.sdkRef.query(CAST_QUERY, {});
            return Array.isArray(answer) ? answer : null;
        } catch {
            return null;
        }
    }
    function castPeople() {
        const answer = castAnswer();
        if (!answer) return null;
        const calendar = directorCalendar();
        return normalizeCast(answer, minutes => storyMinuteText(minutes, calendar));
    }
    // The slice's record of the cast dossiers made (npc.castMade), {} when there is none or no host.
    function castMade() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return {};
        try {
            const made = session.sdkRef.query('npc.castMade', {});
            return made && typeof made === 'object' && !Array.isArray(made) ? made : {};
        } catch {
            return {};
        }
    }
    // Packs' names by id (`packs.list`), for the badge; {} when the host cannot say.
    function packNames() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return {};
        try {
            const list = session.sdkRef.query('packs.list', {});
            return Object.fromEntries((Array.isArray(list) ? list : []).filter(pack => pack && typeof pack.id === 'string')
                .map(pack => [pack.id, String(pack.name ?? pack.title ?? '').trim()]).filter(([, name]) => name));
        } catch {
            return {};
        }
    }
    // A pack portrait's image URL (`packs.portrait`) as a safe URL (safeImageUrl), or null.
    function packPortraitUrl(pack, file) {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function' || !pack || !file) return null;
        try { return safeImageUrl(session.sdkRef.query(PORTRAIT_QUERY, { pack, file })); } catch { return null; }
    }
    // A pack cast member's one "Gear: A, B" line (`packs.castGear`), or '' (no host, an older Story Block without the query, or it answers null).
    function castGearLine(name) {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function' || !name) return '';
        try {
            const line = session.sdkRef.query(CAST_GEAR_QUERY, { name })?.line;
            return typeof line === 'string' ? line.replace(/\s+/g, ' ').trim() : '';
        } catch { return ''; }
    }
    // Whether Story Director offers the reader's pin (`keypeople.pin`, registered by a ready module, its feature not switched off).
    // Delta only ever asks; Story Director's own command writes its own state.
    function keyPinOffered() {
        if (!session.hosted || typeof session.sdkRef?.modules !== 'function') return false;
        try {
            const offered = (session.sdkRef.modules() ?? []).some(module => module?.status === 'ready' && Array.isArray(module.commands) && module.commands.includes(KEY_PIN_COMMAND));
            return offered && hostFeature(KEY_PEOPLE_FEATURE) !== false;
        } catch {
            return false;
        }
    }
    // Story Director's calendar (`director.calendar`: { era, months, leapYears }), or null when it has none to give; Story Director's
    // key people carry their dates as story minutes, which index.js writes on it (calendar.js storyMinuteText).
    function directorCalendar() {
        try {
            const config = session.hosted && typeof session.sdkRef?.query === 'function' ? session.sdkRef.query('director.calendar', {}) : null;
            return config && typeof config === 'object' && Array.isArray(config.months) ? config : null;
        } catch {
            return null;
        }
    }
    // Story Block's `party.levels` ([{ id, name, level, left }], left members too), or null: not hosted, no host query, or the RPG off.
    function partyLevelsAnswer() {
        if (!session.hosted || typeof session.sdkRef?.query !== 'function') return null;
        try {
            const answer = session.sdkRef.query('party.levels', {});
            return Array.isArray(answer) ? answer : null;
        } catch {
            return null;
        }
    }
    // The key people, cleaned (src/key-people.js normalizeKeyPeople); the dates are left to the caller (they are not needed for names).
    function keyPeople() {
        const answer = keyPeopleAnswer();
        return answer ? normalizeKeyPeople(answer) : null;
    }

    return { worldShown, partyLevelsAnswer, keyPeopleAnswer, keyPeopleReadable, keyAwayMemory, castAnswer, castPeople, castMade, packNames, packPortraitUrl, castGearLine, keyPinOffered, directorCalendar, keyPeople };
}
