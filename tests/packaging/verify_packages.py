#!/usr/bin/env python3
"""Validate distributable bytes, without loading either plugin or its backend."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ABI = "5.56.3"
PLUGINS = {
    "trace": ("TraceExplorer", "xnmp.trace-explorer", "trace-explorer-backend"),
    "image-generation": ("ImageGeneration", "xnmp.image-generation", "image-generation-backend"),
}
METHODS = ["describe", "prepare", "start", "status", "cancel", "acknowledge"]


def verify(path: Path, plugin: str, target: str, source_manifest: dict, binary: Path) -> dict:
    name, identity, backend = PLUGINS[plugin]
    executable = backend + (".exe" if "windows" in target else "")
    payloads = {"frontend/index.js", "frontend/index.css", f"backend/{executable}"}
    assert path.name == f"{name}-{source_manifest['version']}-{target}.teplugin", "archive filename"
    archive_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    assert path.with_suffix(".teplugin.sha256").read_text() == f"{archive_sha}  {path.name}\n", "checksum sidecar"
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), "duplicate ZIP entry"
        assert set(names) == payloads | {"manifest.json"}, "exact archive payloads"
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["id"] == identity, "package identity"
        assert manifest["sdkVersion"] == 3 and manifest["svelteVersion"] == ABI, "shared runtime ABI"
        assert manifest["target"] == target, "native target"
        assert manifest["backend"] == f"backend/{executable}", "native payload name"
        assert manifest["frontend"] == "frontend/index.js" and manifest["styles"] == "frontend/index.css", "frontend and stylesheet"
        assert set(manifest["files"]) == payloads, "manifest payload declarations"
        assert {key: value for key, value in manifest.items() if key not in ("target", "backend", "files")} == source_manifest, "source manifest preserved"
        for payload in payloads:
            content = archive.read(payload)
            assert content, f"empty payload: {payload}"
            assert manifest["files"][payload] == {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}, f"payload integrity: {payload}"
            mode = (archive.getinfo(payload).external_attr >> 16) & 0o777
            assert mode == (0o755 if payload == manifest["backend"] else 0o644), f"payload permissions: {payload}"
        assert archive.read(manifest["backend"]) == binary.read_bytes(), "selected backend bytes"
        script = archive.read("frontend/index.js")
        assert b"__TAURI_EXPLORER_PLUGIN_SDK__" in script, "host runtime binding"
        if plugin == "image-generation":
            assert manifest["services"] == [{"id": "image-generation", "major": 1, "methods": METHODS}], "image service export"
            assert manifest["serviceDependencies"] == [], "independent provider"
            assert not manifest.get("initialDataFiles"), "provider cannot initialize a Trace database"
            assert set(manifest["stateFiles"]) == {"operations.sqlite", "operations.sqlite-wal", "operations.sqlite-shm", "operations.initialized", "profiles.json"}, "provider state ownership"
        else:
            assert manifest["serviceDependencies"] == [{"packageId": "xnmp.image-generation", "serviceId": "image-generation", "major": 1, "optional": True}], "optional provider dependency"
    return {"path": str(path), "id": identity, "target": target, "sha256": archive_sha, "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--packages", type=Path, required=True)
    parser.add_argument("--compare", type=Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--trace-binary", type=Path, required=True)
    parser.add_argument("--image-binary", type=Path, required=True)
    args = parser.parse_args()
    reports = []
    for plugin, binary in (("trace", args.trace_binary), ("image-generation", args.image_binary)):
        manifest_root = args.root if plugin == "trace" else args.root / "plugins/image-generation"
        manifest = json.loads((manifest_root / "plugin.json").read_text())
        filename = f"{PLUGINS[plugin][0]}-{manifest['version']}-{args.target}.teplugin"
        path = args.packages / filename
        reports.append(verify(path, plugin, args.target, manifest, binary))
        if args.compare:
            other = args.compare / filename
            verify(other, plugin, args.target, manifest, binary)
            assert path.read_bytes() == other.read_bytes(), "build order changed archive bytes"
    assert reports[0]["sha256"] != reports[1]["sha256"], "independent archive digests"
    assert reports[0]["binarySha256"] != reports[1]["binarySha256"], "independent native binaries"
    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
