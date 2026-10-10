# Shared AI package and CI gates

`Build plugin` builds both independent SDK3 packages on five native runners:

| Runner | Rust target |
| --- | --- |
| Ubuntu 22.04 x64 | `x86_64-unknown-linux-gnu` |
| Ubuntu 22.04 ARM | `aarch64-unknown-linux-gnu` |
| macOS 14 ARM | `aarch64-apple-darwin` |
| macOS 15 Intel | `x86_64-apple-darwin` |
| Windows 2022 | `x86_64-pc-windows-msvc` |

Each runner uses frozen Bun dependencies and locked Rust dependencies, tests
Trace, Image Generation, their shared stdio runtime and image service wire
contract, then builds both native
release binaries. Trace owns `dist/frontend` and `src-tauri/target`; Image
Generation owns `plugins/image-generation/dist/frontend` and
`plugins/image-generation/backend/target`. Both frontends use the host's exact
Svelte `5.56.3` runtime binding.

The provider's separate frontend check and Vitest configuration run explicitly:
the root check/test patterns do not include that directory. The generic browser
job covers Trace's `e2e/` specs. Actual-host managed Modal fixtures and installed
plugin acceptance are separately owned host suites, rather than coverage implied
by that generic browser job.

CI builds frontends in Trace→provider order, packages both with explicit
`--binary`, then builds in provider→Trace order and packages them again. The
verifier requires byte-identical repeat archives. Every archive contains exactly
`manifest.json` plus three payloads: `frontend/index.js`, `frontend/index.css`
and its own named backend (with `.exe` on Windows). It checks source manifest
identity, SDK/ABI, target, declared services/dependencies/state, executable mode,
nonempty stylesheet, every payload size/SHA256, the selected native binary bytes
and the archive's `.sha256` sidecar. The provider cannot declare initial Trace
data. Both archive and native binary digests must differ between packages.

Artifacts are named `SharedAI-plugins-<target>` and contain both `.teplugin`
archives, both checksum sidecars and `verification.json`. Nothing is released or
installed by this workflow. The per-target bound is 45 minutes; five parallel
targets therefore permit 225 runner-minutes, plus the 20-minute browser job.
These are configured limits, not measured cold-build times.

Run the package behavior tests without a compiler, network or installation:

```sh
python3 -m unittest discover -s tests/packaging -p 'test_*.py' -v
```

To verify two already-built package directories, use their exact target/binaries:

```sh
python3 tests/packaging/verify_packages.py \
  --target x86_64-unknown-linux-gnu \
  --packages package --compare package-reverse \
  --trace-binary src-tauri/target/x86_64-unknown-linux-gnu/release/trace-explorer-backend \
  --image-binary plugins/image-generation/backend/target/x86_64-unknown-linux-gnu/release/image-generation-backend
```

Local working-snapshot evidence on 2026-10-10: four package behavior tests pass,
including both package orders for all five target names, missing CSS refusal,
checksum/backend substitution and foreign payload rejection. Real Vite builds
in both orders and Linux debug-binary packaging also pass the verifier and
produce byte-identical archives. This exercises packaging with actual frontend
outputs, not Windows/macOS execution or release-binary qualification.

The verified local debug fixtures have these SHA256 values:

| Package | Archive | Native binary |
| --- | --- | --- |
| TraceExplorer | `8a931d95c77b44554bf04a43e24cb902b239db823f4812722c9077e19090d1f4` | `0294753cc44ae45c45cad9a12f05d8f6de763b9bc2850ab8dd383153e0c47ccd` |
| Image Generation | `288210875452a44bf9cff73aeaecc04f3a130ef426290971f254e017669c4f97` | `d288f327195cb1415936d8f4f098a98a19cdebb88f379eea75fe98b35e5c8c26` |

The local checkout is an uncommitted working snapshot based on
`cae90fb4344375cf8fc1453df74f50ecdc0b4d55`. The packaging run used existing
debug binaries and does not assert that their complete source trees were frozen
or rebuilt during this test. The verifier records their actual bytes.

Actual Windows namespace durability and provider/Trace handoff must pass on a
native Windows runner before merge. Cross-compilation and archive identity alone
do not establish that boundary. Host native acceptance is defined separately in
the host's `docs/shared-ai-ci.md`; it records immutable host/plugin revisions and
binary/archive digests and uses only private fixture profiles and fake providers.

Independent review at this working-snapshot checkpoint found that Trace's
`service_images::sync_ancestors` returns `unsupported_platform` outside Unix,
while accepted/handoff behavior tests also run on Windows. The full Windows
native suite therefore remains a failing gate until consumer publication has a
qualified Windows implementation or those tests verify the supported refusal
contract. The workflow retains the full suite; no filter hides this mismatch.
