"""Produce and verify a deterministic runtime-only Delta installable package."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text())
runtime_config = json.loads((root / 'runtime-modules.json').read_text())
runtime_files = [str(item['path']) for item in runtime_config.get('modules', [])]
root_js = sorted(p.name for p in root.glob('*.js'))
top_level_runtime = [name for name in runtime_files if '/' not in name]
assert sorted(top_level_runtime) == root_js, 'runtime-modules.json must declare every and only top-level runtime JS module'
assert runtime_config.get('applicationVersion') == manifest['version'], 'runtime inventory version differs from manifest'
assert runtime_config.get('entrypoint') == manifest['js'], 'runtime inventory entrypoint differs from manifest'
src_module = re.compile(r'^src/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.js$')
assert all(name.endswith('.js') and ('/' not in name or (src_module.match(name) and '..' not in name.split('/'))) for name in runtime_files), 'runtime inventory contains a JS path outside the top level and src/'
assert all((root / name).is_file() for name in runtime_files), 'runtime inventory declares a missing module'

# src/storysuite-v2.js is the optional Story Suite v2 adapter, imported by index.js at runtime;
# src/npc-meters.js, src/npc-meters-screen.js and src/npc-meters-presets.js are its npc slice, NPC card and meter presets;
# src/adapter/queries.js, cast-ui.js, timeline.js, connect.js and editor.js are the parts of the adapter's factory (moved out of src/storysuite-v2.js);
# src/adapter/queries-dossier.js and -director.js are the dossier/portrait and Story Director/pack parts of src/adapter/queries.js;
# src/adapter/cast-ui/ holds the cohesive parts of cast-ui.js (drawer, section, dossier list, cast render, page API, views, presets and turn);
# src/npc-meters-config.js, -secrets.js, -slice.js and -schema.js are the pure top-level parts of src/npc-meters.js (moved out of it);
# src/npc-meters-commands.js, -queries.js and -prompt.js are the change/command, query and prompt parts of src/npc-meters.js;
# src/social-check.js is the social check rules (npc.socialModifier);
# src/public-paths.js is the definition of Delta's public paths (npc.<name>.<meter>) for Story Block's sdk.registerPublicPaths;
# src/storysuite-participant/ is the Story Block restore participant (checkpoint, prepare, activate, npc.identity).
support_files = ['style.css', 'suite.css', 'manifest.json', 'runtime-modules.json', 'LICENSE', 'README.md', 'src/storysuite-v2.js', 'src/adapter/queries.js', 'src/adapter/queries-dossier.js', 'src/adapter/queries-director.js', 'src/adapter/cast-ui.js', 'src/adapter/timeline.js', 'src/adapter/connect.js', 'src/adapter/editor.js', 'src/npc-meters.js', 'src/npc-meters-commands.js', 'src/npc-meters-queries.js', 'src/npc-meters-prompt.js', 'src/npc-meters-screen.js', 'src/npc-meters-presets.js', 'src/npc-meters-config.js', 'src/npc-meters-secrets.js', 'src/npc-meters-slice.js', 'src/npc-meters-schema.js', 'src/social-check.js', 'src/public-paths.js', 'src/storysuite-participant/checkpoint.js', 'src/storysuite-participant/hash.js', 'src/storysuite-participant/identity.js', 'src/storysuite-participant/index.js', 'src/storysuite-participant/participant.js', 'src/storysuite-participant/timeline.js', 'src/storysuite-participant/vault.js']
support_files = ['style.css', 'suite.css', 'manifest.json', 'runtime-modules.json', 'LICENSE', 'README.md', 'src/storysuite-v2.js', 'src/adapter/queries.js', 'src/adapter/cast-ui.js', 'src/adapter/cast-ui/cast-render.js', 'src/adapter/cast-ui/cast-views.js', 'src/adapter/cast-ui/dom.js', 'src/adapter/cast-ui/dossier-list.js', 'src/adapter/cast-ui/drawer.js', 'src/adapter/cast-ui/page-api.js', 'src/adapter/cast-ui/presets.js', 'src/adapter/cast-ui/section.js', 'src/adapter/cast-ui/turn.js', 'src/adapter/cast-ui/watchers.js', 'src/adapter/timeline.js', 'src/adapter/connect.js', 'src/adapter/editor.js', 'src/npc-meters.js', 'src/npc-meters-screen.js', 'src/npc-meters-presets.js', 'src/npc-meters-config.js', 'src/npc-meters-secrets.js', 'src/npc-meters-slice.js', 'src/npc-meters-schema.js', 'src/social-check.js', 'src/public-paths.js', 'src/storysuite-participant/checkpoint.js', 'src/storysuite-participant/hash.js', 'src/storysuite-participant/identity.js', 'src/storysuite-participant/index.js', 'src/storysuite-participant/participant.js', 'src/storysuite-participant/participant/handlers.js', 'src/storysuite-participant/participant/publication.js', 'src/storysuite-participant/participant/session-ops.js', 'src/storysuite-participant/participant/support.js', 'src/storysuite-participant/timeline.js', 'src/storysuite-participant/vault.js']
files = runtime_files + support_files
src_js = sorted(p.relative_to(root).as_posix() for p in (root / 'src').rglob('*.js'))
assert all(name in files for name in src_js), 'every src/ module must be packaged'
# A src/ module may be declared in the inventory and listed as a support file too; it ships once.
files = list(dict.fromkeys(files))
out = root / 'dist'
out.mkdir(exist_ok=True)
archive = out / f"npc_state_delta-{manifest['version']}.zip"
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
    for name in files:
        info = zipfile.ZipInfo(f'npc_state_delta/{name}', date_time=(2026, 9, 11, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        bundle.writestr(info, (root / name).read_bytes(), compresslevel=9)
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None, 'archive CRC failure'
    assert sorted(bundle.namelist()) == sorted(f'npc_state_delta/{name}' for name in files)
    for name in files:
        data = bundle.read(f'npc_state_delta/{name}')
        assert data == (root / name).read_bytes(), f'packaged bytes differ: {name}'
        if name.endswith('.js'):
            subprocess.run(['node', '--input-type=module', '--check'], input=data, check=True, capture_output=True)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
print(json.dumps({'archive': archive.name, 'runtimeFiles': len(runtime_files), 'bytes': archive.stat().st_size, 'sha256': digest, 'contentsAndSyntaxVerified': True, 'runtimeInventoryVerified': True}))
