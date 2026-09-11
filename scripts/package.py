"""Produce and verify a deterministic runtime-only Delta development package."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text())
runtime_config = json.loads((root / 'runtime-modules.json').read_text())
runtime_files = [str(item['path']) for item in runtime_config.get('modules', [])]
root_js = sorted(p.name for p in root.glob('*.js'))
assert sorted(runtime_files) == root_js, 'runtime-modules.json must declare every and only top-level runtime JS module'
assert runtime_config.get('applicationVersion') == manifest['version'], 'runtime inventory version differs from manifest'
assert runtime_config.get('entrypoint') == manifest['js'], 'runtime inventory entrypoint differs from manifest'
assert all('/' not in name and name.endswith('.js') for name in runtime_files), 'runtime inventory contains a non-top-level JS path'

support_files = ['style.css', 'manifest.json', 'runtime-modules.json', 'LICENSE', 'README.md']
files = runtime_files + support_files
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
