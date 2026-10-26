// Native binary loader for multi-Electron compatibility.
//
// The VS Code extension runs in different editors (VS Code, Cursor, Antigravity)
// that bundle different Electron versions with different ABIs. A .node binary
// compiled for one ABI crashes in another with NODE_MODULE_VERSION mismatch.
//
// This module detects the current runtime ABI and returns the path to the
// matching better-sqlite3 native binary. In Node.js (tests, scripts), uses the
// binary from node_modules/better-sqlite3/build/. In Electron (F5 dev or
// packaged VSIX), uses the bundled native/ directory with per-ABI binaries.
// This split is necessary because pnpm install compiles against system Node.js,
// not VS Code's Electron, so the node_modules binary always has the wrong ABI
// for extension host use.
//
// better-sqlite3's JS is bundled by esbuild (not external), so the bindings
// package can't resolve the .node file via its stack-trace-based search.
// We must always return an explicit path.
//
// See docs/release-lifecycle/native-binary-bundling.md for full context.

import * as path from "path";
import * as fs from "fs";

/**
 * Resolve the path to the correct better-sqlite3 native binary for the
 * current runtime (Electron version or Node.js).
 *
 * Returns the path string if a bundled binary exists for this ABI,
 * or undefined to let better-sqlite3 use its default resolution
 * (works in development where node_modules/better-sqlite3/build/ exists).
 *
 * Throws a user-friendly error if the native/ directory exists (packaged VSIX)
 * but no binary matches the current ABI.
 */
export function resolveNativeBinding(): string | undefined {
  const isElectron = !!(process.versions as Record<string, string>).electron;

  // Dev mode: use node_modules binary only for Node.js (tests, scripts).
  // Skip it for Electron -- pnpm install compiles against system Node.js,
  // not VS Code's Electron, so the ABI will mismatch.
  if (!isElectron) {
    const devPath = path.join(
      __dirname, "..", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node",
    );
    if (fs.existsSync(devPath)) return devPath;
  }

  // Electron (dev F5 or packaged VSIX): select the correct ABI binary
  // from the native/ directory.
  const nativeDir = path.join(__dirname, "..", "native");

  if (fs.existsSync(nativeDir)) {
    const abi = process.versions.modules; // e.g. "132"
    // Node hosts (code-server, Remote SSH, WSL) differ by Node major, so prefer an exact
    // ABI match; "node" is the build machine's Node, kept as a fallback for older VSIXs.
    const candidates = isElectron ? [`electron-${abi}`] : [`node-${abi}`, "node"];
    for (const subdir of candidates) {
      const bindingPath = path.join(nativeDir, subdir, "better_sqlite3.node");
      if (fs.existsSync(bindingPath)) return bindingPath;
    }

    // No matching binary -- throw user-friendly error instead of cryptic ABI crash
    let bundledAbis = "unknown";
    try {
      const dirs = fs.readdirSync(nativeDir).filter(
        (d) => d.startsWith("electron-") || d.startsWith("node"),
      );
      bundledAbis = dirs.join(", ");
    } catch {
      // readdirSync failure is non-critical for the error message
    }

    const runtime = isElectron
      ? `Electron ${(process.versions as Record<string, string>).electron}`
      : "Node.js";

    throw new Error(
      `Ophan: No compatible SQLite binary for this editor.\n` +
      `  Runtime: ${runtime} (ABI ${abi})\n` +
      `  Bundled: ${bundledAbis}\n` +
      `  Please report this at https://github.com/Mikephii/ophanim/issues`,
    );
  }

  // Fallback: let better-sqlite3 try its default resolution (bindings package)
  return undefined;
}
