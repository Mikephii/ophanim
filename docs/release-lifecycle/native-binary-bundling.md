# Native Binary Bundling in VS Code Extensions

> **Current matrix (2026-10):** Electron ABIs 123, 128, 132, 133, 136, 140, 143, 145, 146, 148 (Electron 30 to 43; VS Code 1.142 runs Electron 43, Antigravity 2.9 runs Electron 41) and plain-Node ABIs 127 and 137 (Node 22 and 24, for code-server and remote hosts, in `native/node-<abi>/`). The lists live in `packages/vscode/scripts/build-native.sh`, which CI runs on every platform runner.

> **Status**: Reference documentation for shipping `better-sqlite3` (a native Node.js addon) inside the Ophan VS Code extension. This is an **unsupported configuration** by Microsoft -- native modules in extensions work but carry ongoing maintenance burden.

## Why We Use a Native Module

Ophan's VS Code extension reads `.ophan/index.db` (SQLite) directly from the extension host using `better-sqlite3`. We chose this over alternatives because:

- **Synchronous API**: Queries return values directly -- no callbacks/promises. Keeps CodeLens providers, hover handlers, and diagnostics simple and deterministic.
- **WAL mode concurrency**: The CLI writes while the extension reads. WAL mode handles this natively. An async library would add complexity without benefit.
- **Performance**: `better-sqlite3` is significantly faster than `node-sqlite3` (the async alternative) for the read-heavy, small-query workload our extension performs.
- **`sql.js` (WASM) is ruled out**: It loads the entire DB into memory as a snapshot. When the CLI writes new analysis, the in-memory copy goes stale. This caused persistent bugs with stale data not propagating. See `CLAUDE.md` rule: "sql.js must NEVER be used in the extension host."

The tradeoff: we inherit the full complexity of shipping a platform-specific native binary inside a VS Code extension.

## Support Goal

**Support 1 year of releases across all major VS Code forks and VS Code itself.**

This means bundling prebuilt binaries for every Electron ABI version used by VS Code, Cursor, Google Antigravity, and Windsurf in the trailing 12 months. Based on historical data, VS Code alone spans ~2 Electron major versions per year. Combined with forks (which lag behind), the total is typically 3-5 distinct ABI versions at any given time.

At ~1 MB per binary per platform, this adds ~3-5 MB to each platform-specific VSIX -- negligible given GitLens is 11 MB and Pylance is 29 MB.

## Our Approach: Vendored Multi-Electron Prebuilts

After evaluating 7 strategies, we chose **vendored prebuilts**: downloading pre-compiled binaries from better-sqlite3's GitHub Releases for multiple Electron ABI versions and bundling them in the VSIX with a small runtime loader.

### Why This Approach

1. **Smallest change from current setup**: We already download prebuilts during `pnpm install`. We just download extras for additional Electron versions.
2. **No architectural changes**: Extension still loads better-sqlite3 synchronously in-process. No IPC, no child processes, no HTTP servers. Zero latency impact.
3. **~5 MB size cost**: Negligible. Each binary is ~1 MB. Bundling 3-5 Electron versions per platform VSIX takes us from ~10 MB to ~15 MB.
4. **20-line loader**: A small runtime shim detects `process.versions.modules` (the Electron ABI) and loads the matching binary. No complex framework needed.
5. **Graceful failure**: If a user's editor uses an Electron ABI we haven't bundled, they see a clear error message: "Unsupported editor version -- please report at github.com/Mikephii/ophanim/issues". This is infinitely better than the cryptic `NODE_MODULE_VERSION` crash.

### Strategies We Rejected

| Strategy | Why Not |
|----------|---------|
| Child process / IPC | Adds 5-10ms latency per query. With 50 CodeLens reads, that's 250ms. Unacceptable. |
| CLI as HTTP server | Extension must be standalone. Wrong architecture. |
| On-demand compilation | Users don't have build tools. 30-60s first activation. Terrible UX. |
| Try/catch loading | Same result as our approach but fragile -- `require()` errors aren't always clean ABI mismatches. |
| `node:sqlite` built-in | Experimental. Not in Electron <37. Not exposed to extensions. 1-2 years away. |
| N-API wrapper | better-sqlite3 already uses N-API. Doesn't solve Electron-specific V8 breakage. |

### Upgrade Path

If we exceed 5 Electron ABI targets or better-sqlite3 stops publishing prebuilts for versions we need, upgrade to full [prebuildify](https://github.com/prebuild/prebuildify) + [node-gyp-build](https://github.com/prebuild/node-gyp-build). This would mean compiling from source in CI against each Electron version rather than downloading upstream prebuilts. The runtime loader (`node-gyp-build`) handles binary selection automatically -- same concept, more self-sufficient build pipeline.

## The Core Problem

`better-sqlite3` compiles a C++ addon (`better_sqlite3.node`) that links against Node.js internals. VS Code runs on **Electron**, which bundles its own Node.js with a different ABI than system Node.js. If the `.node` binary was compiled against the wrong Node.js/Electron version, it fails at runtime:

```
The module 'better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 132.
```

This error is fatal -- the extension fails to activate entirely.

## Failure Modes

Every failure mode documented here can cause the extension to silently fail to activate for affected users. Users see no error in the UI -- just missing CodeLens and a non-functional extension.

### 1. Electron ABI Mismatch (Most Common)

**What**: The `.node` binary was compiled against system Node.js, not the Electron version VS Code ships.

**When**: Every time VS Code bumps its Electron major version (roughly every 2-4 months).

**Symptom**: `NODE_MODULE_VERSION` mismatch error in the extension host log.

**Prevention**: Rebuild `better-sqlite3` against the target Electron version using `@electron/rebuild` in CI. See [CI/CD Setup](#cicd-platform-specific-builds).

**Our current setup**: `package.json` has `@electron/rebuild` as a devDependency and a `rebuild-native` script. The release workflow relies on `prebuild-install` downloading the correct prebuilt binary during `pnpm install`. This works **only if** better-sqlite3 publishes a prebuilt for the exact Electron ABI version VS Code uses. If they don't, the install silently falls back to compiling against system Node.js, and the extension breaks at runtime.

### 2. Platform / Architecture Mismatch

**What**: A binary compiled for one OS or CPU architecture loaded on another.

**When**: If the wrong platform-specific VSIX is served, or if a platform target is missing from our build matrix.

**Symptom**: `invalid ELF header`, `Mach-O file but is incompatible architecture`, or `%1 is not a valid Win32 application`.

**Prevention**: Build and publish separate VSIXs per platform using `vsce package --target`. The marketplace serves the correct one automatically.

**Supported targets**:

| Target | OS | Arch | Libc | CI Runner |
|--------|-----|------|------|-----------|
| `win32-x64` | Windows | x86-64 | MSVC | `windows-latest` |
| `win32-arm64` | Windows | ARM64 | MSVC | `windows-latest` (cross-compile via prebuild) |
| `linux-x64` | Linux | x86-64 | glibc | `ubuntu-latest` |
| `linux-arm64` | Linux | ARM64 | glibc | `ubuntu-latest` (cross-compile via prebuild) |
| `linux-armhf` | Linux | ARMv7 | glibc | `ubuntu-latest` (cross-compile via prebuild) |
| `alpine-x64` | Alpine | x86-64 | musl | `ubuntu-latest` (needs `npm_config_libc=musl`) |
| `alpine-arm64` | Alpine | ARM64 | musl | `ubuntu-latest` (needs `npm_config_libc=musl`) |
| `darwin-x64` | macOS | Intel | - | `macos-13` (last Intel runner) |
| `darwin-arm64` | macOS | Apple Silicon | - | `macos-latest` (ARM64 M1+ runner) |

**Critical marketplace behavior**: Once you publish **any** platform-specific VSIX, platforms without a specific VSIX get **no extension at all** -- the marketplace does not fall back to a universal package. Every platform your users might use must have a build.

**Our current gaps**: We build for 5 targets (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64). Missing: `win32-arm64` (Surface Pro X, Copilot+ PCs -- growing market), `alpine-x64`/`alpine-arm64` (Docker/container users), `linux-armhf` (Raspberry Pi -- niche).

### 3. glibc Version Mismatch (Linux)

**What**: The `.node` binary requires a newer glibc than the user's Linux distro provides.

**When**: If compiled on a recent Ubuntu (22.04/24.04) with glibc 2.35+, it won't load on older distros (Debian Buster, Ubuntu 18.04, RHEL 7) with glibc 2.17-2.28.

**Symptom**: `Error: /lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.29' not found`.

**Prevention**: Use `prebuild-install` to download better-sqlite3's official prebuilts, which target broad glibc compatibility. Avoid compiling from source on modern CI runners unless necessary.

**Note**: This is separate from the musl/glibc split (Alpine vs standard Linux). Even within glibc-based distros, version requirements vary.

### 4. V8 Sandbox Breaking Changes (Electron 21+)

**What**: Electron 20+ introduced V8 memory sandboxing. Native modules that allocate memory outside the sandbox crash.

**When**: This has already caused two distinct breaks in better-sqlite3:
- **`db.serialize()` crash** (Electron 35+): `better-sqlite3` used `node::Buffer::New()` which allocates outside the V8 sandbox. Fixed in v11.10.1+ by switching to `node::Buffer::Copy()`. ([Issue #1372](https://github.com/WiseLibs/better-sqlite3/issues/1372))
- **`Context::GetIsolate()` removed** (Electron 39.1+): V8 removed this API entirely. `better-sqlite3` v12.4.1 fails to compile. Fixed in v12.4.2 by switching to `v8::Isolate::GetCurrent()`. ([Issue #1416](https://github.com/WiseLibs/better-sqlite3/issues/1416))

**Symptom**: Extension crashes with `Fatal error in V8` or fails to compile in CI.

**Prevention**: Stay on recent versions of `better-sqlite3`. The maintainers actively patch for Electron compatibility, but there's always a window between an Electron release and the fix landing.

### 5. esbuild Bundling Strategy

**Current setup**: better-sqlite3's **JavaScript** is bundled by esbuild (it is NOT in the `external` array). Only the native `.node` binary is loaded from the filesystem at runtime via the `nativeBinding` constructor option.

```javascript
// packages/vscode/esbuild.mjs
external: ["vscode"]  // better-sqlite3 JS is bundled inline
```

**Why we bundle it**: With pnpm workspaces, `node_modules/better-sqlite3` is a symlink to the pnpm store. `vsce package` (even with `--no-dependencies`) doesn't reliably include pnpm symlinked dependencies. If the JS module is missing from the VSIX, `require('better-sqlite3')` fails at module load time, `activate()` never runs, and all commands show "not found".

**How it works**: The `bindings` package (better-sqlite3's native file resolver) is also bundled but **never called** at runtime. We always provide an explicit `nativeBinding` path via `resolveNativeBinding()` in `native-loader.ts`, which points to the correct binary in the `native/` directory. The bundled `bindings` code is dead code in production.

**Risk**: If `resolveNativeBinding()` ever returns `undefined` in production, the bundled `bindings` package would try to find the `.node` file but fail (since `node_modules/better-sqlite3/build/` doesn't exist in the VSIX). This is mitigated by the loader always returning a path when the `native/` directory exists.

### 6. `.vscodeignore` Configuration

**Our setup** (correct):
```
node_modules/**     # Exclude all node_modules -- better-sqlite3 JS is bundled by esbuild
!native/**          # Include pre-compiled native binaries
!dist/**            # Include esbuild output
!webview-dist/**    # Include webview build
!resources/**       # Include icons
```

No `node_modules/` re-inclusion needed since better-sqlite3's JavaScript is bundled inline.

**Verification**: After packaging, inspect the VSIX to confirm native binaries are present:
```bash
unzip -l *.vsix | grep ".node"
# Should show: extension/native/electron-*/better_sqlite3.node and extension/native/node/better_sqlite3.node
```

### 7. Remote Development (SSH, WSL, Containers)

**What**: When using VS Code Remote SSH/WSL/Containers, the extension runs on the **remote machine**, not the local machine. The remote VS Code Server runs standard Node.js, not Electron.

**When**: Any remote development session.

**Implication**: The `.node` binary needs to match the remote's platform and Node.js version, not the local machine's Electron version.

**Our extension's `extensionKind`**: We don't set `extensionKind` explicitly, so it defaults to `["workspace"]` (runs on the remote side). This means:
- Local-only users: Extension runs in Electron -- needs Electron-compatible binary
- Remote users: Extension runs in VS Code Server's Node.js -- needs Node.js-compatible binary
- The platform-specific VSIX must contain the right binary for whichever context the extension runs in

**This is an unresolved tension**: A single binary can't serve both Electron (local) and Node.js (remote) if their ABI versions differ. In practice, they've been close enough that the same N-API-based binary works for both, but this is not guaranteed.

### 8. Antivirus False Positives (Windows)

**What**: Windows Defender and third-party antivirus software occasionally flag `.node` files as suspicious, quarantining or corrupting them.

**When**: Unpredictable. Signal Desktop has experienced this with `better_sqlite3.node` ([Signal #6613](https://github.com/signalapp/Signal-Desktop/issues/6613)). Kaspersky has been reported to silently corrupt SQLite database files.

**Symptom**: Extension fails to activate, or database reads return corrupted data.

**Prevention**: None from our side. Affected users must add exclusions to their antivirus. This is rare but generates support tickets we can't fix.

### 9. macOS Code Signing (Manual VSIX Install Only)

**What**: macOS Gatekeeper may block unsigned binaries in manually downloaded `.vsix` files.

**When**: Only when users download and install `.vsix` files directly, bypassing the marketplace. Marketplace-served extensions go through VS Code's download path which handles quarantine removal.

**Prevention**: Not a concern for marketplace distribution. For manual distribution, users may need `xattr -cr` on the extension directory.

## Electron Version Tracking

### How VS Code Updates Electron

VS Code updates its bundled Electron version roughly every 2-4 months (median ~3 months). They typically skip every other Electron major version. Each bump potentially changes the Node.js ABI, requiring native module rebuilds.

### Historical Electron Bump Cadence

| VS Code | Electron | Date | Gap Since Previous |
|---------|----------|------|--------------------|
| 1.109.x | 39.x | Jan 2026 | ~4 months |
| 1.107.x | 39.x | Dec 2025 | - |
| 1.103.x | 37.x | Aug 2025 | ~2 months |
| 1.101.x | 35.x | Jun 2025 | ~3 months |
| 1.98.x | 34.x | Mar 2025 | ~5 months |
| 1.95.x | 32.x | Oct 2024 | ~3 months |
| 1.92.x | 30.x | Jul 2024 | ~1 month |
| 1.90.x | 29.x | Jun 2024 | ~3 months |
| 1.88.x | 28.x | Mar 2024 | ~2 months |
| 1.86.x | 27.x | Jan 2024 | ~4 months |
| 1.82.x | 25.x | Sep 2023 | ~4 months |
| 1.78.x | 22.x | May 2023 | ~8 months |

**Summary**: Expect 3-5 Electron bumps per year. The typical gap is 2-4 months, with occasional outliers (1 month or 8 months).

**Source**: [ewanharris/vscode-versions](https://github.com/ewanharris/vscode-versions) -- updated daily by GitHub Actions cron at midnight UTC.

### The Breakage Window

When VS Code ships a new Electron version, users who auto-update get it immediately. If our extension was built against the old Electron, it breaks. The timeline:

1. **Tracking issue opened** (1-3 months before): VS Code team opens "Update to Electron X" on GitHub. This is our earliest signal.
2. **Electron bump lands in Insiders** (~4-5 weeks before stable): Testing begins. Our extension would break in Insiders at this point.
3. **Stable release ships**: All auto-updating users get the new Electron. If we haven't published a rebuild, the extension is broken.

**Our detection window is 4-5 weeks** between the Insiders bump and the stable release. This is our window to rebuild and publish.

### Monitoring Strategy

**Manual (minimum viable)**:
- Install VS Code Insiders with the Ophan extension
- If the extension breaks in Insiders, an Electron bump is incoming
- Rebuild, test, and publish before the next stable release

**Automated (recommended)**:
- Monitor [ewanharris/vscode-versions](https://github.com/ewanharris/vscode-versions) for changes
  - **Atom feed**: `https://github.com/ewanharris/vscode-versions/commits/main.atom` -- subscribe in any RSS reader or poll programmatically
  - **Raw data**: `https://raw.githubusercontent.com/ewanharris/vscode-versions/main/versions.json` -- poll daily, diff against last known Electron version
  - **GitHub watch**: Watch the repo for commit notifications
- A CI job could poll `versions.json` daily, detect Electron version changes, and open a GitHub issue or send a Slack alert
- The job could also automatically trigger a rebuild workflow against the new Electron version

**GitHub issue tracking**:
- Watch for issues matching the pattern "Update to Electron X" in [microsoft/vscode](https://github.com/microsoft/vscode): `https://github.com/microsoft/vscode/issues?q=is%3Aissue+"update+to+electron"`
- These are opened 1-3 months before the bump ships, giving early warning

## engines.vscode and Version Compatibility

The `engines.vscode` field in `package.json` controls which VS Code versions can install the extension:

```json
{
  "engines": {
    "vscode": "^1.107.0"
  }
}
```

### How the Marketplace Uses This

The marketplace evaluates the semver expression against the user's VS Code version:
- Users on VS Code >= 1.107.0 get the extension
- Users on older VS Code versions cannot install it
- When you publish a new version with a higher `engines.vscode`, users on older VS Code **keep the previous compatible version** -- the marketplace auto-serves the right one

### Strategy for Electron Bumps

When VS Code bumps Electron (e.g., from 39.x to 41.x in a hypothetical VS Code 1.114):

1. Rebuild better-sqlite3 against the new Electron version
2. Publish a new extension version (e.g., 0.0.3) with `"engines": { "vscode": "^1.114.0" }`
3. Users on VS Code 1.114+ get v0.0.3 (new Electron binary)
4. Users still on VS Code 1.107-1.113 keep getting v0.0.2 (old Electron binary)
5. Both groups have a working extension

This means **we never break existing users** with an Electron bump, as long as we:
- Keep the old extension version published (marketplace does this automatically)
- Publish the new version with the correct `engines.vscode` minimum

### Important: Only Bump engines.vscode When Required

Don't gratuitously bump `engines.vscode` -- only raise it when you actually need a newer VS Code API or when the Electron ABI changes. A wider range means more users can install the extension.

## CI/CD: Platform-Specific Builds

### Reference: Microsoft's Official Sample

Microsoft maintains [microsoft/vscode-platform-specific-sample](https://github.com/microsoft/vscode-platform-specific-sample) with a CI workflow demonstrating the correct pattern: a matrix build producing one VSIX per target, followed by a single publish job.

### Build Matrix

Each matrix entry needs:
- **Runner**: Matching the target OS (or capable of cross-compiling)
- **`npm_config_arch`**: Tells `prebuild-install` which architecture's prebuilt to download
- **Electron rebuild** (if not relying on prebuilts): `@electron/rebuild` targeting the correct Electron version

```yaml
strategy:
  matrix:
    include:
      - os: macos-latest
        target: darwin-arm64
        npm_config_arch: arm64
      - os: macos-13
        target: darwin-x64
        npm_config_arch: x64
      - os: ubuntu-latest
        target: linux-x64
        npm_config_arch: x64
      - os: ubuntu-latest
        target: linux-arm64
        npm_config_arch: arm64
      - os: windows-latest
        target: win32-x64
        npm_config_arch: x64
      - os: windows-latest
        target: win32-arm64
        npm_config_arch: arm
```

### Cross-Compilation

For targets where we don't have a native runner (linux-arm64 on ubuntu-latest x64), cross-compilation works **only if** `prebuild-install` can download a prebuilt binary for that arch. Setting `npm_config_arch` during install tells `prebuild-install` to fetch the correct one. If no prebuilt exists, the install falls back to compiling from source -- which will produce an x64 binary on an x64 runner, not arm64. This fails silently.

### Atomic Publishing

**Our current approach** (Pattern 2 -- each matrix job publishes independently) risks partial publishes: if darwin-arm64 succeeds but win32-x64 fails, some platforms have the new version and others don't.

**Recommended approach** (Pattern 1 -- build all, publish once):
1. Matrix build job: Each produces a `.vsix`, uploads as artifact
2. Single publish job: Downloads all artifacts, publishes in one command:
   ```bash
   vsce publish --packagePath $(find . -iname '*.vsix')
   ```
3. If any platform fails to build, nothing publishes

### VSIX Verification Step

Add a verification step after packaging to confirm the native binary is present and correct:

```yaml
- name: Verify native binary in VSIX
  run: |
    mkdir -p /tmp/vsix-check
    unzip -o *.vsix -d /tmp/vsix-check
    ls /tmp/vsix-check/extension/native/
    find /tmp/vsix-check/extension/native -name "better_sqlite3.node" -exec file {} \;
```

The `file` command confirms the binary's architecture (e.g., `ELF 64-bit LSB shared object, x86-64` or `Mach-O 64-bit bundle arm64`).

### electron-rebuild in CI

If relying on prebuilt binaries is insufficient (e.g., better-sqlite3 doesn't publish a prebuilt for the exact Electron version), use `@electron/rebuild`:

```yaml
- name: Rebuild native module for Electron
  run: npx @electron/rebuild -f -w better-sqlite3 --version 39.3.0
  working-directory: packages/vscode
```

Or via environment variables:
```yaml
- run: pnpm install --frozen-lockfile
  env:
    npm_config_runtime: electron
    npm_config_target: "39.3.0"
    npm_config_disturl: https://electronjs.org/headers
    npm_config_arch: ${{ matrix.npm_config_arch }}
```

## Multi-Editor Compatibility (Cursor, Antigravity, Windsurf)

### The Landscape

VS Code forks are a growing category. Each is an Electron-based fork of the open-source VS Code codebase, with AI features layered on top. They all run VS Code extensions -- but they bundle **different Electron versions**.

| Editor | Electron | Node.js | Marketplace | Notes |
|--------|----------|---------|-------------|-------|
| **VS Code** (1.109) | 39.3.0 | 22.21.1 | VS Code Marketplace | Reference target |
| **Cursor** (~0.48) | ~34.x | ~20.x | Open VSX | Lags VS Code by ~5 Electron majors |
| **Google Antigravity** | 37.3.1 | 22.18.0 | Open VSX | Announced Nov 2025, agent-first IDE |
| **Windsurf** (Codeium) | Unknown (lags VS Code) | Unknown | Open VSX | Similar lag pattern to Cursor |

**The fundamental problem**: Platform-specific VSIXs target OS + architecture (e.g., `darwin-arm64`), but there is **no mechanism to target different Electron versions** within the same platform. You cannot publish "darwin-arm64 for Electron 34" and "darwin-arm64 for Electron 39" as separate packages on any marketplace. The same VSIX is served to VS Code, Cursor, and Antigravity users on the same platform.

This means a native binary compiled for VS Code's Electron 39 may produce a `NODE_MODULE_VERSION` mismatch when loaded in Cursor's Electron 34 -- and there is no marketplace-level solution.

### Marketplace Split

Microsoft's VS Code Marketplace [Terms of Use](https://cdn.vsassets.io/v/M190_20210811.1/_content/Microsoft-Visual-Studio-Marketplace-Terms-of-Use.pdf) restrict access to Microsoft products only (VS Code, Visual Studio, GitHub Codespaces, Azure DevOps). All forks use the **Open VSX Registry** instead.

| | VS Code Marketplace | Open VSX |
|--|---------------------|----------|
| **Operated by** | Microsoft | Eclipse Foundation |
| **Extensions** | ~80,000+ | ~6,000+ |
| **Used by** | VS Code | Cursor, Antigravity, Windsurf, VSCodium, Gitpod |
| **CLI tool** | `vsce` | `ovsx` |
| **Platform-specific VSIXs** | Yes | Yes |
| **Separate account/token** | Yes | Yes |

**We must publish to both marketplaces** to reach all users. The same `.vsix` files work on both -- the `ovsx` CLI uses the same VSIX format. A typical CI step:

```bash
# Publish to VS Code Marketplace
vsce publish --packagePath *.vsix

# Publish to Open VSX (same files)
ovsx publish *.vsix -p $OPEN_VSX_TOKEN
```

### No Editor-Targeting Mechanism

There is no `engines.cursor`, no `engines.antigravity`, no way to say "this VSIX is for Cursor." The only targeting dimensions are:

- **Platform**: `--target darwin-arm64`, `--target linux-x64`, etc.
- **VS Code API version**: `engines.vscode: "^1.107.0"` -- all forks respect this since they implement the same API surface

Cursor and Antigravity both interpret `engines.vscode` against their underlying VS Code fork version. If our minimum is `^1.107.0` and Cursor's fork is based on VS Code 1.96, users can't install the extension in Cursor at all (which may actually protect them from the ABI mismatch, depending on timing).

### Our Solution: Vendored Multi-Electron Prebuilts

We bundle prebuilt `.node` binaries for multiple Electron ABI versions inside each platform-specific VSIX. A runtime loader detects the current Electron ABI and loads the matching binary. See [Our Approach](#our-approach-vendored-multi-electron-prebuilts) at the top of this document for the full rationale.

**Unsupported Electron versions**: If a user runs an editor with an Electron ABI we haven't bundled, the extension shows a clear error: "Ophan does not support this editor version. Please report at github.com/Mikephii/ophanim/issues so we can add support." This follows our false-negatives-over-false-positives principle -- showing nothing is better than crashing with a cryptic `NODE_MODULE_VERSION` error.

### Supply Chain Security Note

In January 2026, researchers discovered that VS Code forks (Cursor, Windsurf, Antigravity) would recommend extensions by name from VS Code Marketplace metadata, but if those extensions didn't exist on Open VSX, attackers could register them under the same name on Open VSX with malicious payloads. The Eclipse Foundation has since added safeguards, but this underscores the importance of **claiming our extension name on Open VSX** even before we actively publish there, to prevent name squatting.

## Manual Build and Test Before Publishing

Before publishing a release, test that the extension works across editors locally. The process mirrors what CI does, but you run it on your machine and sideload the VSIX.

### Step 1: Build the VSIX Locally

Run the same build steps CI uses, but for your local platform only:

```bash
# From repo root
pnpm install --frozen-lockfile
pnpm build

# Package a platform-specific VSIX for your machine (e.g., darwin-arm64)
cd packages/vscode
npx @vscode/vsce package --target darwin-arm64 --no-git-tag-version --no-dependencies
```

This produces a file like `ophan-darwin-arm64-0.0.2.vsix` in `packages/vscode/`.

### Step 2: Verify the VSIX Contents

Before installing, confirm the native binaries are present:

```bash
# List all .node files in the VSIX
unzip -l ophan-darwin-arm64-*.vsix | grep ".node"

# Should show entries like:
#   extension/native/electron-123/better_sqlite3.node
#   extension/native/electron-128/better_sqlite3.node
#   extension/native/node/better_sqlite3.node
#   ... (one per supported ABI)

# Verify the binary is the correct architecture
mkdir -p /tmp/vsix-check && unzip -o ophan-darwin-arm64-*.vsix -d /tmp/vsix-check
file /tmp/vsix-check/extension/native/electron-140/better_sqlite3.node
# Should show: Mach-O 64-bit bundle arm64
```

### Step 3: Test in VS Code

```bash
# Install the VSIX into VS Code
code --install-extension ophan-darwin-arm64-0.0.2.vsix

# Open a repo that has .ophan/index.db
code /path/to/analyzed/repo

# Verify:
# 1. Extension activates (check Output > Ophan channel for errors)
# 2. CodeLens appears on functions in analyzed files
# 3. Webview panel opens (Cmd+Shift+P > Ophan: Open)
# 4. Security diagnostics appear (if the repo has security findings)
```

To uninstall after testing:
```bash
code --uninstall-extension ophan.ophan
```

### Step 4: Test in Cursor

```bash
# Install the same VSIX into Cursor
cursor --install-extension ophan-darwin-arm64-0.0.2.vsix

# Or via Cursor's UI:
# Cmd+Shift+P > Extensions: Install from VSIX > select the file

# Open the same repo and verify the same checklist as VS Code
cursor /path/to/analyzed/repo
```

If you see `NODE_MODULE_VERSION` errors in the extension host log, the bundled binary doesn't match Cursor's Electron ABI. Check which ABI Cursor needs:

```bash
# In Cursor's Developer Tools (Help > Toggle Developer Tools > Console):
process.versions.modules    # e.g., "127"
process.versions.electron   # e.g., "34.3.4"
```

Then verify we have a prebuilt for that ABI version bundled.

### Step 5: Test in Google Antigravity

```bash
# Install via CLI (if available) or via the UI
# Antigravity uses the same extension install mechanism as VS Code
# Cmd+Shift+P > Extensions: Install from VSIX > select the file

# Same verification checklist
```

### Step 6: Test in VS Code Insiders

This is the most important pre-release test. Insiders gets Electron bumps 4-5 weeks before stable:

```bash
# Install VS Code Insiders if you don't have it
# https://code.visualstudio.com/insiders/

code-insiders --install-extension ophan-darwin-arm64-0.0.2.vsix
code-insiders /path/to/analyzed/repo

# If this breaks, an Electron bump is incoming.
# Check the Electron version:
# Help > About (or Developer Tools console: process.versions.electron)
```

### Quick Checklist for Manual Testing

| Editor | Install Command | Key Check |
|--------|----------------|-----------|
| VS Code | `code --install-extension *.vsix` | Extension activates, CodeLens visible |
| VS Code Insiders | `code-insiders --install-extension *.vsix` | Catches upcoming Electron bumps |
| Cursor | `cursor --install-extension *.vsix` | Different Electron version works |
| Antigravity | Install from VSIX via command palette | Different Electron version works |

### Checking Electron ABI in Any Editor

Open Developer Tools (Help > Toggle Developer Tools) and run in the console:

```javascript
console.log({
  electron: process.versions.electron,
  node: process.versions.node,
  modules: process.versions.modules,  // This is the ABI version
  v8: process.versions.v8
});
```

The `modules` value is the `NODE_MODULE_VERSION` that must match our bundled binary. If we don't have a binary for that ABI, the extension will fail.

## Maintenance Checklist

### On Every Release

- [ ] Verify `better-sqlite3` version has prebuilts for all target Electron ABIs (check [GitHub Releases](https://github.com/WiseLibs/better-sqlite3/releases))
- [ ] Confirm all platform-specific VSIXs contain the correct `.node` binaries (one per supported ABI)
- [ ] Build a local VSIX and test in VS Code + at least one fork (Cursor or Antigravity). See [Manual Build and Test](#manual-build-and-test-before-publishing)
- [ ] Test in VS Code Insiders to catch upcoming Electron bumps

### Every 2-3 Months (Electron Bump Cycle)

- [ ] Check [ewanharris/vscode-versions](https://github.com/ewanharris/vscode-versions) for Electron changes in VS Code Insiders
- [ ] Check Cursor and Antigravity release notes for Electron version changes
- [ ] If any editor bumped to a new Electron ABI: add the new ABI to the CI prebuilt download list
- [ ] Drop ABIs older than 1 year from the bundle to keep VSIX size reasonable
- [ ] Watch for VS Code "Update to Electron X" issues on [microsoft/vscode](https://github.com/microsoft/vscode)

### On better-sqlite3 Major Version Bumps

- [ ] Check changelog for breaking changes, especially V8/Electron compatibility
- [ ] Verify prebuilt binaries exist for all target Electron ABIs and platforms
- [ ] Test `db.serialize()` and other APIs we use still work under V8 sandboxing
- [ ] Update the prebuilt download URLs in CI to the new version

### Annually

- [ ] Review platform target coverage -- are we missing growing platforms? (e.g., win32-arm64)
- [ ] Review whether WASM alternatives have matured enough to reconsider (e.g., if `node:sqlite` becomes stable and available in Electron)
- [ ] Audit supported ABI list against 1-year support window for all major editors
- [ ] Consider upgrading to full prebuildify if ABI target count exceeds 5
- [ ] Verify our extension name is claimed on Open VSX (prevent name squatting)

## Key Files

| File | Purpose |
|------|---------|
| `packages/vscode/package.json` | `engines.vscode`, `better-sqlite3` dependency, `@electron/rebuild` devDep |
| `packages/vscode/esbuild.mjs` | `external: ["vscode"]` -- better-sqlite3 JS is bundled inline, only native `.node` loaded at runtime |
| `packages/vscode/.vscodeignore` | Excludes `node_modules/**`, includes `native/**` for pre-compiled binaries |
| `.github/workflows/release.yml` | Platform matrix build and publish |

## External References

### VS Code Extension Publishing
- [VS Code Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) -- platform-specific packaging docs
- [microsoft/vscode-platform-specific-sample](https://github.com/microsoft/vscode-platform-specific-sample) -- Microsoft's reference CI workflow
- [VS Code Discussions #768](https://github.com/microsoft/vscode-discussions/discussions/768) -- "Correct way to publish extensions with native modules?" (no official answer)
- [microsoft/vscode#658](https://github.com/microsoft/vscode/issues/658) -- original issue on native module support (unsupported)

### Electron Tracking
- [ewanharris/vscode-versions](https://github.com/ewanharris/vscode-versions) -- VS Code to Electron/Node version mapping (updated daily)
- [Electron: Using Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) -- `@electron/rebuild` docs
- [Electron Release Timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) -- Electron's own release cadence

### better-sqlite3
- [better-sqlite3 troubleshooting](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md)
- [better-sqlite3 #1372](https://github.com/WiseLibs/better-sqlite3/issues/1372) -- V8 sandbox serialize() crash
- [better-sqlite3 #1416](https://github.com/WiseLibs/better-sqlite3/issues/1416) -- Electron 39 GetIsolate() removal
- [better-sqlite3 #385](https://github.com/WiseLibs/better-sqlite3/issues/385) -- original VS Code extension discussion
- [better-sqlite3 #1321](https://github.com/WiseLibs/better-sqlite3/issues/1321) -- Electron integration challenges
- [Signal Desktop #6613](https://github.com/signalapp/Signal-Desktop/issues/6613) -- antivirus false positive on better_sqlite3.node

### Multi-Editor / Open VSX
- [Open VSX Registry](https://open-vsx.org/) -- the marketplace used by Cursor, Antigravity, Windsurf
- [eclipse/openvsx](https://github.com/eclipse/openvsx) -- Open VSX source and publishing wiki
- [Google Antigravity announcement](https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/) -- Google's VS Code fork
- [VS Code extension marketplace wars (DevClass)](https://devclass.com/2025/04/08/vs-code-extension-marketplace-wars-cursor-users-hit-roadblocks/) -- Microsoft enforcing marketplace ToU
- [VS Code Forks supply chain risk (The Hacker News)](https://thehackernews.com/2026/01/vs-code-forks-recommend-missing.html) -- name squatting attack on Open VSX
- [Publishing to all VS Code IDEs (David Gomes)](https://davidgomes.com/my-experience-with-publishing-an-extension-for-all-vs-code-ides/) -- practical dual-marketplace guide
