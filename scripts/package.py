"""Produce and verify a deterministic runtime-only Delta development package."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'manifest.json').read_text())
files = sorted([p.name for p in root.glob('*.js')] + ['style.css', 'manifest.json', 'LICENSE', 'README.md'])
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
    assert sorted(bundle.namelist()) == [f'npc_state_delta/{name}' for name in files]
    for name in files:
        data = bundle.read(f'npc_state_delta/{name}')
        assert data == (root / name).read_bytes(), f'packaged bytes differ: {name}'
        if name.endswith('.js'):
            subprocess.run(['node', '--input-type=module', '--check'], input=data, check=True, capture_output=True)
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
print(json.dumps({'archive': archive.name, 'runtimeFiles': len(files), 'bytes': archive.stat().st_size, 'sha256': digest, 'contentsAndSyntaxVerified': True}))
