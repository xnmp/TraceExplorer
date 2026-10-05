#!/usr/bin/env python3
"""Synchronize the explicit plugin source manifest with a Tauri Explorer checkout."""
import argparse
import json
from pathlib import Path
import shutil

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', type=Path, required=True)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument('--check', action='store_true')
mode.add_argument('--write', action='store_true')
args = parser.parse_args()
host = args.host.resolve()
manifest = json.loads((repo / 'integration/source-manifest.json').read_text())
changed = []
for relative in manifest:
    source = host / relative
    target = repo / relative
    if not source.is_file():
        parser.error(f'Missing host source: {relative}')
    if target.is_file() and target.read_bytes() == source.read_bytes():
        continue
    changed.append(relative)
    if args.write:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
if args.check and changed:
    print('\n'.join(changed))
    raise SystemExit(1)
print(f'{len(manifest)} source files checked; {len(changed)} updated' if args.write else f'{len(manifest)} source files match')
