/* NPC State Delta targeted-pass scope (role: targeted-pass-scope). The rules that decide which returned rows,
   profile updates and relationship edges belong to a single-target request. Split from runtime-targeted.js;
   bodies are moved without change. */

import { npcMatchesLabel, normalizeName } from './core.js';
import { resolveNpcReference } from './social.js';

export function createTargetedScopePart() {
    function backfillScanMatchesTarget(npc, request) {
        if (!npc || !request) return false;
        if (npc.id && request.npcId && String(npc.id) === String(request.npcId)) return true;
        if (npcMatchesLabel(npc, request.label)) return true;
        const target = normalizeName(request.label);
        if (!target) return false;
        const labels = [npc.name, ...(npc.aliases || [])].map(normalizeName).filter(Boolean);
        if (labels.some(label => label === target || label.startsWith(`${target} `) || target.startsWith(`${label} `))) return true;
        // A role names its owner only for a role-labelled target ("clerk" for "Gate Clerk"); a role that
        // merely mentions the target ("Assistant to Mira Deep") belongs to someone else.
        const role = normalizeName(npc.role);
        return Boolean(role && role !== target && target.includes(role));
    }

    // A returned row is admissible for a single-target request only if no explicit identity field
    // contradicts the target: another roster member's id or name, or (for a proper-named target) a name
    // that is neither the target's label nor an expansion of it. Interim (role-labelled) targets may be
    // renamed by a revealed proper name.
    function rowContradictsTarget(row, target, roster = []) {
        if (!row || !target) return true;
        const others = (Array.isArray(roster) ? roster : []).filter(npc => npc && npc.id !== target.id);
        const rowId = String(row.id || '').trim();
        if (rowId && rowId !== String(target.id) && others.some(npc => String(npc.id) === rowId)) return true;
        const rowName = String(row.name || '').trim();
        if (!rowName) return false;
        if (npcMatchesLabel(target, rowName)) return false;
        if (others.some(npc => npcMatchesLabel(npc, rowName))) return true;
        const key = normalizeName(rowName);
        const expansion = [target.name, ...(target.aliases || [])].map(normalizeName).filter(Boolean)
            .some(label => key.startsWith(`${label} `) || label.startsWith(`${key} `));
        if (expansion) return false;
        return String(target.identityKind || 'proper_name') === 'proper_name';
    }

    // Single-target channel scope must agree with what the merge will mutate. A profile row binds to the
    // target only when no explicit identity field contradicts it (an exact id with another NPC's name is
    // a contradiction); it is rewritten to the target's id and name so later name-based matching cannot
    // reach the other NPC. An edge endpoint resolves like social.parseScanEdges (explicit id first, then
    // label); an endpoint whose id and label name different people rejects the edge.
    function profileRowBindsToTarget(row, target, roster = []) {
        if (!row || typeof row !== 'object' || !target) return false;
        const rowId = String(row.id || '').trim();
        if (rowId && rowId !== String(target.id)) return false;
        if (!rowId && !String(row.name || '').trim()) return false;
        return !rowContradictsTarget(row, target, roster);
    }

    function edgeTouchesResolvedTarget(edge, target, roster = []) {
        if (!edge || typeof edge !== 'object' || !target) return false;
        const npcs = (Array.isArray(roster) ? roster : []).some(npc => String(npc?.id || '') === String(target.id)) ? roster : [...(roster || []), target];
        const endpoint = (idValue, labelValue) => {
            const id = String(idValue || '').trim();
            const label = String(labelValue || '').trim();
            const resolved = resolveNpcReference(npcs, id || label);
            if (resolved && id && label && String(resolved.id) === id && rowContradictsTarget({ name: label }, resolved, npcs)) return { contradiction: true };
            return { npc: resolved };
        };
        const a = endpoint(edge.aId ?? edge.a_id, edge.a ?? edge.from ?? edge.source);
        const b = endpoint(edge.bId ?? edge.b_id, edge.b ?? edge.to ?? edge.target);
        if (a.contradiction || b.contradiction) return false;
        return String(a.npc?.id || '') === String(target.id) || String(b.npc?.id || '') === String(target.id);
    }

    function scopeProfileUpdatesToTarget(parsed, target, roster = []) {
        const rawProfiles = Array.isArray(parsed?.profileUpdates) ? parsed.profileUpdates : (Array.isArray(parsed?.profile_updates) ? parsed.profile_updates : []);
        parsed.profileUpdates = rawProfiles.filter(row => profileRowBindsToTarget(row, target, roster)).map(row => ({ ...row, id: target.id, name: target.name }));
        delete parsed.profile_updates;
        return parsed.profileUpdates;
    }

    // A single-target request may accept its only returned row even when the model changed the label
    // (e.g. expanded a short name), but never a row that explicitly identifies someone else: that
    // would write another NPC's lifecycle and profile into the requested dossier.
    function soleRowMayBeTarget(row, { npcId = '', labels = [] } = {}, roster = []) {
        if (!row || typeof row !== 'object') return false;
        const rowName = String(row.name || '').trim();
        const targetLabels = labels.map(label => String(label || '').trim()).filter(Boolean);
        if (rowName) {
            const rowRecord = { name: rowName, aliases: Array.isArray(row.aliases) ? row.aliases : [] };
            return targetLabels.some(label => backfillScanMatchesTarget(rowRecord, { npcId: '', label }));
        }
        const rowId = String(row.id || '').trim();
        return !(rowId && rowId !== String(npcId) && roster.some(npc => String(npc?.id || '') === rowId));
    }

    function transcriptMentionsBackfillTarget(transcript, label) {
        const target = normalizeName(label);
        const haystack = normalizeName(transcript);
        if (!target || !haystack) return false;
        return (` ${haystack} `).includes(` ${target} `);
    }

    return { backfillScanMatchesTarget, rowContradictsTarget, profileRowBindsToTarget, edgeTouchesResolvedTarget, scopeProfileUpdatesToTarget, soleRowMayBeTarget, transcriptMentionsBackfillTarget };
}
