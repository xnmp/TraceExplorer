"""Package behavior using private fixture bytes; no build, network, or install."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from verify_packages import verify

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("packager", ROOT / "scripts/package-plugin.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class Packages(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(setattr, packager, "ROOT", packager.ROOT)
        packager.ROOT = self.root
        for plugin, relative in (("trace", Path(".")), ("image-generation", Path("plugins/image-generation"))):
            destination = self.root / relative
            destination.mkdir(parents=True, exist_ok=True)
            (destination / "plugin.json").write_bytes((ROOT / relative / "plugin.json").read_bytes())
            frontend = destination / "dist/frontend"
            frontend.mkdir(parents=True)
            (frontend / "index.js").write_text(f"globalThis.__TAURI_EXPLORER_PLUGIN_SDK__; // {plugin}\n")
            (frontend / "index.css").write_text(f".{plugin}{{color:red}}\n")
        self.binary = self.root / "native-fixture"
        self.binary.write_bytes(b"private-native-backend")

    def package(self, plugin, target="x86_64-unknown-linux-gnu", output="package"):
        return packager.package(target, self.binary, self.root / output, plugin)

    def validate(self, path, plugin, target="x86_64-unknown-linux-gnu"):
        relative = Path(".") if plugin == "trace" else Path("plugins/image-generation")
        return verify(path, plugin, target, json.loads((self.root / relative / "plugin.json").read_text()), self.binary)

    def test_five_targets_both_package_orders_preserve_payloads_and_checksums(self):
        targets = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]
        for target in targets:
            first = {plugin: self.package(plugin, target, "forward") for plugin in ("trace", "image-generation")}
            second = {plugin: self.package(plugin, target, "reverse") for plugin in ("image-generation", "trace")}
            for plugin in first:
                self.validate(first[plugin], plugin, target)
                self.assertEqual(first[plugin].read_bytes(), second[plugin].read_bytes())
            self.assertNotEqual(first["trace"].read_bytes(), first["image-generation"].read_bytes())

    def test_missing_stylesheet_refuses_archive(self):
        for relative, plugin in ((Path("."), "trace"), (Path("plugins/image-generation"), "image-generation")):
            (self.root / relative / "dist/frontend/index.css").unlink()
            with self.assertRaises(FileNotFoundError):
                self.package(plugin)
        self.assertFalse(list(self.root.rglob("*.teplugin")))

    def test_changed_archive_checksum_or_selected_backend_refuses_verification(self):
        path = self.package("trace")
        checksum = path.with_suffix(".teplugin.sha256")
        original = checksum.read_bytes()
        checksum.write_text("0" * 64 + f"  {path.name}\n")
        with self.assertRaisesRegex(AssertionError, "checksum"):
            self.validate(path, "trace")
        checksum.write_bytes(original)
        self.binary.write_bytes(b"other-backend")
        with self.assertRaisesRegex(AssertionError, "backend bytes"):
            self.validate(path, "trace")

    def test_appended_foreign_payload_is_rejected(self):
        import hashlib
        path = self.package("image-generation")
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("trace.sqlite", b"foreign-owned-data")
        path.with_suffix(".teplugin.sha256").write_text(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
        with self.assertRaisesRegex(AssertionError, "archive payloads"):
            self.validate(path, "image-generation")


if __name__ == "__main__":
    unittest.main()
