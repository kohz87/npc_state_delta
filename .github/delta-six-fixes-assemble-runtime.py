from pathlib import Path
import subprocess

TARGETS = {
    'core-mechanics.js': '64604d9',
    'appearance.js': '963b08c',
    'continuity-core.js': '6aaa64a',
    'social.js': '6958faf',
}

def blob(path):
    return subprocess.check_output(['git', 'hash-object', path], text=True).strip()

def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    return text.replace(old, new, 1)

current = {path: blob(path) for path in TARGETS}
if all(current[path].startswith(prefix) for path, prefix in TARGETS.items()):
    for path, sha in current.items():
        print(f'{path}={sha}')
    raise SystemExit(0)

if not current['core-mechanics.js'].startswith(TARGETS['core-mechanics.js']):
    raise SystemExit(f"core-mechanics.js is not the reviewed blob: {current['core-mechanics.js']}")

patch_lines = Path('.github/delta-six-fixes-runtime.patch').read_text(encoding='utf-8').splitlines(True)
out = []
skipping = False
for line in patch_lines:
    if line.startswith('@@ -684,24 +723,56 @@'):
        skipping = True
        continue
    if skipping and line.startswith('@@ -853,7 +924,11 @@'):
        skipping = False
        out.append(line)
        continue
    if not skipping:
        out.append(line)
if skipping:
    raise SystemExit('failed to locate end of filtered social hunk')

safe_patch = Path('/tmp/runtime-safe.patch')
safe_patch.write_text(''.join(out), encoding='utf-8')
subprocess.run(['git', 'apply', '--recount', '--check', str(safe_patch)], check=True)
subprocess.run(['git', 'apply', '--recount', str(safe_patch)], check=True)

path = Path('social.js')
text = path.read_text(encoding='utf-8')

end_anchor = """        }
    }
    return facts;
}

function ensureUnresolvedFacts(graph, facts = []) {
"""
end_replacement = r"""        }
        for (const raw of Array.isArray(npc?.keyRelationships) ? npc.keyRelationships : []) {
            const parsed = parseKeyRelationshipEntry(raw);
            if (!parsed) continue;
            const shape = collectiveRelationshipShape(parsed);
            if (shape) {
                pushFact(npc, shape.expectedCount, parsed.relation, shape.sharedDescriptor, [], raw);
            }
        }
    }
    return facts;
}

function collectiveDescriptorGrounded(value, descriptor) {
    const text = norm(value);
    const shared = norm(descriptor);
    if (!shared) return true;
    if (shared === 'twins' || shared === 'twin') return /\btwins?\b/.test(text);
    return text.includes(shared);
}

function existingEdgeProvesCollectiveMembership(edge, ownerId, fact) {
    const view = relationFromPerspective(edge, ownerId);
    if (!view) return false;
    if (fact.sharedDescriptor && collectiveDescriptorGrounded(edge.sharedDescriptor, fact.sharedDescriptor)) return true;
    if (confidenceRank(edge.confidence) < confidenceRank('explicit')) return false;
    return collectiveDescriptorGrounded(`${view.relation} ${view.reverse} ${edge.reason}`, fact.sharedDescriptor);
}

function ensureUnresolvedFacts(graph, facts = []) {
"""
text = replace_once(text, end_anchor, end_replacement, 'social extract-facts')

resolved_anchor = """        const existingResolved = graph.edges.filter(edge => {
            const view = relationFromPerspective(edge, ownerId);
            return view && socialRelationFamily(view.relation) === family;
        }).length;
"""
resolved_replacement = """        const existingEdges = graph.edges.filter(edge => {
            const view = relationFromPerspective(edge, ownerId);
            return view && socialRelationFamily(view.relation) === family;
        });
        const existingResolved = existingEdges.length;
"""
text = replace_once(text, resolved_anchor, resolved_replacement, 'social resolved-edge')

group_anchor = """        const groupId = existingSlots[0]?.groupId || `group_${slug(`${ownerId}-${family}-${fact.sharedDescriptor || ''}`)}`;
"""
group_replacement = group_anchor + """        if (!existingSlots.length && fact.count >= 2 && existingEdges.length === fact.count
            && existingEdges.every(edge => existingEdgeProvesCollectiveMembership(edge, ownerId, fact))) {
            for (const edge of existingEdges) {
                edge.groupId ||= groupId;
                if (fact.sharedDescriptor) edge.sharedDescriptor ||= fact.sharedDescriptor;
            }
        }
"""
text = replace_once(text, group_anchor, group_replacement, 'social group')
path.write_text(text, encoding='utf-8')

final = {path: blob(path) for path in TARGETS}
for path, sha in final.items():
    print(f'{path}={sha}')
for path, prefix in TARGETS.items():
    if not final[path].startswith(prefix):
        raise SystemExit(f'{path} blob mismatch: expected {prefix}..., got {final[path]}')
