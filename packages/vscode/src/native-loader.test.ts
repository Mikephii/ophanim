import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { resolveNativeBinding } from "./native-loader";

// Mock fs to control native/ directory existence and contents
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

describe("resolveNativeBinding", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when neither dev nor native paths exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = resolveNativeBinding();

    expect(result).toBeUndefined();
  });

  it("prefers dev node_modules binary over native/ directory", () => {
    // Both dev path and native/ exist -- dev should win
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes(path.join("node_modules", "better-sqlite3"))) return true;
      if (s.endsWith("native")) return true;
      return false;
    });

    const result = resolveNativeBinding();

    expect(result).toBeDefined();
    expect(result).toContain("node_modules");
    expect(result).toContain("better_sqlite3.node");
  });

  it("falls back to native/ when node_modules binary does not exist (production VSIX)", () => {
    const abi = process.versions.modules;

    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      // No node_modules binary
      if (s.includes("node_modules")) return false;
      // native/ exists
      if (s.endsWith("native")) return true;
      // Matching ABI binary exists
      if (s.endsWith(path.join("node", "better_sqlite3.node"))) return true;
      return false;
    });

    const result = resolveNativeBinding();

    expect(result).toBeDefined();
    expect(result).toContain("native");
    expect(result).toContain("better_sqlite3.node");
  });

  it("prefers the node-{ABI} binary over the generic node/ one on plain Node hosts", () => {
    const abi = process.versions.modules;

    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("node_modules")) return false;
      if (s.endsWith("native")) return true;
      if (s.endsWith(path.join(`node-${abi}`, "better_sqlite3.node"))) return true;
      if (s.endsWith(path.join("node", "better_sqlite3.node"))) return true;
      return false;
    });

    expect(resolveNativeBinding()).toContain(`node-${abi}`);
  });

  it("looks for electron-{ABI} subdirectory when running in Electron", () => {
    // Simulate Electron runtime
    const originalElectron = (process.versions as Record<string, string>).electron;
    (process.versions as Record<string, string>).electron = "39.0.0";
    const abi = process.versions.modules;

    try {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s.includes("node_modules")) return false; // production
        if (s.endsWith("native")) return true;
        if (s.endsWith(path.join(`electron-${abi}`, "better_sqlite3.node"))) return true;
        return false;
      });

      const result = resolveNativeBinding();

      expect(result).toBeDefined();
      expect(result).toContain(`electron-${abi}`);
      expect(result).toContain("better_sqlite3.node");
    } finally {
      if (originalElectron === undefined) {
        delete (process.versions as Record<string, string>).electron;
      } else {
        (process.versions as Record<string, string>).electron = originalElectron;
      }
    }
  });

  it("throws user-friendly error when ABI is not bundled", () => {
    // No dev path, native/ exists but no matching subdirectory
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("node_modules")) return false;
      if (s.endsWith("native")) return true;
      return false; // no matching binary
    });
    mockReaddirSync.mockReturnValue([
      "electron-132" as unknown as fs.Dirent,
      "electron-136" as unknown as fs.Dirent,
      "node" as unknown as fs.Dirent,
    ]);

    expect(() => resolveNativeBinding()).toThrow(
      /No compatible SQLite binary/,
    );
    expect(() => resolveNativeBinding()).toThrow(/ABI/);
    expect(() => resolveNativeBinding()).toThrow(/electron-132/);
  });

  it("includes the current ABI in the error message", () => {
    const abi = process.versions.modules;

    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("node_modules")) return false;
      if (s.endsWith("native")) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      "electron-999" as unknown as fs.Dirent,
    ]);

    try {
      resolveNativeBinding();
    } catch (e: unknown) {
      expect((e as Error).message).toContain(`ABI ${abi}`);
      expect((e as Error).message).toContain("report this");
    }
  });

  it("handles readdirSync failure gracefully in error path", () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("node_modules")) return false;
      if (s.endsWith("native")) return true;
      return false;
    });
    mockReaddirSync.mockImplementation(() => {
      throw new Error("permission denied");
    });

    // Should still throw user-friendly error, not crash on readdirSync failure
    expect(() => resolveNativeBinding()).toThrow(
      /No compatible SQLite binary/,
    );
  });
});
