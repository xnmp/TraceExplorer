#!/usr/bin/env python3
"""Build a target-specific installable archive from this independent checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def package(target: str, binary: Path, destination: Path, plugin: str = "trace") -> Path:
    plugin_root = ROOT if plugin == "trace" else ROOT / "plugins/image-generation"
    manifest = json.loads((plugin_root / "plugin.json").read_text())
    binary_name = "trace-explorer-backend" if plugin == "trace" else "image-generation-backend"
    executable = binary_name + (".exe" if "windows" in target else "")
    payloads = {
        "frontend/index.js": plugin_root / "dist/frontend/index.js",
        "frontend/index.css": plugin_root / "dist/frontend/index.css",
        f"backend/{executable}": binary,
    }
    manifest.update(target=target, backend=f"backend/{executable}", files={
        name: {"size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for name, path in payloads.items()
    })
    destination.mkdir(parents=True, exist_ok=True)
    package_name = "TraceExplorer" if plugin == "trace" else "ImageGeneration"
    output = destination / f"{package_name}-{manifest['version']}-{target}.teplugin"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        def add(name: str, content: bytes, executable: bool = False) -> None:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            archive.writestr(info, content)
        add("manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
        for name, path in payloads.items():
            add(name, path.read_bytes(), name == manifest["backend"])
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".teplugin.sha256").write_text(f"{digest}  {output.name}\n")
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin", choices=["trace", "image-generation"], default="trace")
    parser.add_argument("--target", help="Rust target triple (defaults to the current host)")
    parser.add_argument("--binary", type=Path, help="An already-built backend; skips builds")
    parser.add_argument("--output", type=Path, default=ROOT / "package")
    args = parser.parse_args()
    target = args.target or next(line.removeprefix("host: ") for line in subprocess.check_output(["rustc", "-vV"], text=True).splitlines() if line.startswith("host: "))
    binary = args.binary
    if binary is None:
        image = args.plugin == "image-generation"
        subprocess.run(["bun", "run", "build:image-generation:frontend" if image else "build:frontend"], cwd=ROOT, check=True)
        backend_root = ROOT / ("plugins/image-generation/backend" if image else "src-tauri")
        subprocess.run(["cargo", "build", "--locked", "--release", "--target", target, "--manifest-path", str(backend_root / "Cargo.toml")], cwd=ROOT, check=True)
        target_directory = Path(os.environ.get("CARGO_TARGET_DIR", backend_root / "target"))
        if not target_directory.is_absolute():
            target_directory = ROOT / target_directory
        binary_name = "image-generation-backend" if image else "trace-explorer-backend"
        binary = target_directory / target / "release" / (binary_name + (".exe" if "windows" in target else ""))
    print(package(target, binary.resolve(), args.output, args.plugin))


if __name__ == "__main__":
    main()
