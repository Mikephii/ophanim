import { describe, it, expect } from "vitest";
import { formatError, isGitIgnored } from "./watch";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync } from "child_process";

describe("formatError", () => {
  it("extracts message from Error instances", () => {
    expect(formatError(new Error("something broke"))).toBe("something broke");
  });

  it("handles Error with empty message", () => {
    const result = formatError(new Error(""));
    expect(result).toBe("Error");
  });

  it("passes through string errors", () => {
    expect(formatError("plain string")).toBe("plain string");
  });

  it("handles empty string error", () => {
    expect(formatError("")).toBe("Empty error string");
  });

  it("extracts .message from non-Error objects", () => {
    expect(formatError({ message: "auth failed", code: 401 })).toBe("auth failed");
  });

  it("extracts .error from non-Error objects", () => {
    expect(formatError({ error: "rate limited", status: 429 })).toBe("rate limited");
  });

  it("JSON-stringifies plain objects without .message or .error", () => {
    expect(formatError({ code: "ECONNREFUSED", port: 5432 })).toBe(
      '{"code":"ECONNREFUSED","port":5432}'
    );
  });

  it("handles circular references without returning [object Object]", () => {
    const obj: any = { name: "circular" };
    obj.self = obj;
    const result = formatError(obj);
    expect(result).not.toBe("[object Object]");
    expect(result).toBe("Unknown error (non-serializable object)");
  });

  it("uses .message from circular objects that have it", () => {
    const obj: any = { message: "connection timeout" };
    obj.self = obj;
    expect(formatError(obj)).toBe("connection timeout");
  });

  it("never returns literal 'undefined'", () => {
    expect(formatError(undefined)).toBe("Unknown error (undefined)");
  });

  it("never returns literal 'null'", () => {
    expect(formatError(null)).toBe("Unknown error (null)");
  });

  it("handles number errors", () => {
    expect(formatError(42)).toBe("42");
  });

  it("prefers .message over .error when both exist", () => {
    expect(formatError({ message: "specific", error: "generic" })).toBe("specific");
  });

  it("handles Error subclasses", () => {
    const err = new TypeError("bad type");
    expect(formatError(err)).toBe("bad type");
  });

  it("handles SDK-style error objects with message property", () => {
    const sdkError = Object.create(null);
    sdkError.message = "Invalid API key";
    sdkError.status = 401;
    expect(formatError(sdkError)).toBe("Invalid API key");
  });

  it("ignores empty .message on objects and tries .error", () => {
    expect(formatError({ message: "", error: "fallback" })).toBe("fallback");
  });
});

describe("isGitIgnored", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-test-"));
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored-dir/\n*.log\n");
    fs.mkdirSync(path.join(tmpDir, "ignored-dir"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "ignored-dir", "file.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "real-file.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "debug.log"), "");
  }

  function cleanup() {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  it("returns true for files in gitignored directories", () => {
    setup();
    try {
      expect(isGitIgnored(path.join(tmpDir, "ignored-dir", "file.ts"), tmpDir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("returns true for files matching gitignore patterns", () => {
    setup();
    try {
      expect(isGitIgnored(path.join(tmpDir, "debug.log"), tmpDir)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("returns false for normal source files", () => {
    setup();
    try {
      expect(isGitIgnored(path.join(tmpDir, "real-file.ts"), tmpDir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("returns false gracefully for non-git directories", () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-nogit-"));
    try {
      fs.writeFileSync(path.join(nonGitDir, "file.ts"), "");
      expect(isGitIgnored(path.join(nonGitDir, "file.ts"), nonGitDir)).toBe(false);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("respects nested .gitignore files", () => {
    setup();
    try {
      // Add a nested .gitignore
      fs.mkdirSync(path.join(tmpDir, "subdir"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "subdir", ".gitignore"), "local-only/\n");
      fs.mkdirSync(path.join(tmpDir, "subdir", "local-only"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "subdir", "local-only", "file.ts"), "");

      expect(isGitIgnored(path.join(tmpDir, "subdir", "local-only", "file.ts"), tmpDir)).toBe(true);
      // File next to the nested .gitignore should not be ignored
      fs.writeFileSync(path.join(tmpDir, "subdir", "keep.ts"), "");
      expect(isGitIgnored(path.join(tmpDir, "subdir", "keep.ts"), tmpDir)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
